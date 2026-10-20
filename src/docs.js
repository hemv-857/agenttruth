import fs from 'node:fs';
import path from 'node:path';

// Doc discovery, shared by the CLI and the MCP server so the two cannot drift
// apart about what counts as an instruction file.
//
// Configured names are matched case-insensitively against real directory
// entries. Two reasons this matters:
//
//   1. CI runs on Linux. `existsSync('README.md')` finds `Readme.md` on a
//      case-insensitive macOS checkout but not on a case-sensitive runner — so
//      a repo could show findings on a laptop and report "no docs found" on CI,
//      exiting 0 having checked nothing.
//   2. The `rel` we report is the name on disk. SARIF and workflow-command
//      annotations are matched against real paths by GitHub, so a finding
//      labelled README.md for a file named Readme.md does not link anywhere.
export function discoverDocs(root, cfg) {
  const ignore = new Set(cfg.ignore);
  const out = [];
  const seen = new Set();

  const rootFiles = byLowerName(root);
  for (const r of cfg.docs) {
    if (ignore.has(r)) continue;
    const actual = rootFiles.get(r.toLowerCase());
    if (!actual) continue;
    const full = path.join(root, actual);
    if (!fs.statSync(full).isFile()) continue;
    out.push({ rel: actual, full });
    seen.add(actual.toLowerCase());
  }

  const docsDir = path.join(root, cfg.docsDir);
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const e of fs.readdirSync(docsDir)) {
      if (!e.toLowerCase().endsWith('.md')) continue;
      const key = e.toLowerCase();
      if (ignore.has(`${cfg.docsDir}/${e}`) || seen.has(key)) continue;
      out.push({ rel: `${cfg.docsDir}/${e}`, full: path.join(docsDir, e) });
      seen.add(key);
    }
  }

  return out;
}

// A configured name may itself be a subpath (docs/foo.md), so resolve each
// path segment against the real entries of its directory.
function byLowerName(dir) {
  const map = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) map.set(e.name.toLowerCase(), e.name);
  return map;
}

// Used by the CLI when the caller names doc files on the command line.
// Always walks real directory entries rather than trusting existsSync, because
// on a case-insensitive checkout existsSync('README.md') is true for a file
// called Readme.md — and the caller needs the name that will actually resolve
// on a case-sensitive CI runner, not the one they happened to type.
export function resolveDocArg(root, rel) {
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel)) return abs;

  const parts = rel.split(/[\\/]/).filter((p) => p.length > 0);
  let dir = root;
  const matched = [];
  for (const part of parts) {
    const actual = byLowerName(dir).get(part.toLowerCase());
    // Unknown segment (typo, `..`, or a path outside the walk) — hand back the
    // literal path so the caller's own error message names what was typed.
    if (!actual) return abs;
    dir = path.join(dir, actual);
    matched.push(actual);
  }
  return path.join(root, ...matched);
}
