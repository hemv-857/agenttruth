import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLinks } from '../src/checks/links.js';
import { checkFileReferences, buildFileIndex } from '../src/checks/filerefs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-prec-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function links(dir, rel) {
  return checkLinks(rel, fs.readFileSync(path.join(dir, rel), 'utf8'), dir).findings;
}

function fileRefs(dir, rel) {
  const idx = buildFileIndex(dir);
  return checkFileReferences(rel, fs.readFileSync(path.join(dir, rel), 'utf8'), dir, idx).findings;
}

// Every case below was found by spot-checking a real repository. Each was a
// false positive: a correct link or a correct file reference reported as drift,
// which is the one thing this tool must not do.

test('precision: site-absolute routes in a docs tree are not repo paths', () => {
  // vite: [Team page](/team) and vitest: [Migration Guides](/guide/migration/)
  // are routes of the rendered docs site, not files the repo ships.
  const dir = tmpdir({
    'docs/acknowledgements.md':
      'See the [Team page](/team) and [Migration](/guide/migration/).\n',
    'docs/guide/migration/index.md': '# Migration\n',
  });
  assert.equal(links(dir, 'docs/acknowledgements.md').length, 0);
});

test('precision: a generated .html page is a site route, not a missing file', () => {
  const dir = tmpdir({ 'docs/ack.md': 'See [changelog](/changelog.html)\n' });
  assert.equal(links(dir, 'docs/ack.md').length, 0);
});

test('precision: a missing site-absolute path shaped like a file is still flagged', () => {
  // `/docs/guide.md` is repo-root-relative on GitHub, so its absence is real.
  const dir = tmpdir({ 'docs/ack.md': 'See [gone](/docs/guide.md)\n' });
  const f = links(dir, 'docs/ack.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'broken-link');
});

test('precision: a file inside a dot-directory the index skips is not missing', () => {
  // babel: the file index deliberately omits dotfiles, so the check must
  // verify the stated path rather than search the index by basename. No
  // "copy" on this line, so only the stated-path check can clear it.
  const dir = tmpdir({
    'CONTRIBUTING.md': 'Use the template in `.vscode/settings.example.json`.\n',
    '.vscode/settings.example.json': '{}\n',
  });
  assert.equal(fileRefs(dir, 'CONTRIBUTING.md').length, 0);
});

test('precision: the destination of "copy X into Y" is created by the reader', () => {
  const dir = tmpdir({
    'CONTRIBUTING.md':
      'Copy the contents of `.vscode/settings.example.json` into `.vscode/settings.json`.\n',
    '.vscode/settings.example.json': '{}\n',
  });
  assert.equal(fileRefs(dir, 'CONTRIBUTING.md').length, 0);
});

test('precision: a genuinely absent file reference is still reported', () => {
  const dir = tmpdir({
    'CONTRIBUTING.md': 'Run `scripts/deploy.json` to configure.\n',
    'scripts/other.json': '{}\n',
  });
  const f = fileRefs(dir, 'CONTRIBUTING.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'missing-file');
});

// Ownership of a code-host citation is decided by `git remote origin`. These
// five cases all come from one line of one file in block/buzz and one in
// babel/babel: labels pointing into a sibling repo are that repo's business,
// labels pointing into this repo are claims about this repo.

function gitRepo(files, originUrl) {
  const dir = tmpdir(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir });
  return dir;
}

test('precision: a link label naming a file in ANOTHER repo is not missing here', () => {
  // buzz/docs/solo-mobile-contract.md links every filename to block/buzz-app.
  const dir = gitRepo(
    {
      'docs/solo.md':
        'The producer lives in [`SoloDraft.tsx`]' +
        '(https://github.com/block/buzz-app/blob/abc123/src/SoloDraft.tsx).\n',
    },
    'https://github.com/block/buzz.git'
  );
  assert.equal(fileRefs(dir, 'docs/solo.md').length, 0);
});

test('precision: bare filenames on a line citing another repo are that repo\'s', () => {
  // The same doc names a sibling-repo test file outside any link.
  const doc = 'Its test is `channel-writes.test.ts`, see ' +
    'https://github.com/block/buzz-app/blob/abc123/src/channel-writes.ts\n';
  const dir = gitRepo({ 'docs/solo.md': doc }, 'https://github.com/block/buzz.git');
  assert.equal(fileRefs(dir, 'docs/solo.md').length, 0);
  // Prove the URL is what silenced it, not the fixture being vacuous.
  const bare = gitRepo(
    { 'docs/solo.md': 'Its test is `channel-writes.test.ts`.\n', 'src/other.test.ts': '' },
    'https://github.com/block/buzz.git'
  );
  assert.equal(fileRefs(bare, 'docs/solo.md').length, 1);
});

test('precision: a link label naming a missing file in THIS repo is reported', () => {
  // babel/CONTRIBUTING.md:424 — label says pluginsConfig.json, the blob URL
  // (and the repo) ship pluginConfig.json. Readers see the label.
  const dir = gitRepo(
    {
      'CONTRIBUTING.md':
        'Add it to [`pluginsConfig.json`]' +
        '(https://github.com/babel/babel/blob/master/scripts/pluginConfig.json).\n',
      'scripts/pluginConfig.json': '{}\n',
    },
    'https://github.com/babel/babel.git'
  );
  const f = fileRefs(dir, 'CONTRIBUTING.md');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'missing-file');
  assert.match(f[0].message, /pluginsConfig\.json/);
});

