'use strict';

/**
 * PreToolUse guards for Read, Grep, Glob and `cat`-style shell commands.
 * Each evaluate* function returns null (allow) or
 * { reason, category, savedTokens, detail } for a deny.
 */

const fs = require('fs');
const path = require('path');
const { classifyFile, estimateReadTokens, buildDirOf, MINIFIED_NAME_RE, SOURCEMAP_RE } = require('./classify');
const { estimateTokens, formatBytes, formatTokens, toPosix, basename, relativeInside } = require('./util');

const SIGNATURE = 'cc-token-saver';

function displayPath(file, projectDir) {
  const rel = projectDir ? relativeInside(file, projectDir) : null;
  return rel ? rel : toPosix(file);
}

function describe(category, info) {
  switch (category) {
    case 'lockfile':
      return 'is a lockfile: generated, and rarely useful to read whole';
    case 'sourcemap':
      return 'is a source map, generated from the real source';
    case 'minified':
      return info.avgLineLength
        ? `looks minified or generated: average line ${info.avgLineLength.toLocaleString('en-US')} characters`
        : 'is a minified bundle';
    case 'build-output':
      return `is inside the build/dependency directory \`${info.dir}/\``;
    case 'binary':
      return 'is a binary file; its bytes are not useful as text';
    case 'blocked-pattern':
      return 'matches a block pattern in the cc-token-saver config';
    case 'large':
      return 'is large';
    default:
      return 'is not worth reading whole';
  }
}

function suggestion(category, via) {
  if (category === 'binary') {
    return via === 'shell'
      ? 'Inspect it with a dedicated tool (for example `file`, or `xxd <file> | head`).'
      : 'Inspect it with a dedicated tool through the shell (for example `file`), not Read.';
  }
  if (category === 'sourcemap' || category === 'minified') {
    return via === 'shell'
      ? 'Read the original source file instead, or search this one with `grep -o` for a specific identifier.'
      : 'Read the original source file instead, or Grep this one for a specific identifier (output_mode "count" or a head_limit).';
  }
  const source = category === 'build-output' ? 'Prefer the original source file. ' : '';
  if (via === 'shell') {
    return `${source}Search it with \`grep -n <pattern> <file>\` or print a slice with \`sed -n '1,80p' <file>\` / \`head -n 80 <file>\`.`;
  }
  return `${source}Use Grep with a specific pattern on this file (output_mode "content"), or Read a slice with offset/limit (for example limit: 200).`;
}

function buildReason({ file, size, category, info, baselineTokens, via, projectDir }) {
  const shown = displayPath(file, projectDir);
  const cost = baselineTokens >= 1000 ? `, ~${formatTokens(baselineTokens)} tokens if read` : '';
  return (
    `${SIGNATURE}: \`${shown}\` ${describe(category, info)} (${formatBytes(size)}${cost}). ` +
    `${suggestion(category, via)} ` +
    (via === 'shell'
      ? 'To bypass this check once, add `# ccts:raw` to the command.'
      : 'A Read with a `limit` is always allowed.')
  );
}

function isBoundedRead(ti, rg) {
  const limit = Number(ti.limit);
  return Number.isFinite(limit) && limit > 0 && limit <= (Number(rg.maxRangeLines) || 2000);
}

/** Core check shared by Read and shell `cat`. */
function checkFile(file, cfg, projectDir, via) {
  const rg = cfg.readGuard;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null; // missing: let the tool report it
  }
  if (!st.isFile()) return null;
  const defer = Number(rg.deferAboveKB) || 0;
  if (via === 'read' && defer > 0 && st.size > defer * 1024) return null; // Claude Code refuses it more cheaply
  const c = classifyFile(file, st.size, rg, projectDir);
  if (!c) return null;
  const baselineTokens = estimateReadTokens(file, st.size, cfg.charsPerToken);
  const reason = buildReason({ file, size: st.size, category: c.category, info: c, baselineTokens, via, projectDir });
  return {
    reason,
    category: c.category,
    detail: displayPath(file, projectDir),
    savedTokens: Math.max(0, baselineTokens - estimateTokens(reason.length, cfg.charsPerToken)),
  };
}

function evaluateRead(input, cfg, projectDir) {
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path;
  if (typeof file !== 'string' || !file) return null;
  if (ti.allow_large === true) return null; // explicit request for the whole file
  if (isBoundedRead(ti, cfg.readGuard)) return null;
  const abs = path.isAbsolute(file) ? file : path.resolve(input.cwd || projectDir || '.', file);
  return checkFile(abs, cfg, projectDir, 'read');
}

