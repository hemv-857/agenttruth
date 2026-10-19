// Entry point for the GitHub Action.
//
// A JS action cannot reference files outside its own directory, so this thin
// wrapper resolves the CLI from node_modules (installed by the caller's
// workflow) or from the action's own checkout, then forwards the inputs.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveCli() {
  // The consuming workflow's node_modules is where `npm install agenttruth`
  // puts the CLI — that is the normal case, so check it first.
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'agenttruth', 'bin', 'agenttruth.js'),
    // Monorepo checkout where the action sits beside the package.
    path.join(here, '..', 'bin', 'agenttruth.js'),
    path.join(here, '..', '..', 'bin', 'agenttruth.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to whatever the PATH resolves, in case it was installed globally.
  const which = spawnSync('node', ['-e', 'process.stdout.write(require.resolve("agenttruth/bin/agenttruth.js"))'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new Error(
    'agenttruth: CLI not found. Install it in a step before this one:\n' +
      '  - run: npm install --no-save agenttruth\n'
  );
}

const args = [resolveCli(), '--dir', process.env.INPUT_DIR || '.'];

const failOn = process.env.INPUT_FAIL_ON;
if (failOn) args.push('--fail-on', failOn);

const changed = process.env.INPUT_CHANGED;
if (changed && changed.trim()) args.push('--changed', changed.trim());

const sarif = process.env.INPUT_SARIF;
if (sarif && sarif.trim()) args.push('--sarif', sarif.trim());

const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
