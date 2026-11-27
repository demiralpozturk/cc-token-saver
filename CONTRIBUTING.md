# Contributing

Thanks for helping. cc-token-saver is small on purpose: plain Node.js, no runtime dependencies, and
every hook must be safe to run on every tool call.

## Ground rules

- **Never block by accident.** `scripts/hook.js` must always exit 0. A hook only denies with a reason
  Claude can act on (Grep, `offset`/`limit`, a bypass), never silently.
- **No dependencies.** Node.js 18+ standard library only, so the plugin works straight from a git clone.
- **Cross-platform.** Paths arrive with backslashes on Windows; normalize with `lib/util.js` helpers and
  add a test with a Windows-style path.
- **Honest numbers.** If you change what is blocked or condensed, run `node benchmark/run.js` and include
  the `benchmark/RESULTS.md` diff in the pull request. Do not compare against raw file sizes: the
  baseline is what Claude Code itself would show (see docs/how-it-works.md).
- **Only documented hook behavior.** Link the section of the
  [hooks reference](https://code.claude.com/docs/en/hooks) a change relies on.

## Development

```bash
npm test                          # node --test, no install needed
node scripts/check-manifests.js   # offline manifest checks
node benchmark/run.js             # regenerate benchmark/RESULTS.md
claude plugin validate .          # if you have Claude Code installed
```

Hook scripts read JSON on stdin, so you can try one directly:

```bash
echo '{"session_id":"t","cwd":"'"$PWD"'","tool_name":"Read","tool_input":{"file_path":"'"$PWD"'/package.json"}}' \
  | node scripts/hook.js pre-tool-use
```

Fixtures for hook inputs live in `test/fixtures/` and use `{{PLACEHOLDERS}}` filled in by
`loadFixture()` in `test/_helpers.js`.

## Pull requests

- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- One topic per pull request, with tests.
- CI runs on Ubuntu and Windows with Node 20 and 22; it must pass.
