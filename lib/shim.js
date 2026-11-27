'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write <plugin data dir>/statusline.js, a one-line file that loads this installed version's
 * status line script. ${CLAUDE_PLUGIN_ROOT} changes on every plugin update but the data dir does
 * not, so users can point their statusLine setting at the shim once.
 */
function writeStatuslineShim(dataDir) {
  if (!dataDir) return null;
  const target = path.resolve(__dirname, '..', 'scripts', 'statusline.js');
  const file = path.join(dataDir, 'statusline.js');
  const content =
    '#!/usr/bin/env node\n' +
    '// Written by cc-token-saver at session start; loads the installed plugin version.\n' +
    `require(${JSON.stringify(target)});\n`;
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* not there yet */
  }
  if (current !== content) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}

module.exports = { writeStatuslineShim };
