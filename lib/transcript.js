'use strict';

/**
 * Reading Claude Code transcripts (JSON Lines).
 *
 * - Assistant lines carry `message.id` and `message.usage`. One API response is written as
 *   several consecutive lines (one per content block) with the same id and usage, so usage is
 *   counted once per id.
 * - Subagent transcripts live next to the main one: <session>.jsonl and <session>/subagents/*.jsonl
 * - Tool results are `tool_result` blocks in user messages, matched to `tool_use` blocks by id.
 * - `{"type":"system","subtype":"compact_boundary"}` marks a compaction.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const state = require('./state');
const { estimateTokens } = require('./util');

const IMAGE_TOKENS = 1600; // rough per-image estimate (about a 1.2-megapixel image)

function subagentFiles(transcriptPath) {
  if (!transcriptPath) return [];
  const dir = path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function transcriptFiles(transcriptPath) {
  if (!transcriptPath) return [];
  const files = fs.existsSync(transcriptPath) ? [transcriptPath] : [];
  return files.concat(subagentFiles(transcriptPath));
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  return [
    Number(u.input_tokens) || 0,
    Number(u.cache_creation_input_tokens) || 0,
    Number(u.cache_read_input_tokens) || 0,
    Number(u.output_tokens) || 0,
  ];
}

function emptyTotals() {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: 0 };
}

function addUsage(t, u, sign = 1) {
  t.input += sign * u[0];
  t.cacheWrite += sign * u[1];
  t.cacheRead += sign * u[2];
  t.output += sign * u[3];
}

/** Apply one parsed line to an incremental usage accumulator { totals, lastId, lastUsage }. */
function applyUsageLine(acc, obj) {
  if (!obj || obj.type !== 'assistant' || !obj.message) return;
  const id = obj.message.id;
  const u = usageOf(obj.message.usage);
  if (!id || !u || obj.message.model === '<synthetic>') return;
  if (id === acc.lastId && acc.lastUsage) {
    addUsage(acc.totals, acc.lastUsage, -1); // same response, later block: replace, do not add
  } else {
    acc.totals.requests += 1;
  }
  addUsage(acc.totals, u, 1);
  acc.lastId = id;
  acc.lastUsage = u;
}

