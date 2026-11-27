'use strict';

/**
 * Condense long command output: keep the first few lines, every error-like line (with a
 * little context), a handful of distinct warnings, and the last N lines. Everything else
 * is replaced by "... N lines omitted ..." markers. The caller saves the full output to a
 * file and the header says where, so nothing is lost.
 */

const DEFAULTS = {
  minChars: 3000,
  headLines: 5,
  tailLines: 30,
  maxErrorLines: 40,
  maxWarningLines: 10,
  contextLines: 2,
  maxLineChars: 400,
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const ERROR_RE =
  /\b(?:errors?|err!|failed|failures?|failing|fatal|exception|traceback|panic(?:ked)?|segmentation fault|cannot find|could not|couldn't|unable to|not found|undefined reference|permission denied|aborted|assertionerror|expected|received)\b|✖|✗|✕|×|❌|\bFAIL\b|\bERR\b/i;
const NOT_ERROR_RE = /\b0 (?:errors?|failed|failures?)\b|\bno errors?\b|\bwithout errors?\b|\berrors?: 0\b|\bfailed: 0\b/i;
const WARN_RE = /\bwarn(?:ing)?s?\b|\bdeprecated\b|⚠/i;

/** Strip ANSI codes, resolve carriage-return progress lines, collapse identical consecutive lines. */
function clean(raw) {
  const lines = String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const noAnsi = line.replace(ANSI_RE, '');
      if (!noAnsi.includes('\r')) return noAnsi;
      const parts = noAnsi.split('\r').filter((p) => p.trim() !== '');
      return parts.length ? parts[parts.length - 1] : '';
    });
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    out.push(run > 2 && lines[i].trim() ? `${lines[i]}  [repeated ${run} times]` : lines[i]);
    if (run === 2) out.push(lines[i]);
    i = j;
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function truncate(line, max) {
  if (!max || line.length <= max) return line;
  return line.slice(0, max) + ` … [+${line.length - max} chars]`;
}

function isErrorLine(line) {
  return ERROR_RE.test(line) && !NOT_ERROR_RE.test(line);
}

/**
 * Returns null when the text is short enough to keep, otherwise
 * { text, totalLines, keptLines, errorLines, warningLines, originalChars }.
 * `opts.logFile` (optional) is mentioned in the header.
 */
function condense(raw, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const original = String(raw == null ? '' : raw);
  if (original.length < o.minChars) return null;

  const lines = clean(original);
  const n = lines.length;
  const keep = new Uint8Array(n);
  for (let i = 0; i < Math.min(o.headLines, n); i++) keep[i] = 1;
  for (let i = Math.max(0, n - o.tailLines); i < n; i++) keep[i] = 1;

  let errorLines = 0;
  let warningLines = 0;
  let errKept = 0;
  let warnKept = 0;
  const seenWarnings = new Set();
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (isErrorLine(line)) {
      errorLines++;
      if (errKept < o.maxErrorLines) {
        for (let j = i; j <= Math.min(n - 1, i + o.contextLines) && errKept < o.maxErrorLines; j++) {
          if (!keep[j]) {
            keep[j] = 1;
            errKept++;
          }
        }
      }
    } else if (WARN_RE.test(line)) {
      warningLines++;
      const shape = line.replace(/\d+/g, '#').slice(0, 160);
      if (warnKept < o.maxWarningLines && !seenWarnings.has(shape)) {
        seenWarnings.add(shape);
        if (!keep[i]) {
          keep[i] = 1;
          warnKept++;
        }
      }
    }
  }

  const body = [];
  let gap = 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) {
      gap++;
      continue;
    }
    if (gap) body.push(`… ${gap} line${gap === 1 ? '' : 's'} omitted …`);
    gap = 0;
    body.push(truncate(lines[i], o.maxLineChars));
    kept++;
  }
  if (gap) body.push(`… ${gap} line${gap === 1 ? '' : 's'} omitted …`);

  const header =
    `[cc-token-saver] Output condensed from ${n} lines (${original.length.toLocaleString('en-US')} chars) to ${kept}: ` +
    `first ${Math.min(o.headLines, n)}, last ${Math.min(o.tailLines, n)}, and ${errorLines} error-like / ${warningLines} warning lines (capped).` +
    (o.logFile ? ` Full output: ${o.logFile}` : '');
  const text = header + '\n' + body.join('\n');
  if (text.length >= original.length * 0.85) return null; // not worth it
  return { text, totalLines: n, keptLines: kept, errorLines, warningLines, originalChars: original.length };
}

module.exports = { condense, clean, isErrorLine, DEFAULTS };
