import fs from 'node:fs';
import path from 'node:path';

const MAGNIFIERS = '\\d{1,3}(?:,\\d{3})*';
const NOUNS =
  'check|assert|test|provider|agent|model|example|sample|file|command|option|flag|skill|rule|line|migrat\\w*|endpoint|table|column|step|chapter|slide|item|entry|node|plugin|hook|template|preset|channel|message|event|task|job|run|benchmark|loc|kloc|catalog';
const CLAIM = new RegExp(
  // The noun must stand alone: "299 checks" is a claim, "256 test-results/" is a path.
  "(?<![\\\\w$/{}-])" + `(${MAGNIFIERS})[\\s-]+(?![\\d])(${NOUNS})(?:e?s)?(?![\\w-])`,
  'gi'
);

// Only compare a number against counters of the same kind.
// Stops "290 catalog agents" being judged against a count of test assertions.
const NOUN_GROUP = {
  check: 'test', assert: 'test', test: 'test', loc: 'test', kloc: 'test',
  agent: 'agent', catalog: 'agent',
  plugin: 'plugin', hook: 'plugin', template: 'plugin',
  provider: 'provider', model: 'provider', endpoint: 'provider',
  skill: 'item', rule: 'item', example: 'item', sample: 'item', file: 'item',
  command: 'item', option: 'item', flag: 'item', task: 'item', job: 'item',
  run: 'item', message: 'item', event: 'item', entry: 'item', node: 'item',
  table: 'item', column: 'item', step: 'item', chapter: 'item', slide: 'item',
  channel: 'item', preset: 'item', benchmark: 'item', example_: 'item',
};

const CONTEXT =
  /\b(all|exactly|contains?|covers?|includes?|ships?|supports?|provides?|registers?|total|currently|now|with|and|across|every|per)\b/i;

function countMatches(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n++;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

// Compile the declaration check once. Building a RegExp per file per macro
// cost ~30s on a 5,800-file repo.
const DECL_CACHE = new Map();
function hasDeclaration(text, macro) {
  let re = DECL_CACHE.get(macro);
  if (!re) {
    re = new RegExp(
      `(?:function|def|fn|func|sub|public|private|static|const|let|var)\\s+${macro.replace(/[(]/g, '\\(')}`
    );
    DECL_CACHE.set(macro, re);
  }
  return re.test(text);
}

const MACROS = ['check(', 'expect(', 'assert(', 'XCTAssert', 'test(', 'it(', 'describe('];
const ENUM_RE = /enum\s+\w+[^{]*\{([\s\S]{0,6000}?)\n\s*\}/g;
const CASE_RE = /^\s*case\s+\w+/gm;

// Counters extracted from source files.
function countersFromSource(text) {
  const out = [];
  ENUM_RE.lastIndex = 0;
  for (const m of text.matchAll(ENUM_RE)) {
    CASE_RE.lastIndex = 0;
    const cases = m[1].match(CASE_RE);
    if (cases) {
      out.push({
        count: cases.length,
        group: 'enum',
        why: `enum ${cases.length} cases (${m[0].slice(0, 32).replace(/\s+/g, ' ').trim()}…)`,
      });
    }
  }
for (const macro of MACROS) {
    const n = countMatches(text, macro);
    // Exclude the declaration itself — `func check(` is not a passing assertion.
    const count = hasDeclaration(text, macro) ? n - 1 : n;
    if (count > 0) out.push({ count, group: 'test', why: `${macro}… × ${count}` });
  }
  return out;
}

// Counters from JSON catalogs (agents.json and friends).
function countersFromCatalogs(repoRoot) {
  const out = [];
  const SKIP = new Set(['.git', 'node_modules', '.build', 'dist', 'target', 'Release']);
  (function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.json$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > 8_000_000) continue;
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        let n = null;
        let label = null;
        if (Array.isArray(data)) {
          n = data.length;
          label = path.basename(e.name);
        } else if (data && typeof data === 'object') {
          for (const key of ['agents', 'catalog', 'items', 'entries', 'models', 'providers', 'mascots']) {
            if (Array.isArray(data[key])) {
              n = data[key].length;
              label = `${path.basename(e.name)} → ${key}[]`;
              break;
            }
          }
        }
        if (n && n > 2) {
          const group = /agent|mascot|catalog/i.test(label) ? 'agent'
            : /model|provider/i.test(label) ? 'provider'
            : /plugin|hook|template/i.test(label) ? 'plugin'
            : 'item';
          out.push({ count: n, group, why: `${label} = ${n}` });
        }
      } catch {}
    }
  })(repoRoot, 0);
  return out;
}