/** Read complete new lines of `file` from `offset`. Returns { lines, offset }. */
function readNewLines(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset: size < offset ? -1 : offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { lines: [], offset };
    return { lines: buf.subarray(0, end).toString('utf8').split('\n'), offset: offset + end + 1 };
  } catch {
    return { lines: [], offset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Exact token usage of a session (main transcript + subagents), read incrementally with a
 * small cache so the status line stays fast on long sessions.
 */
function sessionUsage(transcriptPath, env = process.env) {
  const totals = emptyTotals();
  const files = transcriptFiles(transcriptPath);
  if (files.length === 0) return { ...totals, files: 0 };
  const key = 'usage-' + crypto.createHash('sha1').update(String(transcriptPath)).digest('hex').slice(0, 16);
  const cacheFile = state.cachePath(key, env);
  const cache = state.readJson(cacheFile) || {};
  const next = {};
  for (const file of files) {
    let entry = cache[file] && typeof cache[file] === 'object' ? cache[file] : null;
    if (!entry) entry = { offset: 0, totals: emptyTotals(), lastId: null, lastUsage: null };
    let r = readNewLines(file, entry.offset);
    if (r.offset === -1) {
      entry = { offset: 0, totals: emptyTotals(), lastId: null, lastUsage: null }; // file shrank: start over
      r = readNewLines(file, 0);
    }
    for (const line of r.lines) {
      if (!line || !line.includes('"assistant"')) continue;
      try {
        applyUsageLine(entry, JSON.parse(line));
      } catch {
        /* skip torn line */
      }
    }
    entry.offset = r.offset;
    next[file] = entry;
    for (const k of Object.keys(totals)) totals[k] += entry.totals[k];
  }
  try {
    state.writeJson(cacheFile, next);
  } catch {
    /* cache is optional */
  }
  return { ...totals, files: files.length };
}

function contentTokens(content, charsPerToken) {
  if (typeof content === 'string') return estimateTokens(content.length, charsPerToken);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') tokens += estimateTokens(block.text.length, charsPerToken);
    else if (block.type === 'image') tokens += IMAGE_TOKENS;
    else tokens += estimateTokens(JSON.stringify(block).length, charsPerToken);
  }
  return tokens;
}

function describeToolInput(name, input) {
  const i = input || {};
  const short = (s, n = 70) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const tail = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/');
  if (i.file_path) return tail(i.file_path) + (i.offset != null || i.limit != null ? ` [${i.offset ?? 1}+${i.limit ?? ''}]` : '');
  if (i.notebook_path) return tail(i.notebook_path);
  if (i.command) return short(i.command);
  if (i.pattern) return short(`${i.pattern}${i.path ? ' in ' + tail(i.path) : ''}`);
  if (i.url) return short(i.url);
  if (i.query) return short(i.query);
  if (i.description) return short(i.description);
  if (i.prompt) return short(i.prompt);
  return '';
}

/**
 * Full analysis for the token report: usage per file, tool results per tool, and how many
 * later requests re-sent each result (until a compaction dropped it).
 */
function analyze(files, charsPerToken = 4) {
  const totals = emptyTotals();
  const toolUses = new Map();
  const results = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const acc = { totals: emptyTotals(), lastId: null, lastUsage: null };
    const fileResults = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'assistant' && obj.message) {
        applyUsageLine(acc, obj);
        for (const b of Array.isArray(obj.message.content) ? obj.message.content : []) {
          if (b && b.type === 'tool_use' && b.id) toolUses.set(b.id, { name: b.name, input: b.input });
        }
      } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
        for (const b of obj.message.content) {
          if (!b || b.type !== 'tool_result') continue;
          const r = { id: b.tool_use_id, tokens: contentTokens(b.content, charsPerToken), at: acc.totals.requests, end: null, file };
          fileResults.push(r);
          results.push(r);
        }
      } else if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
        for (const r of fileResults) if (r.end == null) r.end = acc.totals.requests;
      }
    }
    for (const r of fileResults) r.carried = Math.max(0, (r.end == null ? acc.totals.requests : r.end) - r.at);
    for (const k of Object.keys(totals)) totals[k] += acc.totals[k];
  }

  const byTool = {};
  const reads = new Map();
  for (const r of results) {
    const use = toolUses.get(r.id) || { name: 'unknown', input: {} };
    r.tool = use.name || 'unknown';
    r.detail = describeToolInput(r.tool, use.input);
    const t = (byTool[r.tool] = byTool[r.tool] || { calls: 0, tokens: 0, carried: 0 });
    t.calls += 1;
    t.tokens += r.tokens;
    t.carried += r.tokens * r.carried;
    if (r.tool === 'Read' && use.input && use.input.file_path) {
      const key = [use.input.file_path, use.input.offset ?? '', use.input.limit ?? '', r.file].join('|');
      const e = reads.get(key) || { file: r.detail, count: 0, repeatTokens: 0 };
      if (e.count > 0) e.repeatTokens += r.tokens;
      e.count += 1;
      reads.set(key, e);
    }
  }
  const repeatedReads = [...reads.values()].filter((e) => e.count > 1);
  const resultTokens = results.reduce((s, r) => s + r.tokens, 0);
  const largest = [...results].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  return { totals, files: files.length, byTool, resultTokens, largest, repeatedReads };
}

/** Locate a transcript: explicit path, by session id, or the newest one for a directory. */
function findTranscript({ transcript, session, cwd, env = process.env, home = os.homedir() } = {}) {
  if (transcript) return fs.existsSync(transcript) ? transcript : null;
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects).map((d) => path.join(projects, d));
  } catch {
    return null;
  }
  if (session) {
    const name = state.safeId(session) + '.jsonl';
    for (const d of dirs) {
      const f = path.join(d, name);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }
  const newest = (dir) => {
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    } catch {
      /* ignore */
    }
    return best;
  };
  if (cwd) {
    const slug = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
    const b = newest(path.join(projects, slug));
    if (b) return b.p;
  }
  let best = null;
  for (const d of dirs) {
    const b = newest(d);
    if (b && (!best || b.m > best.m)) best = b;
  }
  return best ? best.p : null;
}

module.exports = {
  IMAGE_TOKENS,
  transcriptFiles,
  subagentFiles,
  sessionUsage,
  analyze,
  applyUsageLine,
  contentTokens,
  describeToolInput,
  findTranscript,
  emptyTotals,
};
