import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toWorkflowCommands } from '../src/github.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth.js');

// Validation errors go to stderr, so a failed run returns both streams in
// `stdout` — the assertions below only care that the message reached the user.
function run(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-gh-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// numeric-claim and missing-file are errors; broken-link and missing-command
// are warnings — annotations must carry the same split, since GitHub renders
// ::error as a red annotation and ::warning as amber.

test('github: error rules annotate as ::error', () => {
  const out = toWorkflowCommands([
    { file: 'README.md', line: 12, rule: 'numeric-claim', message: 'claims "299" — repo has 266' },
  ]);
  const line = out.split('\n')[0];
  assert.match(line, /^::error file=README\.md,line=12,title=numeric-claim::/);
  assert.match(line, /claims "299"/);
});

test('github: warning rules annotate as ::warning', () => {
  const out = toWorkflowCommands([
    { file: 'docs/a.md', line: 3, rule: 'broken-link', message: 'target missing' },
  ]);
  assert.match(out.split('\n')[0], /^::warning file=docs\/a\.md,line=3,title=broken-link::/);
});

test('github: always ends with a count summary line', () => {
  const none = toWorkflowCommands([]);
  assert.equal(none, '::notice::agenttruth: 0 doc drift findings');

  const one = toWorkflowCommands([
    { file: 'a.md', line: 1, rule: 'broken-link', message: 'x' },
  ]);
  assert.ok(one.endsWith('\n::notice::agenttruth: 1 doc drift finding'));
});

test('github: escapes the characters the workflow-command parser treats as control', () => {
  const out = toWorkflowCommands([
    { file: 'weird, name.md', line: 1, rule: 'missing-file', message: '100% gone\nsecond line' },
  ]);
  const [first] = out.split('\n');
  // A raw comma would end the property early, so GitHub would see the file as
  // just "weird". Spaces are legal in a property value and stay literal.
  assert.match(first, /^::error file=weird%2C name\.md,line=1,title=missing-file::/);
  assert.match(first, /100%25 gone%0Asecond line/);
  assert.ok(!/file=weird,/.test(first));
});

test('cli: --format github emits annotations and keeps the exit code', () => {
  const dir = tmpdir({
    'README.md': 'See [gone](./nope.md)\n',
    'other.md': '# Other\n',
  });
  const r = run(['--dir', dir, '--format', 'github']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::warning file=README\.md,line=1,title=broken-link::/m);
  assert.match(r.stdout, /::notice::agenttruth: 1 doc drift finding/);
});

test('cli: --format github on a clean repo annotates nothing but reports 0', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n', 'a.md': 'ok\n' });
  const r = run(['--dir', dir, '--format', 'github']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::notice::agenttruth: 0 doc drift findings/);
});

test('cli: an unknown --format fails fast with exit 2', () => {
  const dir = tmpdir({ 'README.md': '# Docs\n' });
  const r = run(['--dir', dir, '--format', 'yaml']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--format must be one of text, json, github/);
});

test('cli: --format json is exactly --json', () => {
  const dir = tmpdir({
    'README.md': 'See [gone](./nope.md)\n',
    'other.md': '# Other\n',
  });
  const a = run(['--dir', dir, '--json']);
  const b = run(['--dir', dir, '--format', 'json']);
  assert.equal(a.status, b.status);
  assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
});
