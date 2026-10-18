import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprint, loadBaseline, saveBaseline, partition } from '../src/baseline.js';
import { loadConfig } from '../src/config.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth.js');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttruth-'));
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
const DRIFT_README = 'Covered by all 120-checks in CI, running every day.\n';

function driftRepo(extra = {}) {
  return tmpdir({ 'README.md': DRIFT_README, 'test.js': SRC_100, ...extra });
}

test('cli: exits 1 on drift', () => {
  const dir = driftRepo();
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /numeric-claim/);
});

test('cli: exits 0 when clean', () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 100-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  assert.equal(run(dir).code, 0);
});

test('baseline: --update-baseline records findings and then suppresses them', () => {
  const dir = driftRepo();
  assert.equal(run(dir).code, 1);

  const up = run(dir, ['--update-baseline']);
  assert.equal(up.code, 0);
  assert.ok(fs.existsSync(path.join(dir, '.agenttruth-baseline.json')));

  const after = run(dir);
  assert.equal(after.code, 0);
  assert.match(after.out, /no new drift/);
});

test('baseline: new drift still fails after baselining', () => {
  const dir = driftRepo();
  run(dir, ['--update-baseline']);
  // fix the old claim, introduce a different one
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    'Covered by all 100-checks in CI, plus all 118-asserts.\n'
  );
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /118/);
});

test('baseline: fingerprint ignores line shifts', () => {
  const a = { file: 'README.md', line: 9, rule: 'numeric-claim', message: 'claims "299 check" — repo has 267' };
  const b = { file: 'README.md', line: 900, rule: 'numeric-claim', message: 'claims "299 check" — repo has 267' };
  assert.equal(fingerprint(a), fingerprint(b));
});

test('baseline: fingerprint differs when the message differs', () => {
  const a = { file: 'README.md', line: 1, rule: 'numeric-claim', message: 'claims "299 check"' };
  const b = { file: 'README.md', line: 1, rule: 'numeric-claim', message: 'claims "12 agents"' };
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('baseline: partition splits known from fresh', () => {
  const f = { file: 'README.md', line: 1, rule: 'numeric-claim', message: 'x' };
  const known = { known: new Set([fingerprint(f)]) };
  const { fresh, known: k } = partition([f, { ...f, message: 'y' }], known);
  assert.equal(k.length, 1);
  assert.equal(fresh.length, 1);
});

test('baseline: corrupt file fails loudly instead of disabling the check', () => {
  const dir = driftRepo({ '.agenttruth-baseline.json': '{not json' });
  const r = run(dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
});

test('config: narrows the doc set', () => {
  const dir = driftRepo({
    'CONTRIBUTING.md': DRIFT_README,
    'agenttruth.config.json': JSON.stringify({ docs: ['README.md'] }),
  });
  // README still drifts, CONTRIBUTING is out of scope -> 1 finding not 2
  const r = run(dir, ['--json']);
  const out = JSON.parse(r.out);
  assert.equal(out.count, 1);
});

test('config: ignore excludes a doc', () => {
  const dir = driftRepo({
    'agenttruth.config.json': JSON.stringify({ ignore: ['README.md'] }),
  });
  assert.equal(run(dir).code, 0);
});

test('config: can disable a check', () => {
  const dir = driftRepo({
    'agenttruth.config.json': JSON.stringify({ checks: ['missing-file'] }),
  });
  assert.equal(run(dir).code, 0);
});

test('config: rejects an unknown check name', () => {
  const dir = driftRepo({
    'agenttruth.config.json': JSON.stringify({ checks: ['nope'] }),
  });
  const r = run(dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown check/);
});

test('config: defaults apply with no config file', () => {
  const dir = tmpdir({ 'README.md': 'x' });
  const cfg = loadConfig(dir);
  assert.equal(cfg.source, null);
  assert.ok(cfg.docs.includes('README.md'));
});

test('cli: --fail-on none never fails', () => {
  assert.equal(run(driftRepo(), ['--fail-on', 'none']).code, 0);
});
// ---------- --fix ----------

test('fix: rewrites an unambiguous stale count', () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 120-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  const r = run(dir, ['--fix']);
  assert.equal(r.code, 0);
  assert.match(r.out, /rewrote 1 claim/);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /all 100-checks/);
  assert.equal(run(dir).code, 0); // now clean
});

test('fix: is idempotent', () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 120-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  run(dir, ['--fix']);
  const second = run(dir, ['--fix']);
  assert.match(second.out, /nothing to auto-fix/);
});

test('fix: refuses when the counter is ambiguous', () => {
  // two files each hold a different number of assertions
  const dir = tmpdir({
    'README.md': 'Covered by all 120-checks in CI, running every day.\n',
    'test.js': Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n'),
    'other.js': Array.from({ length: 110 }, (_, i) => `check("b${i}");`).join('\n'),
  });
  const before = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const r = run(dir, ['--fix']);
  assert.match(r.out, /nothing to auto-fix|ambiguous/);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before);
});

test('fix: rewrites every occurrence on separate lines', () => {
  const dir = tmpdir({
    'README.md': 'Line one: all 120-checks in CI.\n\nLine two: all 120-checks again.\n',
    'test.js': SRC_100,
  });
  const r = run(dir, ['--fix']);
  assert.match(r.out, /rewrote 2 claims/);
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.equal((readme.match(/100-checks/g) ?? []).length, 2);
});

test('fix: leaves missing-file findings alone', () => {
  const dir = tmpdir({
    'README.md': 'Edit `src/Ghost.swift` to change it.\n',
    'src/real.swift': 'x',
  });
  const r = run(dir, ['--fix']);
  assert.match(r.out, /nothing to auto-fix/);
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /Ghost\.swift/);
});
