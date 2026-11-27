# Changelog

## 0.1.0 (unreleased)

- Read guard: blocks whole-file reads of lockfiles, minified bundles, source maps, binaries, large files in
  build/dependency directories and files over 64 KB unless a line range is given; also Grep content mode
  over build output, recursive Globs of `node_modules`, and `cat`/`Get-Content` of the same files.
  Leaves reads over 256 KB to Claude Code, which refuses them more cheaply.
- Repeated-read guard: denies an identical re-read of an unchanged file once, per agent; edits
  invalidate, compaction resets.
- Noisy command output: condenses install/build/test output via PostToolUse `updatedToolOutput`
  (default) or a command rewrite that keeps the exit status and `cd` (bypassPermissions mode or
  `"strategy": "rewrite"`). Full output is kept in a log file.
- Status line: model, context %, cost estimate, session tokens (main + subagents), tokens saved.
- Token report: `/cc-token-saver:token-report` and `scripts/token-report.js`.
- Reproducible benchmark (`node benchmark/run.js`).
