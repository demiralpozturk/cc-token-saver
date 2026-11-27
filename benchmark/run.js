#!/usr/bin/env node
'use strict';

/**
 * Reproducible benchmark: replays tool calls through the real hook scripts and compares what
 * would reach Claude's context with and without cc-token-saver.
 *
 *   node benchmark/run.js            print the table and write benchmark/RESULTS.md + results.json
 *   node benchmark/run.js --check    run everything, write nothing, exit 1 on any error (CI)
 *
 * Tokens are ESTIMATES: characters / 4. "Without plugin" follows Claude Code's documented
 * limits (tools reference, "Output limits" and "Large files"), not raw file sizes:
 *   - Read returns at most 25,000 tokens and refuses whole files over 256 KB
 *   - a successful Bash result is inlined up to ~30,000 chars, beyond that a ~2,000-char preview
 *   - a failing Bash result is cut to a ~10,000-char head-and-tail excerpt
 * "With plugin" is what the hooks actually return (deny reason or condensed output), plus a
 * stated follow-up cost when a denial would make Claude do a narrower call instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./samples');
const { estimateTokens, formatInt } = require('../lib/util');
const { buildRewrite, matchNoisy } = require('../lib/bash-guard');
const { READ_MAX_TOKENS, READ_MAX_BYTES } = require('../lib/classify');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');
const CHECK = process.argv.includes('--check');
const WORK = path.join(__dirname, '.work');
const PROJECT = path.join(WORK, 'project');
const CALL_OVERHEAD = 50; // tokens Claude spends writing one extra tool call after a denial (assumption)

function tok(chars) {
  return estimateTokens(chars, 4);
}

function write(rel, content) {
  const file = path.join(PROJECT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function env() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(CC_TOKEN_SAVER|CLAUDE_)/.test(k)) delete e[k];
  return { ...e, CC_TOKEN_SAVER_STATE_DIR: path.join(WORK, 'state'), CLAUDE_CONFIG_DIR: path.join(WORK, 'claude-config') };
}

function hook(event, input) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env: env(), encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`hook ${event} exited ${r.status}: ${r.stderr}`);
  return { json: r.stdout.trim() ? JSON.parse(r.stdout) : null, ms };
}

// ---- Claude Code baseline model (documented limits) ------------------------------------
function readBaseline(file) {
  const text = fs.readFileSync(file, 'utf8');
  const size = Buffer.byteLength(text);
  if (size > READ_MAX_BYTES) return { tokens: 60, refused: true, note: 'Claude Code refuses whole files over 256 KB' };
  const lines = text.split('\n').length;
  const t = tok(text.length + lines * 7);
  return t > READ_MAX_TOKENS ? { tokens: READ_MAX_TOKENS, note: 'Claude Code returns the first 25k tokens' } : { tokens: t, note: '' };
}

function bashBaseline(chars, success) {
  if (success) return chars <= 30000 ? { tokens: tok(chars), note: '' } : { tokens: tok(2200), note: 'Claude Code saves it to a file, 2k preview' };
  return chars <= 10000 ? { tokens: tok(chars), note: '' } : { tokens: tok(10000), note: 'Claude Code keeps a 10k-char excerpt' };
}

// ---- Inputs ------------------------------------------------------------------------------
let n = 0;
const sid = () => `bench-${++n}`;
const base = (session) => ({ session_id: session, transcript_path: path.join(WORK, 't.jsonl'), cwd: PROJECT, permission_mode: 'default' });
const readInput = (session, file, extra = {}) => ({ ...base(session), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file, ...extra }, tool_use_id: 'toolu_' + n });
const bashPre = (session, command, mode = 'default') => ({ ...base(session), permission_mode: mode, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'bench' }, tool_use_id: 'toolu_' + n });
const bashPost = (session, command, stdout) => ({ ...base(session), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command, description: 'bench' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, tool_use_id: 'toolu_bench_' + n });

/** Lines a Grep for `pattern` with `after` lines of context would return (Grep content format). */
function grepCost(file, pattern, after) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (l.includes(pattern)) for (let j = i; j <= Math.min(lines.length - 1, i + after); j++) out.push(`${file}:${j + 1}:${lines[j]}`);
  });
  return tok(out.join('\n').length) + CALL_OVERHEAD;
}

