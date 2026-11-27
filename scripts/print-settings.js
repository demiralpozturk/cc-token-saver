#!/usr/bin/env node
'use strict';

/**
 * Manual install helper: prints the settings.json block for this checkout (hooks + status line)
 * with absolute paths filled in. It only prints; it never edits your settings.
 *
 *   node scripts/print-settings.js               exec-form hooks (Claude Code v2.1.139+)
 *   node scripts/print-settings.js --shell-form  "node \"/path/hook.js\" event" strings for older versions
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..').replace(/\\/g, '/');
const shellForm = process.argv.includes('--shell-form');
const hooksFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));

const hooks = {};
for (const [event, groups] of Object.entries(hooksFile.hooks)) {
  hooks[event] = groups.map((g) => ({
    matcher: g.matcher,
    hooks: g.hooks.map((h) => {
      const args = (h.args || []).map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', ROOT));
      if (shellForm) return { type: 'command', command: `node "${args[0]}" ${args.slice(1).join(' ')}`.trim(), timeout: h.timeout };
      return { type: 'command', command: 'node', args, timeout: h.timeout };
    }),
  }));
}

const settings = {
  hooks,
  statusLine: { type: 'command', command: `node "${ROOT}/scripts/statusline.js"` },
};

process.stdout.write(
  '// Merge this into ~/.claude/settings.json (all projects) or <project>/.claude/settings.json.\n' +
    '// If you already have "hooks", add these entries to the existing event arrays.\n' +
    JSON.stringify(settings, null, 2) +
    '\n',
);
