'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isolatedEnv, runHook, loadFixture, writeFile } = require('./_helpers');
const { makeProject } = require('./_project');
const state = require('../lib/state');

const { root, files } = makeProject();

function readInput(file, extra = {}) {
  const input = loadFixture('pre-read.json', { SESSION: 'rg-' + Math.random().toString(36).slice(2), PROJECT: root, FILE: file });
  Object.assign(input.tool_input, extra);
  return input;
}

function expectDeny(r, pattern) {
  assert.equal(r.status, 0);
  assert.ok(r.json, 'expected JSON output, got: ' + r.stdout + r.stderr);
  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  if (pattern) assert.match(out.permissionDecisionReason, pattern);
  return out.permissionDecisionReason;
}

function expectAllow(r) {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'expected no output (no decision), got: ' + r.stdout);
}

test('denies reading a lockfile and suggests Grep or offset/limit', () => {
  const env = isolatedEnv();
  const input = readInput(files.lockfile);
  const reason = expectDeny(runHook('pre-tool-use', input, env), /lockfile/);
  assert.match(reason, /Grep/);
  assert.match(reason, /offset\/limit/);
  const saved = state.readEvents(input.session_id, env).filter((e) => e.t === 'saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'blocked-read');
  assert.ok(saved[0].tokens > 1000, 'a 300-package lockfile should be worth thousands of tokens');
});

test('allows a lockfile read with a line range (limit)', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.lockfile, { offset: 1, limit: 100 }), isolatedEnv()));
});

test('allows an explicit allow_large read', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.lockfile, { allow_large: true }), isolatedEnv()));
});

test('treats a huge limit as unbounded', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.lockfile, { limit: 50000 }), isolatedEnv()), /lockfile/);
});

test('never blocks tiny files, even lockfiles', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.tinyLock), isolatedEnv()));
});

test('allows ordinary source files', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.source), isolatedEnv()));
});

test('denies minified bundles by name and by content', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.minifiedByName), isolatedEnv()), /minified/);
  expectDeny(runHook('pre-tool-use', readInput(files.minifiedByContent), isolatedEnv()), /average line/);
});

test('denies source maps', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.sourceMap), isolatedEnv()), /source map/);
});

test('denies large files in build output, allows small ones', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.distBundle), isolatedEnv()), /`dist\/`/);
  expectAllow(runHook('pre-tool-use', readInput(files.distSmall), isolatedEnv()));
});

test('node_modules: package.json is fine, big sources are blocked', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.nodeModulesPkgJson), isolatedEnv()));
  expectDeny(runHook('pre-tool-use', readInput(files.nodeModulesIndex), isolatedEnv()), /node_modules/);
});

test('denies files over maxFileKB unless a range is given', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.large), isolatedEnv()), /is large/);
  expectAllow(runHook('pre-tool-use', readInput(files.large, { limit: 200 }), isolatedEnv()));
});

test('denies binary content detected by NUL bytes', () => {
  expectDeny(runHook('pre-tool-use', readInput(files.binary), isolatedEnv()), /binary/);
});

test('above 256 KB the Read is left to Claude Code, which refuses it with a shorter message', () => {
  const p = makeProject().root;
  const { lockfile } = require('./_project');
  const big = writeFile(path.join(p, 'big', 'package-lock.json'), lockfile(1400));
  const mk = (extraCfg) => {
    if (extraCfg) writeFile(path.join(p, '.claude', 'cc-token-saver.json'), JSON.stringify(extraCfg));
    return loadFixture('pre-read.json', { SESSION: 'd', PROJECT: p, FILE: big });
  };
  assert.ok(require('fs').statSync(big).size > 256 * 1024);
  expectAllow(runHook('pre-tool-use', mk(), isolatedEnv()));
  expectDeny(runHook('pre-tool-use', mk({ readGuard: { deferAboveKB: 0 } }), isolatedEnv()), /lockfile/);
  // cat of the same file is still worth blocking: Bash would show a 2k-char preview plus a path.
  const cat = loadFixture('pre-bash.json', { SESSION: 'd', PROJECT: p, COMMAND: 'cat big/package-lock.json', MODE: 'default' });
  writeFile(path.join(p, '.claude', 'cc-token-saver.json'), '{}');
  expectDeny(runHook('pre-tool-use', cat, isolatedEnv()), /lockfile/);
});

test('never blocks images (Claude can look at them)', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.image), isolatedEnv()));
});

test('missing files are left for the Read tool to report', () => {
  expectAllow(runHook('pre-tool-use', readInput(path.join(root, 'nope', 'missing.json')), isolatedEnv()));
});

test('project config can raise maxFileKB and allow-list paths', () => {
  const project = makeProject().root;
  writeFile(path.join(project, '.claude', 'cc-token-saver.json'), JSON.stringify({ readGuard: { maxFileKB: 500, allow: ['package-lock.json'] } }));
  const env = isolatedEnv();
  const mk = (rel) => {
    const i = loadFixture('pre-read.json', { SESSION: 's', PROJECT: project, FILE: path.join(project, rel) });
    return i;
  };
  expectAllow(runHook('pre-tool-use', mk('docs/big.md'), env));
  expectAllow(runHook('pre-tool-use', mk('package-lock.json'), env));
});

test('the readGuard can be switched off by env', () => {
  expectAllow(runHook('pre-tool-use', readInput(files.lockfile), isolatedEnv({ CC_TOKEN_SAVER_DISABLE: 'readGuard' })));
  expectAllow(runHook('pre-tool-use', readInput(files.lockfile), isolatedEnv({ CC_TOKEN_SAVER: 'off' })));
});

test('Grep content mode over build output is denied; files_with_matches and head_limit are fine', () => {
  const env = isolatedEnv();
  const mk = (p, extra = {}) => {
    const i = loadFixture('pre-grep.json', { SESSION: 'g', PROJECT: root, PATH: p });
    Object.assign(i.tool_input, extra);
    return i;
  };
  expectDeny(runHook('pre-tool-use', mk(path.join(root, 'dist')), env), /files_with_matches/);
  expectDeny(runHook('pre-tool-use', mk('node_modules'), env), /node_modules/);
  expectAllow(runHook('pre-tool-use', mk(path.join(root, 'dist'), { output_mode: 'files_with_matches' }), env));
  expectAllow(runHook('pre-tool-use', mk(path.join(root, 'dist'), { head_limit: 50 }), env));
  expectAllow(runHook('pre-tool-use', mk(path.join(root, 'src')), env));
  // Grepping a lockfile is exactly what we recommend instead of reading it.
  expectAllow(runHook('pre-tool-use', mk(files.lockfile), env));
});

test('Glob of everything under node_modules is denied, targeted globs are fine', () => {
  const env = isolatedEnv();
  const mk = (pattern) => loadFixture('pre-glob.json', { SESSION: 'gl', PROJECT: root, PATTERN: pattern });
  expectDeny(runHook('pre-tool-use', mk('node_modules/**/*'), env), /Narrow/);
  expectAllow(runHook('pre-tool-use', mk('node_modules/react/**/*.d.ts'), env));
  expectAllow(runHook('pre-tool-use', mk('src/**/*'), env));
  expectAllow(runHook('pre-tool-use', mk('**/*.ts'), env));
});
