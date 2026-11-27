'use strict';

/**
 * Noisy command output (installs, builds, test runs).
 *
 * Two documented mechanisms, chosen by config.noisyCommands.strategy:
 *
 *  - "post": PostToolUse `updatedToolOutput` replaces a *successful* command's output with a
 *    condensed version. The command itself is never touched, so exit codes, the working
 *    directory and permission rules behave exactly as before. Failed commands go to
 *    PostToolUseFailure, which cannot replace output, so they are left alone.
 *
 *  - "rewrite": PreToolUse `updatedInput` wraps the command so its output goes to a log file
 *    and a condensed version is printed, for failures too. The original command runs in the
 *    current shell inside `{ ...; }` (so `cd` still carries over) and its exit status is
 *    restored with `(exit $code)`; no pipeline, so no pipefail is needed.
 *    Claude Code evaluates permission rules against the rewritten command, so in the default
 *    permission mode this can cause extra prompts. "auto" therefore rewrites only in
 *    bypassPermissions mode and uses "post" otherwise.
 *
 * Bypass for one command: add `# ccts:raw` or prefix `CCTS_RAW=1`.
 */

const fs = require('fs');
const path = require('path');
const { condense } = require('./condense');
const { splitSegments, shellWords, isShellBypassed } = require('./read-guard');
const { toPosix, estimateTokens, ensureDir } = require('./util');
const state = require('./state');

const WRAP_MARKER = '__ccts_ec';

const NOISY = [
  { name: 'package install', re: /^(?:npm|pnpm|yarn|bun|cnpm)\s+(?:install|i|ci|add|update|up|upgrade|rebuild|dedupe)\b/ },
  { name: 'package install', re: /^yarn$/ },
  { name: 'pip install', re: /^(?:python[0-9.]*\s+-m\s+)?(?:pip[0-9.]*|uv\s+pip)\s+install\b/ },
  { name: 'python deps', re: /^(?:uv\s+(?:sync|add|lock)|poetry\s+(?:install|update|lock|add)|pipenv\s+(?:install|update|sync)|pdm\s+(?:install|sync|add))\b/ },
  { name: 'conda', re: /^(?:conda|mamba|micromamba)\s+(?:install|create|update|env\s+(?:create|update))\b/ },
  { name: 'ruby/php deps', re: /^(?:bundle\s+(?:install|update)|composer\s+(?:install|update|require))\b/ },
  { name: 'cargo', re: /^cargo\s+(?:build|test|install|update|check|clippy|run)\b/ },
  { name: 'go', re: /^go\s+(?:build|test|mod\s+(?:download|tidy)|get|install|vet)\b/ },
  { name: 'jvm build', re: /^(?:\.\/)?(?:mvnw?|gradlew?)(?:\.bat|\.cmd)?\b/ },
  { name: 'dotnet', re: /^dotnet\s+(?:build|restore|test|publish)\b/ },
  { name: 'make', re: /^(?:make|ninja|cmake\s+--build|meson\s+compile)\b/ },
  { name: 'docker build', re: /^(?:docker\s+(?:build|buildx\s+build|compose\s+(?:build|pull))|docker-compose\s+(?:build|pull)|podman\s+build)\b/ },
  { name: 'system packages', re: /^(?:apt|apt-get|dnf|yum)\s+(?:install|update|upgrade)\b|^brew\s+(?:install|upgrade|update)\b/ },
  { name: 'npm script', re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|tests|test:[\w:-]+|build:[\w:-]+|e2e|ci)\b/ },
  { name: 'npm test', re: /^(?:npm|pnpm|yarn|bun)\s+t\b/ },
  { name: 'test runner', re: /^(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+(?:--yes\s+)?)?(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|pytest|py\.test|phpunit|rspec|tox|nox)\b/ },
  { name: 'test runner', re: /^python[0-9.]*\s+-m\s+(?:pytest|unittest|tox)\b/ },
  { name: 'build tool', re: /^(?:(?:npx|bunx)\s+(?:--yes\s+)?)?(?:webpack|vite\s+build|next\s+build|nuxt\s+build|turbo\s+(?:run\s+)?\S+|nx\s+(?:run|build|test|affected)|rollup|parcel\s+build|ng\s+(?:build|test)|gatsby\s+build|astro\s+build|expo\s+export|tsc\s+-b|tsc\s+--build)\b/ },
];

