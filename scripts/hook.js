#!/usr/bin/env node
'use strict';

/**
 * Single entry point for every cc-token-saver hook:
 *   node scripts/hook.js pre-tool-use | post-tool-use | session-start
 *
 * Reads the hook input JSON from stdin and prints at most one JSON object.
 * It always exits 0: a bug in this plugin must never block a tool call.
 */

const { readStdin, parseJson } = require('../lib/util');
const { run } = require('../lib/hooks');

const event = process.argv[2] || '';
let output = null;

try {
  const input = parseJson(readStdin());
  if (input) output = run(event, input, { env: process.env });
} catch (err) {
  if (process.env.CC_TOKEN_SAVER_DEBUG) process.stderr.write(String((err && err.stack) || err) + '\n');
  output = null;
}

if (output) process.stdout.write(JSON.stringify(output));
process.exitCode = 0;
