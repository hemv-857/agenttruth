import { severityOf } from './severity.js';

// GitHub Actions workflow commands. Emitted on a step's stdout they become
// inline annotations on the pull request, next to the diff that caused them —
// the same result as a SARIF upload, but with no code-scanning setup and no
// GHAS requirement on private repos.
export function toWorkflowCommands(findings) {
  const lines = findings.map((f) => {
    const level = severityOf(f.rule) === 'error' ? 'error' : 'warning';
    return `::${level} file=${escapeProp(f.file)},line=${f.line},title=${escapeProp(f.rule)}::${escapeMsg(f.message)}`;
  });
  lines.push(
    `::notice::agenttruth: ${findings.length} doc drift finding${findings.length === 1 ? '' : 's'}`
  );
  return lines.join('\n');
}

// Workflow commands are read line-by-line: % \r \n must be escaped in values,
// and a property value cannot contain a comma or the parser stops early.
function escapeProp(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C');
}

function escapeMsg(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
