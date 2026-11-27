#!/usr/bin/env node
'use strict';

/**
 * Status line command. Configure in ~/.claude/settings.json (see README):
 *   "statusLine": { "type": "command", "command": "node /path/to/cc-token-saver/scripts/statusline.js" }
 *
 * Shows model, context use, Claude Code's own session cost estimate, session tokens summed from
 * the transcript (main + subagents), and tokens kept out of context by cc-token-saver.
 */

const { readStdin, parseJson } = require('../lib/util');
const { loadConfig } = require('../lib/config');
const { render } = require('../lib/statusline');
const { sessionUsage } = require('../lib/transcript');
const state = require('../lib/state');

function main() {
  const input = parseJson(readStdin()) || {};
  let line = (input.model && input.model.display_name) || 'Claude';
  try {
    const cwd = (input.workspace && input.workspace.project_dir) || input.cwd;
    const { config } = loadConfig({ cwd, projectDir: cwd });
    const options = config.statusline || {};
    const color = options.color !== false && !process.env.NO_COLOR;
    const usage = options.showTokens === false ? null : sessionUsage(input.transcript_path);
    const saved = input.session_id ? state.summarizeSavings(state.readEvents(input.session_id)).total : 0;
    line = render(input, { usage, saved: config.enabled ? saved : 0, options, color });

    if (input.session_id) {
      // Remember Claude Code's cost estimate so the token report can show it.
      state.writeJson(state.statusPath(input.session_id), {
        costUsd: input.cost && input.cost.total_cost_usd,
        model: input.model && (input.model.display_name || input.model.id),
        transcriptPath: input.transcript_path,
        updatedAt: Date.now(),
      });
    }
  } catch {
    /* fall back to the plain model name */
  }
  process.stdout.write(line + '\n');
}

main();
