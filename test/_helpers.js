'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');
const FIXTURES = path.join(__dirname, 'fixtures');

function tmpDir(prefix = 'ccts-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Isolated environment: own state dir, own user config dir, no inherited plugin env. */
function isolatedEnv(extra = {}) {
  const home = tmpDir('ccts-home-');
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CC_TOKEN_SAVER|CLAUDE_)/.test(k)) delete env[k];
  }
  return {
    ...env,
    CC_TOKEN_SAVER_STATE_DIR: path.join(home, 'state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ...extra,
  };
}

function runHook(event, input, env, script = HOOK) {
  const res = spawnSync(process.execPath, [script, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env,
    encoding: 'utf8',
  });
  let json = null;
  if (res.stdout && res.stdout.trim()) json = JSON.parse(res.stdout);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/** Load a JSON fixture and replace {{TOKENS}} with values (paths are JSON-escaped). */
function loadFixture(name, vars = {}) {
  let text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    const escaped = JSON.stringify(String(v)).slice(1, -1);
    text = text.split('{{' + k + '}}').join(escaped);
  }
  return JSON.parse(text);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

module.exports = { ROOT, HOOK, FIXTURES, tmpDir, isolatedEnv, runHook, loadFixture, writeFile };
