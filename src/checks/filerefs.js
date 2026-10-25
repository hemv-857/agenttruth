import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

// Config files are created by whoever runs the tool (codex's `requirements.toml`
// is written by an admin, agent-browser's `config.json` by the user), so a doc
// naming one says nothing about what the repo ships. A repo that DOES ship one
// is cleared by the basename lookup below before this matters.
const CONFIG_ARTIFACT = /^(?:requirements?|config|settings|preferences|options|defaults)\.(?:toml|json|jsonc|ya?ml|ini|conf)$/i;

const ARTIFACT_HINT = new RegExp(
  "you(?:'ll| will|r)?\\s+(?:create|write|save|generate|produce)" +
    '|create (?:a|an|your|the)|generated (?:by|at)|output (?:file|dir)' +
    '|will be (?:created|written|produced)|placeholder' +
    // "your project-level `agent-browser.json`", "auto-discovered config files"
    // — docs describing where the reader's own config may live.
    '|(?:user|project)-level|auto-discovered' +
    // "copy `.vscode/settings.example.json` into `.vscode/settings.json`" —
    // the destination does not exist yet by construction. The gap spans the
    // source filename, which itself contains dots.
    '|(?:copy|rename)\\b.{0,90}?\\b(?:into|to)\\b',
  'i'
);

// A markdown link is one claim about its TARGET. broken-link owns whether a
// relative target resolves, and a link into ANOTHER repository describes that
// repo's files — flagging its label here produced false positives on docs
// that cite sibling repos (buzz's solo-mobile-contract.md links every filename
// to block/buzz-app). But a code-host link into THIS repo still claims the
// label names a file here, which is how babel's `pluginsConfig.json` typo is
// caught. Ownership is decided by git remote origin; with no origin we cannot
// prove the link is ours, so we skip rather than risk a false positive.
const CODE_HOST_LINK = /https?:\/\/(?:www\.)?(github\.com|gitlab\.[a-z0-9.-]+|bitbucket\.org|codeberg\.org)\/([^/\s]+)\/([^/\s)?#]+)/i;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const originMemo = new Map();

function originOf(repoRoot) {
  if (originMemo.has(repoRoot)) return originMemo.get(repoRoot);
  let id = null;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/(?:https?:\/\/|git@)([^/:]+)[:/]+([^/]+)\/([^/]+?)(?:\.git)?\s*$/);
    if (m) id = `${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3].toLowerCase()}`;
  } catch { /* not a git checkout: identity unknowable */ }
  originMemo.set(repoRoot, id);
  return id;
}

function codeHostId(href) {
  const m = href.match(CODE_HOST_LINK);
  if (!m) return null;
  return `${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3].replace(/\.git$/i, '').toLowerCase()}`;
}

// Extensions the repo actually contains. A doc naming a source language the
// repo has none of is citing someone else's code (buzz, a Rust project, quotes
// Kubernetes `kubelet/container/helpers.go`); it cannot be drift. Config and
// data names are exempt from this rule so a young repo still answers for the
// files its docs promise.
const SOURCE_EXT = new Set([
  '.swift', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go', '.rb',
  '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh',
]);
const extSets = new WeakMap();
function extSetOf(fileIndex) {
  let set = extSets.get(fileIndex);
  if (!set) {
    set = new Set();
    for (const f of fileIndex.values()) set.add(path.extname(f).toLowerCase());
    extSets.set(fileIndex, set);
  }
  return set;
}

