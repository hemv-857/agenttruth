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

> README: *"covered by a 299-check behavior harness"* → repo has **267** assertions.

Counters are matched by kind, so a test count is never compared to an agent count. Only typo-sized differences are flagged (a stale count from an older commit), never unrelated numbers.

**`missing-file`** — docs name a file the repo doesn't ship.

> CONTRIBUTING: *"see `e2e_mcp.rs` for the integration harness"* → file does not exist.

It stays quiet on the things that aren't drift: badge URLs, `CLAUDE.md` files you tell people *not* to use, files a CLI command expects the user to supply (`--params @input.json`), submodule paths, and anything inside a fenced code block.

## CI

```yaml
- uses: hemv-857/agenttruth@v1
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
  "checks": ["numeric-claim", "missing-file"],
  "ignore": ["CHANGELOG.md"],
  "driftTolerance": 0.25
}
```

## MCP

Agents can check their own instructions before a run:

```json
{ "mcpServers": { "agenttruth": { "command": "npx", "args": ["-y", "agenttruth-mcp"] } } }
```

Two tools: `check_drift` (findings with file and line) and `list_agent_docs` (what gets inspected). Zero dependencies — it speaks JSON-RPC over stdio directly.

## Options

```
--dir <path>          repo root (default: cwd)
--json                machine-readable output
--fail-on <sev>       error | any | none (default: any) — exit threshold
--update-baseline     record current findings as known
-q, --quiet           print only when there are findings
```

## Honest scope

v1 does **two** checks well (`numeric-claim`, `missing-file`) and stays silent on anything it can't prove. It is tuned for low false positives over recall: on a sample of well-maintained repos it flags a handful of findings, and the ones we spot-checked are real drift. If it can't prove a file is wrong, it stays quiet.

## License

MIT