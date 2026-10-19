import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDisables, applyDisables } from '../src/ignores.js';
import { shouldFail, severityOf, summarize, isValidThreshold } from '../src/severity.js';
import { toSarif } from '../src/sarif.js';
import { isDocPath } from '../src/changed.js';
import { loadConfig } from '../src/config.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth.js');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-v04-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function run(dir, args = []) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, '--dir', dir, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

const SRC_100 = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');

// ---------- severity ----------

test('severity: numeric-claim and missing-file are errors', () => {
  assert.equal(severityOf('numeric-claim'), 'error');
  assert.equal(severityOf('missing-file'), 'error');
});

test('severity: broken-link and missing-command are warnings', () => {
  assert.equal(severityOf('broken-link'), 'warning');
  assert.equal(severityOf('missing-command'), 'warning');
});

test('severity: an unknown rule defaults to warning', () => {
  assert.equal(severityOf('something-new'), 'warning');
});

test('severity: --fail-on error ignores warnings', () => {
  const warnings = [{ rule: 'broken-link' }, { rule: 'missing-command' }];
  assert.equal(shouldFail(warnings, 'error'), false);
  assert.equal(shouldFail(warnings, 'warning'), true);
  assert.equal(shouldFail(warnings, 'any'), true);
  assert.equal(shouldFail(warnings, 'none'), false);
});

test('severity: --fail-on error fails on any error', () => {
  assert.equal(shouldFail([{ rule: 'numeric-claim' }], 'error'), true);
});

test('severity: threshold validation', () => {
  for (const t of ['error', 'warning', 'any', 'none']) assert.ok(isValidThreshold(t));
  for (const t of ['bogus', 'ERROR', '']) assert.equal(isValidThreshold(t), false);
});

test('severity: cli rejects an invalid --fail-on with exit 2', () => {
  const r = run(tmpdir({ 'README.md': 'x' }), ['--fail-on', 'bogus']);
  assert.equal(r.code, 2);
  assert.match(r.err, /must be one of/);
});

test('severity: cli passes a warnings-only repo under --fail-on error', () => {
  const dir = tmpdir({ 'README.md': 'See [x](./gone.md).\n' });
  const r = run(dir, ['--fail-on', 'error']);
  assert.equal(r.code, 0);
  assert.match(r.out, /0 errors, 1 warning/);
});

test('severity: cli fails an errors repo under --fail-on error', () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 120-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  assert.equal(run(dir, ['--fail-on', 'error']).code, 1);
});

// ---------- inline disables ----------

test('ignores: disable-next-line suppresses the following line', () => {
  const d = parseDisables('README.md', '<!-- agenttruth-disable-next-line -->\nmake test\n');
  assert.ok(d.lines.has(2));
  assert.equal(d.file, false);
});

test('ignores: disable-line suppresses its own line', () => {
  const d = parseDisables('README.md', 'make test <!-- agenttruth-disable-line -->\n');
  assert.ok(d.lines.has(1));
});

test('ignores: disable-file suppresses everything', () => {
  const d = parseDisables('README.md', '<!-- agenttruth-disable-file reason: vendored -->\nanything\n');
  assert.equal(d.file, true);
  assert.equal(d.reasons[0].reason, 'vendored');
});

test('ignores: applyDisables separates kept from suppressed', () => {
  const map = new Map([
    ['README.md', parseDisables('README.md', '<!-- agenttruth-disable-next-line -->\nmake test\n')],
  ]);
  const findings = [
    { file: 'README.md', line: 2, rule: 'missing-command' },
    { file: 'README.md', line: 9, rule: 'missing-command' },
    { file: 'other.md', line: 2, rule: 'missing-command' },
  ];
  const { kept, suppressed } = applyDisables(findings, map);
  assert.equal(suppressed.length, 1);
  assert.equal(kept.length, 2);
});

test('ignores: cli suppresses a real finding via disable-next-line', () => {
  const dir = tmpdir({
    'README.md':
      '<!-- agenttruth-disable-next-line reason: Makefile is vendored at build time -->\n' +
      '```bash\nmake test\n```\n',
  });
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /suppressed by inline disable/);
});

test('ignores: cli fails when the directive is removed', () => {
  const dir = tmpdir({ 'README.md': '```bash\nmake test\n```\n' });
  assert.equal(run(dir).code, 1);
});