function sliceCost(file, count) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, count);
  return tok(lines.join('\n').length + lines.length * 7) + CALL_OVERHEAD;
}

// ---- Scenarios ---------------------------------------------------------------------------
function readScenario({ id, title, file, followUp, followNote }) {
  return () => {
    const b = readBaseline(file);
    const r = hook('pre-tool-use', readInput(sid(), file));
    const reason = r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason;
    // After Claude Code's own refusal Claude makes the same narrower follow-up call, so count it on both sides.
    const without = b.tokens + (b.refused ? followUp() : 0);
    const withPlugin = reason ? tok(reason.length) + followUp() : without;
    const fuNote = reason || b.refused ? followNote : '';
    return { id, title, without, withPlugin, action: reason ? 'denied' : 'allowed', note: [b.note, fuNote].filter(Boolean).join('; '), ms: r.ms };
  };
}

function bashPostScenario({ id, title, command, output, success = true, note = '' }) {
  return () => {
    const b = bashBaseline(output.length, success);
    if (!success) {
      // Failures fire PostToolUseFailure, which cannot replace output: the post strategy leaves them alone.
      return { id, title, without: b.tokens, withPlugin: b.tokens, action: 'untouched', note: [b.note, note].filter(Boolean).join('; '), ms: 0 };
    }
    const r = hook('post-tool-use', bashPost(sid(), command, output));
    const u = r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.updatedToolOutput;
    const withPlugin = u ? tok(u.stdout.length + u.stderr.length) : b.tokens;
    return { id, title, without: b.tokens, withPlugin, action: u ? 'condensed' : 'untouched', note: [b.note, note].filter(Boolean).join('; '), ms: r.ms };
  };
}

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (fs.existsSync(p)) return p;
  return null;
}

function rewriteScenario({ id, title, command, outputFile, exitCode }) {
  return () => {
    const output = fs.readFileSync(outputFile, 'utf8');
    const b = bashBaseline(output.length, exitCode === 0);
    const pre = hook('pre-tool-use', bashPre(sid(), command, 'bypassPermissions'));
    if (!(pre.json && pre.json.hookSpecificOutput && pre.json.hookSpecificOutput.updatedInput)) throw new Error(`${id}: expected a rewrite`);
    const bash = findBash();
    if (!bash) return { id, title, without: b.tokens, withPlugin: null, action: 'skipped (no bash)', note: '', ms: pre.ms };
    // Same wrapper the hook produced, with the real command swapped for one that replays the sample output.
    const replay = `"${process.execPath.replace(/\\/g, '/')}" -e 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(${exitCode})' "${outputFile.replace(/\\/g, '/')}"`;
    const wrapped = buildRewrite(replay, { nodePath: process.execPath, scriptPath: path.join(ROOT, 'scripts', 'condense-log.js'), logFile: path.join(WORK, 'logs', id + '.log'), sessionId: 'bench-rewrite' });
    fs.mkdirSync(path.join(WORK, 'logs'), { recursive: true });
    const r = spawnSync(bash, ['-c', wrapped], { cwd: PROJECT, env: env(), encoding: 'utf8' });
    if (r.status !== exitCode) throw new Error(`${id}: exit code ${r.status}, expected ${exitCode}`);
    return { id, title, without: b.tokens, withPlugin: tok(r.stdout.length), action: `rewritten (exit ${r.status} kept)`, note: b.note, ms: pre.ms };
  };
}

