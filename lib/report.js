'use strict';

const { formatTokens, formatInt } = require('./util');

const KIND_LABELS = {
  'blocked-read': 'blocked reads',
  'repeat-read': 'repeat reads',
  'condensed-output': 'condensed outputs',
  'blocked-cat': 'blocked cat/Get-Content',
  'blocked-grep': 'redirected Greps',
  'blocked-glob': 'redirected Globs',
};

function pad(s, n, right = false) {
  const t = String(s);
  if (t.length >= n) return t;
  return right ? ' '.repeat(n - t.length) + t : t + ' '.repeat(n - t.length);
}

/**
 * Render the token report. `analysis` comes from transcript.analyze(), `savings` from
 * state.summarizeSavings(), `status` from the status line's saved cost (optional).
 */
function formatReport({ analysis, savings, status, sessionId, transcriptPath, markdown = false }) {
  const a = analysis;
  const t = a.totals;
  const out = [];
  const h = (s) => out.push(markdown ? `### ${s}` : s);
  const subagents = Math.max(0, a.files - 1);

  out.push(markdown ? '## cc-token-saver: token report' : 'cc-token-saver: token report');
  out.push(`Session ${sessionId || '?'} · ${a.files} transcript file${a.files === 1 ? '' : 's'}${subagents ? ` (main + ${subagents} subagent${subagents === 1 ? '' : 's'})` : ''}`);
  if (transcriptPath && !markdown) out.push(`Transcript: ${transcriptPath}`);
  out.push('');

  h('API usage (exact, summed from the transcript)');
  const usageRows = [
    ['Requests', formatInt(t.requests)],
    ['Input (uncached)', formatTokens(t.input)],
    ['Cache write', formatTokens(t.cacheWrite)],
    ['Cache read', formatTokens(t.cacheRead)],
    ['Output', formatTokens(t.output)],
  ];
  if (status && typeof status.costUsd === 'number') usageRows.push(['Cost (Claude Code estimate)', '$' + status.costUsd.toFixed(2)]);
  if (markdown) {
    out.push('| | |', '| --- | ---: |');
    for (const [k, v] of usageRows) out.push(`| ${k} | ${v} |`);
  } else {
    for (const [k, v] of usageRows) out.push(`  ${pad(k, 28)}${pad(v, 10, true)}`);
  }
  out.push('');

  h('Tool results by tool (estimated at ~4 chars/token)');
  const tools = Object.entries(a.byTool).sort((x, y) => y[1].tokens - x[1].tokens);
  if (tools.length === 0) {
    out.push('  No tool results yet.');
  } else {
    const total = a.resultTokens || 1;
    const rows = tools.map(([name, v]) => [name, formatInt(v.calls), formatTokens(v.tokens), Math.round((v.tokens / total) * 100) + '%', formatTokens(v.carried)]);
    const head = ['Tool', 'Calls', 'Result tokens', 'Share', 'Re-sent later*'];
    if (markdown) {
      out.push('| ' + head.join(' | ') + ' |', '| --- | ---: | ---: | ---: | ---: |');
      for (const r of rows) out.push('| ' + r.join(' | ') + ' |');
    } else {
      out.push('  ' + pad(head[0], 26) + pad(head[1], 7, true) + pad(head[2], 15, true) + pad(head[3], 7, true) + pad(head[4], 16, true));
      for (const r of rows) out.push('  ' + pad(r[0].slice(0, 25), 26) + pad(r[1], 7, true) + pad(r[2], 15, true) + pad(r[3], 7, true) + pad(r[4], 16, true));
    }
    out.push('  * result tokens x later requests that re-sent them before a compaction (mostly billed as cache reads)');
  }
  out.push('');

  if (a.largest.length) {
    h('Largest tool results');
    for (const r of a.largest) {
      const line = `${pad(formatTokens(r.tokens), 7, true)}  ${pad(r.tool, 10)} ${r.detail}`;
      out.push(markdown ? `- \`${line.trim()}\`` : '  ' + line);
    }
    out.push('');
  }

  if (a.repeatedReads.length) {
    const wasted = a.repeatedReads.reduce((s, e) => s + e.repeatTokens, 0);
    out.push(`Repeated reads: ${a.repeatedReads.length} file${a.repeatedReads.length === 1 ? '' : 's'} read more than once with the same range (~${formatTokens(wasted)} tokens of repeats)`);
    for (const e of a.repeatedReads.slice(0, 5)) out.push(`  ${e.count}x  ${e.file}`);
    out.push('');
  }

  if (savings && savings.count > 0) {
    const kinds = Object.entries(savings.byKind)
      .map(([k, v]) => `${v.count} ${KIND_LABELS[k] || k}`)
      .join(', ');
    out.push(`cc-token-saver: ~${formatTokens(savings.total)} tokens kept out of context (${kinds}).`);
  } else {
    out.push('cc-token-saver: nothing blocked or condensed in this session yet.');
  }
  return out.join('\n');
}

module.exports = { formatReport };