test('precision: a self-repo citation on the line does not silence bare refs', () => {
  const dir = gitRepo(
    {
      'README.md':
        'See https://github.com/hemv-857/agenttruth/blob/main/docs/x.md ' +
        'then edit `missing-config.json`.\n',
      'other.json': '{}\n',
    },
    'https://github.com/hemv-857/agenttruth.git'
  );
  const f = fileRefs(dir, 'README.md');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /missing-config\.json/);
});

test('precision: an unverifiable origin silences code-host lines entirely', () => {
  // No git remote: we cannot prove the citation is ours, so we do not flag.
  const dir = tmpdir({
    'README.md':
      'See [`gone.ts`](https://github.com/any/repo/blob/main/gone.ts) ' +
      'and `also-gone.ts`.\n',
  });
  assert.equal(fileRefs(dir, 'README.md').length, 0);
});

// Second corpus pass: 18 findings across 16 repos (10 JS/TS + 6 Python/Go/Rust)
// were spot-checked line by line. Fifteen were describing files that belong to
// someone else — the user's machine, another project, the compiler, or an HTTP
// route — which is the same false positive class as a link label, so it is
// answered the same way: only claims about this tree may be reported.

test('precision: a home-directory path is the reader\'s file, not the repo\'s', () => {
  // agent-browser: `plugin add` writes `~/.agent-browser/config.json`.
  const dir = tmpdir({
    'README.md': 'Plugins are configured in `~/.agent-browser/config.json` (or `--config`).\n',
    'src/cli.ts': 'x\n',
  });
  assert.equal(fileRefs(dir, 'README.md').length, 0);
});

test('precision: a config file the reader or admin creates is not shipped', () => {
  // codex: "Admins can set ... in `requirements.toml`".
  const dir = tmpdir({
    'docs/config.md': 'Admins can set `allow_managed_hooks_only` in `requirements.toml`.\n',
    'Cargo.toml': '[package]\n',
  });
  assert.equal(fileRefs(dir, 'docs/config.md').length, 0);
});

test('precision: "project-level" config names the reader\'s file', () => {
  // agent-browser: "your project-level `agent-browser.json` contains ...".
  const dir = tmpdir({
    'README.md': 'If your project-level `agent-browser.json` has paths, gitignore it.\n',
    'src/app.ts': 'x\n',
  });
  assert.equal(fileRefs(dir, 'README.md').length, 0);
});

