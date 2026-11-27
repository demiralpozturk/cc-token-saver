#!/usr/bin/env node
'use strict';

/**
 * Used by the "rewrite" strategy. The wrapped command writes its output to a log file, then:
 *   node condense-log.js <logFile> <exitCode> <sessionId>
 * prints either the condensed output or, when condensing would not help, the raw output.
 * Always exits 0; the wrapper restores the command's own exit status afterwards.
 */

const fs = require('fs');
const { loadConfig } = require('../lib/config');
const { condense } = require('../lib/condense');
const { condenseOptions } = require('../lib/bash-guard');
const { estimateTokens } = require('../lib/util');
const state = require('../lib/state');

// What Claude Code would put in context without us (tools reference, "Output limits").
const INLINE_OK = 30000; // successful output inlined up to ~30k chars
const PREVIEW = 2000 + 200; // beyond that: ~2k-char preview plus a file path
const FAILURE_CAP = 10000; // failing output: ~10k-char head-and-tail excerpt
const MAX_IN_MEMORY = 32 * 1024 * 1024;

function baselineChars(length, exitCode) {
  if (exitCode === 0) return length <= INLINE_OK ? length : PREVIEW;
  return Math.min(length, FAILURE_CAP);
}

function main() {
  const [logFile, codeArg, sessionId] = process.argv.slice(2);
  const exitCode = Number.parseInt(codeArg, 10) || 0;
  let raw = '';
  try {
    if (fs.statSync(logFile).size > MAX_IN_MEMORY) {
      fs.createReadStream(logFile).pipe(process.stdout); // too big to condense in memory: pass through unchanged
      return;
    }
    raw = fs.readFileSync(logFile, 'utf8');
  } catch {
    return;
  }
  let text = raw;
  try {
    const { config } = loadConfig({ cwd: process.cwd() });
    const nc = config.noisyCommands;
    const condensed = config.enabled && nc.enabled !== false ? condense(raw, condenseOptions(nc, logFile)) : null;
    if (condensed) {
      const cpt = config.charsPerToken;
      const before = estimateTokens(baselineChars(raw.length, exitCode), cpt);
      const after = estimateTokens(condensed.text.length, cpt);
      if (after < before) {
        text = condensed.text;
        if (sessionId && sessionId !== 'unknown') {
          state.appendEvent(sessionId, {
            t: 'saved',
            kind: 'condensed-output',
            tool: 'Bash',
            tokens: before - after,
            detail: `rewrite, exit ${exitCode}, ${raw.length} chars`,
          });
        }
      }
    }
  } catch {
    text = raw;
  }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

main();
process.exitCode = 0;
