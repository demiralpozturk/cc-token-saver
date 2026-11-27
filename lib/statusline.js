'use strict';

const { formatTokens } = require('./util');

const SEP = ' · ';

function painter(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), yellow: wrap('33'), red: wrap('31'), cyan: wrap('36') };
}

/**
 * One status line from the status line JSON, the session's usage totals and the plugin's
 * savings. Example: "Opus 5.5 · ctx 42% · $1.23 · 1.2M tok (93% cached) · saved ~24k"
 */
function render(input, { usage, saved = 0, options = {}, color = true } = {}) {
  const c = painter(color);
  const parts = [];
  const model = (input.model && (input.model.display_name || input.model.id)) || 'Claude';
  parts.push(c.bold(c.cyan(model)));

  const pct = input.context_window && input.context_window.used_percentage;
  if (options.showContext !== false && typeof pct === 'number') {
    const p = Math.round(pct);
    const paint = p >= 80 ? c.red : p >= 50 ? c.yellow : c.green;
    parts.push(paint(`ctx ${p}%`));
  }

  const cost = input.cost && input.cost.total_cost_usd;
  if (typeof cost === 'number') parts.push(c.yellow('$' + (cost >= 100 ? cost.toFixed(0) : cost.toFixed(2))));

  if (options.showTokens !== false && usage && usage.requests > 0) {
    const inTotal = usage.input + usage.cacheWrite + usage.cacheRead;
    const total = inTotal + usage.output;
    const cached = inTotal > 0 ? Math.round((usage.cacheRead / inTotal) * 100) : 0;
    parts.push(`${formatTokens(total)} tok` + c.dim(` (${cached}% cached)`));
  }

  if (options.showSaved !== false && saved > 0) parts.push(c.green(`saved ~${formatTokens(saved)}`));
  return parts.join(c.dim(SEP));
}

module.exports = { render };
