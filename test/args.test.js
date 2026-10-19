import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth.js');

// Invocation errors must fail loudly. This tool's contract is "exit 1 when the
// docs are wrong", so a mistyped option that quietly exits 0 would report
// drift-free to CI while checking nothing at all.

function run(args) {
  try {
    return { status: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-args-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('args: an unknown option exits 2 instead of silently checking nothing', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n' });
  const r = run(['--dir', dir, '--definitely-not-a-flag']);
  assert.equal(r.status, 2);
  assert.match(r.out, /unknown option "--definitely-not-a-flag"/);
});

test('args: a typo cannot produce a false clean run', () => {
  // A real finding exists here, so a typo that ignored the flag would exit 0
  // and tell CI the docs were fine.
  const dir = tmpdir({
    'README.md': 'See [gone](./nope.md)\n',
    'other.md': '# Other\n',
  });
  assert.equal(run(['--dir', dir]).status, 1);
  const r = run(['--dir', dir, '--format-github']);
  assert.equal(r.status, 2);
  assert.match(r.out, /unknown option/);
});

test('args: a value-taking option with no value exits 2', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n' });
  for (const flag of ['--dir', '--fail-on', '--changed', '--format']) {
    const r = run(['--dir', dir, flag]);
    assert.equal(r.status, 2, `${flag} should be rejected`);
    assert.match(r.out, new RegExp(`${flag} needs a value`));
  }
});

test('args: an option followed by another option is rejected, not consumed', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n' });
  // `--dir --format github` would otherwise resolve dir to the literal
  // "--format" and fail with the much less helpful "no such directory".
  const r = run(['--dir', '--format', 'github']);
  assert.equal(r.status, 2);
  assert.match(r.out, /--dir needs a value/);
});

test('args: --help wins over a bad option so the reference stays reachable', () => {
  const r = run(['--help', '--bogus']);
  assert.equal(r.status, 0);
  assert.match(r.out, /find docs that no longer match the code/);
});

test('args: valid invocations are unaffected', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n', 'a.md': 'ok\n' });
  assert.equal(run(['--dir', dir, '--format', 'github']).status, 0);
  assert.equal(run(['--dir', dir, '--json']).status, 0);
  assert.equal(run(['--dir', dir, '--fail-on', 'error']).status, 0);
  assert.equal(run(['--dir', dir, '-q']).status, 0);
  // Point the SARIF report into the temp dir; with no value it would be
  // written into the working directory the tests run from.
  assert.equal(run(['--dir', dir, '--sarif', path.join(dir, 'a.sarif')]).status, 0);
});
