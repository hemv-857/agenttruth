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
  if (cfg.ignore.includes(rel)) return false;
  if (cfg.docs.includes(rel)) return true;
  return rel.startsWith(cfg.docsDir + '/') && rel.endsWith('.md');
}

export function docFilesChanged(root, ref, cfg) {
  const changed = changedFiles(root, ref);
  if (changed === null) return null; // signals "scan everything"
  return changed.filter((rel) => isDocPath(rel, cfg));
}