// Counters are a property of the REPO, not of the doc being checked. Scanning
// every source file once per document turned a 5,800-file repo with 42 docs
// into 246,000 redundant passes (4m34s -> 10s once memoised).
//
// Keyed by repo root. When there is no root (unit tests, ad-hoc callers) the
// sources themselves identify the input, so fall back to identity — sharing a
// fixed key there would serve one fixture's counts to another.
const counterCache = new Map();
const MAX_CACHED_REPOS = 8;

function countersFor(sources, repoRoot) {
  const key = repoRoot ?? sources; // array identity when no root
  const hit = counterCache.get(key);
  if (hit) return hit;
  const built = [
    ...sources.flatMap(countersFromSource),
    ...(repoRoot ? countersFromCatalogs(repoRoot) : []),
  ];
  if (counterCache.size >= MAX_CACHED_REPOS) {
    counterCache.delete(counterCache.keys().next().value);
  }
  counterCache.set(key, built);
  return built;
}

export function resetCounterCache() {
  counterCache.clear();
}

export function checkNumericClaims(file, text, sources, repoRoot = null, opts = {}) {
  const findings = [];
  const counters = countersFor(sources, repoRoot);
  if (counters.length === 0) return { file, findings };

  const seen = new Set();
  for (const m of text.matchAll(CLAIM)) {
    const num = Number(m[1].replace(/,/g, ''));
    const noun = m[2].toLowerCase();
    const group = NOUN_GROUP[noun] ?? 'item';
    const line = text.slice(0, m.index).split('\n').length;
    const lineText = text.split('\n')[line - 1] ?? '';
    if (!CONTEXT.test(lineText)) continue;

    const eligible = counters.filter((c) => c.group === group);
    if (eligible.length === 0) continue;
    if (eligible.some((c) => c.count === num)) continue;

    // Typo-sized error only. Drift is usually a stale count from an earlier
    // commit, so the band is generous (25%), but wild numbers stay ignored.
    const tolerance = typeof opts.tolerance === 'number' && opts.tolerance > 0
      ? opts.tolerance
      : 0.25;
    const near = eligible.filter((c) =>
      // Band scales off the MEASURED count, not the claimed one. Scaling off
      // the claim means an inflated number widens its own tolerance — "I claim
      // 130 checks" would then tolerate a gap of 32 checks.
      Math.abs(c.count - num) <= Math.max(5, c.count * tolerance)
    );
    if (near.length === 0) continue;

    const key = `${line}:${num}:${noun}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Only offer an auto-fix when the intended counter is unambiguous. If the
    // candidates disagree, refuse — a wrong rewrite is worse than stale text,
    // because the author stops checking.
    const distinct = [...new Set(near.map((c) => c.count))];
    const fix =
      distinct.length === 1
        ? { from: m[1], to: String(distinct[0]) }
        : null;

    findings.push({
      file,
      line,
      rule: 'numeric-claim',
      message: `claims "${m[1]} ${noun}" — repo has ${distinct.join(', ')}`,
      detail: fix
        ? `counter: ${near[0].why}`
        : `ambiguous (${distinct.join(', ')}) — fix manually`,
      fix,
    });
  }
  return { file, findings };
}