import fs from 'node:fs';
import path from 'node:path';

// Config is optional. Every field has a working default; the file exists so a
// project can narrow the doc set or relax a threshold without forking.

const CONFIG_FILES = [
  'agenttruth.config.json',
  '.agenttruthrc',
  '.agenttruthrc.json',
];

const DEFAULTS = {
  docs: [
    'README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md',
    'ARCHITECTURE.md', 'DEVELOPMENT.md', 'SETUP.md', 'QUICKSTART.md',
    'GEMINI.md', '.cursorrules', '.windsurfrules',
  ],
  docsDir: 'docs',
  checks: ['numeric-claim', 'missing-file', 'broken-link', 'missing-command'],
  ignore: [],
  // A claim must be within this fraction of the real counter to count as a
  // typo. 0.25 catches stale counts without flagging unrelated numbers.
  driftTolerance: 0.25,
};

function validate(cfg, source) {
  if (cfg.docs !== undefined && !Array.isArray(cfg.docs)) {
    throw new Error(`${source}: "docs" must be an array of paths`);
  }
  if (cfg.checks !== undefined) {
    const known = new Set(['numeric-claim', 'missing-file', 'broken-link', 'missing-command']);
    const bad = (cfg.checks ?? []).filter((c) => !known.has(c));
    if (bad.length) {
      throw new Error(
        `${source}: unknown check(s) ${bad.join(', ')}. Known: ${[...known].join(', ')}`
      );
    }
  }
  if (
    cfg.driftTolerance !== undefined &&
    (typeof cfg.driftTolerance !== 'number' || cfg.driftTolerance <= 0)
  ) {
    throw new Error(`${source}: "driftTolerance" must be a positive number`);
  }
  return cfg;
}

export function loadConfig(root) {
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${name} is not valid JSON: ${e.message}`);
    }
    return {
      ...DEFAULTS,
      ...validate(parsed, name),
      source: name,
    };
  }
  return { ...DEFAULTS, source: null };
}