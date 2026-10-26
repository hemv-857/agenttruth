import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from '../paths.js';

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
        // Site-absolute path: a leading `/` is repo-root-relative on GitHub,
        // but in a file under docs/ it is normally a route of the rendered
        // site (`/team`, `/guide/migration/`). Those are correct links, so only
        // a missing FILE-shaped path can be proven wrong — extensionless paths
        // and generated .html pages are treated as site routes.
        if (target.startsWith('/')) {
          const asPath = target.slice(1);
          if (!fs.existsSync(path.join(repoRoot, asPath))) {
            const bare = asPath.replace(/\/+$/, '');
            if (!/\.[A-Za-z0-9]+$/.test(bare)) continue;
            if (/\.(html?|php)$/i.test(bare)) continue;
          }
        }

        const [pathPart, anchor] = target.split('#');
        if (pathPart === '') continue;
        const decoded = safeDecode(pathPart);
        // A leading `/` is repo-root-relative on GitHub; resolving it as an
        // absolute filesystem path would look outside the repo (gin's
        // `/BENCHMARKS.md` exists at the repo root).
        const resolved = pathPart.startsWith('/')
          ? path.join(repoRoot, decoded.replace(/^\/+/, ''))
          : path.resolve(path.dirname(path.join(repoRoot, file)), decoded);
        const rel = toPosix(path.relative(repoRoot, resolved));

        if (!fs.existsSync(resolved)) {
          // `[installation guide](tutorial/#install-fastapi)` — an extensionless
          // target with a fragment addresses a page of the rendered docs site,
          // not a file in this tree (fastapi's README doubles as its docs home).
          if (anchor && !/\.[A-Za-z0-9]+$/.test(pathPart.replace(/\/+$/, ''))) continue;
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
  // Explicit anchors: <a id="...">, <a name="...">, <h3 name="..."> (ripgrep's
  // FAQ names HTML headings), and {#custom-anchor} in markdown.
  for (const m of md.matchAll(/<[a-z][\w-]*\s+[^>]*?(?:id|name)=["']([^"']+)["']/gi)) {
    if (m[1].toLowerCase() === want) return true;
  }
  for (const m of md.matchAll(/\{#([\w-]+)\}/g)) {
    if (m[1].toLowerCase() === want) return true;
  }
  return false;
}