export function checkFileReferences(file, text, repoRoot, fileIndex) {
  const findings = [];
  const lines = text.split('\n');
  const ourSlug = (originOf(repoRoot) ?? '').split('/').slice(-2).join('/').toLowerCase();
  // A paragraph that names another project (`mattn/git-remote-s3`) describes
  // that project's files; the citation may sit a wrapped line above the file.
  let paraForeign = false;
  // Fenced blocks are samples and command output, not claims about the tree:
  // `c.File("local/file.go")` names a path the reader's app supplies.
  let inFence = false;

  lines.forEach((lineText, idx) => {
    if (/^\s*```/.test(lineText)) {
      inFence = !inFence;
      paraForeign = false;
      return;
    }
    if (inFence) return;
    if (!lineText.trim()) paraForeign = false;
    // Skip lines that are purely markup — badge <img>/<a href> URLs, raw HTML.
    // `skills.sh` inside an href is a website, not a file reference.
    const isHtml = /^\s*</.test(lineText);
    // Skip submodules: their files exist but aren't in this checkout.
    if (/^Submodule:|\.gitmodules/.test(lineText)) return;

    // Code-host citations on this line decide whose files we are looking at.
    // A line citing another repository describes THAT repo's files — buzzing's
    // solo-mobile-contract.md links every filename to block/buzz-app — and with
    // no origin we cannot prove a citation is ours, so both cases skip the line.
    const cited = [...lineText.matchAll(/https?:\/\/[^\s)\]>"']+/gi)]
      .map((u) => codeHostId(u[0]))
      .filter(Boolean);
    if (cited.length && (originOf(repoRoot) === null || cited.some((id) => id !== originOf(repoRoot)))) {
      return;
    }

    // Strip every markdown link; broken-link owns whether a relative target
    // resolves, and a bare URL must never read as a repo file. The exception:
    // a code-host link into THIS repo still claims its label names a file here
    // — that is what catches babel's `pluginsConfig.json` typo label.
    const scannable = lineText
      .replace(MARKDOWN_LINK, (full, label, target) => {
        const id = codeHostId(target);
        return id && id === originOf(repoRoot) ? ` ${label} ` : ' ';
      })
      .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');

    // "**`mattn/git-remote-s3`** uses a `latest.json` pointer" — a bolded
    // owner/repo with no extension names another project, and files in that
    // paragraph belong to it. Plain backticked pairs are just paths here
    // (`packages/babel-plugin-syntax-jsx`), so they must not trigger this.
    paraForeign ||= [...scannable.matchAll(/\*\*\s*`([\w.-]+)\/([\w.-]+)`\s*\*\*/g)].some(
      ([, a, b]) =>
        !b.includes('.') &&
        !a.startsWith('.') &&
        `${a}/${b}`.toLowerCase() !== ourSlug
    );
    if (paraForeign) return;

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
      // Root-absolute path: an HTTP route (`/.well-known/nostr.json`) or a
      // filesystem path the reader supplies — never a repo-relative file.
      if (m.index > 0 && scannable[m.index - 1] === '/') continue;
      // `org.eclipse.jgit/.../dfs/DfsRefDatabase.java` — an elided path cites
      // another project's source and cannot be verified here.
      if (/\/\.\.\.\/|\/…\//.test(m[0])) continue;
      // C/C++ system headers (`include/c++/12/bits/stl_vector.h`) are compiler
      // files, not repo files.
      if (/\binclude\/(?:c\+\+|c)\//.test(scannable)) continue;
      // `my-auth.json`, `example.json`, `out/result.json` — files the reader
      // creates, not files the repo ships. Referencing them is correct.
      if (USER_ARTIFACT.test(base)) continue;
      if (CONFIG_ARTIFACT.test(base)) continue;
      if (ARTIFACT_HINT.test(scannable)) continue;
      // A source language the repo has none of is being cited, not claimed.
      if (
        fileIndex &&
        SOURCE_EXT.has(path.extname(m[1]).toLowerCase()) &&
        !extSetOf(fileIndex).has(path.extname(m[1]).toLowerCase())
      ) continue;

      // The doc named a directory too, so check that exact path. The file
      // index skips dotfiles by design (`.vscode/settings.example.json` is
      // invisible to it), and a basename lookup alone would then report an
      // existing file as missing.
      if (m[0].includes('/') || m[0].includes('\\')) {
        const stated = m[0].replace(/^\.\//, '');
        if (fs.existsSync(path.join(repoRoot, stated))) continue;
      }

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
      if (/(?:--\S*|@\s*|\/tmp\/|~[^/\s]*\/|\.\/|\.\.\/|\$\{?\w+[}:]*\/?)$/.test(before)) continue;
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