import fs from 'node:fs';
import path from 'node:path';

// `--fix` rewrites a stale count to the value the repo actually measures.
//
// The risk is a wrong rewrite, so a fix is only applied when the counter is
// UNAMBIGUOUS: exactly one candidate of the right kind exists. If two files
// both claim to hold "the agent catalog" and they disagree, we refuse rather
// than guess — a wrong number in a README is worse than a stale one, because
// the author stops looking.

export function planFixes(findings) {
  const fixes = [];
  for (const f of findings) {
    if (f.rule !== 'numeric-claim' || !f.fix) continue;
    fixes.push({
      file: f.file,
      line: f.line,
      from: f.fix.from,
      to: f.fix.to,
      reason: f.message,
    });
  }
  return fixes;
}

export function applyFixes(root, fixes, { dryRun = false } = {}) {
  const byFile = new Map();
  for (const fix of fixes) {
    if (!byFile.has(fix.file)) byFile.set(fix.file, []);
    byFile.get(fix.file).push(fix);
  }

  const applied = [];
  for (const [rel, fileFixes] of byFile) {
    const full = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let changed = 0;
    // Apply bottom-up so earlier line indices stay valid.
    for (const fix of [...fileFixes].sort((a, b) => b.line - a.line)) {
      const idx = fix.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const before = lines[idx];
      const at = before.indexOf(fix.from);
      if (at === -1) continue;
      const after = before.slice(0, at) + fix.to + before.slice(at + fix.from.length);
      if (after === before) continue;
      lines[idx] = after;
      changed++;
      applied.push({ ...fix, before, after });
    }
    if (changed === 0) continue;
    if (!dryRun) fs.writeFileSync(full, lines.join('\n'));
  }
  return applied;
}
