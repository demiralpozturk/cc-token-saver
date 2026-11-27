# How cc-token-saver works

cc-token-saver is a set of Claude Code [hooks](https://code.claude.com/docs/en/hooks) plus a
[status line](https://code.claude.com/docs/en/statusline) script, packaged as a
[plugin](https://code.claude.com/docs/en/plugins-reference). Everything is plain Node.js with no
dependencies. This page records what the official documentation says hooks, plugins and the status
line can do, because every feature is designed around those limits.

> Unofficial community plugin for Claude Code. Not affiliated with or endorsed by Anthropic.

## 1. What the documentation allows (verified 2026-11-27, Claude Code v2.1.332)

Sources: [hooks reference](https://code.claude.com/docs/en/hooks),
[plugin manifest reference](https://code.claude.com/docs/en/plugins-reference),
[marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[status line](https://code.claude.com/docs/en/statusline),
[tools reference](https://code.claude.com/docs/en/tools-reference),
[skills](https://code.claude.com/docs/en/skills), and the
[Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

### Hook input

Every hook gets JSON on stdin with `session_id`, `transcript_path`, `cwd`, `permission_mode` and
`hook_event_name`; tool events add `tool_name`, `tool_input` and `tool_use_id`, and PostToolUse adds
`tool_response`. Subagent calls also carry `agent_id` / `agent_type`.

Relevant `tool_input` fields:

| Tool | Fields |
| --- | --- |
| `Read` | `file_path` (always absolute; backslashes on Windows), `offset`, `limit`, and since v2.1.296 `allow_large` |
| `Grep` | `pattern`, `path`, `glob`, `output_mode` (`files_with_matches` default, `content`, `count`), `head_limit`, `-i`, `multiline` |
| `Glob` | `pattern`, `path` (results are capped at 100 files) |
| `Bash` / `PowerShell` | `command`, `description`, `timeout`, `run_in_background` |

### PreToolUse can deny with a reason, rewrite the input, or add context

Output goes in `hookSpecificOutput` with `hookEventName: "PreToolUse"`:

- `permissionDecision`: `"allow"`, `"deny"`, `"ask"` or `"defer"` (`defer` only in `-p` mode).
- `permissionDecisionReason`: for `"deny"` it is **shown to Claude**, so Claude can adapt (for example
  use Grep instead).
- `updatedInput`: **replaces the whole tool input** before the tool runs. Supported for Bash. Permission
  rules are evaluated against the *rewritten* input, not the one Claude sent. Without a
  `permissionDecision` the normal permission flow still applies.
- `additionalContext`: text placed next to the tool result.

A hook that prints nothing and exits 0 makes no decision. Exit code 2 blocks with stderr as the reason;
any other non-zero exit is a non-blocking error. On Windows **without Git Bash**, a failing shell-form
PreToolUse hook can block the call, so cc-token-saver uses exec form (`"command": "node"` plus `args`,
available since v2.1.139) and always exits 0.

### PostToolUse can replace a successful tool's output

`hookSpecificOutput.updatedToolOutput` replaces what Claude sees (all tools since v2.1.121). For built-in
tools the value must match the tool's output shape: for Bash that is the object with `stdout`, `stderr`,
`interrupted`, `isImage` (cc-token-saver copies the original object and only swaps `stdout`/`stderr`). A
value with the wrong shape is ignored and the original output is used.

PostToolUse only runs for **successful** calls. A Bash command that exits non-zero fires
`PostToolUseFailure`, which can only add context, **not** replace the output.

### What Claude Code already does on its own (so we do not double count)

- **Bash output:** a successful result is inlined up to ~30,000 characters; beyond that Claude gets a
  file path plus a ~2,000-character preview. A failing result is inlined up to ~10,000 characters
  (head-and-tail excerpt).
- **Read:** one call returns at most 25,000 tokens (a `PARTIAL view` of the first page when the file is
  bigger) and refuses whole files over 256 KB.
- **Repeated reads:** Claude Code used to answer a repeat Read of an unchanged file with a short
  "file unchanged" stub. **v2.1.317 removed that stub**, so re-reading an unchanged file now costs its
  full size again.
- **Glob/Grep** are default tools on Windows; on macOS/Linux Claude usually searches with `find`/`grep`
  through Bash instead.

### Plugins

- Manifest: `.claude-plugin/plugin.json` (only `name` is required). Hooks live in `hooks/hooks.json`
  under a top-level `"hooks"` key; skills in `skills/<name>/SKILL.md` (invoked as
  `/cc-token-saver:<name>`).
- `${CLAUDE_PLUGIN_ROOT}` (install dir, changes on update) and `${CLAUDE_PLUGIN_DATA}` (persistent data
  dir, survives updates) are substituted in hook commands/args and exported to hook processes. In skill
  bodies, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_SESSION_ID}` are substituted.
- A marketplace is `.claude-plugin/marketplace.json` with `name`, `owner` and `plugins[]`; a plugin that
  lives in the same repository uses `"source": "./"`. Users run
  `/plugin marketplace add demiralpozturk/cc-token-saver` and `/plugin install cc-token-saver@cc-token-saver`.
- Plugin names starting with `claude-`, `anthropic-` or `cc-plugin-` are reserved; `cc-token-saver` is
  allowed (`claude plugin validate .` passes).
- A top-level `bin/` directory is put on the Bash tool's PATH, so this repository keeps scripts in
  `scripts/`.
- **A plugin cannot set the status line.** `statusLine` is a user/project setting, so it is a one-time
  manual step (see the README).

### Status line

The command receives JSON on stdin including `model.id`, `model.display_name`, `session_id`,
`transcript_path`, `cost.total_cost_usd` (Claude Code's client-side estimate at list price),
`cost.total_duration_ms`, and `context_window` (`used_percentage`, `total_input_tokens`,
`current_usage`, ...). It reruns after each assistant message (debounced 300 ms), supports multiple lines
and ANSI colors, and on Windows runs through Git Bash when installed (use forward slashes in the path).

### What is *not* possible with hooks

- Changing what Claude sees for a **failed** Bash command after the fact (PostToolUseFailure cannot
  replace output). Only rewriting the command up front can do that.
- Knowing whether earlier content is still in Claude's context after a rewind (Esc Esc). This is why the
  repeated-read guard blocks only once (see below).
- Installing a status line from a plugin.

## 2. How each feature uses those capabilities

### Read guard (PreToolUse: Read, Grep, Glob, Bash, PowerShell)

`lib/classify.js` decides whether a whole-file Read is wasteful, in this order: images, PDFs and notebooks
pass; `readGuard.allow` globs pass; files under `minBlockBytes` (2 KB) pass; then lockfile name, source
map name, `.min.*` name, binary extension, `readGuard.block` globs, a large file inside a build or
dependency directory, NUL bytes in the first 64 KB (binary), an average line length of 1,000+
characters (minified or generated), and finally size over `maxFileKB`.

A Read is never blocked when it has a `limit` (up to `maxRangeLines`) or `allow_large: true`. Files over
256 KB are left to Claude Code, which refuses them with a shorter message than ours (the benchmark showed
our denial would cost more than it saves there).

The denial is a `permissionDecision: "deny"` with a `permissionDecisionReason` that names the file, its
size and estimated token cost, and what to do instead. Build directories are only checked inside the
project, so a project that itself lives under `~/build/` is not flagged; outside the project only
`node_modules` counts.

The same file check runs for `cat`, `less`, `more`, `bat`, `nl`, `type` and `Get-Content` in Bash and
PowerShell commands, following `cd` within the command. Piped or redirected commands, `head`/`tail`,
`Get-Content -TotalCount` and commands marked `# ccts:raw` are left alone.

### Repeated reads (PostToolUse: Read, Edit, Write, MultiEdit, NotebookEdit; PreToolUse: Read)

PostToolUse(Read) appends `{path, offset, limit, agent, mtime, size, tokens}` to the session log.
PreToolUse(Read) denies an identical Read (same agent, path, offset and limit) when the file's mtime and
size are unchanged and the earlier result was worth at least 200 tokens. It denies **once**: a
`repeat-denied` event is logged, and the next identical attempt is allowed. This matters because a hook
cannot see whether the earlier result is still in Claude's context (for example after Esc Esc rewind).
Edits invalidate the path; SessionStart with `source: "compact"` or `"clear"` resets everything.

### Noisy command output

Commands are matched per segment (`&&`, `;`, `||`, newlines) after stripping `FOO=bar`, `sudo`, `time`
and similar prefixes. Known noisy commands: package installs (npm, pnpm, yarn, bun, pip, uv, poetry,
pipenv, conda, bundle, composer, apt, brew), builds (cargo, go, gradle, maven, dotnet, make, docker build,
next/vite/webpack/turbo/nx builds) and test runners (npm test, jest, vitest, mocha, pytest, phpunit,
rspec, playwright, cypress). Commands Claude already piped or redirected are skipped.

`lib/condense.js` strips ANSI codes, resolves carriage-return progress bars, collapses repeated lines,
then keeps the first 5 lines, every error-like line with 2 lines of context (up to 40), up to 10
distinct warnings, and the last 30 lines. The header states what was kept and where the full log is.

- **post** (default): PostToolUse `updatedToolOutput` with the original `tool_response` object and only
  `stdout`/`stderr` replaced, so the shape always matches. Only output between 3,000 and 30,000
  characters is touched; above that Claude Code already saves it to a file with a preview.
- **rewrite**: PreToolUse `updatedInput` with the command wrapped as
  `{ cmd\n} > log 2>&1; __ccts_ec=$?; node condense-log.js log $__ccts_ec session; (exit $__ccts_ec)`.
  No pipeline means no `pipefail` and an exact exit status; `{ }` instead of `( )` means `cd` carries
  over. The trailing newline before `}` keeps heredocs and trailing comments working. Not applied to
  background commands, commands with `exit`/`exec`/`set -e`, the PowerShell tool, or bypassed commands.
  `condense-log.js` prints the condensed text only when it is smaller than what Claude Code would show
  anyway (full output if successful and under 30k, a 2k preview above that, a 10k excerpt for failures).
- **auto**: rewrite only when `permission_mode` is `bypassPermissions`, because in other modes Claude
  Code checks permission rules against the rewritten command, which would cause extra prompts.

### Status line and token report

The status line reads `model`, `context_window.used_percentage` and `cost.total_cost_usd` straight
from its JSON input. Session tokens come from the transcript JSONL at `transcript_path` plus
`<session>/subagents/*.jsonl`: each assistant line has `message.id` and `message.usage`, and one API
response is written as several lines with the same id, so each id is counted once. Files are read
incrementally (byte offset cache under the state directory), so long sessions stay fast.

The token report parses the same files fully: usage totals, `tool_use` blocks (name and input) matched
to `tool_result` blocks by id, result size per tool, and for each result how many later API requests in
the same transcript re-sent it before a `compact_boundary` system line.

## 3. Token accounting

- **Exact:** API usage in the status line and the report (from the transcript).
- **Claude Code's estimate:** the cost (`cost.total_cost_usd`).
- **Our estimate (characters / 4):** tool result sizes, and "saved". For a denial, saved = what Claude
  Code would have returned (whole file with line-number prefixes, capped at 25,000 tokens) minus the
  denial reason. For condensed output, saved = original output minus condensed output. These are
  *gross* numbers: the follow-up call Claude makes after a denial is not subtracted in the status line
  (the benchmark does subtract a stated follow-up).

## 4. Known limitations

- Hooks start one `node` process per call (~60 ms median on the benchmark machine).
- The repeated-read guard cannot know about context lost to a rewind; deny-once is the compromise.
- In the default strategy, failing commands are not condensed (PostToolUseFailure cannot replace output).
- On macOS/Linux, Claude Code searches with `find`/`grep` through Bash instead of the Glob/Grep tools, so
  the Glob and Grep guards mostly matter on Windows.
- Token estimates use 4 characters per token; dense content (hashes, minified code) tokenizes worse.
