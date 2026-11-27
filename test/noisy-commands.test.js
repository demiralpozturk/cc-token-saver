'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isolatedEnv, runHook, loadFixture, tmpDir, writeFile, ROOT } = require('./_helpers');
const { npmInstall, pytest } = require('./_outputs');
const bg = require('../lib/bash-guard');
const state = require('../lib/state');

const project = tmpDir('ccts-noisy-');

function postBash(command, stdout, stderr = '', session = 'nb-' + Math.random().toString(36).slice(2)) {
  return loadFixture('post-bash.json', { SESSION: session, PROJECT: project, COMMAND: command, STDOUT: stdout, STDERR: stderr });
}

function preBash(command, mode = 'default', extra = {}) {
  const input = loadFixture('pre-bash.json', { SESSION: 'pb', PROJECT: project, COMMAND: command, MODE: mode });
  Object.assign(input.tool_input, extra);
  return input;
}

test('recognizes noisy installs, builds and test runs', () => {
  for (const cmd of [
    'npm install',
    'npm i lodash',
    'npm ci --no-audit',
    'pnpm install --frozen-lockfile',
    'yarn',
    'cd web && yarn install',
    'pip install -r requirements.txt',
    'python3 -m pip install -e .',
    'uv sync',
    'poetry install',
    'cargo build --release',
    'go test ./...',
    './gradlew build',
    'mvn -q package',
    'dotnet test',
    'docker build -t app .',
    'npm run build',
    'npm test',
    'npm t',
    'yarn test:unit',
    'npx jest --ci',
    'pytest -q',
    'python -m pytest tests/',
    'vitest run',
    'NODE_ENV=test npx vitest run',
    'sudo apt-get install -y curl',
    'npx next build',
    'make -j8',
  ]) {
    assert.ok(bg.matchNoisy(cmd), cmd);
  }
});

test('leaves ordinary commands alone', () => {
  for (const cmd of ['ls -la', 'git status', 'npm --version', 'node script.js', 'cat README.md', 'npm view react version', 'echo "npm install"', 'grep -r install .']) {
    assert.equal(bg.matchNoisy(cmd), null, cmd);
  }
});

test('custom patterns from config are honoured', () => {
  assert.ok(bg.matchNoisy('./scripts/bootstrap.sh --all', ['^\\./scripts/bootstrap\\.sh']));
  assert.equal(bg.matchNoisy('ls', ['([invalid']), null, 'invalid regex is ignored');
});

test('detects output Claude already shaped', () => {
  assert.equal(bg.isAlreadyShaped('npm install 2>&1'), false);
  assert.equal(bg.isAlreadyShaped('npm test 2>&1 | tail -40'), true);
  assert.equal(bg.isAlreadyShaped('npm install > /tmp/log.txt'), true);
  assert.equal(bg.isAlreadyShaped('npm install && npm test || echo failed'), false);
  assert.equal(bg.isAlreadyShaped('echo "a | b" && npm install'), false);
});

test('post strategy: condenses a successful noisy command, keeps the output shape', () => {
  const env = isolatedEnv();
  const stdout = npmInstall(200);
  const input = postBash('npm install', stdout);
  const r = runHook('post-tool-use', input, env);
  assert.equal(r.status, 0);
  const out = r.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  const u = out.updatedToolOutput;
  assert.deepEqual(Object.keys(u).sort(), ['interrupted', 'isImage', 'noOutputExpected', 'stderr', 'stdout']);
  assert.equal(u.interrupted, false);
  assert.ok(u.stdout.length < stdout.length / 3);
  assert.match(u.stdout, /added 1312 packages/);
  const logFile = /Full output: (.+)$/m.exec(u.stdout)[1];
  assert.equal(fs.readFileSync(logFile, 'utf8').trim(), stdout.trim(), 'full output is kept on disk');
  const saved = state.readEvents(input.session_id, env).filter((e) => e.t === 'saved');
  assert.equal(saved[0].kind, 'condensed-output');
  assert.ok(saved[0].tokens > 1000);
});

test('post strategy: noisy output on stderr is condensed too', () => {
  const r = runHook('post-tool-use', postBash('npm ci', 'added 1 package\n', npmInstall(150)), isolatedEnv());
  const u = r.json.hookSpecificOutput.updatedToolOutput;
  assert.equal(u.stdout, 'added 1 package\n');
  assert.match(u.stderr, /Output condensed/);
});

test('post strategy: skips short output, non-noisy commands, bypass markers and huge output', () => {
  const env = isolatedEnv();
  const none = (input) => assert.equal(runHook('post-tool-use', input, env).stdout, '');
  none(postBash('npm install', 'added 2 packages in 1s\n'));
  none(postBash('node build-report.js', npmInstall(200)));
  none(postBash('npm install # ccts:raw', npmInstall(200)));
  none(postBash('CCTS_RAW=1 npm install', npmInstall(200)));
  none(postBash('npm test 2>&1 | tail -50', pytest(400)));
  none(postBash('npm install', npmInstall(1000)), 'over maxChars: Claude Code already offloads it to a file');
});

