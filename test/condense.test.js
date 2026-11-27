'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { condense, clean, isErrorLine } = require('../lib/condense');
const { npmInstall, pytest } = require('./_outputs');

test('short output is left alone', () => {
  assert.equal(condense('added 3 packages in 1s\n'), null);
});

test('clean strips ANSI colors, resolves progress bars and collapses repeats', () => {
  const raw = '\x1b[32mok\x1b[0m\nprogress 10%\rprogress 50%\rprogress 100%\nsame\nsame\nsame\nsame\nend\n';
  assert.deepEqual(clean(raw), ['ok', 'progress 100%', 'same  [repeated 4 times]', 'end']);
});

test('npm install: keeps the summary tail, a few distinct warnings, drops the rest', () => {
  const raw = npmInstall(200);
  const r = condense(raw, { logFile: '/tmp/x.log' });
  assert.ok(r, 'should condense');
  assert.ok(r.text.length < raw.length / 3, `expected a big reduction, got ${r.text.length} of ${raw.length}`);
  assert.match(r.text, /added 1312 packages/);
  assert.match(r.text, /found 0 vulnerabilities/);
  assert.match(r.text, /Full output: \/tmp\/x\.log/);
  assert.match(r.text, /lines omitted/);
});

test('pytest failure: error lines with context and the summary survive', () => {
  const raw = pytest(400, [17, 250]);
  const r = condense(raw);
  assert.ok(r);
  assert.match(r.text, /AssertionError: assert 17 == 18/);
  assert.match(r.text, /FAILED tests\/test_module_12\.py::test_case_250/);
  assert.match(r.text, /398 passed, 2 failed/);
  assert.ok(r.errorLines >= 4);
});

test('error detection ignores "0 errors" style summaries', () => {
  assert.equal(isErrorLine('found 0 vulnerabilities, 0 errors'), false);
  assert.equal(isErrorLine('Compiled successfully without errors'), false);
  assert.equal(isErrorLine('error TS2304: Cannot find name foo'), true);
  assert.equal(isErrorLine('npm ERR! code ERESOLVE'), true);
  assert.equal(isErrorLine(' FAIL  src/app.test.ts'), true);
});

test('very long lines are truncated with a marker', () => {
  const raw = Array.from({ length: 200 }, (_, i) => (i === 199 ? 'x'.repeat(5000) : `line ${i}`)).join('\n');
  const r = condense(raw, { maxLineChars: 100 });
  assert.ok(r);
  assert.match(r.text, /\[\+4900 chars\]/);
});

test('the error budget is capped', () => {
  const raw = Array.from({ length: 2000 }, (_, i) => `error: problem number ${i}`).join('\n');
  const r = condense(raw, { maxErrorLines: 10, tailLines: 5, headLines: 2, contextLines: 0 });
  assert.ok(r);
  assert.ok(r.keptLines <= 17, `kept ${r.keptLines}`);
  assert.equal(r.errorLines, 2000);
});
