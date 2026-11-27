'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isolatedEnv, runHook, loadFixture } = require('./_helpers');
const { makeProject } = require('./_project');
const { splitSegments, shellWords, resolveShellPath } = require('../lib/read-guard');

const { root } = makeProject();
const isDeny = (r) => Boolean(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny');

function bash(command) {
  return loadFixture('pre-bash.json', { SESSION: 'sc', PROJECT: root, COMMAND: command, MODE: 'default' });
}

test('cat of a lockfile is denied with shell-friendly suggestions', () => {
  const r = runHook('pre-tool-use', bash('cat package-lock.json'), isolatedEnv());
  assert.ok(isDeny(r));
  const reason = r.json.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /grep -n/);
  assert.match(reason, /# ccts:raw/);
});

test('cat after cd and && chains is still checked', () => {
  assert.ok(isDeny(runHook('pre-tool-use', bash('cd docs && cat ../package-lock.json'), isolatedEnv())));
});

test('piped, bounded or bypassed reads are allowed', () => {
  const env = isolatedEnv();
  for (const cmd of [
    'cat package-lock.json | grep lodash',
    'head -n 40 package-lock.json',
    'cat src/app.js',
    'cat package-lock.json # ccts:raw',
    'CCTS_RAW=1 cat package-lock.json',
    'echo "cat package-lock.json"',
  ]) {
    const r = runHook('pre-tool-use', bash(cmd), env);
    assert.equal(isDeny(r), false, cmd);
  }
});

test('PowerShell Get-Content of a minified bundle is denied, -TotalCount is allowed', () => {
  const env = isolatedEnv();
  const ps = (command) => loadFixture('pre-powershell.json', { SESSION: 'ps', PROJECT: root, COMMAND: command });
  assert.ok(isDeny(runHook('pre-tool-use', ps('Get-Content public/vendor.min.js'), env)));
  assert.equal(isDeny(runHook('pre-tool-use', ps('Get-Content public/vendor.min.js -TotalCount 20'), env)), false);
});

test('segment and word splitting respect quotes', () => {
  assert.deepEqual(splitSegments('a && b; c || d\ne'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitSegments('echo "a && b"; ls'), ['echo "a && b"', 'ls']);
  assert.deepEqual(shellWords(`cat "my file.json" 'x y'`), ['cat', 'my file.json', 'x y']);
});

test('Git Bash style paths resolve to Windows drive paths', () => {
  assert.match(resolveShellPath('/c/Users/me/x.json', 'C:\\work', 'win32'), /^C:[\\/]Users[\\/]me[\\/]x\.json$/);
});
