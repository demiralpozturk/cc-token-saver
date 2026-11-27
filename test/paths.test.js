'use strict';

/** Pure path handling, exercised with both POSIX and Windows inputs on every OS. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathKey, relativeInside, toPosix, formatTokens, formatBytes } = require('../lib/util');
const { globToRegExp, matchesAny } = require('../lib/glob');
const { buildDirOf } = require('../lib/classify');

test('pathKey normalizes separators and case per platform', () => {
  assert.equal(pathKey('C:\\Repo\\Src\\App.ts', 'win32'), 'c:/repo/src/app.ts');
  assert.equal(pathKey('/repo//src/App.ts/', 'linux'), '/repo/src/App.ts');
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
});

test('relativeInside handles backslashes, case and siblings', () => {
  assert.equal(relativeInside('C:\\Proj\\src\\a.ts', 'c:/proj', 'win32'), 'src/a.ts');
  assert.equal(relativeInside('/proj/src/a.ts', '/proj', 'linux'), 'src/a.ts');
  assert.equal(relativeInside('/project2/a.ts', '/proj', 'linux'), null);
  assert.equal(relativeInside('/Proj/a.ts', '/proj', 'linux'), null, 'case-sensitive on POSIX');
});

test('glob matching: basename patterns, ** and braces', () => {
  assert.ok(globToRegExp('**/*.gen.ts').test('src/a/b.gen.ts'));
  assert.ok(globToRegExp('**/*.gen.ts').test('b.gen.ts'));
  assert.ok(globToRegExp('*.{json,yaml}').test('x.yaml'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(matchesAny('C:\\proj\\fixtures\\big.json', ['fixtures/**'], 'C:\\proj', 'win32'));
  assert.ok(matchesAny('/proj/a/package-lock.json', ['package-lock.json'], '/proj', 'linux'));
  assert.ok(!matchesAny('/proj/a/b.json', ['package-lock.json'], '/proj', 'linux'));
});

test('buildDirOf only looks inside the project (except node_modules)', () => {
  const dirs = ['node_modules', 'dist', 'build'];
  assert.equal(buildDirOf('C:\\proj\\dist\\x.js', dirs, 'C:\\proj', { platform: 'win32' }), 'dist');
  assert.equal(buildDirOf('/home/me/build/proj/src/x.js', dirs, '/home/me/build/proj', { platform: 'linux' }), null);
  assert.equal(buildDirOf('/elsewhere/node_modules/x/index.js', dirs, '/proj', { platform: 'linux' }), 'node_modules');
  assert.equal(buildDirOf('/elsewhere/dist/x.js', dirs, '/proj', { platform: 'linux' }), null);
  assert.equal(buildDirOf('/proj/dist', dirs, '/proj', { platform: 'linux', includeSelf: true }), 'dist');
});

test('formatting helpers', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(25000), '25k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(150 * 1024), '150 KB');
});
