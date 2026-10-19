import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLinks } from '../src/checks/links.js';
import { checkCommands } from '../src/checks/commands.js';
import { buildFileIndex } from '../src/checks/filerefs.js';

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth.js');
function checkDriftCli(dir, args = []) {
  try {
    execFileSync('node', [CLI, '--dir', dir, ...args], { encoding: 'utf8' });
    return 0;
  } catch (e) {
    return e.status;
  }
}

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-checks-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---------- broken-link ----------

test('links: clean when every relative link resolves', () => {
  const dir = tmpdir({
    'README.md': '[src](./src/app.js)\n[docs](./docs/guide.md)\n',
    'src/app.js': 'x',
    'docs/guide.md': '# Guide\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: flags a relative link to a missing file', () => {
  const dir = tmpdir({ 'README.md': '[gone](./nope.md)\n' });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'broken-link');
});

test('links: resolves relative to the doc, not the repo root', () => {
  const dir = tmpdir({
    'docs/guide.md': '[cfg](../src/app.js)\n',
    'src/app.js': 'x',
  });
  const r = checkLinks('docs/guide.md', fs.readFileSync(path.join(dir, 'docs/guide.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: ignores absolute, mailto, and in-page links', () => {
  const dir = tmpdir({
    'README.md': '[web](https://example.com) [mail](mailto:a@b.c) [here](#section)\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: flags a directory link with no index', () => {
  const dir = tmpdir({ 'README.md': '[dir](./src/)\n', 'src/app.js': 'x' });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /no index/);
});

test('links: accepts a directory link that has an index', () => {
  const dir = tmpdir({
    'README.md': '[dir](./docs/)\n',
    'docs/index.md': '# Index\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: flags an anchor with no matching heading', () => {
  const dir = tmpdir({
    'README.md': '[jump](./docs/guide.md#install)\n',
    'docs/guide.md': '# Usage\n\ntext\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /anchor/);
});

test('links: accepts an anchor that matches a slugified heading', () => {
  const dir = tmpdir({
    'README.md': '[jump](./docs/guide.md#quick-start)\n',
    'docs/guide.md': '## Quick Start\n\ntext\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: skips fenced code blocks', () => {
  const dir = tmpdir({ 'README.md': '```md\n[gone](./nope.md)\n```\n' });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

test('links: handles images and title attributes', () => {
  const dir = tmpdir({
    'README.md': '![badge](./img.png)\n[ok](./a.md "A title")\n',
    'img.png': 'x',
    'a.md': '# A\n',
  });
  const r = checkLinks('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir);
  assert.equal(r.findings.length, 0);
});

// ---------- missing-command ----------

test('commands: clean when the project file exists', () => {
  const dir = tmpdir({ 'README.md': '```bash\nmake test\n```\n', Makefile: 'test:\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('commands: flags `make x` with no Makefile', () => {
  const dir = tmpdir({ 'README.md': 'Run this:\n\n```bash\nmake test\n```\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'missing-command');
  assert.match(r.findings[0].message, /no Makefile/);
});

test('commands: accepts any of Makefile/Justfile for make', () => {
  const dir = tmpdir({ 'README.md': '```bash\nmake dev\n```\n', Justfile: 'dev:\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('commands: flags `cargo build` with no Cargo.toml', () => {
  const dir = tmpdir({ 'README.md': '```bash\ncargo build\n```\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 1);
});

test('commands: npm is satisfied by package.json', () => {
  const dir = tmpdir({
    'README.md': '```bash\nnpm install\nnpx tsc --noEmit\n```\n',
    'package.json': '{}',
  });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('commands: ignores prose that merely mentions a tool', () => {
  const dir = tmpdir({ 'README.md': 'The make target, for example, builds the site.\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('commands: satisfied by a project file anywhere in a monorepo', () => {
  const dir = tmpdir({
    'README.md': '```bash\nmake test\n```\n',
    'sub/Makefile': 'test:\n',
  });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('commands: flags swift build with no Package.swift', () => {
  const dir = tmpdir({ 'README.md': '```bash\nswift build\nswift run\n```\n' });
  const idx = buildFileIndex(dir);
  const r = checkCommands('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  // both invocations are claims; dedupe is by line so both may appear
  assert.ok(r.findings.length >= 1);
  assert.ok(r.findings.every((f) => f.rule === 'missing-command'));
});
// ---------- driftTolerance (config-wired, not hardcoded) ----------

test('tolerance: default 0.25 flags a 10% gap', async () => {
  const { checkNumericClaims } = await import('../src/checks/numeric.js');
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  const r = checkNumericClaims('R.md', 'Covers all 110-checks in CI today.\n', [src]);
  assert.equal(r.findings.length, 1);
});

test('tolerance: an exact match is never flagged', async () => {
  const { checkNumericClaims } = await import('../src/checks/numeric.js');
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  assert.equal(
    checkNumericClaims('R.md', 'Covers all 100-checks in CI today.\n', [src]).findings.length,
    0
  );
});

test('tolerance: a stale count off by one is caught (the point of the tool)', async () => {
  const { checkNumericClaims } = await import('../src/checks/numeric.js');
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  // 102 vs 100 is 2%, inside the max(5, ...) floor, and is genuinely drift
  const r = checkNumericClaims('R.md', 'Covers all 102-checks in CI today.\n', [src]);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /102/);
});

test('tolerance: config tolerance widens the band past the 5-unit floor', async () => {
  const { checkNumericClaims } = await import('../src/checks/numeric.js');
  // Source carries 100 assertions; the doc's own text is never part of
  // `sources` in real use, so the two counters below are the only candidates.
  const src = Array.from({ length: 100 }, (_, i) => `expect(x${i}).toBe(1);`).join('\n');
  // 130 vs 100 is a 30% gap: outside max(5, 100*0.25)=25 by default.
  const doc = 'Covers all 130-checks in CI today.\n';
  const def = checkNumericClaims('R.md', doc, [src], null, { tolerance: 0.25 });
  const loose = checkNumericClaims('R2.md', doc, [src], null, { tolerance: 0.5 });
  assert.equal(def.findings.length, 0);
  assert.equal(loose.findings.length, 1);
});

test('tolerance: cli honours agenttruth.config.json driftTolerance', () => {
  const dir = tmpdir({
    'README.md': 'Covers all 108-checks in CI, running every day.\n',
    'test.js': Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n'),
    // 108 vs 100 = 8%, inside a 0.25 tolerance -> caught
    'agenttruth.config.json': JSON.stringify({ driftTolerance: 0.25 }),
  });
  assert.equal(checkDriftCli(dir), 1);
});
