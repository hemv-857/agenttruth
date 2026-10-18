#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkNumericClaims } from './checks/numeric.js';
import { checkFileReferences, buildFileIndex } from './checks/filerefs.js';
import { render } from './report.js';

const AGENT_DOCS = [
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md',
  'ARCHITECTURE.md', 'DEVELOPMENT.md', 'SETUP.md', 'QUICKSTART.md',
  'GEMINI.md', '.cursorrules', '.windsurfrules',
  'docs/README.md', 'docs/architecture.md',
];

const SKIP_DIR = new Set([
  '.git', 'node_modules', '.build', 'dist', 'target', 'vendor',
  '.next', '.venv', '__pycache__', 'build', 'out',
]);

function parseArgs(argv) {
  const opts = { json: false, quiet: false, failOn: 'any', dir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) opts.files.push(a);
  }
  opts.files = opts.files || [];
  return opts;
}

const HELP = `agenttruth — find docs that no longer match the code

Usage
  npx agenttruth [options]           scan repo for doc drift
  npx agenttruth --json              machine-readable output

Options
  --dir <path>     repo root (default: cwd)
  --json           emit JSON instead of text
  --fail-on <sev>  error|any|none (default: any) — exit code threshold
  -q, --quiet      only print when findings exist
  -h, --help       this text

Checks
  numeric-claim   "299 checks" vs what the code actually counts
  missing-file    docs name a file that isn't in the repo
  wrong-extension docs say App.sh, repo has App.swift

Exit codes
  0  clean
  1  drift found (and --fail-on threshold met)
  2  bad invocation
`;

function collectDocs(root, explicit) {
  if (explicit.length) {
    return explicit.map((f) => path.resolve(root, f));
  }
  const out = [];
  const seen = new Set();
  const rel = AGENT_DOCS.map((f) => f.replace(/^\.\//, ''));
  for (const r of rel) {
    const full = path.join(root, r);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      out.push(full);
      seen.add(r);
    }
  }
  // docs/*.md too, but only the top level of docs/
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const e of fs.readdirSync(docsDir)) {
      if (e.endsWith('.md') && !seen.has(`docs/${e}`)) {
        out.push(path.join(docsDir, e));
      }
    }
  }
  return out;
}

function readSources(root, fileIndex) {
  const exts = new Set([
    '.swift', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.rs', '.go',
    '.rb', '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs',
  ]);
  const parts = [];
  for (const [rel, full] of fileIndex) {
    if (!exts.has(path.extname(rel))) continue;
    try {
      const st = fs.statSync(full);
      if (st.size > 1_500_000) continue; // skip giant blobs
      parts.push(fs.readFileSync(full, 'utf8'));
    } catch {}
  }
  return parts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!fs.existsSync(opts.dir)) {
    process.stderr.write(`agenttruth: no such directory: ${opts.dir}\n`);
    return 2;
  }

  const fileIndex = buildFileIndex(opts.dir);
  const docs = collectDocs(opts.dir, opts.files);
  if (docs.length === 0) {
    const msg = 'agenttruth: no README/CLAUDE/AGENTS docs found — nothing to check\n';
    if (opts.json) process.stdout.write(JSON.stringify({ findings: [], docs: 0 }) + '\n');
    else process.stderr.write(msg);
    return 0;
  }

  const sources = readSources(opts.dir, fileIndex);

  const results = [];
  for (const doc of docs) {
    let text;
    try {
      text = fs.readFileSync(doc, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(opts.dir, doc);
    results.push(checkNumericClaims(rel, text, sources, opts.dir));
    results.push(checkFileReferences(rel, text, opts.dir, fileIndex));
  }

  const { text, count, findings } = render(results, { cwd: '' });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ docs: docs.length, count, findings }, null, 2) + '\n');
  } else if (!opts.quiet || count > 0) {
    const head = `agenttruth · ${docs.length} doc${docs.length === 1 ? '' : 's'} · ${fileIndex.size} files indexed\n`;
    process.stdout.write(head + text);
    if (count === 0) process.stdout.write('  docs currently match the code.\n');
  }

  if (opts.failOn === 'none') return 0;
  return count > 0 ? 1 : 0;
}

process.exit(main());