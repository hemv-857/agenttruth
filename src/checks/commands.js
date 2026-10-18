import fs from 'node:fs';
import path from 'node:path';

// Docs tell you how to build, test, and run. If the tool they name isn't in
// the repo, an agent following the instructions fails on its first command.
//
// Only leading build-tool invocations are checked, and only when the file
// that would define them is absent. A bare `pytest` in a prose paragraph is
// not a claim.

const RUNNERS = {
  make: ['Makefile', 'makefile', 'GNUmakefile', 'Justfile', 'justfile'],
  just: ['Justfile', 'justfile'],
  gradle: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  mvn: ['pom.xml'],
  cargo: ['Cargo.toml'],
  npm: ['package.json'],
  pnpm: ['package.json'],
  yarn: ['package.json'],
  bun: ['package.json'],
  swift: ['Package.swift'],
  cmake: ['CMakeLists.txt'],
  bazel: ['BUILD', 'BUILD.bazel', 'WORKSPACE', 'MODULE.bazel'],
  poetry: ['pyproject.toml'],
  uv: ['pyproject.toml', 'uv.lock'],
  composer: ['composer.json'],
  bundle: ['Gemfile'],
  mix: ['mix.exs'],
  dotnet: ['*.csproj', '*.sln'],
  rake: ['Rakefile'],
};

// `make test`, `npx build`, `cargo run` — tool at the start of a code span
// or a shell line, optionally npx/bunx/uvx-prefixed.
const INVOCATION = new RegExp(
  `(?<![\\w-])(?:npx|bunx|pnpm dlx|uvx|poetry run|\\./)?\\b(${Object.keys(RUNNERS).join('|')})\\s+(?![-])([\\w][\\w:.-]*)`,
  'g'
);

// A line that is obviously an example, not an instruction to run this repo.
const EXAMPLE_HINT =
  /(?:e\.g\.|for example|output|prints|returns|yields|such as|like|→|->|reads?|writes?|contains?|means|describes?|e\.g\b)/i;

function hasProjectFile(root, names) {
  for (const n of names) {
    if (n.includes('*')) {
      const re = new RegExp('^' + n.replace(/\*/g, '.*') + '$');
      let entries;
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      if (entries.some((e) => re.test(e))) return true;
    } else if (fs.existsSync(path.join(root, n))) {
      return true;
    }
  }
  return false;
}

// A command is only a CLAIM about this repo when it appears in an instructional
// position: a fenced shell block, a shell prompt line, or an indented snippet.
// Prose that merely names a tool ("installation via npm is deprecated", "makes
// sense", "just the one") is not a claim, and flagging it is the fastest way
// to make a linter uninstalled.
const FENCE_LINE = /^\s*(`{3,})/;
const SHELL_LANGS = new Set(['bash','sh','shell','zsh','console','shell-session','shellsession','']);
const PROMPT_LINE = /^[\s>*_-]*\$\s+\S/;

// Tool names that are ordinary English words. `make sense`, `just the one`,
// `cargo cult` — these must never be read as invocations.
const ENGLISH_WORD_TARGETS = new Set([
  'sense', 'the', 'a', 'an', 'it', 'this', 'that', 'your', 'my', 'no', 'not',
  'sure', 'surely', 'file', 'files', 'room', 'up', 'out', 'work', 'works',
  'easy', 'simple', 'fast', 'better', 'best', 'so', 'if', 'when',
]);

export function checkCommands(file, text, repoRoot, fileIndex) {
  const findings = [];
  const lines = text.split('\n');
  let fence = null; // language of the open fence, null when not in one
  let indentSnippet = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx];

    const fenceMatch = lineText.match(FENCE_LINE);
    if (fenceMatch) {
      if (fence === null) {
        const lang = lineText.slice(fenceMatch[1].length).trim().toLowerCase();
        fence = lang || 'shell';
      } else {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      // Inside a recognised shell fence, the line IS an instruction.
      if (!SHELL_LANGS.has(fence)) continue;
      indentSnippet = true;
    } else {
      const isPrompt = PROMPT_LINE.test(lineText);
      if (!isPrompt) indentSnippet = /^(?: {4}|\t)\S/.test(lineText);
      if (!isPrompt && !indentSnippet) continue;
    }
    if (EXAMPLE_HINT.test(lineText)) continue;

    const bodyLine = lineText.replace(/^[\s>*_$-]*\$\s?/, '').replace(/^(?: {4}|\t)/, '');
    INVOCATION.lastIndex = 0;
    for (const m of bodyLine.matchAll(INVOCATION)) {
      const tool = m[1];
      const target = m[2];
      if (!target || target.startsWith('-')) continue;
      if (ENGLISH_WORD_TARGETS.has(target.toLowerCase())) continue;
      const projectFiles = RUNNERS[tool];
      if (!projectFiles) continue;
      if (hasProjectFile(repoRoot, projectFiles)) continue;

      const anyRepo = [...fileIndex.values()].some((f) =>
        projectFiles.some((n) => path.basename(f) === n)
      );
      if (anyRepo) continue;

      findings.push({
        file,
        line: idx + 1,
        rule: 'missing-command',
        message: `docs run \`${tool} ${target}\` but repo has no ${projectFiles[0]}`,
        detail: `no ${projectFiles.join('/')} in repo root`,
      });
    }
  }
  return { file, findings };
}
