import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinks } from '../src/checks/links.js';
import { checkFileReferences, buildFileIndex } from '../src/checks/filerefs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-prec-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function links(dir, rel) {
  return checkLinks(rel, fs.readFileSync(path.join(dir, rel), 'utf8'), dir).findings;
}

function fileRefs(dir, rel) {
  const idx = buildFileIndex(dir);
  return checkFileReferences(rel, fs.readFileSync(path.join(dir, rel), 'utf8'), dir, idx).findings;
}

// Every case below was found by spot-checking a real repository. Each was a
// false positive: a correct link or a correct file reference reported as drift,
// which is the one thing this tool must not do.

test('precision: site-absolute routes in a docs tree are not repo paths', () => {
  // vite: [Team page](/team) and vitest: [Migration Guides](/guide/migration/)
  // are routes of the rendered docs site, not files the repo ships.
  const dir = tmpdir({
    'docs/acknowledgements.md':
      'See the [Team page](/team) and [Migration](/guide/migration/).\n',
    'docs/guide/migration/index.md': '# Migration\n',
  });
  assert.equal(links(dir, 'docs/acknowledgements.md').length, 0);
});

test('precision: a generated .html page is a site route, not a missing file', () => {
  const dir = tmpdir({ 'docs/ack.md': 'See [changelog](/changelog.html)\n' });
  assert.equal(links(dir, 'docs/ack.md').length, 0);
});

test('precision: a missing site-absolute path shaped like a file is still flagged', () => {
  // `/docs/guide.md` is repo-root-relative on GitHub, so its absence is real.
  const dir = tmpdir({ 'docs/ack.md': 'See [gone](/docs/guide.md)\n' });
  const f = links(dir, 'docs/ack.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'broken-link');
});

test('precision: a file inside a dot-directory the index skips is not missing', () => {
  // babel: the file index deliberately omits dotfiles, so the check must
  // verify the stated path rather than search the index by basename. No
  // "copy" on this line, so only the stated-path check can clear it.
  const dir = tmpdir({
    'CONTRIBUTING.md': 'Use the template in `.vscode/settings.example.json`.\n',
    '.vscode/settings.example.json': '{}\n',
  });
  assert.equal(fileRefs(dir, 'CONTRIBUTING.md').length, 0);
});

test('precision: the destination of "copy X into Y" is created by the reader', () => {
  const dir = tmpdir({
    'CONTRIBUTING.md':
      'Copy the contents of `.vscode/settings.example.json` into `.vscode/settings.json`.\n',
    '.vscode/settings.example.json': '{}\n',
  });
  assert.equal(fileRefs(dir, 'CONTRIBUTING.md').length, 0);
});

test('precision: a genuinely absent file reference is still reported', () => {
  const dir = tmpdir({ 'CONTRIBUTING.md': 'Run `scripts/deploy.json` to configure.\n' });
  const f = fileRefs(dir, 'CONTRIBUTING.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'missing-file');
});
