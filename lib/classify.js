'use strict';

/** Decide whether a file is wasteful to read whole: lockfile, minified, source map, build output, binary, or large. */

const fs = require('fs');
const path = require('path');
const { toPosix, relativeInside, basename, estimateTokens } = require('./util');
const { matchesAny } = require('./glob');

const LOCKFILES = new Set(
  [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'deno.lock',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',
    'pdm.lock',
    'go.sum',
    'go.work.sum',
    'mix.lock',
    'pubspec.lock',
    'Podfile.lock',
    'packages.lock.json',
    'flake.lock',
    'gradle.lockfile',
    'Package.resolved',
    'paket.lock',
    'conan.lock',
    'shard.lock',
    'cabal.project.freeze',
  ].map((s) => s.toLowerCase()),
);

const MINIFIED_NAME_RE = /\.min\.(?:js|mjs|cjs|css)$/i;
const SOURCEMAP_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|less)\.map$/i;

const BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.jar', '.war', '.pyc', '.pyo',
  '.wasm', '.node', '.pdb', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.ico', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.mp3', '.mp4', '.mov', '.avi',
  '.mkv', '.wav', '.flac', '.ogg', '.psd', '.iso', '.dmg', '.msi', '.lockb',
]);

// Claude can look at these (images, PDFs) or Claude Code has its own limits for them (notebooks).
const PASSTHROUGH_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ipynb']);

// Claude Code limits, from the tools reference (see docs/how-it-works.md).
const READ_MAX_TOKENS = 25000;
const READ_MAX_BYTES = 256 * 1024;
const READ_REFUSAL_TOKENS = 60;
const LINE_PREFIX_CHARS = 7; // Read prefixes each line with its number and a tab

function extOf(file) {
  return path.extname(basename(file)).toLowerCase();
}

/**
 * Name of the build/output directory containing `file`, or null.
 * Inside the project only the relative path is checked (so a project that itself lives
 * under ~/build is not flagged). Outside the project only node_modules counts.
 */
function buildDirOf(file, buildDirs, projectDir, { includeSelf = false, platform = process.platform } = {}) {
  if (!file || !Array.isArray(buildDirs) || buildDirs.length === 0) return null;
  const rel = projectDir ? relativeInside(file, projectDir, platform) : null;
  const candidates = rel != null ? buildDirs : buildDirs.filter((d) => d === 'node_modules');
  const segs = toPosix(rel != null ? rel : file).split('/').filter(Boolean);
  const dirs = includeSelf ? segs : segs.slice(0, -1);
  const norm = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const wanted = new Set(candidates.map(norm));
  for (const seg of dirs) if (wanted.has(norm(seg))) return seg;
  return null;
}

/** Look at the first 64 KB: NUL bytes mean binary; very long average lines mean minified/generated. */
function sniff(file, size) {
  const len = Math.min(size, 65536);
  if (len <= 0) return { binary: false, avgLineLength: 0 };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  let newlines = 0;
  for (let i = 0; i < len; i++) if (buf[i] === 10) newlines++;
  const lines = newlines + (buf[len - 1] === 10 ? 0 : 1);
  return { binary: !utf16 && buf.includes(0), avgLineLength: len / Math.max(1, lines) };
}

/**
 * Classify a file. Returns null (fine to read) or { category, ...details }.
 * `rg` is the readGuard config section.
 */
function classifyFile(file, size, rg, projectDir, platform = process.platform) {
  const base = basename(file).toLowerCase();
  const ext = extOf(file);
  if (PASSTHROUGH_EXTS.has(ext)) return null;
  if (matchesAny(file, rg.allow, projectDir, platform)) return null;
  if (size < (Number(rg.minBlockBytes) || 0)) return null;

  if (rg.lockfiles !== false && LOCKFILES.has(base)) return { category: 'lockfile' };
  if (rg.sourceMaps !== false && SOURCEMAP_RE.test(base)) return { category: 'sourcemap' };
  if (rg.minified !== false && MINIFIED_NAME_RE.test(base)) return { category: 'minified' };
  if (rg.binary !== false && BINARY_EXTS.has(ext)) return { category: 'binary' };
  if (matchesAny(file, rg.block, projectDir, platform)) return { category: 'blocked-pattern' };

  const dir = buildDirOf(file, rg.buildDirs, projectDir, { platform });
  if (rg.buildOutput !== false && dir && size >= (Number(rg.buildOutputMinKB) || 0) * 1024) {
    return { category: 'build-output', dir };
  }

  let s = { binary: false, avgLineLength: 0 };
  try {
    s = sniff(file, size);
  } catch {
    /* unreadable: let Claude Code report it */
  }
  if (rg.binary !== false && s.binary) return { category: 'binary' };
  if (rg.minified !== false && size >= 16 * 1024 && s.avgLineLength >= 1000) {
    return { category: 'minified', avgLineLength: Math.round(s.avgLineLength) };
  }
  if (size > (Number(rg.maxFileKB) || 64) * 1024) return { category: 'large' };
  return null;
}

/**
 * Estimated tokens a whole-file Read would have put into context, following Claude Code's
 * documented limits: whole files over 256 KB are refused (a short error), otherwise the
 * content plus line-number prefixes, capped at 25,000 tokens.
 */
function estimateReadTokens(file, size, charsPerToken = 4) {
  if (size > READ_MAX_BYTES) return READ_REFUSAL_TOKENS;
  let lines = 1;
  let chars = size;
  try {
    const text = fs.readFileSync(file, 'utf8');
    chars = text.length;
    lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  } catch {
    /* fall back to byte size */
  }
  return Math.min(READ_MAX_TOKENS, estimateTokens(chars + lines * LINE_PREFIX_CHARS, charsPerToken));
}

module.exports = {
  LOCKFILES,
  MINIFIED_NAME_RE,
  SOURCEMAP_RE,
  BINARY_EXTS,
  PASSTHROUGH_EXTS,
  READ_MAX_TOKENS,
  READ_MAX_BYTES,
  buildDirOf,
  sniff,
  classifyFile,
  estimateReadTokens,
  extOf,
};