function evaluateGrep(input, cfg, projectDir) {
  const rg = cfg.readGuard;
  if (rg.grep === false) return null;
  const ti = (input && input.tool_input) || {};
  if ((ti.output_mode || 'files_with_matches') !== 'content') return null;
  if (Number(ti.head_limit) > 0) return null;

  let why = null;
  let target = '';
  if (typeof ti.path === 'string' && ti.path) {
    const abs = path.isAbsolute(ti.path) ? ti.path : path.resolve(input.cwd || projectDir || '.', ti.path);
    target = displayPath(abs, projectDir);
    const base = basename(abs);
    if (MINIFIED_NAME_RE.test(base)) why = 'a minified file';
    else if (SOURCEMAP_RE.test(base)) why = 'a source map';
    else {
      const dir = buildDirOf(abs, rg.buildDirs, projectDir, { includeSelf: true });
      if (dir) why = `build/dependency output (\`${dir}/\`)`;
    }
  }
  if (!why && typeof ti.glob === 'string' && /\.min\.|\.map(?:$|[,}])/i.test(ti.glob)) {
    why = 'minified or source-map files';
    target = target || ti.glob;
  }
  if (!why) return null;
  const reason =
    `${SIGNATURE}: Grep in content mode over ${target ? `\`${target}\` ` : ''}(${why}) can return huge generated lines. ` +
    'Run it with output_mode "files_with_matches" or "count" first, or set head_limit (for example 50).';
  return { reason, category: 'grep-generated', detail: target, savedTokens: 0 };
}

function evaluateGlob(input, cfg, projectDir) {
  const rg = cfg.readGuard;
  if (rg.glob === false) return null;
  const ti = (input && input.tool_input) || {};
  const pattern = toPosix(ti.pattern || '');
  if (!pattern.includes('**')) return null;
  const last = pattern.split('/').pop();
  if (!['*', '**', '*.*'].includes(last)) return null; // a specific name or extension is a targeted search
  const base = ti.path ? toPosix(ti.path).replace(/\/+$/, '') + '/' : '';
  const prefix = (base + pattern).split('**')[0];
  const probe = path.isAbsolute(prefix) ? prefix + 'x' : path.resolve(input.cwd || projectDir || '.', prefix + 'x');
  const dir = buildDirOf(probe, rg.buildDirs, projectDir);
  if (!dir) return null;
  const reason =
    `${SIGNATURE}: a recursive Glob of everything under \`${dir}/\` lists generated or dependency files (capped at 100 results). ` +
    'Narrow it to a package or file name, for example `node_modules/<pkg>/**/*.d.ts`.';
  return { reason, category: 'glob-generated', detail: pattern, savedTokens: 0 };
}

const CAT_COMMANDS = new Set(['cat', 'less', 'more', 'bat', 'nl', 'type', 'get-content', 'gc']);

/** Split on top-level ;, &&, || and newlines (not on single |), honouring quotes. */
function splitSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (c === ';' || c === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tiny shell word splitter (quotes only, no expansion). */
function shellWords(segment) {
  const words = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}

function isShellBypassed(command) {
  return /\bCCTS_RAW=1\b|#\s*ccts:raw\b/i.test(command);
}

/** Resolve a shell word to a file path, including Git Bash style /c/Users/... on Windows and ~/. */
function resolveShellPath(word, cwd, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let w = word;
  if (w === '~' || w.startsWith('~/')) w = p.join(require('os').homedir(), w.slice(1));
  if (platform === 'win32') {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(w);
    if (m) w = m[1].toUpperCase() + ':' + (m[2] || '/');
  }
  return p.isAbsolute(w) ? p.normalize(w) : p.resolve(cwd, w);
}

function evaluateShellCat(input, cfg, projectDir) {
  const rg = cfg.readGuard;
  if (rg.shellCat === false) return null;
  const ti = (input && input.tool_input) || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  if (!command || isShellBypassed(command)) return null;
  let cwd = input.cwd || projectDir || '.';
  for (const seg of splitSegments(command)) {
    const words = shellWords(seg);
    while (words.length && /^\w+=/.test(words[0])) words.shift(); // FOO=bar cat x
    if (!words.length) continue;
    const cmd = words[0].toLowerCase();
    if ((cmd === 'cd' || cmd === 'pushd' || cmd === 'set-location' || cmd === 'sl') && words[1] && !words[1].startsWith('-')) {
      cwd = resolveShellPath(words[1], cwd); // follow `cd dir && cat file`
      continue;
    }
    if (/[|<>]/.test(seg.replace(/"[^"]*"|'[^']*'/g, ''))) continue; // piped or redirected: output is already shaped
    if (!CAT_COMMANDS.has(cmd)) continue;
    if (words.some((w) => /^-(totalcount|head|tail|first|last)$/i.test(w))) continue; // Get-Content -TotalCount N
    for (const w of words.slice(1)) {
      if (!w || w.startsWith('-')) continue;
      const r = checkFile(resolveShellPath(w, cwd), cfg, projectDir, 'shell');
      if (r) return r;
    }
  }
  return null;
}

module.exports = {
  evaluateRead,
  evaluateGrep,
  evaluateGlob,
  evaluateShellCat,
  splitSegments,
  shellWords,
  isShellBypassed,
  resolveShellPath,
  buildReason,
};
