'use strict';

/** Synthetic command output shaped like real npm / pytest output. */

function npmInstall(warnings = 120) {
  const lines = [];
  for (let i = 0; i < warnings; i++) {
    lines.push(`npm WARN deprecated pkg-${i}@1.${i % 9}.0: This package is no longer supported. Please use pkg-${i}-next instead.`);
  }
  lines.push('npm WARN EBADENGINE Unsupported engine { package: "legacy@2.0.0", required: { node: "<16" }, current: { node: "v22.11.0" } }');
  lines.push('');
  lines.push('added 1312 packages, and audited 1313 packages in 41s');
  lines.push('');
  lines.push('214 packages are looking for funding');
  lines.push('  run `npm fund` for details');
  lines.push('');
  lines.push('found 0 vulnerabilities');
  return lines.join('\n') + '\n';
}

function pytest(tests = 300, failing = []) {
  const lines = ['============================= test session starts ==============================', 'platform linux -- Python 3.12.4, pytest-8.3.3, pluggy-1.5.0', `collected ${tests} items`, ''];
  for (let i = 0; i < tests; i++) {
    const ok = !failing.includes(i);
    lines.push(`tests/test_module_${Math.floor(i / 20)}.py::test_case_${i} ${ok ? 'PASSED' : 'FAILED'}${' '.repeat(10)}[${String(Math.round(((i + 1) / tests) * 100)).padStart(3)}%]`);
  }
  if (failing.length) {
    lines.push('', '=================================== FAILURES ===================================');
    for (const i of failing) {
      lines.push(`_________________________________ test_case_${i} _________________________________`, '', `    def test_case_${i}():`, `>       assert compute(${i}) == ${i + 1}`, `E       AssertionError: assert ${i} == ${i + 1}`, '', `tests/test_module_${Math.floor(i / 20)}.py:${10 + i}: AssertionError`);
    }
    lines.push('=========================== short test summary info ============================');
    for (const i of failing) lines.push(`FAILED tests/test_module_${Math.floor(i / 20)}.py::test_case_${i} - AssertionError: assert ${i} == ${i + 1}`);
  }
  lines.push(`======================= ${tests - failing.length} passed${failing.length ? `, ${failing.length} failed` : ''} in 12.34s =======================`);
  return lines.join('\n') + '\n';
}

module.exports = { npmInstall, pytest };
