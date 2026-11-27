'use strict';

const { toPosix, relativeInside, basename } = require('./util');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Minimal glob -> RegExp: `**`, `*`, `?` and `{a,b}`. Paths use forward slashes. */
function globToRegExp(glob, platform = process.platform) {
  const g = toPosix(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp('^' + re + '$', platform === 'win32' ? 'i' : '');
}

/**
 * Does `file` match any glob? Patterns without a slash match the basename (like .gitignore);
 * patterns with a slash match the path relative to `projectDir`, or the absolute path.
 */
function matchesAny(file, globs, projectDir, platform = process.platform) {
  if (!Array.isArray(globs) || globs.length === 0 || !file) return false;
  const abs = toPosix(file);
  const rel = projectDir ? relativeInside(file, projectDir, platform) : null;
  const base = basename(file);
  for (const glob of globs) {
    if (typeof glob !== 'string' || !glob) continue;
    const re = globToRegExp(glob.replace(/^\.\//, ''), platform);
    if (!glob.includes('/')) {
      if (re.test(base)) return true;
    } else {
      if (rel != null && re.test(rel)) return true;
      if (re.test(abs)) return true;
    }
  }
  return false;
}

module.exports = { globToRegExp, matchesAny };