test('precision: an HTTP route in a table is not a repo path', () => {
  // buzz: | GET | `/.well-known/nostr.json` | NIP-05 identity |
  const dir = tmpdir({
    'ARCHITECTURE.md': '| GET | `/.well-known/nostr.json` | NIP-05 identity |\n',
    'src/lib.rs': 'x\n',
  });
  assert.equal(fileRefs(dir, 'ARCHITECTURE.md').length, 0);
});

test('precision: an elided path cites another project\'s source', () => {
  // buzz: (`org.eclipse.jgit/.../dfs/DfsRefDatabase.java`)
  const dir = tmpdir({
    'docs/design.md': 'JGit reduces refs to CAS (`org.eclipse.jgit/.../dfs/DfsRefDatabase.java`).\n',
    'src/lib.rs': 'x\n',
  });
  assert.equal(fileRefs(dir, 'docs/design.md').length, 0);
});

test('precision: a compiler system header in a stack trace is not a repo file', () => {
  // buzz: ././/include/c++/12/bits/stl_vector.h:1123: Assertion failed.
  const dir = tmpdir({
    'docs/trouble.md': '././/include/c++/12/bits/stl_vector.h:1123: Assertion failed\n',
    'src/lib.rs': 'x\n',
  });
  assert.equal(fileRefs(dir, 'docs/trouble.md').length, 0);
});

test('precision: a language the repo has none of is cited, not claimed', () => {
  // buzz (Rust): `kubelet/container/helpers.go` from Kubernetes.
  const dir = tmpdir({
    'docs/remote.md': 'A missing Secret self-heals (`kubelet/container/helpers.go`).\n',
    'src/lib.rs': 'x\n',
    'Cargo.toml': '[package]\n',
  });
  assert.equal(fileRefs(dir, 'docs/remote.md').length, 0);
  // ...but a repo that does contain .go files still answers for its paths.
  const withGo = tmpdir({
    'docs/remote.md': 'See `kubelet/container/helpers.go`.\n',
    'src/main.go': 'package main\n',
  });
  assert.equal(fileRefs(withGo, 'docs/remote.md').length, 1);
});

test('precision: a bolded foreign project name silences its paragraph', () => {
  // buzz: "**`mattn/git-remote-s3`** uses a `latest.json` pointer ..." —
  // the filename sits on the wrapped next line.
  const dir = tmpdir({
    'docs/design.md':
      '- **`mattn/git-remote-s3`** uses a\n  `latest.json` pointer with `If-Match`.\n',
    'package.json': '{}\n',
  });
  assert.equal(fileRefs(dir, 'docs/design.md').length, 0);
});

test('precision: a plain backticked dir pair is not a foreign project name', () => {
  // babel: `packages/babel-plugin-syntax-jsx` is a path in THIS repo and must
  // not silence the `pluginsConfig.json` typo later in the paragraph.
  const dir = gitRepo(
    {
      'CONTRIBUTING.md':
        '- Copy `packages/babel-plugin-syntax-jsx`.\n' +
        '- Add it to [`pluginsConfig.json`]' +
        '(https://github.com/babel/babel/blob/master/scripts/pluginConfig.json).\n',
      'packages/babel-plugin-syntax-jsx/index.js': '',
      'scripts/pluginConfig.json': '{}\n',
    },
    'https://github.com/babel/babel.git'
  );
  const f = fileRefs(dir, 'CONTRIBUTING.md');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /pluginsConfig\.json/);
});

test('precision: fenced samples name the reader\'s runtime paths', () => {
  // gin: c.File("local/file.go") inside a ```go block.
  const dir = tmpdir({
    'docs/doc.md': '```go\nrouter.GET("/f", func(c *gin.Context) {\n  c.File("local/file.go")\n})\n```\n',
    'main.go': 'package main\n',
  });
  assert.equal(fileRefs(dir, 'docs/doc.md').length, 0);
});
