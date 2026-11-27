'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FIXTURES, tmpDir, isolatedEnv } = require('./_helpers');
const { sessionUsage, analyze, transcriptFiles, findTranscript, contentTokens, describeToolInput } = require('../lib/transcript');

/** Copy the fixture transcript (main + subagent) into a temp dir so tests can append to it. */
function copyTranscript() {
  const dir = tmpDir('ccts-tr-');
  const main = path.join(dir, 'session-abc.jsonl');
  fs.copyFileSync(path.join(FIXTURES, 'transcript-main.jsonl'), main);
  fs.mkdirSync(path.join(dir, 'session-abc', 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'transcript-main', 'subagents', 'agent-a1.jsonl'), path.join(dir, 'session-abc', 'subagents', 'agent-a1.jsonl'));
  return main;
}

const EXPECTED = { requests: 6, input: 27, cacheWrite: 13700, cacheRead: 14200, output: 380 };

test('sums usage once per API response across main and subagent transcripts', () => {
  const main = copyTranscript();
  const u = sessionUsage(main, isolatedEnv());
  assert.equal(u.files, 2);
  for (const [k, v] of Object.entries(EXPECTED)) assert.equal(u[k], v, k);
});

test('usage is incremental: only new complete lines are read, results stay correct', () => {
  const main = copyTranscript();
  const env = isolatedEnv();
  sessionUsage(main, env);
  const line = (blockText) =>
    JSON.stringify({ type: 'assistant', message: { id: 'msg_6', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: blockText }], usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 } } });
  fs.appendFileSync(main, line('a') + '\n' + line('b')); // second block of the same response, no trailing newline yet
  let u = sessionUsage(main, env);
  assert.equal(u.requests, EXPECTED.requests + 1);
  assert.equal(u.output, EXPECTED.output + 7);
  fs.appendFileSync(main, '\n');
  u = sessionUsage(main, env);
  assert.equal(u.requests, EXPECTED.requests + 1, 'a repeated id is the same response');
  assert.equal(u.cacheRead, EXPECTED.cacheRead + 100);
});

test('missing transcript gives zero usage', () => {
  assert.equal(sessionUsage(path.join(tmpDir(), 'nope.jsonl'), isolatedEnv()).requests, 0);
  assert.equal(sessionUsage(undefined, isolatedEnv()).requests, 0);
});

test('analyze attributes tool results to tools and counts re-sends until compaction', () => {
  const a = analyze(transcriptFiles(copyTranscript()));
  assert.equal(a.totals.requests, EXPECTED.requests);
  assert.deepEqual(a.byTool.Read, { calls: 2, tokens: 2000, carried: 2000 });
  assert.deepEqual(a.byTool.Bash, { calls: 1, tokens: 2000, carried: 2000 });
  assert.deepEqual(a.byTool.Grep, { calls: 1, tokens: 300, carried: 300 });
  assert.deepEqual(a.byTool.Glob, { calls: 1, tokens: 100, carried: 0 });
  assert.equal(a.resultTokens, 4400);
  assert.equal(a.repeatedReads.length, 1);
  assert.equal(a.repeatedReads[0].count, 2);
  assert.equal(a.repeatedReads[0].repeatTokens, 1000);
  assert.equal(a.largest[0].tokens, 2000);
});

test('content token estimates handle strings, text blocks and images', () => {
  assert.equal(contentTokens('x'.repeat(400)), 100);
  assert.equal(contentTokens([{ type: 'text', text: 'x'.repeat(40) }, { type: 'image', source: {} }]), 10 + 1600);
});

test('tool inputs are described briefly', () => {
  assert.equal(describeToolInput('Read', { file_path: 'C:\\a\\b\\c\\d.ts', offset: 10, limit: 5 }), 'b/c/d.ts [10+5]');
  assert.equal(describeToolInput('Bash', { command: 'npm   test' }), 'npm test');
  assert.equal(describeToolInput('Grep', { pattern: 'TODO', path: '/x/src' }), 'TODO in x/src');
});

test('findTranscript by session id and by project directory slug', () => {
  const home = tmpDir('ccts-home-');
  const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  const cwd = process.platform === 'win32' ? 'C:\\work\\demo app' : '/work/demo app';
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '1234-abcd.jsonl');
  fs.writeFileSync(f, '\n');
  assert.equal(findTranscript({ session: '1234-abcd', env }), f);
  assert.equal(findTranscript({ cwd, env }), f);
  assert.equal(findTranscript({ session: 'missing', env }), null);
});