test('post strategy is a no-op when the strategy is "rewrite"', () => {
  const p = tmpDir('ccts-rw-');
  writeFile(path.join(p, '.claude', 'cc-token-saver.json'), JSON.stringify({ noisyCommands: { strategy: 'rewrite' } }));
  const input = loadFixture('post-bash.json', { SESSION: 's', PROJECT: p, COMMAND: 'npm install', STDOUT: npmInstall(200), STDERR: '' });
  assert.equal(runHook('post-tool-use', input, isolatedEnv()).stdout, '');
});

test('failed commands (PostToolUseFailure) are never touched', () => {
  const input = loadFixture('post-bash-failure.json', { SESSION: 's', PROJECT: project });
  assert.equal(runHook('post-tool-use-failure', input, isolatedEnv()).stdout, '');
});

test('auto strategy does not rewrite in the default permission mode', () => {
  assert.equal(runHook('pre-tool-use', preBash('npm install'), isolatedEnv()).stdout, '');
});

test('auto strategy rewrites in bypassPermissions mode and keeps the other input fields', () => {
  const r = runHook('pre-tool-use', preBash('npm install', 'bypassPermissions', { timeout: 300000 }), isolatedEnv());
  const out = r.json.hookSpecificOutput;
  assert.equal(out.permissionDecision, undefined, 'never auto-approves');
  assert.equal(out.updatedInput.description, 'Run a command');
  assert.equal(out.updatedInput.timeout, 300000);
  assert.match(out.updatedInput.command, /^\{ npm install\n\} > ".+" 2>&1; __ccts_ec=\$\?; ".+" ".+condense-log\.js" ".+" "\$__ccts_ec" "pb"; \(exit \$__ccts_ec\)$/);
});

test('rewrite is skipped for background, piped, exit/errexit and bypassed commands', () => {
  const env = isolatedEnv();
  const none = (input) => assert.equal(runHook('pre-tool-use', input, env).stdout, '', input.tool_input.command);
  none(preBash('npm install', 'bypassPermissions', { run_in_background: true }));
  none(preBash('npm run build &', 'bypassPermissions'));
  none(preBash('npm test | tail -20', 'bypassPermissions'));
  none(preBash('npm test || exit 1', 'bypassPermissions'));
  none(preBash('set -e; npm ci', 'bypassPermissions'));
  none(preBash('npm install # ccts:raw', 'bypassPermissions'));
  none(preBash('ls -la', 'bypassPermissions'));
  assert.equal(bg.rewriteBlocker('npx mocha --exit', {}), null, '--exit flag is not the exit builtin');
});

test('project config strategy "post" disables rewriting even in bypassPermissions mode', () => {
  const p = tmpDir('ccts-post-');
  writeFile(path.join(p, '.claude', 'cc-token-saver.json'), JSON.stringify({ noisyCommands: { strategy: 'post' } }));
  const input = loadFixture('pre-bash.json', { SESSION: 's', PROJECT: p, COMMAND: 'npm install', MODE: 'bypassPermissions' });
  assert.equal(runHook('pre-tool-use', input, isolatedEnv()).stdout, '');
});

// --- The rewritten command, executed for real -------------------------------------------

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const BASH = findBash();

function runWrapped(command, { cwd = project, env = isolatedEnv(), after = '' } = {}) {
  const logFile = path.join(tmpDir('ccts-log-'), 'out.log');
  const wrapped = bg.buildRewrite(command, {
    nodePath: process.execPath,
    scriptPath: path.join(ROOT, 'scripts', 'condense-log.js'),
    logFile,
    sessionId: 'e2e',
  });
  const res = spawnSync(BASH, ['-c', wrapped + after], { cwd, env, encoding: 'utf8' });
  return { ...res, logFile };
}

function nodeEval(js) {
  // A node -e command that works the same in Git Bash and Linux bash.
  return `"${process.execPath.replace(/\\/g, '/')}" -e '${js}'`;
}

test('rewritten command preserves a failing exit code and condenses its output', { skip: !BASH && 'bash not found' }, () => {
  const js = 'for (let i = 0; i < 3000; i++) console.log("noise line " + i); console.error("Error: boom at step 7"); process.exit(3)';
  const r = runWrapped(nodeEval(js));
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /\[cc-token-saver\] Output condensed/);
  assert.match(r.stdout, /Error: boom at step 7/);
  assert.match(r.stdout, /noise line 2999/);
  assert.ok(r.stdout.length < 6000, `condensed output is ${r.stdout.length} chars`);
  assert.match(fs.readFileSync(r.logFile, 'utf8'), /noise line 1500/, 'full log kept');
});

test('rewritten command keeps exit code 0 and prints short output unchanged', { skip: !BASH && 'bash not found' }, () => {
  const r = runWrapped(nodeEval('console.log("all good")'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'all good\n');
});

test('a cd inside the rewritten command still carries over (no subshell)', { skip: !BASH && 'bash not found' }, () => {
  const sub = path.join(project, 'sub dir');
  fs.mkdirSync(sub, { recursive: true });
  const r = runWrapped(`cd "sub dir" && ${nodeEval('console.log(1)')}`, { after: '; pwd' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim().split('\n').pop(), /sub dir$/);
});

test('heredocs and comments survive the wrapper', { skip: !BASH && 'bash not found' }, () => {
  const r = runWrapped('cat <<EOF\nhello from heredoc\nEOF\n# trailing comment');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hello from heredoc\n');
});
