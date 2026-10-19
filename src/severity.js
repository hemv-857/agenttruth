// Severity drives --fail-on. A checker that treats a proven contradiction the
// same as a heuristic guess forces users to ignore everything or fail on
// everything, so the two are separated.
//
// error   — proven from the repo. "299 checks" vs 266 measured assertions is
//           arithmetic, not a judgement call.
// warning — a real signal that could still be intentional.

export const RULES = {
  'numeric-claim': {
    severity: 'error',
    help: 'The number in the doc contradicts a counter measured from the code.',
  },
  'missing-file': {
    severity: 'error',
    help: 'The doc names a file that does not exist in the repository.',
  },
  'broken-link': {
    severity: 'warning',
    help: 'A relative markdown link resolves to a path that does not exist.',
  },
  'missing-command': {
    severity: 'warning',
    help:
      'The doc instructs running a build tool with no project file in the repo. ' +
      'May be intentional when the tool is expected in the reader environment.',
  },
};

export const SEVERITIES = ['error', 'warning'];

export function severityOf(rule) {
  return RULES[rule]?.severity ?? 'warning';
}

export function summarize(findings) {
  return {
    error: findings.filter((f) => severityOf(f.rule) === 'error').length,
    warning: findings.filter((f) => severityOf(f.rule) === 'warning').length,
  };
}

// `error`   → fail on errors only
// `warning` → fail on errors and warnings
// `any`     → fail on anything
// `none`    → never fail
export function shouldFail(findings, threshold) {
  if (threshold === 'none') return false;
  const { error, warning } = summarize(findings);
  if (threshold === 'error') return error > 0;
  if (threshold === 'warning') return error + warning > 0;
  return error + warning > 0;
}

export function isValidThreshold(t) {
  return t === 'error' || t === 'warning' || t === 'any' || t === 'none';
}