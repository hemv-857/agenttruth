import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNumericClaims } from '../src/checks/numeric.js';
import { checkFileReferences, buildFileIndex } from '../src/checks/filerefs.js';

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttruth-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('numeric-claim: flags a claim the counter contradicts', () => {
  // 100 assertions in source; doc claims 120 — a typo-sized error, which is
  // the class of drift worth failing a build over.
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  const doc = 'Covered by all 120-checks in CI.\n';
  const r = checkNumericClaims('README.md', doc, [src]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'numeric-claim');
  assert.match(r.findings[0].message, /120/);
});

test('numeric-claim: silent when the claim is correct', () => {
  const src = ['check("a");', 'check("b");', 'check("c");'].join('\n');
  const doc = 'Covered by all 3-checks in CI.\n';
  assert.equal(checkNumericClaims('README.md', doc, [src]).findings.length, 0);
});

test('numeric-claim: does not compare agents against test counts', () => {
  const src = ['check("a");', 'check("b");', 'check("c");'].join('\n');
  // "30 agents" must never be judged against 3 assertions
  const doc = 'The catalog ships with all 30-agents.\n';
  const r = checkNumericClaims('README.md', doc, [src]);
  assert.equal(r.findings.length, 0);
});

test('numeric-claim: ignores numbers with no claim language nearby', () => {
  const src = ['check("a");', 'check("b");', 'check("c");'].join('\n');
  const doc = 'Version 99-checks of the tool.\n'; // no context word
  assert.equal(checkNumericClaims('README.md', doc, [src]).findings.length, 0);
});

test('numeric-claim: ignores wildly different numbers', () => {
  const src = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
  const doc = 'Covers all 5000-checks.\n'; // not a typo of 100
  assert.equal(checkNumericClaims('README.md', doc, [src]).findings.length, 0);
});

test('numeric-claim: counts JSON catalog entries', () => {
  const dir = tmpdir({
    'agents.json': JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: `a${i}` }))),
  });
  const doc = 'The bundle ships all 46-agents by default.\n'; // typo of 40
  const r = checkNumericClaims('README.md', doc, [], dir);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].detail, /40/);
});

test('filerefs: clean when every named file exists', () => {
  const dir = tmpdir({
    'README.md': 'See `AppStore.swift` for state.\n',
    'src/AppStore.swift': 'let x = 1\n',
  });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: flags a file that does not exist', () => {
  const dir = tmpdir({ 'README.md': 'Edit `src/Ghost.swift` to change it.\n', 'src/Other.swift': 'let x = 1\n' });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'missing-file');
});

test('filerefs: does not flag CLI-supplied file arguments', () => {
  const dir = tmpdir({ 'README.md': 'agent-browser webmcp invoke <tool> --params @input.json\n' });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: does not flag a path when the exact basename exists elsewhere', () => {
  const dir = tmpdir({
    'README.md': 'Edit `AgentOfficeApp.swift` to change the entry point.\n',
    'macOS/AgentOffice/Sources/AgentOfficeApp.swift': 'main',
  });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: does not match .js inside .json or .shared', () => {
  const dir = tmpdir({
    'README.md': 'Uses `agents.json` and `PluginManager.shared`.\n',
    'agents.json': '{}',
    'src/PluginManager.swift': 'class PluginManager {}\n',
  });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: skips fenced code blocks', () => {
  const dir = tmpdir({
    'README.md': '```sh\nnpm run Ghost.swift\n```\n',
    'other.md': '',
  });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: does not flag files the reader creates', () => {
  const dir = tmpdir({ 'README.md': 'Save auth to `./my-auth.json` first.\n' });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: does not flag badge URLs as file refs', () => {
  const dir = tmpdir({
    'README.md': '<a href="https://skills.sh/x/y"><img alt="skills.sh" src="https://skills.sh/b/x"></a>\n',
    'skills.rs': 'fn main() {}',
  });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('filerefs: does not flag a filename the doc says not to use', () => {
  const dir = tmpdir({ 'README.md': 'Use kebab-case, e.g. `session-tree.tsx`, not `SessionTree.tsx`.\n' });
  const idx = buildFileIndex(dir);
  const r = checkFileReferences('README.md', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), dir, idx);
  assert.equal(r.findings.length, 0);
});

test('buildFileIndex: skips build dirs and dotfiles', () => {
  const dir = tmpdir({
    'README.md': 'x',
    'node_modules/pkg/index.js': 'x',
    '.build/out/main.swift': 'x',
    'src/real.swift': 'x',
  });
  const idx = buildFileIndex(dir);
  const names = [...idx.keys()];
  assert.ok(names.includes('src/real.swift'));
  assert.ok(names.includes('README.md'));
  assert.ok(!names.some((n) => n.includes('node_modules')));
  assert.ok(!names.some((n) => n.includes('.build')));
});
test('numeric-claim: does not treat a directory name as a count claim', () => {
  const src = Array.from({ length: 280 }, (_, i) => `expect(1).toBe(${i});`).join('\n');
  const doc = 'Run `shasum -a 256 test-results/<dir>/*.png`\n';
  assert.equal(checkNumericClaims('README.md', doc, [src]).findings.length, 0);
});

test('numeric-claim: excludes the helper declaration from the count', () => {
  // 266 call sites + 1 `function check(` declaration => must report 266
  const src =
    'function check(a, b) {}\n' + Array.from({ length: 266 }, (_, i) => `  check(${i});`).join('\n');
  const doc = 'Covers all 272-checks in CI today.\n';
  const r = checkNumericClaims('README.md', doc, [src]);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /266/);
});

test('numeric-claim: a longer number is not re-read from its tail', () => {
  // buzz: "**1200 lines/file**" once matched the claim "200 lines" because the
  // lookbehind was written with a double escape and never saw the digit.
  const src = Array.from({ length: 191 }, () => 'check(1);').join('\n');
  const doc = '**1200 lines/file**, enforced with the other limits by the gate.\n';
  assert.equal(checkNumericClaims('README.md', doc, [src]).findings.length, 0);
});
