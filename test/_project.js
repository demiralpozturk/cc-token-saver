'use strict';

/** Builds a throwaway sample project with the kinds of files the read guard cares about. */

const path = require('path');
const { tmpDir, writeFile } = require('./_helpers');

function lockfile(packages) {
  const pkgs = { '': { name: 'demo', version: '1.0.0' } };
  for (let i = 0; i < packages; i++) {
    pkgs[`node_modules/pkg-${i}`] = {
      version: `1.${i % 10}.${i % 7}`,
      resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.${i % 10}.${i % 7}.tgz`,
      integrity: 'sha512-' + Buffer.from(`pkg-${i}-integrity-hash-value-padding-padding`).toString('base64'),
      dev: i % 3 === 0,
    };
  }
  return JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: pkgs }, null, 2);
}

function minified(bytes) {
  let s = '!function(e){"use strict";';
  let i = 0;
  while (s.length < bytes) s += `var a${i}=function(t,n){return t+n*${i}};e.f${i}=a${i};`, i++;
  return s + '}(window);';
}

function sourceLines(lines) {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(`export function fn${i}(value) { return value * ${i}; } // line ${i}`);
  return out.join('\n') + '\n';
}

function makeProject() {
  const root = tmpDir('ccts-proj-');
  const files = {
    lockfile: writeFile(path.join(root, 'package-lock.json'), lockfile(300)),
    tinyLock: writeFile(path.join(root, 'sub', 'yarn.lock'), '# tiny\n'),
    source: writeFile(path.join(root, 'src', 'app.js'), sourceLines(60)),
    minifiedByName: writeFile(path.join(root, 'public', 'vendor.min.js'), minified(30000)),
    minifiedByContent: writeFile(path.join(root, 'src', 'generated.js'), minified(40000)),
    distBundle: writeFile(path.join(root, 'dist', 'bundle.js'), sourceLines(400)),
    distSmall: writeFile(path.join(root, 'dist', 'small.js'), sourceLines(30)),
    nodeModulesPkgJson: writeFile(path.join(root, 'node_modules', 'pkg', 'package.json'), '{"name":"pkg","version":"1.0.0"}\n'),
    nodeModulesIndex: writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), sourceLines(300)),
    large: writeFile(path.join(root, 'docs', 'big.md'), sourceLines(1500)),
    sourceMap: writeFile(path.join(root, 'public', 'app.js.map'), JSON.stringify({ version: 3, mappings: 'AAAA,'.repeat(8000) })),
    binary: writeFile(path.join(root, 'data', 'blob.xyz'), Buffer.concat([Buffer.from('HDR'), Buffer.alloc(9000, 0), Buffer.from('end')])),
    image: writeFile(path.join(root, 'assets', 'shot.png'), Buffer.alloc(300000, 1)),
  };
  return { root, files };
}

module.exports = { makeProject, lockfile, minified, sourceLines };
