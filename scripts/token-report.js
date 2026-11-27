#!/usr/bin/env node
'use strict';

/**
 * Where did the tokens go in a Claude Code session?
 *
 *   node scripts/token-report.js                      newest session for the current directory
 *   node scripts/token-report.js --session <id>       a specific session
 *   node scripts/token-report.js --transcript <file>  a specific transcript file
 *   add --markdown for Markdown tables, --json for raw numbers
 */

const path = require('path');
const { findTranscript, transcriptFiles, analyze } = require('../lib/transcript');
const { formatReport } = require('../lib/report');
const { loadConfig } = require('../lib/config');
const state = require('../lib/state');

function parseArgs(argv) {
  const args = { markdown: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--markdown' || a === '--md') args.markdown = true;
    else if (a === '--json') args.json = true;
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--transcript') args.transcript = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  // An unsubstituted ${CLAUDE_SESSION_ID} means "no session given".
  if (args.session && /\$\{/.test(args.session)) args.session = undefined;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: token-report.js [--session <id> | --transcript <file>] [--cwd <dir>] [--markdown | --json]\n');
    return 0;
  }
  const cwd = args.cwd || process.cwd();
  const transcript = findTranscript({ transcript: args.transcript, session: args.session, cwd });
  if (!transcript) {
    process.stdout.write('cc-token-saver: no transcript found' + (args.session ? ` for session ${args.session}` : '') + '.\n');
    return 0;
  }
  const sessionId = args.session || path.basename(transcript, '.jsonl');
  const { config } = loadConfig({ cwd });
  const analysis = analyze(transcriptFiles(transcript), config.charsPerToken);
  const savings = state.summarizeSavings(state.readEvents(sessionId));
  const status = state.readJson(state.statusPath(sessionId));

  if (args.json) {
    process.stdout.write(JSON.stringify({ sessionId, transcript, analysis, savings, status }, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport({ analysis, savings, status, sessionId, transcriptPath: transcript, markdown: args.markdown }) + '\n');
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stdout.write('cc-token-saver: could not build the report: ' + (err && err.message) + '\n');
  process.exitCode = 0;
}
