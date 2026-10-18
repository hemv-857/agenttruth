#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkNumericClaims } from './checks/numeric.js';
import { checkFileReferences, buildFileIndex } from './checks/filerefs.js';
import { checkLinks } from './checks/links.js';
import { checkCommands } from './checks/commands.js';
import { render } from './report.js';
import { loadConfig } from './config.js';
import { loadBaseline, saveBaseline, partition } from './baseline.js';
import { planFixes, applyFixes } from './fix.js';

const SKIP_DIR = new Set([
  '.git', 'node_modules', '.build', 'dist', 'target', 'vendor',
  '.next', '.venv', '__pycache__', 'build', 'out',
]);

function parseArgs(argv) {
  const opts = {
    json: false, quiet: false, failOn: 'any',
    dir: process.cwd(), updateBaseline: false, fix: false, files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--fix') opts.fix = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) opts.files.push(a);
  }
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
  --update-baseline  record current findings as known; CI then fails on new drift only
  -q, --quiet      only print when findings exist
  -h, --help       this text

Checks
  numeric-claim   "299 checks" vs what the code actually counts
  missing-file    docs name a file that isn't in the repo
  broken-link     a relative markdown link that resolves to nothing
  missing-command docs run \`make test\` but there's no Makefile

Config (optional)
  agenttruth.config.json  { docs, docsDir, checks, ignore, driftTolerance }

Baseline
  .agenttruth-baseline.json  suppresses known findings so you can adopt
  without failing CI on drift that predates the tool

Exit codes
  0  no new drift
  1  new drift found
  2  bad invocation or bad config

MCP
  agenttruth-mcp           stdio server exposing the same checks to agents
`;

function collectDocs(root, explicit, cfg) {
  if (explicit.length) {
    return explicit.map((f) => path.resolve(root, f));
  }
  const out = [];
  const seen = new Set();
  const ignore = new Set(cfg.ignore);
  for (const r of cfg.docs) {
    if (ignore.has(r)) continue;
    const full = path.join(root, r);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      out.push(full);
      seen.add(r);
    }
  }
  const docsDir = path.join(root, cfg.docsDir);
  if (fs.existsSync(docsDir)) {
    for (const e of fs.readdirSync(docsDir)) {
      if (!e.endsWith('.md')) continue;
      const rel = `${cfg.docsDir}/${e}`;
      if (ignore.has(rel) || seen.has(rel)) continue;
      out.push(path.join(docsDir, e));
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

  let cfg;
  let baseline;
  try {
    cfg = loadConfig(opts.dir);
    baseline = loadBaseline(opts.dir);
  } catch (e) {
    process.stderr.write(`agenttruth: ${e.message}\n`);
    return 2;
  }

  const fileIndex = buildFileIndex(opts.dir);
  const docs = collectDocs(opts.dir, opts.files, cfg);
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
    if (cfg.checks.includes('numeric-claim')) {
      results.push(checkNumericClaims(rel, text, sources, opts.dir));
    }
    if (cfg.checks.includes('missing-file')) {
      results.push(checkFileReferences(rel, text, opts.dir, fileIndex));
    }
    if (cfg.checks.includes('broken-link')) {
      results.push(checkLinks(rel, text, opts.dir));
    }
    if (cfg.checks.includes('missing-command')) {
      results.push(checkCommands(rel, text, opts.dir, fileIndex));
    }
  }

  const all = results.flatMap((r) => r.findings);
  const { fresh, known } = partition(all, baseline);
  const payload = fresh.length ? [{ file: 'drift', findings: fresh }] : [];
  const { text, count, findings } = render(payload, { cwd: '' });

  if (opts.fix) {
    const fixes = planFixes(findings);
    if (fixes.length === 0) {
      process.stdout.write('agenttruth · nothing to auto-fix (only unambiguous counts are rewritten)\n');
      return count === 0 ? 0 : 1;
    }
    const applied = applyFixes(opts.dir, fixes);
    for (const a of applied) {
      process.stdout.write(`fixed ${a.file}:${a.line}  ${a.from} -> ${a.to}\n`);
    }
    const skipped = fixes.length - applied.length;
    process.stdout.write(
      `agenttruth · rewrote ${applied.length} claim${applied.length === 1 ? '' : 's'}` +
        (skipped > 0 ? `, ${skipped} left for manual fix (ambiguous)\n` : '\n')
    );
    return 0;
  }

  if (opts.updateBaseline) {
    const saved = saveBaseline(opts.dir, all);
    process.stdout.write(
      `agenttruth · recorded ${saved.count} finding${saved.count === 1 ? '' : 's'} in ${path.basename(saved.file)}\n`
    );
    return 0;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { docs: docs.length, count, baselined: known.length, findings },
        null,
        2
      ) + '\n'
    );
  } else if (!opts.quiet || count > 0) {
    const head =
      `agenttruth · ${docs.length} doc${docs.length === 1 ? '' : 's'} · ` +
      `${fileIndex.size} files indexed` +
      (cfg.source ? ` · ${cfg.source}` : '') + '\n';
    process.stdout.write(head + text);
    if (count === 0) {
      const clean =
        known.length > 0
          ? `  no new drift (${known.length} known finding${known.length === 1 ? '' : 's'} baselined).\n`
          : '  docs currently match the code.\n';
      process.stdout.write(clean);
    }
  }

  if (opts.failOn === 'none') return 0;
  return count > 0 ? 1 : 0;
}

process.exit(main());