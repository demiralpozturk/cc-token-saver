'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolatedEnv, runHook, loadFixture, writeFile, tmpDir } = require('./_helpers');
const { sourceLines } = require('./_project');
const state = require('../lib/state');

function setup(lines = 120) {
  const project = tmpDir('ccts-rr-');
  const file = writeFile(path.join(project, 'src', 'service.ts'), sourceLines(lines));
  const session = 'rr-' + Math.random().toString(36).slice(2);
  const env = isolatedEnv();
  const content = fs.readFileSync(file, 'utf8');
  const vars = { SESSION: session, PROJECT: project, FILE: file, CONTENT: content, LINES: content.split('\n').length };
  return { project, file, session, env, vars };
}

const pre = (vars, name = 'pre-read.json') => loadFixture(name, vars);
const post = (vars) => loadFixture('post-read.json', vars);
const isDeny = (r) => Boolean(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny');

test('first read is allowed and recorded', () => {
  const { env, vars, session } = setup();
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
  runHook('post-tool-use', post(vars), env);
  const reads = state.readEvents(session, env).filter((e) => e.t === 'read');
  assert.equal(reads.length, 1);
  assert.ok(reads[0].tokens > 500);
});

test('re-reading an unchanged file is denied once, then allowed if Claude insists', () => {
  const { env, vars, session } = setup();
  runHook('post-tool-use', post(vars), env);

  const first = runHook('pre-tool-use', pre(vars), env);
  assert.ok(isDeny(first), 'repeat read should be denied');
  assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /already read/);
  assert.match(first.json.hookSpecificOutput.permissionDecisionReason, /repeat this exact Read/);

  const second = runHook('pre-tool-use', pre(vars), env);
  assert.equal(isDeny(second), false, 'second attempt after a denial must go through');

  // The allowed re-read is recorded again, so a third repeat is denied again.
  runHook('post-tool-use', post(vars), env);
  assert.ok(isDeny(runHook('pre-tool-use', pre(vars), env)));

  const saved = state.readEvents(session, env).filter((e) => e.t === 'saved' && e.kind === 'repeat-read');
  assert.equal(saved.length, 2);
  assert.ok(saved[0].tokens > 0);
});

test('a changed file can be read again', () => {
  const { env, vars, file } = setup();
  runHook('post-tool-use', post(vars), env);
  fs.appendFileSync(file, '// new line\n');
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
});

test('an Edit invalidates earlier reads even if size and mtime look the same', () => {
  const { env, vars } = setup();
  runHook('post-tool-use', post(vars), env);
  runHook('post-tool-use', loadFixture('post-edit.json', vars), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
});

test('a different range is not a repeat', () => {
  const { env, vars } = setup();
  runHook('post-tool-use', post(vars), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars, 'pre-read-range.json'), env)), false);
});

test('a subagent has its own context, so its first read is allowed', () => {
  const { env, vars } = setup();
  runHook('post-tool-use', post(vars), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars, 'pre-read-subagent.json'), env)), false);
});

test('compaction resets the tracker', () => {
  const { env, vars } = setup();
  runHook('post-tool-use', post(vars), env);
  runHook('session-start', loadFixture('session-start.json', { ...vars, SOURCE: 'compact' }), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
});

test('resume keeps the tracker (the conversation is restored)', () => {
  const { env, vars } = setup();
  runHook('post-tool-use', post(vars), env);
  runHook('session-start', loadFixture('session-start.json', { ...vars, SOURCE: 'resume' }), env);
  assert.ok(isDeny(runHook('pre-tool-use', pre(vars), env)));
});

test('tiny files are not worth a denial round trip', () => {
  const { env, vars } = setup(3);
  runHook('post-tool-use', post(vars), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
});

test('repeatReads can be disabled', () => {
  const { vars } = setup();
  const env = isolatedEnv({ CC_TOKEN_SAVER_DISABLE: 'repeatReads' });
  runHook('post-tool-use', post(vars), env);
  assert.equal(isDeny(runHook('pre-tool-use', pre(vars), env)), false);
});

test('image reads are not tracked', () => {
  const { env, vars, session } = setup();
  const input = post(vars);
  input.tool_response = { type: 'image', file: { base64: 'AAAA', type: 'image/png' } };
  runHook('post-tool-use', input, env);
  assert.equal(state.readEvents(session, env).filter((e) => e.t === 'read').length, 0);
});
