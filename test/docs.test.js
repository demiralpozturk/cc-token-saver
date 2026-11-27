'use strict';

/** Keep the README, the example config and the manual-install helper in sync with the code. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./_helpers');
const { DEFAULTS } = require('../lib/config');

const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function leafKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, prefix + k + '.'));
    else out.push({ section: prefix.replace(/\.$/, ''), key: k });
  }
  return out;
}

test('README documents every config key', () => {
  for (const { section, key } of leafKeys(DEFAULTS)) {
    assert.ok(README.includes('`' + key + '`') || README.includes(`${section}.${key}`) || README.includes(`/ \`${key}\``) || README.includes(`\`${section}.${key}\``) || new RegExp(`[\`/ ]${key}[\` /]`).test(README), `README is missing ${section ? section + '.' : ''}${key}`);
  }
});

test('README carries the unofficial notice and the creator line', () => {
  assert.match(README, /Unofficial community plugin for Claude Code\. Not affiliated with or endorsed by Anthropic\./);
  assert.match(README, /Creator: \*\*Demiralp Öztürk\*\* · \[GitHub\]\(https:\/\/github\.com\/demiralpozturk\) · \[LinkedIn\]/);
  assert.match(README, /## Türkçe/);
});

test('example config only uses known keys', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'cc-token-saver.json'), 'utf8'));
  for (const [section, values] of Object.entries(example)) {
    assert.ok(section in DEFAULTS, `unknown section ${section}`);
    for (const key of Object.keys(values)) assert.ok(key in DEFAULTS[section], `unknown key ${section}.${key}`);
  }
});

test('print-settings emits valid settings with existing script paths', () => {
  for (const flag of [[], ['--shell-form']]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'print-settings.js'), ...flag], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const json = JSON.parse(r.stdout.split('\n').filter((l) => !l.startsWith('//')).join('\n'));
    assert.deepEqual(Object.keys(json.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart']);
    const h = json.hooks.PreToolUse[0].hooks[0];
    const script = flag.length ? /node "([^"]+)"/.exec(h.command)[1] : h.args[0];
    assert.ok(fs.existsSync(script), script);
    assert.match(json.statusLine.command, /statusline\.js"$/);
  }
});