function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });

  const lock150 = write('package-lock.json', S.packageLock(420, 11));
  const lock600 = write('legacy/package-lock.json', S.packageLock(1700, 12));
  const yarn = write('web/yarn.lock', S.yarnLock(330, 13));
  const vendor = write('public/vendor.min.js', S.minifiedBundle(140 * 1024, 14));
  const map = write('public/app.js.map', S.sourceMap(200 * 1024, 15));
  const dist = write('dist/assets/index.js', S.generatedCode(80 * 1024, 16));
  const gen = write('src/api/generated.ts', S.generatedCode(120 * 1024, 17));
  const routes = write('src/routes.ts', S.sourceFile(520, 18));
  const jestOut = write('../jest-output.txt', S.jestFailing(60, 19));
  const pytestOut = S.pytestVerbose(320, 20);
  const npmOut = S.npmInstallOutput(21);
  const nextOut = S.nextBuild(90, 22);
  const lockPkg = Object.keys(JSON.parse(fs.readFileSync(lock150, 'utf8')).packages)[25];
  const yarnPkg = fs
    .readFileSync(yarn, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('"'))[25]
    .replace(/:$/, '');
  const genFns = [...fs.readFileSync(gen, 'utf8').matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  const genFn = genFns[Math.floor(genFns.length / 2)];

  const scenarios = [
    readScenario({ id: 'lockfile', title: `Read package-lock.json (${Math.round(fs.statSync(lock150).size / 1024)} KB)`, file: lock150, followUp: () => grepCost(lock150, `"${lockPkg}"`, 4), followNote: 'follow-up: Grep one package (-A 4)' }),
    readScenario({ id: 'lockfile-huge', title: `Read package-lock.json (${Math.round(fs.statSync(lock600).size / 1024)} KB)`, file: lock600, followUp: () => grepCost(lock600, `"${lockPkg}"`, 4), followNote: 'follow-up: Grep one package' }),
    readScenario({ id: 'yarn-lock', title: `Read yarn.lock (${Math.round(fs.statSync(yarn).size / 1024)} KB)`, file: yarn, followUp: () => grepCost(yarn, yarnPkg, 3), followNote: 'follow-up: Grep one entry (-A 3)' }),
    readScenario({ id: 'minified', title: 'Read vendor.min.js (140 KB, one line)', file: vendor, followUp: () => CALL_OVERHEAD + 20, followNote: 'follow-up: Grep count for an identifier' }),
    readScenario({ id: 'sourcemap', title: 'Read app.js.map (200 KB)', file: map, followUp: () => 0, followNote: 'Claude reads the real source instead, which it needed anyway' }),
    readScenario({ id: 'dist', title: 'Read dist/assets/index.js (80 KB build output)', file: dist, followUp: () => sliceCost(routes, 100), followNote: 'follow-up: 100-line Read of a source file' }),
    readScenario({ id: 'large', title: 'Read src/api/generated.ts (120 KB)', file: gen, followUp: () => grepCost(gen, `function ${genFn}(`, 5), followNote: 'follow-up: Grep one function (-A 5)' }),
    () => {
      // Read once (allowed, recorded), then the same Read again while the file is unchanged.
      const session = sid();
      const content = fs.readFileSync(routes, 'utf8');
      hook('post-tool-use', { ...base(session), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: routes }, tool_response: { type: 'text', file: { filePath: routes, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } } });
      const b = readBaseline(routes);
      const r = hook('pre-tool-use', readInput(session, routes));
      const reason = r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason;
      return { id: 'repeat-read', title: `Re-read unchanged src/routes.ts (${Math.round(fs.statSync(routes).size / 1024)} KB)`, without: b.tokens, withPlugin: reason ? tok(reason.length) : b.tokens, action: reason ? 'denied once' : 'allowed', note: 'since Claude Code v2.1.317 a repeat read costs the full file again', ms: r.ms };
    },
    () => {
      const out = fs.readFileSync(yarn, 'utf8');
      const b = bashBaseline(out.length, true);
      const r = hook('pre-tool-use', bashPre(sid(), 'cat web/yarn.lock'));
      const reason = r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecisionReason;
      return { id: 'cat-lock', title: 'Bash: cat web/yarn.lock', without: b.tokens + grepCost(yarn, yarnPkg, 3), withPlugin: reason ? tok(reason.length) + grepCost(yarn, yarnPkg, 3) : b.tokens + grepCost(yarn, yarnPkg, 3), action: reason ? 'denied' : 'allowed', note: b.note + '; follow-up on both sides: grep one entry (-A 3)', ms: r.ms };
    },
    bashPostScenario({ id: 'npm-install', title: 'npm install (success, deprecation warnings)', command: 'npm install', output: npmOut }),
    bashPostScenario({ id: 'pytest', title: 'pytest -v (success, 150 tests)', command: 'python -m pytest -v', output: S.pytestVerbose(150, 23) }),
    bashPostScenario({ id: 'pytest-big', title: 'pytest -v (success, 320 tests)', command: 'python -m pytest -v', output: pytestOut }),
    bashPostScenario({ id: 'next-build', title: 'next build (success, 90 routes)', command: 'npx next build', output: nextOut }),
    bashPostScenario({ id: 'jest-post', title: 'jest, 2 failures (exit 1), strategy "post"', command: 'npx jest', output: fs.readFileSync(jestOut, 'utf8'), success: false, note: 'PostToolUseFailure cannot replace output' }),
    rewriteScenario({ id: 'jest-rewrite', title: 'jest, 2 failures (exit 1), strategy "rewrite"', command: 'npx jest', outputFile: jestOut, exitCode: 1 }),
    readScenario({ id: 'control-read', title: 'Control: first Read of src/routes.ts', file: routes, followUp: () => 0, followNote: '' }),
    bashPostScenario({ id: 'control-git', title: 'Control: git status (short output)', command: 'git status', output: 'On branch main\nnothing to commit, working tree clean\n' }),
  ];

  const rows = [];
  for (const s of scenarios) rows.push(s());
  if (!matchNoisy('npx jest')) throw new Error('npx jest should be noisy');

  // Hook latency: median of 15 PreToolUse runs on an ordinary Read.
  const times = [];
  for (let i = 0; i < 15; i++) times.push(hook('pre-tool-use', readInput(sid(), routes)).ms);
  times.sort((a, b) => a - b);
  const latency = Math.round(times[7]);

  return { rows, latency };
}

