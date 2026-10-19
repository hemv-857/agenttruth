// SARIF 2.1.0 for GitHub code scanning.
//
// Static output is not enough: a CI log line scrolls past, but a SARIF upload
// annotates the exact file and line on the pull request, next to the diff that
// caused it. That is the difference between a tool people read and a tool
// people rerun.

import { RULES, severityOf } from './severity.js';

const SARIF_LEVEL = { error: 'error', warning: 'warning' };

export function toSarif(findings, { repoUrl } = {}) {
  const rules = Object.entries(RULES).map(([id, meta]) => ({
    id,
    name: id,
    shortDescription: { text: id },
    fullDescription: { text: meta.help },
    defaultConfiguration: { level: SARIF_LEVEL[meta.severity] ?? 'warning' },
    helpUri: repoUrl ? `${repoUrl}#${id}` : undefined,
  }));

  const used = new Set(findings.map((f) => f.rule));
  const results = findings.map((f, i) => ({
    ruleId: f.rule,
    level: SARIF_LEVEL[severityOf(f.rule)] ?? 'warning',
    message: { text: f.detail ? `${f.message} — ${f.detail}` : f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: Math.max(1, f.line) },
        },
      },
    ],
    partialFingerprints: { agenttruthFinding: `${f.file}:${f.rule}:${i}` },
  }));

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'agenttruth',
            informationUri: repoUrl ?? 'https://github.com/hemv-857/agenttruth',
            rules: rules.filter((r) => used.has(r.id)),
          },
        },
        results,
      },
    ],
  };
}