'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { deepMerge, isPlainObject } = require('./util');

/**
 * Built-in defaults. Every feature can be switched off with `"enabled": false`,
 * and the whole plugin with the top-level `"enabled": false` or CC_TOKEN_SAVER=off.
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  charsPerToken: 4,

  readGuard: {
    enabled: true,
    // Files larger than this are blocked unless Read is given a `limit` (line range).
    maxFileKB: 64,
    // Never block files smaller than this, whatever their name.
    minBlockBytes: 2048,
    // A Read with `limit` up to this many lines counts as a bounded, allowed read.
    maxRangeLines: 2000,
    // Claude Code itself refuses whole-file Reads above 256 KB with a short error, which is
    // cheaper than our message, so the Read guard stays out of the way above this size (0 = never).
    deferAboveKB: 256,
    lockfiles: true,
    minified: true,
    sourceMaps: true,
    binary: true,
    buildOutput: true,
    // Files inside these directories are blocked when larger than buildOutputMinKB.
    buildDirs: [
      'node_modules',
      'dist',
      'build',
      'out',
      '.next',
      '.nuxt',
      '.svelte-kit',
      '.turbo',
      '.output',
      '.parcel-cache',
      '.angular',
      'coverage',
      '__pycache__',
      '.gradle',
      'target',
    ],
    buildOutputMinKB: 16,
    // Glob patterns (relative to the project, or absolute) that are never blocked.
    allow: [],
    // Extra glob patterns that are always blocked (unless a line range is given).
    block: [],
    // Also guard Grep (content mode over build output / minified files) and Glob (recursive globs in build dirs).
    grep: true,
    glob: true,
    // Also guard `cat`/`less`/`Get-Content` of blocked files in Bash / PowerShell.
    shellCat: true,
  },

  repeatReads: {
    enabled: true,
  },

  noisyCommands: {
    enabled: true,
    // "auto": rewrite the command only in bypassPermissions mode, otherwise condense after it ran.
    // "post": never touch the command; condense successful output with PostToolUse.
    // "rewrite": always wrap the command so output is condensed before Claude sees it (also on failure).
    strategy: 'auto',
    // Only condense output longer than this many characters.
    minChars: 3000,
    // Leave output above this size alone: Claude Code already saves it to a file and shows a short preview.
    maxChars: 30000,
    headLines: 5,
    tailLines: 30,
    maxErrorLines: 40,
    maxWarningLines: 10,
    contextLines: 2,
    maxLineChars: 400,
    // Extra regular expressions (strings) matched against each command segment.
    extraPatterns: [],
  },

  statusline: {
    color: true,
    showContext: true,
    showTokens: true,
    showSaved: true,
  },
});

const FEATURE_KEYS = ['readGuard', 'repeatReads', 'noisyCommands', 'statusline'];
const FALSEY = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { value: null };
    return { error: `${file}: ${err.message}` };
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    if (!isPlainObject(value)) return { error: `${file}: expected a JSON object` };
    return { value };
  } catch (err) {
    return { error: `${file}: invalid JSON (${err.message})` };
  }
}

function userConfigPath(env = process.env, home = os.homedir()) {
  if (env.CC_TOKEN_SAVER_CONFIG) return env.CC_TOKEN_SAVER_CONFIG;
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return path.join(claudeDir, 'cc-token-saver.json');
}

function projectConfigPath(projectDir) {
  return projectDir ? path.join(projectDir, '.claude', 'cc-token-saver.json') : null;
}

/**
 * Load configuration: defaults <- user file <- project file <- environment.
 * Never throws; problems are returned in `errors`.
 */
function loadConfig({ cwd, projectDir, env = process.env, home = os.homedir() } = {}) {
  const errors = [];
  const sources = [];
  let config = clone(DEFAULTS);
  const project = projectDir || env.CLAUDE_PROJECT_DIR || cwd || null;

  for (const file of [userConfigPath(env, home), projectConfigPath(project)]) {
    if (!file) continue;
    const r = readJsonFile(file);
    if (r.error) errors.push(r.error);
    else if (r.value) {
      config = deepMerge(config, r.value);
      sources.push(file);
    }
  }

  const master = String(env.CC_TOKEN_SAVER || '').trim().toLowerCase();
  if (FALSEY.has(master)) config.enabled = false;

  const disabled = String(env.CC_TOKEN_SAVER_DISABLE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const key of disabled) {
    if (key === 'all') config.enabled = false;
    else if (isPlainObject(config[key])) config[key].enabled = false;
  }

  if (!(Number(config.charsPerToken) > 0)) config.charsPerToken = DEFAULTS.charsPerToken;
  return { config, errors, sources, projectDir: project };
}

/** True when the plugin and the given feature are both enabled. */
function featureOn(config, key) {
  return Boolean(config && config.enabled !== false && config[key] && config[key].enabled !== false);
}

module.exports = { DEFAULTS, FEATURE_KEYS, loadConfig, featureOn, userConfigPath, projectConfigPath, readJsonFile };
