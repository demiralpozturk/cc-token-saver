# cc-token-saver

[![CI](https://github.com/demiralpozturk/cc-token-saver/actions/workflows/ci.yml/badge.svg)](https://github.com/demiralpozturk/cc-token-saver/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Dependencies: none](https://img.shields.io/badge/dependencies-0-brightgreen)

> **Unofficial community plugin for Claude Code. Not affiliated with or endorsed by Anthropic.**

Hooks and a status line that keep wasted tokens out of your Claude Code sessions, and show what a
session costs. Plain Node.js, zero dependencies, works on Windows, macOS and Linux.

```text
cc-token-saver: `package-lock.json` is a lockfile: generated, and rarely useful to read whole
(161 KB, ~25k tokens if read). Use Grep with a specific pattern on this file (output_mode "content"),
or Read a slice with offset/limit (for example limit: 200). A Read with a `limit` is always allowed.
```

```text
Opus 5.5 · ctx 42% · $1.23 · 28k tok (51% cached) · saved ~24k
```

## What it does

| Feature | How | Hook |
| --- | --- | --- |
| **Blocks wasteful reads** | Denies reading lockfiles, minified bundles, source maps, binaries, big files in `node_modules`/`dist`/`build`/`.next`/..., and any file over 64 KB, unless the Read has a line range. The reason tells Claude to use Grep or `offset`/`limit` instead. Also covers `cat`/`less`/`Get-Content` in the shell, Grep in content mode over build output, and recursive Globs of `node_modules`. | PreToolUse |
| **Stops repeated reads** | Remembers what was read in the session (per agent). Re-reading an unchanged file with the same range is denied once; if Claude repeats the call, it goes through, so it never gets stuck. Edits invalidate, compaction resets. | PreToolUse + PostToolUse |
| **Condenses noisy output** | `npm install`, `pip install`, builds and test runners: keeps the first lines, error lines with context, a few distinct warnings and the last 30 lines. The full output is saved to a log file whose path is in the header. | PostToolUse (`updatedToolOutput`) or PreToolUse (`updatedInput`) |
| **Status line** | Model, context %, Claude Code's session cost estimate, session tokens (main + subagents, from the transcript) and tokens saved. | statusLine |
| **Token report** | `/cc-token-saver:token-report`: where tokens went, per tool, with the largest results and repeated reads. | skill + script |

Everything is configurable per user and per project, and every feature can be turned off.

## Benchmark

`node benchmark/run.js` replays tool calls through the real hook scripts. Full table and method:
[benchmark/RESULTS.md](benchmark/RESULTS.md).

**Token numbers are estimates (characters / 4), not tokenizer counts.** "Without plugin" is not the raw
file size: it applies Claude Code's own documented limits (a Read returns at most 25,000 tokens and
refuses whole files over 256 KB; Bash output over ~30,000 characters becomes a file path plus a
~2,000-character preview; failing output is cut to ~10,000 characters). "With plugin" is the deny reason
or condensed output the hooks returned, plus the narrower follow-up call Claude would make instead.

| Scenario | Without plugin | With plugin | Saved |
| --- | ---: | ---: | ---: |
| Read `package-lock.json` (161 KB) | 25,000 | 312 | 24,688 |
| Read `yarn.lock` (106 KB) | 25,000 | 292 | 24,708 |
| Read `vendor.min.js` (140 KB, one line) | 25,000 | 133 | 24,867 |
| Read `app.js.map` (200 KB) | 25,000 | 69 | 24,931 |
| Read `dist/assets/index.js` (80 KB) | 24,564 | 1,235 | 23,329 |
| Read a 120 KB generated API client | 25,000 | 337 | 24,663 |
| Re-read an unchanged 19 KB source file | 5,853 | 72 | 5,781 |
| `npm install` (success, deprecation warnings) | 3,644 | 737 | 2,907 (80%) |
| `pytest -v`, 150 tests (success) | 3,863 | 802 | 3,061 (79%) |
| `next build`, 90 routes (success) | 1,646 | 524 | 1,122 (68%) |
| `jest` with 2 failures, strategy `rewrite` | 2,500 | 589 | 1,911 (76%) |
| `cat yarn.lock` in Bash | 769 | 292 | 477 |
| Read `package-lock.json` (634 KB) | 110 | 110 | 0 |
| `pytest -v`, 320 tests (36k chars) | 550 | 550 | 0 |
| `jest` with 2 failures, default strategy | 2,500 | 2,500 | 0 |
| Control: first Read of a normal file, `git status` | unchanged | unchanged | 0 |

What the numbers mean, honestly:

- The big wins are **reads Claude should not have made**: one blocked lockfile or bundle read keeps up to
  25,000 tokens out of the context window. Those tokens would otherwise be re-sent with every later
  request in the session (as cheaper cache reads, but still).
- Condensing saves **roughly 70-80% of noisy output** that Claude Code would show in full (between ~3,000
  and ~30,000 characters). It does nothing for output Claude Code already moves to a file, and in the
  default strategy it cannot touch **failed** commands (hooks cannot replace a failure's output).
- Files over 256 KB and huge outputs show **zero savings**: Claude Code already handles those, so the
  plugin deliberately stays out of the way.
- Each denial costs one extra model request, whose input is mostly cached context. The table counts the
  follow-up call Claude makes, not that cache read.
- Hook overhead is about **60 ms per tool call** (median, one `node` process per hook, Windows 11).

How much a real session saves depends entirely on how often Claude hits these cases. Run
`/cc-token-saver:token-report` on your own sessions to see where your tokens go.

## Install

Requirements: **Claude Code v2.1.139 or later** (exec-form hooks) and **Node.js 18+** on your `PATH`.

### Plugin marketplace (recommended)

Inside Claude Code:

```text
/plugin marketplace add demiralpozturk/cc-token-saver
/plugin install cc-token-saver@cc-token-saver
```

Restart the session (or run `/reload-plugins`). The hooks are active right away. For the status line, run:

```text
/cc-token-saver:setup-statusline
```

Plugins cannot set the status line themselves, so this shows the one-time change to
`~/.claude/settings.json` and only makes it if you say yes. It points at
`${CLAUDE_PLUGIN_DATA}/statusline.js`, a tiny file the plugin refreshes at every session start, so the
setting keeps working after plugin updates.

### Manual install (settings.json hooks)

```bash
git clone https://github.com/demiralpozturk/cc-token-saver.git ~/cc-token-saver
node ~/cc-token-saver/scripts/print-settings.js
```

`print-settings.js` prints a `hooks` + `statusLine` block with the absolute paths of your checkout
filled in. Merge it into `~/.claude/settings.json` (all projects) or `<project>/.claude/settings.json`
(one project). It only prints; it never edits your settings. On Claude Code older than v2.1.139, use
`--shell-form`.

## Status line

```text
Opus 5.5 · ctx 42% · $1.23 · 28k tok (51% cached) · saved ~24k
```

| Part | Source |
| --- | --- |
| `Opus 5.5` | `model.display_name` from the status line JSON |
| `ctx 42%` | `context_window.used_percentage` (green below 50 %, yellow below 80 %, red above) |
| `$1.23` | `cost.total_cost_usd`: Claude Code's own client-side estimate at list price, which may differ from your bill |
| `28k tok (51% cached)` | Sum of `usage` over every API response in the transcript, main session plus subagents, counted once per response. "cached" is cache reads / all input tokens |
| `saved ~24k` | cc-token-saver's estimate of tokens kept out of context this session |

Already have a status line? Call `node /path/to/scripts/statusline.js` from your own script and print
its output wherever you like; it reads the same JSON on stdin.

## Token report

`/cc-token-saver:token-report` (asks once for permission to run `node`), or with zero token cost in a
terminal:

```bash
node ~/cc-token-saver/scripts/token-report.js                 # newest session for the current directory
node ~/cc-token-saver/scripts/token-report.js --session <id>  # a specific session
node ~/cc-token-saver/scripts/token-report.js --json          # raw numbers
```

It shows exact API usage (requests, uncached input, cache writes, cache reads, output), estimated
tool-result tokens per tool, how many later requests re-sent each result before a compaction, the
largest results, repeated reads, and what cc-token-saver blocked or condensed.

## Configuration

Config files are merged in this order (later wins):

1. built-in defaults ([`lib/config.js`](lib/config.js))
2. user: `~/.claude/cc-token-saver.json` (or the file in `CC_TOKEN_SAVER_CONFIG`)
3. project: `<project>/.claude/cc-token-saver.json`
4. environment variables

Example ([examples/cc-token-saver.json](examples/cc-token-saver.json)):

```json
{
  "readGuard": { "maxFileKB": 96, "allow": ["fixtures/**"], "block": ["src/generated/**"] },
  "noisyCommands": { "strategy": "auto", "tailLines": 30 },
  "statusline": { "showSaved": true }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `charsPerToken` | `4` | Used for every estimate |
| `readGuard.enabled` | `true` | Read/Grep/Glob/cat guard |
| `readGuard.maxFileKB` | `64` | Block whole-file reads above this size |
| `readGuard.minBlockBytes` | `2048` | Never block files smaller than this |
| `readGuard.maxRangeLines` | `2000` | A Read with `limit` up to this is always allowed |
| `readGuard.deferAboveKB` | `256` | Above this, let Claude Code refuse the Read itself (it is cheaper); `0` = never |
| `readGuard.lockfiles` / `minified` / `sourceMaps` / `binary` / `buildOutput` | `true` | Individual rules |
| `readGuard.buildDirs` | `node_modules`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.output`, `.parcel-cache`, `.angular`, `coverage`, `__pycache__`, `.gradle`, `target` | Build/dependency directories |
| `readGuard.buildOutputMinKB` | `16` | Files in build dirs are blocked above this size |
| `readGuard.allow` / `readGuard.block` | `[]` | Glob patterns always allowed / always blocked |
| `readGuard.grep` / `glob` / `shellCat` | `true` | Guard Grep, Glob, and `cat`-style shell commands |
| `repeatReads.enabled` | `true` | Repeated-read guard |
| `noisyCommands.enabled` | `true` | Output condensing |
| `noisyCommands.strategy` | `"auto"` | `"post"`, `"rewrite"`, or `"auto"` (rewrite only in bypassPermissions mode) |
| `noisyCommands.minChars` / `maxChars` | `3000` / `30000` | Only condense output in this range |
| `noisyCommands.headLines` / `tailLines` | `5` / `30` | Lines kept from the start / end |
| `noisyCommands.maxErrorLines` / `maxWarningLines` / `contextLines` | `40` / `10` / `2` | Error and warning budget |
| `noisyCommands.maxLineChars` | `400` | Truncate longer lines |
| `noisyCommands.extraPatterns` | `[]` | Extra regexes for noisy commands |
| `statusline.color` / `showContext` / `showTokens` / `showSaved` | `true` | Status line parts (`NO_COLOR` is respected) |

Environment variables:

| Variable | Effect |
| --- | --- |
| `CC_TOKEN_SAVER=off` | Disable everything (set it before starting Claude Code) |
| `CC_TOKEN_SAVER_DISABLE=readGuard,repeatReads` | Disable individual features |
| `CC_TOKEN_SAVER_CONFIG=/path/file.json` | Use another user config file |
| `CC_TOKEN_SAVER_STATE_DIR=/path` | Where session state and logs go (default: `<os tmp>/cc-token-saver`) |
| `CC_TOKEN_SAVER_DEBUG=1` | Print hook errors to stderr |

### The two output strategies

| Strategy | Mechanism | Failed commands | Changes the command |
| --- | --- | --- | --- |
| `post` | PostToolUse `updatedToolOutput` replaces a successful command's output | not covered (hooks cannot replace a failure's output) | no |
| `rewrite` | PreToolUse `updatedInput` wraps the command | covered | yes |
| `auto` (default) | `rewrite` in bypassPermissions mode, `post` otherwise | | |

The rewrite is:

```bash
{ npm test
} > "<log>" 2>&1; __ccts_ec=$?; "<node>" "<condense-log.js>" "<log>" "$__ccts_ec" "<session>"; (exit $__ccts_ec)
```

There is no pipeline, so no `pipefail` is needed and the exit status is exactly the command's own. The
command runs in the current shell (`{ ...; }`, not a subshell), so a `cd` still carries over to the next
command. Claude Code evaluates permission rules against the rewritten command, which is why `auto` does
not rewrite in the default permission mode.

## Bypass

| Scope | How |
| --- | --- |
| One Read | Give it a `limit` (up to 2,000 lines), or `allow_large: true` |
| One repeated Read | Repeat the same call: the second attempt is allowed |
| One shell command | Add `# ccts:raw` to it, or prefix `CCTS_RAW=1` |
| One path or pattern | `readGuard.allow` in the config |
| One feature | `"enabled": false` in the config, or `CC_TOKEN_SAVER_DISABLE=...` |
| Everything | `CC_TOKEN_SAVER=off`, or disable the plugin in `/plugin` |

You can also just tell Claude "read the whole file anyway": it will read it in ranges.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for what the hooks, plugin and status line APIs allow
(verified against the official docs), and how each feature uses them. In short:

- One script, `scripts/hook.js`, handles PreToolUse, PostToolUse and SessionStart. It always exits 0, so
  a bug in the plugin can never block a tool call; it only ever denies with a reason.
- Session state is an append-only JSON Lines log in the OS temp directory, keyed by `session_id`, so
  parallel tool calls never overwrite each other. Files older than 7 days are cleaned up.
- No network access, no telemetry. Nothing leaves your machine.

## FAQ

**Will Claude get stuck when it really needs a blocked file?**
No. Every denial tells Claude how to get what it needs (Grep, or a Read with `offset`/`limit`), a Read
with a `limit` is always allowed, and the repeated-read guard lets the second identical attempt through.

**Does it change what my commands do?**
With the default strategy, no: commands run exactly as Claude wrote them and only the output Claude sees
is condensed (and the full output is saved to a log file). The `rewrite` strategy wraps the command but
keeps its exit status and working-directory changes; the tests run the wrapper in real bash on Linux and
Windows (Git Bash) to check this.

**Why doesn't it condense failing test output by default?**
Claude Code sends failures through the `PostToolUseFailure` hook, which can add context but cannot replace
output. Only rewriting the command up front can condense a failure, and that changes what permission
rules see. Set `"strategy": "rewrite"` if you want it.

**Are the numbers exact?**
The status line token total is exact (summed from the API usage in the transcript). The cost is Claude
Code's own estimate. "Saved" and the per-tool numbers in the report are estimates at 4 characters per
token.

**Does it work with subagents?**
Yes. Hooks fire in subagents too; the repeated-read guard tracks each agent separately because each has
its own context, and the status line and report include subagent transcripts.

**Windows?**
Yes. CI runs on `windows-latest` and `ubuntu-latest`. Paths with backslashes, Git Bash paths like
`/c/Users/...` and the PowerShell tool (`Get-Content`, output condensing) are handled.

**Does Claude Code not already do this?**
Partly, and the plugin is built around that: Claude Code caps a Read at 25,000 tokens, refuses whole
files over 256 KB, and moves Bash output over ~30,000 characters to a file. The plugin covers the gap
below those limits. Claude Code used to answer repeated reads of unchanged files with a short stub, but
removed it in v2.1.317, which is why the repeated-read guard exists.

## Project structure

```text
.claude-plugin/
  plugin.json          plugin manifest
  marketplace.json     single-plugin marketplace ("source": "./")
hooks/hooks.json       PreToolUse, PostToolUse, SessionStart (exec form: node + args)
skills/
  token-report/        /cc-token-saver:token-report
  setup-statusline/    /cc-token-saver:setup-statusline
scripts/
  hook.js              entry point for every hook (always exits 0)
  statusline.js        status line command
  token-report.js      token report CLI
  condense-log.js      used by the "rewrite" strategy
  print-settings.js    manual install helper
  check-manifests.js   offline manifest checks (CI)
lib/
  config.js            defaults + user/project/env config
  state.js             per-session JSONL event log, logs, cleanup
  classify.js          lockfile / minified / source map / binary / build output detection
  read-guard.js        Read, Grep, Glob and cat guards
  repeat-reads.js      repeated-read tracking
  bash-guard.js        noisy command detection, rewrite, post condensing
  condense.js          output condenser
  transcript.js        transcript parsing (usage, tool results)
  statusline.js        status line rendering
  report.js            token report formatting
  shim.js              keeps ${CLAUDE_PLUGIN_DATA}/statusline.js current
benchmark/             reproducible benchmark (run.js, samples.js, RESULTS.md)
test/                  node:test suites and JSON hook fixtures
docs/how-it-works.md   verified capabilities and design notes
examples/              example config
```

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` (Node's
built-in test runner, no install needed) and `node benchmark/run.js` before opening a PR, and include the
benchmark diff if you change what gets blocked or condensed.

## License

[MIT](LICENSE) © Demiralp Öztürk

Creator: **Demiralp Öztürk** · [GitHub](https://github.com/demiralpozturk) · [LinkedIn](https://www.linkedin.com/in/demiralp-%C3%B6zt%C3%BCrk/)

"Claude" and "Claude Code" are trademarks of Anthropic. This project is an independent, unofficial
community plugin and is not affiliated with or endorsed by Anthropic.

---

## Türkçe

> **Claude Code için resmî olmayan bir topluluk eklentisidir. Anthropic ile bağlantılı değildir ve Anthropic tarafından onaylanmamıştır.**

cc-token-saver, Claude Code oturumlarında boşa harcanan token'ları azaltan hook'lar ve oturum maliyetini
gösteren bir durum satırıdır. Bağımlılığı olmayan saf Node.js; Windows, macOS ve Linux'ta çalışır.

**Ne yapar?**

- **Gereksiz okumaları engeller:** lockfile, minify edilmiş paket, source map, binary dosya, `node_modules`/`dist`/`build` içindeki büyük dosyalar ve 64 KB üstü dosyalar, satır aralığı (`limit`) verilmedikçe okunmaz. Claude'a Grep veya `offset`/`limit` kullanmasını söyler.
- **Tekrarlanan okumaları durdurur:** değişmemiş bir dosyanın aynı aralığını yeniden okumayı bir kez engeller; Claude ısrar ederse izin verir, yani asla takılı kalmaz.
- **Gürültülü çıktıyı kısaltır:** `npm install`, `pip install`, build ve test komutlarının çıktısında ilk satırları, hata satırlarını ve son 30 satırı tutar; tam çıktıyı bir log dosyasına kaydeder.
- **Durum satırı:** model, bağlam yüzdesi, Claude Code'un maliyet tahmini, oturum token'ları ve tasarruf.
- **Token raporu:** `/cc-token-saver:token-report` ile token'ların hangi araca gittiğini gösterir.

**Kurulum:**

```text
/plugin marketplace add demiralpozturk/cc-token-saver
/plugin install cc-token-saver@cc-token-saver
/cc-token-saver:setup-statusline
```

Manuel kurulum için depoyu klonlayıp `node scripts/print-settings.js` çıktısını `~/.claude/settings.json`
dosyanıza ekleyin. Gereksinimler: Claude Code v2.1.139+ ve Node.js 18+.

**Dürüst benchmark:** Tüm sayılar tahmindir (karakter / 4). Bir lockfile veya bundle okumasının
engellenmesi bağlama girecek 25.000 token'a kadarını önler; gürültülü komut çıktısında tasarruf yaklaşık
%70-80'dir. Claude Code'un zaten kendi sınırlarıyla yönettiği durumlarda (256 KB üstü dosyalar, 30.000
karakter üstü çıktılar, varsayılan stratejide başarısız komutlar) tasarruf sıfırdır. Ayrıntılar:
[benchmark/RESULTS.md](benchmark/RESULTS.md).

**Devre dışı bırakma:** tek komut için `# ccts:raw`, tek özellik için `CC_TOKEN_SAVER_DISABLE=readGuard`,
tamamen kapatmak için `CC_TOKEN_SAVER=off`.

Lisans: MIT · Geliştirici: **Demiralp Öztürk** · [GitHub](https://github.com/demiralpozturk) · [LinkedIn](https://www.linkedin.com/in/demiralp-%C3%B6zt%C3%BCrk/)
