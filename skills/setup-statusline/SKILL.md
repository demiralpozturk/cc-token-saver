---
name: setup-statusline
description: Turn on the cc-token-saver status line (model, context %, session cost, session tokens, tokens saved). Plugins cannot set the status line themselves, so this edits the user's settings after confirmation.
disable-model-invocation: true
---

Plugins cannot configure the status line, so this is a one-time change to the user's own settings.

1. Take this path and replace every backslash with a forward slash:
   `${CLAUDE_PLUGIN_DATA}/statusline.js`
   cc-token-saver rewrites that small file at every session start so it always points at the
   installed plugin version, which means the setting keeps working after plugin updates.

2. Show the user the JSON they need in `~/.claude/settings.json` (their user settings), with the
   path from step 1 in place of `<PATH>`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"<PATH>\""
     }
   }
   ```

3. If `~/.claude/settings.json` already has a `statusLine`, show it and say it would be replaced.

4. Ask the user whether you should make this edit. Only edit the file if they say yes, change only
   the `statusLine` key, and keep the file valid JSON. Do not touch any other setting.

5. Tell the user the status line appears after the next reply, and that it reads like:
   `Opus 5.5 · ctx 42% · $1.23 · 1.2M tok (93% cached) · saved ~24k`
   where cost is Claude Code's own estimate and "saved" is cc-token-saver's estimate of tokens kept
   out of context.
