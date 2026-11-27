'use strict';

/**
 * Per-session state, stored as an append-only JSON Lines event log under the
 * OS temp directory: <tmp>/cc-token-saver/sessions/<session_id>.jsonl
 *
 * Append-only keeps concurrent hook processes (parallel tool calls) from
 * clobbering each other without any locking.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureDir } = require('./util');

function stateDir(env = process.env) {
  return env.CC_TOKEN_SAVER_STATE_DIR || path.join(os.tmpdir(), 'cc-token-saver');
}

function safeId(id) {
  const s = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return s || 'unknown';
}

function eventsPath(sessionId, env) {
  return path.join(stateDir(env), 'sessions', safeId(sessionId) + '.jsonl');
}

function statusPath(sessionId, env) {
  return path.join(stateDir(env), 'sessions', safeId(sessionId) + '.status.json');
}

function logPath(sessionId, name, env) {
  return path.join(stateDir(env), 'logs', safeId(sessionId), safeId(name) + '.log');
}

function cachePath(name, env) {
  return path.join(stateDir(env), 'cache', safeId(name) + '.json');
}

function appendEvent(sessionId, event, env) {
  const file = eventsPath(sessionId, env);
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}

function readEvents(sessionId, env) {
  let text;
  try {
    text = fs.readFileSync(eventsPath(sessionId, env), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore a torn line */
    }
  }
  return out;
}

/** Sum of `saved` events: { total, count, byKind: { kind: { count, tokens } } } */
function summarizeSavings(events) {
  const byKind = {};
  let total = 0;
  let count = 0;
  for (const e of events) {
    if (!e || e.t !== 'saved') continue;
    const tokens = Number(e.tokens) || 0;
    total += tokens;
    count += 1;
    const k = e.kind || 'other';
    byKind[k] = byKind[k] || { count: 0, tokens: 0 };
    byKind[k].count += 1;
    byKind[k].tokens += tokens;
  }
  return { total, count, byKind };
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse a rename over a file another process holds open; fall back to a direct write.
    fs.writeFileSync(file, JSON.stringify(value));
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Remove state, logs and caches older than maxAgeDays. Best effort, never throws. */
function cleanup(env, maxAgeDays = 7, now = Date.now()) {
  const root = stateDir(env);
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  let removed = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          if (depth < 3) walk(p, depth + 1);
          if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
        } else if (fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed += 1;
        }
      } catch {
        /* ignore */
      }
    }
  };
  walk(root, 0);
  return removed;
}

module.exports = {
  stateDir,
  safeId,
  eventsPath,
  statusPath,
  logPath,
  cachePath,
  appendEvent,
  readEvents,
  summarizeSavings,
  writeJson,
  readJson,
  cleanup,
};
