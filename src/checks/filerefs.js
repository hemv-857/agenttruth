import fs from 'node:fs';
import path from 'node:path';

// Docs name files: `AppStore.swift`, `harness.swift`, `build_release.sh`
// Verify each named file exists somewhere in the repo, with the right extension.

const CODE_EXT = [
  '.swift', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go', '.rb',
  '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.json', '.yml', '.yaml', '.toml', '.sql',
];

const IGNORE_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'README.md',
  'LICENSE', 'Makefile', 'Dockerfile', '.gitignore',
]);

// Paths that live in git submodules — absent from normal CI checkouts, so
// their absence is not drift.
const SUBMODULE_PREFIXES = new Set(['opensrc', 'third_party', 'thirdparty', 'vendor']);

// Names that describe a file the *reader* creates, not one the repo ships.
// Referencing these in docs is correct and must never be flagged.
const USER_ARTIFACT = new RegExp(
  '^(my|your|example|sample|demo|tmp|temp|local|out|output|dist|build|result|results|data|dump|export|snapshot|snapshots|cache|scratch|test-results?|node_modules|coverage|ci-|custom|\\.|_)'
);
const ARTIFACT_HINT = /(?:you(?:'ll| will|r)?\s+(?:create|write|save|generate|produce)|create (?:a|an|your|the)|generated (?:by|at)|output (?:file|dir)|will be (?:created|written|produced)|placeholder)/i;

export function checkFileReferences(file, text, repoRoot, fileIndex) {
  const findings = [];
  const lines = text.split('\n');

  lines.forEach((lineText, idx) => {
    // Skip fenced code blocks (architecture trees are real claims, code samples are not).
    if (/^\s*```/.test(lineText)) return;
    // Skip lines that are purely markup — badge <img>/<a href> URLs, raw HTML.
    // `skills.sh` inside an href is a website, not a file reference.
    const isHtml = /^\s*</.test(lineText);
    // Skip submodules: their files exist but aren't in this checkout.
    if (/^Submodule:|\.gitmodules/.test(lineText)) return;

    // Strip URLs before scanning so href/src/badge text can never be read as a
// repo file. Only real URL forms are removed — a bare `foo.sh` is a file.
const scannable = lineText.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '  ');

    const refs = scannable.matchAll(
      /(?<![\w.-])(?:[\w.-]+[\\/])*([A-Za-z0-9_.-]+\.(?:swift|ts|tsx|js|mjs|py|rs|go|rb|java|kt|c|h|cpp|cs|php|sh|json|yml|yaml|toml|sql))(?![\w])/g
    );

    // A doc that says "not `X`" or "use `Y`, not `X`" is instructing, not claiming.
    // Any line with a prohibition word before a filename is a style rule.
    const isInstruction = /\b(?:not|never|avoid|don'?t|do not|no|rather than|instead of)\b/i.test(scannable);

    for (const m of refs) {
      const base = path.basename(m[1]);
      if (IGNORE_BASENAMES.has(base)) continue;
      if (!CODE_EXT.includes(path.extname(m[1]))) continue;
      if (isHtml) continue;
      if (isInstruction) continue;
      // `my-auth.json`, `example.json`, `out/result.json` — files the reader
      // creates, not files the repo ships. Referencing them is correct.
      if (USER_ARTIFACT.test(base)) continue;
      if (ARTIFACT_HINT.test(scannable)) continue;

      // Bare filename mentioned: verify a file with this name exists in the repo.
      const hits = [...fileIndex.values()].filter((f) => path.basename(f) === base);
      if (hits.length > 0) continue; // exact basename exists, doc is correct

      // Does it look like a real file reference (not prose)? Require backticks
      // or a path. Bare prose mentions are too weak to fail a build on.
      const inBackticks = scannable.includes('`' + m[1] + '`');
      const inPath = scannable.includes('/' + base) || scannable.includes('\\' + base);
      if (!inBackticks && !inPath) continue;
      // Path points into a submodule/dir absent from a shallow clone.
      const firstSeg = m[0].split(/[\\/]/)[0];
      if (SUBMODULE_PREFIXES.has(firstSeg)) continue;
      // Appears as a CLI/runtime value — the path is supplied by whoever runs the
      // command, so its absence from the repo is not drift:
      //   --messages /tmp/msgs.json    ./agent-browser.json    @input.json
      const at = scannable.indexOf(base);
      const before = scannable.slice(0, at).replace(/[`'"\s]+$/, '');
      if (/(?:--\S*|@\s*|\/tmp\/|\.\/|\.\.\/|\$\{?\w+[}:]*\/?)$/.test(before)) continue;
      // "writes `./x.json`", "creates `x.json`" — produced at runtime.
      if (/\b(?:writes?|creates?|generates?|emits?|saves?|outputs?|produces?)\b[^.]{0,40}$/i.test(before)) continue;

      findings.push({
        file,
        line: idx + 1,
        rule: 'missing-file',
        message: `references "${base}" — no such file in repo`,
        detail: `named in docs, absent from the tree`,
      });
    }
  });

  return { file, findings };
}

export function buildFileIndex(repoRoot) {
  const index = new Map();
  const SKIP = new Set(['.git', 'node_modules', '.build', 'dist', 'target', 'vendor', '.next']);
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full);
      } else {
        index.set(path.relative(repoRoot, full), full);
      }
    }
  })(repoRoot);
  return index;
}