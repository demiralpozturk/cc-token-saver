'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isolatedEnv, runHook, tmpDir } = require('./_helpers');
const { normalizeEvent } = require('../lib/hooks');
const { check } = require('../scripts/check-manifests');

test('event names normalize from CLI and hook_event_name spellings', () => {
  assert.equal(normalizeEvent('PreToolUse'), 'pre-tool-use');
  assert.equal(normalizeEvent('post-tool-use'), 'post-tool-use');
  assert.equal(normalizeEvent('SessionStart'), 'session-start');
});

test('garbage on stdin exits 0 with no output (never blocks a tool call)', () => {
  const r = runHook('pre-tool-use', 'this is not json', isolatedEnv());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('empty stdin exits 0 with no output', () => {
  const r = runHook('post-tool-use', '', isolatedEnv());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('unknown event exits 0 with no output', () => {
  const r = runHook('nonsense', { session_id: 's', cwd: tmpDir() }, isolatedEnv());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('session-start runs cleanly', () => {
  const r = runHook('session-start', { session_id: 's1', cwd: tmpDir(), hook_event_name: 'SessionStart', source: 'startup' }, isolatedEnv());
  assert.equal(r.status, 0);
});

test('plugin manifests pass the offline checks', () => {
  assert.deepEqual(check(), []);
});
