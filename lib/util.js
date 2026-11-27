'use strict';

const fs = require('fs');
const path = require('path');

/** Characters per token used for every estimate in this project. See docs/how-it-works.md. */
const DEFAULT_CHARS_PER_TOKEN = 4;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Rough token estimate: ceil(chars / charsPerToken). Clearly an estimate, not a tokenizer. */
function estimateTokens(chars, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const n = typeof chars === 'string' ? chars.length : Number(chars) || 0;
  if (n <= 0) return 0;
  return Math.ceil(n / (charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN));
}

/** Convert any path to forward slashes (Windows paths arrive with backslashes). */
function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

/**
 * A comparable key for a path: forward slashes, no duplicate or trailing slashes,
 * lower-cased on Windows (case-insensitive file system).
 */
function pathKey(p, platform = process.platform) {
  let s = toPosix(p).replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** Path of `file` relative to `dir` (both normalized), or null when `file` is outside `dir`. */
function relativeInside(file, dir, platform = process.platform) {
  if (!file || !dir) return null;
  const f = pathKey(file, platform);
  const d = pathKey(dir, platform);
  if (f === d) return '';
  if (f.startsWith(d + '/')) return toPosix(file).replace(/\/{2,}/g, '/').slice(d.length + 1);
  return null;
}

function formatTokens(n) {
  const v = Math.round(Number(n) || 0);
  const a = Math.abs(v);
  if (a < 1000) return String(v);
  if (a < 1e6) return (v / 1000).toFixed(a < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (v / 1e6).toFixed(2).replace(/0$/, '') + 'M';
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0).replace(/\.0$/, '') + ' KB';
  return (v / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
}

function formatInt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, everything else (arrays included) is replaced. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function basename(p) {
  return path.posix.basename(toPosix(p));
}

module.exports = {
  DEFAULT_CHARS_PER_TOKEN,
  readStdin,
  parseJson,
  estimateTokens,
  toPosix,
  pathKey,
  relativeInside,
  formatTokens,
  formatBytes,
  formatInt,
  isPlainObject,
  deepMerge,
  ensureDir,
  basename,
};
