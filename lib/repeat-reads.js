'use strict';

/**
 * Repeated-read guard.
 *
 * PostToolUse(Read) records what was read (path, offset/limit, mtime, size, estimated tokens).
 * PreToolUse(Read) denies an identical Read of a file that has not changed since, once:
 * if Claude repeats the exact same Read right after the denial (for example because the
 * earlier content was lost to a rewind), the next attempt is allowed. Compaction resets the
 * tracker because the earlier content is no longer in context.
 *
 * Tracking is per agent: a subagent has its own context window, so its first read of a file
 * the main conversation already read is not a repeat.
 */

const fs = require('fs');
const path = require('path');
const { pathKey, estimateTokens, formatTokens, relativeInside, toPosix } = require('./util');

const MIN_TOKENS_WORTH_BLOCKING = 200;
const LINE_PREFIX_CHARS = 7;

function agentOf(input) {
  return (input && (input.agent_id || input.agentId)) || 'main';
}

function readKey(file, ti, agent) {
  const offset = ti.offset == null ? '' : String(ti.offset);
  const limit = ti.limit == null ? '' : String(ti.limit);
  return [agent, pathKey(file), offset, limit].join('|');
}

function absPath(input, projectDir) {
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path;
  if (typeof file !== 'string' || !file) return null;
  return path.isAbsolute(file) ? file : path.resolve(input.cwd || projectDir || '.', file);
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { mtimeMs: Math.round(st.mtimeMs), size: st.size } : null;
  } catch {
    return null;
  }
}

/** Fold the event log into the state relevant to one key. */
function lookup(events, key, fileKey) {
  let lastRead = null;
  let deniedSince = false;
  for (const e of events) {
    if (!e) continue;
    if (e.t === 'reset') {
      lastRead = null;
      deniedSince = false;
    } else if (e.t === 'invalidate' && e.path === fileKey) {
      lastRead = null;
      deniedSince = false;
    } else if (e.key === key) {
      if (e.t === 'read') {
        lastRead = e;
        deniedSince = false;
      } else if (e.t === 'repeat-denied') {
        deniedSince = true;
      }
    }
  }
  return { lastRead, deniedSince };
}

/** PreToolUse: returns null (allow) or { reason, savedTokens, key, detail }. */
function evaluateRepeat(input, events, cfg, projectDir) {
  const file = absPath(input, projectDir);
  if (!file) return null;
  const ti = input.tool_input || {};
  const key = readKey(file, ti, agentOf(input));
  const { lastRead, deniedSince } = lookup(events, key, pathKey(file));
  if (!lastRead || deniedSince) return null;
  if ((Number(lastRead.tokens) || 0) < MIN_TOKENS_WORTH_BLOCKING) return null;
  const st = statOf(file);
  if (!st || st.mtimeMs !== lastRead.mtimeMs || st.size !== lastRead.size) return null;

  const shown = (projectDir && relativeInside(file, projectDir)) || toPosix(file);
  const range = ti.offset != null || ti.limit != null ? ` (offset ${ti.offset ?? 1}, limit ${ti.limit ?? 'default'})` : '';
  const reason =
    `cc-token-saver: \`${shown}\`${range} was already read in this conversation and has not changed on disk since ` +
    `(~${formatTokens(lastRead.tokens)} tokens). Use the content from that earlier Read result instead of reading it again. ` +
    'If that content is no longer available to you, repeat this exact Read and it will be allowed.';
  return {
    reason,
    key,
    detail: shown,
    savedTokens: Math.max(0, lastRead.tokens - estimateTokens(reason.length, cfg.charsPerToken)),
  };
}

/** Estimated tokens of a Read result as Claude saw it. */
function resultTokens(response, charsPerToken) {
  if (response && typeof response === 'object' && response.file && typeof response.file.content === 'string') {
    const lines = Number(response.file.numLines) || response.file.content.split('\n').length;
    return estimateTokens(response.file.content.length + lines * LINE_PREFIX_CHARS, charsPerToken);
  }
  if (typeof response === 'string') return estimateTokens(response.length, charsPerToken);
  return 0;
}

/** PostToolUse(Read): build the 'read' event to record, or null for non-text reads. */
function readEvent(input, cfg, projectDir) {
  const file = absPath(input, projectDir);
  if (!file) return null;
  const resp = input.tool_response;
  if (resp && typeof resp === 'object' && resp.type && resp.type !== 'text') return null; // images, PDFs, notebooks
  const tokens = resultTokens(resp, cfg.charsPerToken);
  if (!tokens) return null;
  const st = statOf(file);
  if (!st) return null;
  const ti = input.tool_input || {};
  return {
    t: 'read',
    key: readKey(file, ti, agentOf(input)),
    path: pathKey(file),
    mtimeMs: st.mtimeMs,
    size: st.size,
    tokens,
  };
}

/** PostToolUse(Edit/Write/...): forget earlier reads of the file. */
function invalidateEvent(input, projectDir) {
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path || ti.notebook_path;
  if (typeof file !== 'string' || !file) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || projectDir || '.', file);
  return { t: 'invalidate', path: pathKey(abs) };
}

module.exports = { evaluateRepeat, readEvent, invalidateEvent, readKey, lookup, resultTokens, MIN_TOKENS_WORTH_BLOCKING };
