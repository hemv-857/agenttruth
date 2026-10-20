import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverDocs, resolveDocArg } from '../src/docs.js';
import { isDocPath } from '../src/changed.js';
import { loadConfig } from '../src/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agenttruth.js');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-docs-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function run(args) {
  try {
    return { status: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// A repo shipping `Readme.md` must be checked everywhere. Before this, the
// configured name `README.md` was looked up with an exact existsSync: it
// resolved on a case-insensitive macOS checkout but not on a case-sensitive
// Linux CI runner, where the tool reported no docs and exited 0.

test('docs: a non-README casing is discovered and reported under its real name', () => {
  const dir = tmpdir({ 'Readme.md': '# Docs\n' });
  const found = discoverDocs(dir, loadConfig(dir));
  assert.equal(found.length, 1);
  assert.equal(found[0].rel, 'Readme.md');
});

test('docs: findings are attributed to the name on disk so annotations link', () => {
  // SARIF and workflow-command annotations are matched by GitHub against real
  // paths; "README.md" for a file called Readme.md does not link anywhere.
  const dir = tmpdir({
    'Readme.md': 'See [gone](./nope.md)\n',
    'x.md': '# x\n',
  });
  const r = run(['--dir', dir, '--json']);
  assert.equal(r.status, 1);
  const { findings } = JSON.parse(r.out);
  assert.equal(findings[0].file, 'Readme.md');

  const gh = run(['--dir', dir, '--format', 'github']);
  assert.match(gh.out, /^::warning file=Readme\.md,/m);
});

test('docs: an explicit arg naming README.md resolves to the file that exists', () => {
  const dir = tmpdir({ 'Readme.md': '# Docs\n' });
  assert.equal(resolveDocArg(dir, 'README.md'), path.join(dir, 'Readme.md'));
  const r = run(['--dir', dir, 'README.md', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.out).docs, 1);
});

test('docs: docsDir matches extension case-insensitively', () => {
  const dir = tmpdir({ 'docs/Notes.MD': '# Notes\n' });
  const found = discoverDocs(dir, loadConfig(dir));
  assert.deepEqual(found.map((d) => d.rel), ['docs/Notes.MD']);
});

test('docs: discovery still reports configured-casing files and does not duplicate', () => {
  const dir = tmpdir({
    'README.md': '# R\n',
    'CLAUDE.md': '# C\n',
    'docs/guide.md': '# G\n',
  });
  const found = discoverDocs(dir, loadConfig(dir));
  assert.deepEqual(found.map((d) => d.rel).sort(), ['CLAUDE.md', 'README.md', 'docs/guide.md']);
});

test('docs: --changed recognizes a touched Readme.md as a doc', () => {
  const cfg = loadConfig('/root');
  assert.equal(isDocPath('Readme.md', cfg), true);
  assert.equal(isDocPath('README.md', cfg), true);
  assert.equal(isDocPath('readme.md', cfg), true);
  assert.equal(isDocPath('src/index.ts', cfg), false);
  assert.equal(isDocPath('CHANGELOG.md', cfg), false);
});

test('docs: ignore list is honoured case-insensitively', () => {
  const dir = tmpdir({ 'Readme.md': '# R\n', 'CLAUDE.md': '# C\n' });
  const cfg = { ...loadConfig(dir), ignore: ['README.md'] };
  const found = discoverDocs(dir, cfg);
  assert.deepEqual(found.map((d) => d.rel), ['CLAUDE.md']);
});

test('docs: a missing directory yields no docs rather than throwing', () => {
  const dir = tmpdir({ 'README.md': '# R\n' });
  const cfg = { ...loadConfig(dir), docsDir: 'nope' };
  assert.equal(discoverDocs(dir, cfg).length, 1);
});
