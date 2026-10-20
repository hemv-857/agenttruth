# agenttruth

[![CI](https://github.com/hemv-857/agenttruth/actions/workflows/ci.yml/badge.svg)](https://github.com/hemv-857/agenttruth/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agenttruth)](https://www.npmjs.com/package/agenttruth)

**CI check that fails when `CLAUDE.md` / `AGENTS.md` / `README` stop matching the code they describe.**

Your agents read your instruction files on every run. If those files lie, every run is wrong — and nothing tells you, because docs don't fail builds.

```bash
npx agenttruth
```

```
agenttruth · 2 docs · 468 files indexed
8 drift findings in 1 file
README.md
    878  missing-file   references "policy.json" — no such file in repo
    904  missing-file   references "agent-browser.json" — no such file in repo
```

Exit code `1` — your CI fails. That's the point.

## Why

The 2026 agent-tooling wave is very good at *feeding* agents context and very bad at checking that context is true. `graphify`, `codegraph`, `archify`, `CLAUDE.md` generators — dozens of projects building knowledge graphs and instruction files. **Zero of them verify the output still matches the code.** So an agent reads a stale `CLAUDE.md` and confidently does the wrong thing.

`agenttruth` is the missing half: the CI gate that fails on drift.

## Install

```bash
npx agenttruth              # scan the current repo
npm i -D agenttruth         # or add to devDependencies
```

Requires Node 18+. Zero runtime dependencies.

## Checks

**`numeric-claim`** — a count in your docs that the code contradicts.

> README: *"covered by a 299-check behavior harness"* → repo has **266** assertions.

Counters are matched by kind, so a test count is never compared to an agent count. Only typo-sized differences are flagged (a stale count from an older commit), never unrelated numbers. Helper declarations (`function check()`) are excluded.

**`missing-file`** — docs name a file the repo doesn't ship.

> CONTRIBUTING: *"see `e2e_mcp.rs` for the integration harness"* → file does not exist.

It stays quiet on the things that aren't drift: badge URLs, `CLAUDE.md` files you tell people *not* to use, files a CLI command expects the user to supply (`--params @input.json`), submodule paths, and anything inside a fenced code block.

**`broken-link`** — a relative markdown link that resolves to nothing.

> README: *"see the [Authentication](docs/src/app/sessions/page.mdx) docs"* → file does not exist.

Also catches directory links with no index and anchors with no matching heading. Absolute `http(s)` links are skipped on purpose — verifying them would make CI depend on the network.

**`missing-command`** — docs tell you to run a build tool the repo doesn't have.

> README: *"make test"* → no `Makefile`, `makefile`, `GNUmakefile`, `Justfile`, or `justfile`.

Only counts commands in shell-fenced blocks, `$`-prefixed lines, or indented snippets. Prose like *"installation via npm is deprecated"* or *"a fix that doesn't make sense"* is never flagged.

### Auto-fix

```bash
npx agenttruth --fix
```

Rewrites stale counts to the measured value. **Only unambiguous ones** — if two files claim to hold "the agent catalog" and disagree, it refuses rather than guesses, because a wrong number in a README is worse than a stale one.

## Severity

| check | severity | why |
|---|---|---|
| `numeric-claim` | **error** | arithmetic — 299 claimed, 266 measured |
| `missing-file` | **error** | the file is either there or it isn't |
| `broken-link` | warning | could be an intentional external path |
| `missing-command` | warning | the tool may exist in the reader's environment |

```bash
npx agenttruth --fail-on error    # block the build on errors only
npx agenttruth --fail-on warning  # errors and warnings
```

## Inline disables

Every finding can be waved through in place, with a reason. All invisible in rendered markdown.

```markdown
<!-- agenttruth-disable-next-line reason: Makefile is vendored at build time -->
```bash
make test
```

```
<!-- agenttruth-disable-line -->       this line only
<!-- agenttruth-disable-file -->        the whole file
```

`disable-next-line` covers an entire fenced block when the next line opens one.

## GitHub code scanning

```yaml
- run: npx agenttruth --sarif agenttruth.sarif --fail-on none
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: agenttruth.sarif
```

Findings then annotate the exact file and line on the pull request, next to the diff that caused them — rather than scrolling past in a CI log.

## Speed

Counters are measured once per repo, not once per document. Before memoisation a 5,873-file repo with 42 markdown files took **4m34s** — nobody waits that long in CI. It now takes **~10s**, and `block/buzz` (5,873 files) and `openai/codex` (9,212 files) both complete in seconds. Output is byte-identical before and after.

## Only check what changed

```bash
npx agenttruth --changed origin/main
```

Scans only the doc files a branch touched, so the check is cheap enough to run on every push instead of nightly. Falls back to a full scan when the ref is missing or the tree isn't a git repo.

## CI

```yaml
- uses: hemv-857/agenttruth@v0
```

Or run it directly:

```yaml
- run: npx agenttruth
```

### Adopting without breaking your build

A repo that has been drifting for a year cannot adopt a checker that fails on day one — nobody reads 40 findings, everyone uninstalls. Baseline the existing findings, then CI fails only on **new** drift, which is the only thing anyone can act on:

```bash
npx agenttruth --update-baseline   # commit .agenttruth-baseline.json
```

Fix what you can, then re-baseline. Fingerprints ignore line numbers, so unrelated edits won't resurrect a suppressed finding.

## Config (optional)

`agenttruth.config.json` — every field has a working default:

```json
{
  "docs": ["README.md", "CLAUDE.md", "AGENTS.md"],
  "docsDir": "docs",
  "checks": ["numeric-claim", "missing-file", "broken-link", "missing-command"],
  "ignore": ["CHANGELOG.md"],
  "driftTolerance": 0.25
}
```

## MCP

Agents can check their own instructions before a run, and fix them when stale:

```json
{ "mcpServers": { "agenttruth": { "command": "npx", "args": ["-y", "agenttruth-mcp"] } } }
```

| tool | does |
|---|---|
| `check_drift` | findings with file and line, baseline-aware |
| `fix_drift` | rewrites unambiguous stale counts (`dry_run` supported) |
| `baseline_drift` | records current findings so CI fails only on new drift |
| `list_agent_docs` | which instruction files are inspected |

Zero dependencies — it speaks JSON-RPC over stdio directly.

## GitHub Action

```yaml
- run: npm install --no-save agenttruth
- uses: hemv-857/agenttruth@v0
  with:
    fail-on: error
    changed: origin/main     # only docs this branch touched
```

Findings annotate the pull request at the exact file and line, next to the diff that caused them — no code-scanning setup required. `fail-on` defaults to `error` so the action blocks on provable findings without failing builds on judgement calls.

The `v0` tag moves with each release, so you get fixes without editing the workflow. Pin `@v0.8.0` instead if you want the version frozen.

Prefer code scanning annotations? `sarif: agenttruth.sarif` writes a SARIF report for `github/codeql-action/upload-sarif`, and the action then skips its own annotations so nothing appears twice.

## Options

```
--dir <path>          repo root (default: cwd)
--json                machine-readable output (--format json)
--format <fmt>        text | json | github
--fail-on <sev>       error | warning | any | none (default: any) — exit threshold
--update-baseline     record current findings as known
--fix                 rewrite unambiguous stale counts to the measured value
--sarif [file]        write SARIF 2.1.0 for code scanning
--changed <ref>       only check docs changed since this git ref
-q, --quiet           print only when there are findings
```

`--format github` prints [workflow commands](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions), so plain `- run: npx agenttruth` annotates a PR diff too. It needs no code scanning, which matters on private repos where that requires GitHub Advanced Security.

## Honest scope

Four checks (`numeric-claim`, `missing-file`, `broken-link`, `missing-command`), each tuned for low false positives over recall. Errors and warnings are separated so `--fail-on error` can block on the provable ones and leave judgement calls visible. If it can't prove a file is wrong, it stays quiet.

Measured on ten repos — `claude-code`, `pretext`, `openai/codex`, `agent-browser`, `block/buzz`, `express`, `vite`, `eslint`, `vitest`, `babel` — it reports **0, 0, 2, 6, 9, 0, 0, 0, 0, 1**. Every one of those findings was inspected. Three were false positives (a docs-site route read as a repo path, a file inside a dot-directory the index skips) and are fixed, not explained away; the single `babel` hit is a real typo — `CONTRIBUTING.md` names `pluginsConfig.json`, the repo ships `pluginConfig.json`.

It behaves identically on a macOS checkout and a case-sensitive Linux CI runner. Docs are matched against their real on-disk names, so a repo shipping `Readme.md` is checked everywhere, and annotations point at a path that exists.

## License

MIT