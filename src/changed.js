import { execFileSync } from 'node:child_process';
import path from 'node:path';

// CI runs on every push but most pushes touch no docs. Checking only the
// files a branch actually changed turns a repo-wide scan into a near-free
// one, so the check can live on every PR instead of a nightly job.

export function changedFiles(root, ref) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // Not a git repo, ref doesn't exist, or no merge base — fall back to all.
    return null;
  }
}

export function isDocPath(rel, cfg) {
  // Case-insensitive for the same reason discovery is: git reports the name on
  // disk (`Readme.md`) while config lists `README.md`, and on a case-sensitive
  // runner an exact match would skip the one doc this branch actually touched.
  const lower = rel.toLowerCase();
  // Config is written with `/`; Windows users may type `\\`.
  if (cfg.ignore.some((i) => i.replace(/\\/g, '/').toLowerCase() === lower)) return false;
  if (cfg.docs.some((d) => d.toLowerCase() === lower)) return true;
  if (lower.startsWith(cfg.docsDir.toLowerCase() + '/') && lower.endsWith('.md')) return true;
  // Nested agent files, mirroring what discovery recurses for.
  return (cfg.agentDocs ?? []).some((n) => n.toLowerCase() === path.basename(lower));
}

export function docFilesChanged(root, ref, cfg) {
  const changed = changedFiles(root, ref);
  if (changed === null) return null; // signals "scan everything"
  return changed.filter((rel) => isDocPath(rel, cfg));
}