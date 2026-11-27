'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadConfig, featureOn, DEFAULTS } = require('../lib/config');
const { tmpDir, writeFile } = require('./_helpers');

function env(extra = {}) {
  const home = tmpDir('ccts-cfg-');
  return { home, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...extra } };
}

test('defaults are used when no config files exist', () => {
  const { home, env: e } = env();
  const { config, errors, sources } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.deepEqual(errors, []);
  assert.deepEqual(sources, []);
  assert.equal(config.enabled, true);
  assert.equal(config.readGuard.maxFileKB, DEFAULTS.readGuard.maxFileKB);
  assert.equal(featureOn(config, 'readGuard'), true);
});

test('user config then project config override defaults', () => {
  const { home, env: e } = env();
  const project = tmpDir('ccts-proj-');
  writeFile(path.join(home, '.claude', 'cc-token-saver.json'), JSON.stringify({ readGuard: { maxFileKB: 10 }, noisyCommands: { tailLines: 5 } }));
  writeFile(path.join(project, '.claude', 'cc-token-saver.json'), JSON.stringify({ readGuard: { maxFileKB: 20 } }));
  const { config, sources } = loadConfig({ cwd: project, env: e, home });
  assert.equal(config.readGuard.maxFileKB, 20, 'project wins over user');
  assert.equal(config.noisyCommands.tailLines, 5, 'user value kept when project does not set it');
  assert.equal(config.readGuard.lockfiles, true, 'unrelated defaults kept');
  assert.equal(sources.length, 2);
});

test('arrays in config replace defaults instead of concatenating', () => {
  const { home, env: e } = env();
  const project = tmpDir('ccts-proj-');
  writeFile(path.join(project, '.claude', 'cc-token-saver.json'), JSON.stringify({ readGuard: { buildDirs: ['gen'] } }));
  const { config } = loadConfig({ cwd: project, env: e, home });
  assert.deepEqual(config.readGuard.buildDirs, ['gen']);
});

test('CC_TOKEN_SAVER=off disables everything', () => {
  const { home, env: e } = env({ CC_TOKEN_SAVER: 'off' });
  const { config } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.equal(config.enabled, false);
  assert.equal(featureOn(config, 'readGuard'), false);
});

test('CC_TOKEN_SAVER_DISABLE turns off individual features', () => {
  const { home, env: e } = env({ CC_TOKEN_SAVER_DISABLE: 'repeatReads, noisyCommands' });
  const { config } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.equal(featureOn(config, 'repeatReads'), false);
  assert.equal(featureOn(config, 'noisyCommands'), false);
  assert.equal(featureOn(config, 'readGuard'), true);
});

test('invalid JSON is reported, not thrown, and defaults still apply', () => {
  const { home, env: e } = env();
  writeFile(path.join(home, '.claude', 'cc-token-saver.json'), '{ not json');
  const { config, errors } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /invalid JSON/);
  assert.equal(config.enabled, true);
});

test('a config file with a UTF-8 BOM (common on Windows) still loads', () => {
  const { home, env: e } = env();
  writeFile(path.join(home, '.claude', 'cc-token-saver.json'), '﻿' + JSON.stringify({ enabled: false }));
  const { config, errors } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.deepEqual(errors, []);
  assert.equal(config.enabled, false);
});

test('prototype-polluting keys are ignored', () => {
  const { home, env: e } = env();
  writeFile(path.join(home, '.claude', 'cc-token-saver.json'), '{"__proto__": {"polluted": true}, "readGuard": {"maxFileKB": 1}}');
  const { config } = loadConfig({ cwd: tmpDir(), env: e, home });
  assert.equal({}.polluted, undefined);
  assert.equal(config.readGuard.maxFileKB, 1);
});
