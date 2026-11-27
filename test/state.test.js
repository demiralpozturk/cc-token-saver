'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../lib/state');
const { tmpDir } = require('./_helpers');

test('events append and savings add up by kind', () => {
  const env = { CC_TOKEN_SAVER_STATE_DIR: tmpDir('ccts-state-') };
  state.appendEvent('s/1', { t: 'saved', kind: 'blocked-read', tokens: 100 }, env);
  state.appendEvent('s/1', { t: 'saved', kind: 'blocked-read', tokens: 50 }, env);
  state.appendEvent('s/1', { t: 'saved', kind: 'repeat-read', tokens: 7 }, env);
  state.appendEvent('s/1', { t: 'read', key: 'k' }, env);
  fs.appendFileSync(state.eventsPath('s/1', env), '{"torn": ');
  const events = state.readEvents('s/1', env);
  assert.equal(events.length, 4, 'a torn last line is skipped');
  const s = state.summarizeSavings(events);
  assert.equal(s.total, 157);
  assert.equal(s.count, 3);
  assert.deepEqual(s.byKind['blocked-read'], { count: 2, tokens: 150 });
  assert.match(path.basename(state.eventsPath('s/1', env)), /^s_1\.jsonl$/, 'session ids are sanitized');
});

test('cleanup removes old files only', () => {
  const env = { CC_TOKEN_SAVER_STATE_DIR: tmpDir('ccts-state-') };
  state.appendEvent('old', { t: 'x' }, env);
  state.appendEvent('new', { t: 'x' }, env);
  const old = state.eventsPath('old', env);
  const past = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  assert.equal(state.cleanup(env, 7), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(state.eventsPath('new', env)), true);
});

test('POSIX: state lives in a per-user directory with owner-only permissions', { skip: typeof process.getuid !== 'function' && 'POSIX only' }, () => {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir('ccts-tmp-');
  try {
    const dir = state.stateDir({});
    assert.equal(path.basename(dir), 'cc-token-saver-' + process.getuid());
    state.appendEvent('p', { t: 'x' }, {});
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(state.eventsPath('p', {})).mode & 0o077, 0);
    fs.chmodSync(dir, 0o777);
    state.stateDir({});
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'loose permissions are tightened');
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});
