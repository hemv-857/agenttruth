import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLinks } from '../src/checks/links.js';
import { checkCommands } from '../src/checks/commands.js';
import { buildFileIndex } from '../src/checks/filerefs.js';

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