const PREFIX_RE = /^(?:sudo|time|nice|nohup|command|env|exec)\s+/;

/** Remove `FOO=bar`, `sudo`, `time`, ... and a leading `cd x &&` so the real command is first. */
function stripPrefixes(segment) {
  const words = shellWords(segment.replace(/^[({]\s*/, ''));
  while (words.length && (/^\w+=/.test(words[0]) || PREFIX_RE.test(words[0] + ' '))) words.shift();
  return words.join(' ');
}

/** Name of the first noisy command in `command`, or null. */
function matchNoisy(command, extraPatterns = []) {
  const extras = [];
  for (const src of extraPatterns || []) {
    try {
      extras.push({ name: 'custom', re: new RegExp(src) });
    } catch {
      /* ignore invalid user regex */
    }
  }
  for (const raw of splitSegments(String(command || ''))) {
    for (const piece of raw.split(/(?<!\|)\|(?!\|)/)) {
      const seg = stripPrefixes(piece.trim());
      if (!seg) continue;
      for (const p of NOISY.concat(extras)) if (p.re.test(seg)) return p.name;
    }
  }
  return null;
}

function withoutQuoted(command) {
  return String(command || '').replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
}

/** Claude already shaped the output (piped into tail/grep, redirected to a file, ...). */
function isAlreadyShaped(command) {
  const c = withoutQuoted(command).replace(/\d?>&\d/g, '').replace(/&>\s*\/dev\/null/g, '>x');
  return /(?:^|[^|])\|(?!\|)/.test(c) || />/.test(c) || /\bOut-File\b|\bSelect-Object\b/i.test(c);
}

/** Reasons the command must not be wrapped. */
function rewriteBlocker(command, ti) {
  if (ti && ti.run_in_background) return 'background';
  const c = withoutQuoted(command);
  if (/&\s*$/.test(c.trim())) return 'background';
  for (const seg of splitSegments(c)) {
    // `exit`/`exec` as a command would end the shell before the condensed output is printed
    if (/^[({]?\s*(?:exit|exec|logout|return)\b/.test(seg)) return 'exit';
  }
  if (/(?:^|[\s;&|])set\s+(?:-\w*e\w*|-o\s+errexit)\b/.test(c)) return 'errexit';
  if (c.includes(WRAP_MARKER)) return 'already-wrapped';
  return null;
}

function q(p) {
  return '"' + toPosix(p).replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * Wrap `command` so its output is condensed. Exit status and cwd changes are preserved:
 *   { <command>
 *   } > "<log>" 2>&1; __ccts_ec=$?; "<node>" "<condense-log.js>" "<log>" "$__ccts_ec" "<session>"; (exit $__ccts_ec)
 */
function buildRewrite(command, { nodePath, scriptPath, logFile, sessionId }) {
  return (
    `{ ${command}\n} > ${q(logFile)} 2>&1; ${WRAP_MARKER}=$?; ` +
    `${q(nodePath)} ${q(scriptPath)} ${q(logFile)} "$${WRAP_MARKER}" ${q(sessionId || 'unknown')}; ` +
    `(exit $${WRAP_MARKER})`
  );
}

function shouldRewrite(strategy, permissionMode) {
  if (strategy === 'rewrite') return true;
  if (strategy === 'auto') return permissionMode === 'bypassPermissions';
  return false;
}

/** PreToolUse(Bash): returns { updatedInput, name } or null. */
function planRewrite(input, cfg, env = process.env) {
  const nc = cfg.noisyCommands;
  if (input.tool_name !== 'Bash') return null; // PowerShell syntax differs; it uses the post strategy
  if (!shouldRewrite(nc.strategy, input.permission_mode)) return null;
  const ti = input.tool_input || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  if (!command || isShellBypassed(command) || isAlreadyShaped(command)) return null;
  if (rewriteBlocker(command, ti)) return null;
  const name = matchNoisy(command, nc.extraPatterns);
  if (!name) return null;
  const logFile = state.logPath(input.session_id, input.tool_use_id || String(Date.now()), env);
  ensureDir(path.dirname(logFile));
  const rewritten = buildRewrite(command, {
    nodePath: process.execPath,
    scriptPath: path.join(__dirname, '..', 'scripts', 'condense-log.js'),
    logFile,
    sessionId: input.session_id,
  });
  return { name, updatedInput: { ...ti, command: rewritten } };
}

/** Condense options from config, plus a log file path to mention in the header. */
function condenseOptions(nc, logFile) {
  return {
    minChars: nc.minChars,
    headLines: nc.headLines,
    tailLines: nc.tailLines,
    maxErrorLines: nc.maxErrorLines,
    maxWarningLines: nc.maxWarningLines,
    contextLines: nc.contextLines,
    maxLineChars: nc.maxLineChars,
    logFile: logFile ? toPosix(logFile) : undefined,
  };
}

/**
 * PostToolUse(Bash|PowerShell): returns { updatedToolOutput, savedTokens, name, originalChars } or null.
 * Only successful calls reach PostToolUse, so this never hides a failure's output.
 */
function planPostCondense(input, cfg, env = process.env) {
  const nc = cfg.noisyCommands;
  if (nc.strategy === 'rewrite') return null;
  const ti = input.tool_input || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  if (!command || command.includes(WRAP_MARKER)) return null;
  if (isShellBypassed(command) || isAlreadyShaped(command)) return null;
  const name = matchNoisy(command, nc.extraPatterns);
  if (!name) return null;

  const resp = input.tool_response;
  if (!resp || typeof resp !== 'object' || typeof resp.stdout !== 'string' || resp.isImage) return null;
  const stdout = resp.stdout;
  const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
  const total = stdout.length + stderr.length;
  if (total < nc.minChars) return null;
  // Above Claude Code's inline ceiling the output is already saved to a file with a short preview.
  if (nc.maxChars > 0 && total > nc.maxChars) return null;

  const logFile = state.logPath(input.session_id, input.tool_use_id || String(Date.now()), env);
  const opts = condenseOptions(nc, logFile);
  const half = { ...opts, minChars: Math.max(1, Math.floor(nc.minChars / 2)) };
  const out = condense(stdout, half);
  const err = condense(stderr, { ...half, logFile: out ? undefined : opts.logFile });
  if (!out && !err) return null;

  try {
    ensureDir(path.dirname(logFile));
    fs.writeFileSync(logFile, stdout + (stderr ? '\n--- stderr ---\n' + stderr : ''), { mode: 0o600 });
  } catch {
    return null; // without the full log on disk we do not condense
  }

  const newStdout = out ? out.text : stdout;
  const newStderr = err ? err.text : stderr;
  const cpt = cfg.charsPerToken;
  return {
    name,
    originalChars: total,
    updatedToolOutput: { ...resp, stdout: newStdout, stderr: newStderr },
    savedTokens: Math.max(0, estimateTokens(total, cpt) - estimateTokens(newStdout.length + newStderr.length, cpt)),
  };
}

module.exports = {
  NOISY,
  WRAP_MARKER,
  matchNoisy,
  stripPrefixes,
  isAlreadyShaped,
  rewriteBlocker,
  buildRewrite,
  shouldRewrite,
  planRewrite,
  planPostCondense,
  condenseOptions,
};
