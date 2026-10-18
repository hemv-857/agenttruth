import fs from 'node:fs';
import path from 'node:path';

// A relative link in a README that 404s is drift the same way a wrong count
// is: the docs describe a repo that no longer exists in that shape.
//
// Only RELATIVE links are checked. Absolute http(s) links are a different
// class of problem (link rot), and verifying them would make CI depend on the
// network — unacceptable for a check that runs on every push.

const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function checkLinks(file, text, repoRoot) {
  const findings = [];
  const lines = text.split('\n');
  let inFence = false;

  lines.forEach((lineText, idx) => {
    if (/^\s*```/.test(lineText)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const seen = new Set();
    // Both patterns expose the target as group 2: [label](target) and ![alt](target).
    for (const re of [LINK, IMAGE]) {
      re.lastIndex = 0;
      for (const m of lineText.matchAll(re)) {
        const target = m[2];
        if (!target) continue;
        if (seen.has(target)) continue;
        seen.add(target);

        // Absolute, protocol-relative, mailto, and in-page anchors.
        if (/^[a-z][\w+.-]*:/i.test(target)) continue;
        if (target.startsWith('//') || target.startsWith('#')) continue;
        // A bare fragment path like `#/route` or `/docs/x` may be site-absolute.
        if (target.startsWith('/') && !fs.existsSync(path.join(repoRoot, target.slice(1)))) {
          // Could be a hosted-docs absolute path. Only flag if the repo has
          // a docs dir the path plausibly points into.
          const asPath = target.slice(1);
          if (fs.existsSync(path.join(repoRoot, asPath))) continue;
          if (/\.(html?|php)$/i.test(asPath)) continue;
        }

        const [pathPart, anchor] = target.split('#');
        if (pathPart === '') continue;
        const decoded = safeDecode(pathPart);
        const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), decoded);
        const rel = path.relative(repoRoot, resolved);

        if (!fs.existsSync(resolved)) {
          findings.push({
            file,
            line: idx + 1,
            rule: 'broken-link',
            message: `link target "${pathPart}" does not exist`,
            detail: `\`${m[1] || pathPart}\`](${target}) → ${rel}`,
          });
          continue;
        }
        // Link resolves to a directory: does it have an index file?
        if (fs.statSync(resolved).isDirectory()) {
          const hasIndex = ['index.md', 'index.html', 'README.md'].some((i) =>
            fs.existsSync(path.join(resolved, i))
          );
          if (!hasIndex) {
            findings.push({
              file,
              line: idx + 1,
              rule: 'broken-link',
              message: `link points at a directory with no index: "${pathPart}"`,
              detail: `\`${m[1] || pathPart}\`](${target})`,
            });
          }
        }
        // Anchor that no heading produces.
        if (anchor && fs.statSync(resolved).isFile()) {
          const target_ = fs.readFileSync(resolved, 'utf8');
          if (!slugExists(target_, anchor)) {
            findings.push({
              file,
              line: idx + 1,
              rule: 'broken-link',
              message: `anchor "#${anchor}" has no matching heading`,
              detail: `\`${m[1] || pathPart}\`](${target})`,
            });
          }
        }
      }
    }
  });

  return { file, findings };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function slugExists(md, anchor) {
  const want = decodeURIComponent(anchor).toLowerCase();
  for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    if (slugify(m[1]) === want) return true;
  }
  // Explicit anchors: <a id="..."> or <a name="...">
  for (const m of md.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) {
    if (m[1].toLowerCase() === want) return true;
  }
  return false;
}