function pct(a, b) {
  if (!a) return '0%';
  return Math.round(((a - b) / a) * 100) + '%';
}

function markdown({ rows, latency }) {
  const lines = [];
  lines.push('| Scenario | Without plugin | With plugin | Saved | What happened |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  let w = 0;
  let p = 0;
  for (const r of rows) {
    const withP = r.withPlugin == null ? 'n/a' : formatInt(r.withPlugin);
    const saved = r.withPlugin == null ? 'n/a' : `${formatInt(r.without - r.withPlugin)} (${pct(r.without, r.withPlugin)})`;
    lines.push(`| ${r.title} | ${formatInt(r.without)} | ${withP} | ${saved} | ${r.action}${r.note ? ' – ' + r.note : ''} |`);
    if (r.withPlugin != null) {
      w += r.without;
      p += r.withPlugin;
    }
  }
  lines.push(`| Sum of the rows above (not a typical session) | ${formatInt(w)} | ${formatInt(p)} | ${formatInt(w - p)} | |`);
  return { table: lines.join('\n'), latency, totalWithout: w, totalWith: p };
}

const result = main();
const md = markdown(result);
const meta = `Node ${process.version}, ${os.platform()} ${os.arch()}, ${new Date().toISOString().slice(0, 10)}`;

if (CHECK) {
  process.stdout.write(md.table + `\n\nHook latency (median, PreToolUse on a normal Read): ${md.latency} ms\n`);
} else {
  const doc = [
    '# Benchmark results',
    '',
    `Generated by \`node benchmark/run.js\` (${meta}). Re-run it to reproduce; numbers move by a few tokens between machines because file paths appear in the messages.`,
    '',
    '**All token numbers are estimates: characters / 4.** Real tokenization differs: dense content such as the base64 hashes in lockfiles needs more tokens per character than prose, while rows at 25,000 hit the Claude Code Read limit either way. Treat every number as an order of magnitude, not an exact count.',
    '',
    '"Without plugin" is what Claude Code itself would put into context, using its documented limits: a Read returns at most 25,000 tokens and refuses whole files over 256 KB; a successful Bash result over ~30,000 chars becomes a file path plus a ~2,000-char preview; a failing one is cut to a ~10,000-char excerpt. "With plugin" is the deny reason or condensed output the hooks actually returned, plus the follow-up call Claude would likely make instead (stated per row, with 50 tokens for writing the extra tool call).',
    '',
    md.table,
    '',
    `Hook overhead: median ${md.latency} ms per PreToolUse call on this machine (one \`node\` process per hook).`,
    '',
    'Inputs are synthetic but shaped like the real thing (`benchmark/samples.js`): npm lockfile v3, yarn v1 lockfile, minified bundle, source map, generated API client, npm install with deprecation warnings, `pytest -v`, `jest` with two failures, `next build`.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'RESULTS.md'), doc);
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ meta, ...result }, null, 2) + '\n');
  process.stdout.write(md.table + `\n\nHook latency: ${md.latency} ms (median)\nWrote benchmark/RESULTS.md and benchmark/results.json\n`);
}
