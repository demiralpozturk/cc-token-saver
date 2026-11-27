---
name: token-report
description: Show where tokens went in this Claude Code session, broken down by tool, plus what cc-token-saver kept out of context.
disable-model-invocation: true
---

Run this command with the Bash tool (or PowerShell if Bash is unavailable):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/token-report.js" --session "${CLAUDE_SESSION_ID}" --markdown
```

Then show the user its output exactly as printed; it is already formatted as Markdown. Do not add
analysis unless the user asks for it.

If it prints "no transcript found", tell the user the transcript has not been written yet and to run
`/cc-token-saver:token-report` again after the next reply.

The same report is available outside Claude Code, at no token cost:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/token-report.js" --session ${CLAUDE_SESSION_ID}`
