#!/usr/bin/env node
'use strict';

/**
 * Offline sanity checks for the plugin manifests (CI has no Claude Code install).
 * If `claude` is available locally, also run: claude plugin validate .
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function check() {
  const problems = [];
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  const plugin = readJson('.claude-plugin/plugin.json');
  if (!kebab.test(plugin.name || '')) problems.push('plugin.json: name must be kebab-case');
  if (/^(claude|anthropic|anthropics|cc-plugin)-/.test(plugin.name || '')) problems.push('plugin.json: reserved name prefix');
  for (const key of ['version', 'description', 'author', 'license']) {
    if (!plugin[key]) problems.push(`plugin.json: missing ${key}`);
  }

  const market = readJson('.claude-plugin/marketplace.json');
  if (!market.name || !market.owner || !market.owner.name) problems.push('marketplace.json: name and owner.name are required');
  if (!Array.isArray(market.plugins) || market.plugins.length === 0) problems.push('marketplace.json: plugins[] is empty');
  for (const [i, entry] of (market.plugins || []).entries()) {
    if (entry.name !== plugin.name) problems.push(`marketplace.json: plugins[${i}].name must equal plugin.json name`);
    if (typeof entry.source !== 'string' || !entry.source.startsWith('./')) problems.push(`marketplace.json: plugins[${i}].source must start with ./`);
    else if (!fs.existsSync(path.join(ROOT, entry.source, '.claude-plugin', 'plugin.json'))) problems.push(`marketplace.json: plugins[${i}].source has no plugin.json`);
  }

  const hooks = readJson('hooks/hooks.json');
  if (!hooks.hooks || typeof hooks.hooks !== 'object') problems.push('hooks.json: missing top-level "hooks" wrapper');
  for (const [event, groups] of Object.entries(hooks.hooks || {})) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        if (h.type !== 'command') problems.push(`hooks.json ${event}: unexpected hook type ${h.type}`);
        for (const arg of h.args || []) {
          if (arg.includes('${CLAUDE_PLUGIN_ROOT}')) {
            const file = path.join(ROOT, arg.replace('${CLAUDE_PLUGIN_ROOT}', ''));
            if (!fs.existsSync(file)) problems.push(`hooks.json ${event}: ${arg} does not exist`);
          }
        }
      }
    }
  }

  const skillsDir = path.join(ROOT, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const file = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(file)) {
        problems.push(`skills/${name}: missing SKILL.md`);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      if (!/^---\r?\n[\s\S]*?\bdescription:\s*\S[\s\S]*?\r?\n---/.test(text)) problems.push(`skills/${name}/SKILL.md: frontmatter needs a description`);
    }
  }

  if (fs.existsSync(path.join(ROOT, 'bin'))) problems.push('a top-level bin/ directory would be put on the Bash PATH; keep scripts in scripts/');
  if (fs.existsSync(path.join(ROOT, 'CLAUDE.md'))) problems.push('CLAUDE.md at the plugin root is not loaded and triggers a validate warning');
  return problems;
}

if (require.main === module) {
  const problems = check();
  if (problems.length) {
    for (const p of problems) console.error('x ' + p);
    process.exit(1);
  }
  console.log('Manifests OK');
}

module.exports = { check };