test('ignores: a disabled finding is not auto-fixed', () => {
  const dir = tmpdir({
    'README.md':
      '<!-- agenttruth-disable-next-line -->\n' +
      'Covered by all 120-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  run(dir, ['--fix']);
  assert.match(
    fs.readFileSync(path.join(dir, 'README.md'), 'utf8'),
    /120-checks/
  );
});

// ---------- SARIF ----------

test('sarif: produces valid 2.1.0 shape', () => {
  const report = toSarif([{ file: 'README.md', line: 3, rule: 'numeric-claim', message: 'claims "299 check"', detail: 'x' }]);
  assert.equal(report.version, '2.1.0');
  assert.equal(report.runs.length, 1);
  const driver = report.runs[0].tool.driver;
  assert.equal(driver.name, 'agenttruth');
  assert.ok(Array.isArray(driver.rules));
  const result = report.runs[0].results[0];
  assert.equal(result.ruleId, 'numeric-claim');
  assert.equal(result.level, 'error');
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'README.md');
  assert.equal(result.locations[0].physicalLocation.region.startLine, 3);
});

test('sarif: warning rules map to warning level', () => {
  const report = toSarif([{ file: 'README.md', line: 1, rule: 'broken-link', message: 'dead link' }]);
  assert.equal(report.runs[0].results[0].level, 'warning');
});

test('sarif: only rules that fired are included', () => {
  const report = toSarif([{ file: 'README.md', line: 1, rule: 'broken-link', message: 'x' }]);
  assert.deepEqual(report.runs[0].tool.driver.rules.map((r) => r.id), ['broken-link']);
});

test('sarif: cli writes a file that parses', () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 120-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  const out = path.join(dir, 'r.sarif');
  run(dir, ['--sarif', out]);
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(parsed.version, '2.1.0');
  assert.ok(parsed.runs[0].results.length >= 1);
});

// ---------- changed ----------

const CFG = { docs: ['README.md', 'CLAUDE.md'], docsDir: 'docs', ignore: [] };

test('changed: recognises doc paths', () => {
  assert.equal(isDocPath('README.md', CFG), true);
  assert.equal(isDocPath('docs/guide.md', CFG), true);
  assert.equal(isDocPath('src/app.ts', CFG), false);
  assert.equal(isDocPath('docs/notes.txt', CFG), false);
});

test('changed: ignores configured ignore list', () => {
  assert.equal(isDocPath('README.md', { ...CFG, ignore: ['README.md'] }), false);
});

test('changed: cli skips cleanly when no doc changed', () => {
  const dir = tmpdir({ 'README.md': 'all 3-checks covered\n', 'test.js': SRC_100 });
  // not a git repo -> ref invalid -> must fall back to scanning, not crash
  const r = run(dir, ['--changed', 'HEAD~1']);
  assert.ok(r.code === 0 || r.code === 1);
  assert.doesNotMatch(r.err ?? '', /Error|ENOENT/);
});
// ---------- counter cache ----------
// A 5,800-file repo took 4m34s before memoisation and 10s after. The cache is
// keyed by repo root (or by sources identity when there is no root) so two
// repos in one process — the MCP server case — cannot read each other's counts.

test('cache: two different sources arrays do not share counters', async () => {
  const { checkNumericClaims, resetCounterCache } = await import('../src/checks/numeric.js');
  resetCounterCache();
  const a = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  const b = Array.from({ length: 110 }, (_, i) => `check("b${i}");`).join('\n');
  // Both within tolerance of 120, so both produce a finding — and they must
  // report their own counter, not a neighbour's.
  const doc = 'Covers all 120-checks in CI today.\n';
  assert.match(checkNumericClaims('R.md', doc, [a]).findings[0].message, /100/);
  assert.match(checkNumericClaims('R.md', doc, [b]).findings[0].message, /110/);
  resetCounterCache();
});

test('cache: repeated calls with the same sources reuse the same result', async () => {
  const { checkNumericClaims, resetCounterCache } = await import('../src/checks/numeric.js');
  resetCounterCache();
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  const doc = 'Covers all 120-checks in CI today.\n';
  const one = checkNumericClaims('A.md', doc, [src]);
  const two = checkNumericClaims('B.md', doc, [src]);
  assert.equal(one.findings.length, 1);
  assert.equal(two.findings.length, 1);
  assert.match(two.findings[0].message, /100/);
  resetCounterCache();
});

test('perf: a synthetic repo with many docs completes quickly', () => {
  const files = {};
  const SRC = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  for (let i = 0; i < 40; i++) {
    files[`README${i === 0 ? '' : i}.md`] = 'Covers all 120-checks in CI.\n';
  }
  for (let i = 0; i < 400; i++) files[`src/file${i}.js`] = SRC;
  const dir = tmpdir(files);
  const started = process.hrtime.bigint();
  run(dir);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Generous ceiling: the memoised path is well under this, the un-memoised
  // path on this fixture took seconds.
  assert.ok(ms < 5000, `took ${ms.toFixed(0)}ms — counter cache may have regressed`);
});
