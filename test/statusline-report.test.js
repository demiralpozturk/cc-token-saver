'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, FIXTURES, tmpDir, isolatedEnv, loadFixture, runHook } = require('./_helpers');
const { render } = require('../lib/statusline');
const state = require('../lib/state');

const STATUSLINE = path.join(ROOT, 'scripts', 'statusline.js');
const REPORT = path.join(ROOT, 'scripts', 'token-report.js');

function transcriptCopy() {
  const dir = tmpDir('ccts-sl-');
  const main = path.join(dir, 'sess-1.jsonl');
  fs.copyFileSync(path.join(FIXTURES, 'transcript-main.jsonl'), main);
  fs.mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'transcript-main', 'subagents', 'agent-a1.jsonl'), path.join(dir, 'sess-1', 'subagents', 'agent-a1.jsonl'));
  return { dir, main };
}

function run(script, args, input, env) {
  return spawnSync(process.execPath, [script, ...args], { input: input == null ? '' : JSON.stringify(input), env, encoding: 'utf8' });
}

test('render: model, context, cost, tokens and savings', () => {
  const line = render(
    { model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 42.4 }, cost: { total_cost_usd: 1.2345 } },
    { usage: { requests: 3, input: 100, cacheWrite: 900, cacheRead: 9000, output: 500 }, saved: 24100, color: false },
  );
  assert.equal(line, 'Opus 5.5 · ctx 42% · $1.23 · 11k tok (90% cached) · saved ~24k');
});

test('render: hides what is missing or switched off, colors when asked', () => {
  assert.equal(render({}, { color: false }), 'Claude');
  const opts = { showContext: false, showSaved: false };
  assert.equal(render({ model: { id: 'x' }, context_window: { used_percentage: 10 } }, { saved: 5, options: opts, color: false }), 'x');
  assert.match(render({ model: { id: 'x' }, context_window: { used_percentage: 91 } }, { color: true }), /\x1b\[31mctx 91%/);
});

test('statusline script: end to end with a transcript and recorded savings', () => {
  const { dir, main } = transcriptCopy();
  const env = isolatedEnv({ NO_COLOR: '1' });
  state.appendEvent('sess-1', { t: 'saved', kind: 'blocked-read', tokens: 18000 }, env);
  state.appendEvent('sess-1', { t: 'saved', kind: 'condensed-output', tokens: 6100 }, env);
  const input = loadFixture('statusline-input.json', { PROJECT: dir, SESSION: 'sess-1', TRANSCRIPT: main });
  const r = run(STATUSLINE, [], input, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Opus 5.5 · ctx 42% · $1.23 · 28k tok (51% cached) · saved ~24k');
  const status = state.readJson(state.statusPath('sess-1', env));
  assert.equal(status.costUsd, 1.2345);
});

test('statusline script never fails, even on garbage input', () => {
  const r = spawnSync(process.execPath, [STATUSLINE], { input: 'nope', env: isolatedEnv({ NO_COLOR: '1' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'Claude');
});

test('token report: plain text and markdown', () => {
  const { main } = transcriptCopy();
  const env = isolatedEnv();
  state.appendEvent('sess-1', { t: 'saved', kind: 'blocked-read', tokens: 18000 }, env);
  state.writeJson(state.statusPath('sess-1', env), { costUsd: 0.5 });

  const text = run(REPORT, ['--transcript', main, '--session', 'sess-1'], null, env);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /token report/);
  assert.match(text.stdout, /Requests\s+6/);
  assert.match(text.stdout, /Cost \(Claude Code estimate\)\s+\$0\.50/);
  assert.match(text.stdout, /Read\s+2\s+2k\s+45%/);
  assert.match(text.stdout, /Repeated reads: 1 file/);
  assert.match(text.stdout, /~18k tokens kept out of context \(1 blocked reads\)/);

  const md = run(REPORT, ['--transcript', main, '--session', 'sess-1', '--markdown'], null, env);
  assert.match(md.stdout, /^## cc-token-saver: token report/m);
  assert.match(md.stdout, /\| Read \| 2 \| 2k \| 45% \| 2k \|/);
});

test('token report: --json and a missing session', () => {
  const { main } = transcriptCopy();
  const env = isolatedEnv();
  const j = JSON.parse(run(REPORT, ['--transcript', main, '--json'], null, env).stdout);
  assert.equal(j.analysis.totals.requests, 6);
  const missing = run(REPORT, ['--session', 'does-not-exist'], null, env);
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /no transcript found/);
});

test('session start writes a status line shim into the plugin data dir', () => {
  const data = tmpDir('ccts-data-');
  const env = isolatedEnv({ CLAUDE_PLUGIN_DATA: data, NO_COLOR: '1' });
  const input = loadFixture('session-start.json', { SESSION: 's', PROJECT: tmpDir(), SOURCE: 'startup' });
  assert.equal(runHook('session-start', input, env).status, 0);
  const shim = path.join(data, 'statusline.js');
  assert.ok(fs.existsSync(shim));
  const r = spawnSync(process.execPath, [shim], { input: JSON.stringify({ model: { display_name: 'Sonnet' } }), env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'Sonnet');
});
