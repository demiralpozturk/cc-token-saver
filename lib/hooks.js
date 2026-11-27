'use strict';

/**
 * Hook dispatcher. Each handler receives the parsed hook input and a context
 * ({ env, config, projectDir }) and returns the JSON object to print, or null.
 */

const { loadConfig } = require('./config');
const state = require('./state');

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

function preToolUse(_input, _ctx) {
  return null;
}

function postToolUse(_input, _ctx) {
  return null;
}

function sessionStart(_input, ctx) {
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
