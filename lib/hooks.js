'use strict';

/**
 * Hook dispatcher. Each handler receives the parsed hook input and a context
 * ({ env, config, projectDir }) and returns the JSON object to print, or null.
 */

const { loadConfig, featureOn } = require('./config');
const state = require('./state');
const readGuard = require('./read-guard');
const repeatReads = require('./repeat-reads');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function normalizeEvent(name) {
  return String(name || '')
    .replace(/[_\s]/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function buildContext(input, base = {}) {
  const env = base.env || process.env;
  const { config, projectDir } = loadConfig({ cwd: input.cwd, env });
  return { env, config, projectDir, now: base.now || Date.now() };
}

function record(input, ctx, event) {
  try {
    state.appendEvent(input.session_id, event, ctx.env);
  } catch {
    /* state is best effort */
  }
}

function deny(input, ctx, result, kind) {
  record(input, ctx, {
    t: 'saved',
    kind,
    tool: input.tool_name,
    tokens: result.savedTokens || 0,
    category: result.category,
    detail: result.detail,
  });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    },
  };
}

function preToolUse(input, ctx) {
  const { config, projectDir } = ctx;
  const tool = input.tool_name;
  const guard = featureOn(config, 'readGuard');

  if (tool === 'Read') {
    if (guard) {
      const r = readGuard.evaluateRead(input, config, projectDir);
      if (r) return deny(input, ctx, r, 'blocked-read');
    }
    if (featureOn(config, 'repeatReads') && input.session_id) {
      const r = repeatReads.evaluateRepeat(input, state.readEvents(input.session_id, ctx.env), config, projectDir);
      if (r) {
        record(input, ctx, { t: 'repeat-denied', key: r.key });
        return deny(input, ctx, r, 'repeat-read');
      }
    }
    return null;
  }

  if (tool === 'Grep' && guard) {
    const r = readGuard.evaluateGrep(input, config, projectDir);
    return r ? deny(input, ctx, r, 'blocked-grep') : null;
  }

  if (tool === 'Glob' && guard) {
    const r = readGuard.evaluateGlob(input, config, projectDir);
    return r ? deny(input, ctx, r, 'blocked-glob') : null;
  }

  if ((tool === 'Bash' || tool === 'PowerShell') && guard) {
    const r = readGuard.evaluateShellCat(input, config, projectDir);
    if (r) return deny(input, ctx, r, 'blocked-cat');
  }

  return null;
}

function postToolUse(input, ctx) {
  const { config, projectDir } = ctx;
  const tool = input.tool_name;
  if (!input.session_id) return null;

  if (tool === 'Read' && featureOn(config, 'repeatReads')) {
    const ev = repeatReads.readEvent(input, config, projectDir);
    if (ev) record(input, ctx, ev);
    return null;
  }

  if (EDIT_TOOLS.has(tool) && featureOn(config, 'repeatReads')) {
    const ev = repeatReads.invalidateEvent(input, projectDir);
    if (ev) record(input, ctx, ev);
    return null;
  }

  return null;
}

function sessionStart(input, ctx) {
  // After compaction (or /clear) earlier Read results are gone from context: forget them.
  if (input.session_id && (input.source === 'compact' || input.source === 'clear')) {
    record(input, ctx, { t: 'reset', reason: input.source });
  }
  // Housekeeping: drop state older than a week. Cheap, best effort.
  state.cleanup(ctx.env, 7);
  return null;
}

const HANDLERS = {
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  'session-start': sessionStart,
};

function run(event, input, base = {}) {
  const handler = HANDLERS[normalizeEvent(event || input.hook_event_name)];
  if (!handler) return null;
  const ctx = buildContext(input, base);
  if (!ctx.config.enabled) return null;
  return handler(input, ctx);
}

module.exports = { run, normalizeEvent, buildContext, HANDLERS };
