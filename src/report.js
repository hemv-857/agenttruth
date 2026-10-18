export function finding(file, line, rule, message, detail) {
  return { file, line, rule, message, detail };
}

export function render(results, { cwd = '' } = {}) {
  const all = results.flatMap((r) => r.findings);
  if (all.length === 0) {
    return {
      text: `No drift found across ${results.length} checked file(s).`,
      count: 0,
      findings: [],
    };
  }
  const byFile = new Map();
  for (const f of all) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const lines = [];
  for (const [file, fs] of [...byFile].sort()) {
    lines.push(`\n${cwd}${file}`);
    for (const f of fs.sort((a, b) => a.line - b.line)) {
      lines.push(`  ${String(f.line).padStart(5)}  ${f.rule.padEnd(16)}  ${f.message}`);
      if (f.detail) lines.push(`         ${'-'.repeat(4)} ${f.detail}`);
    }
  }
  const text =
    `${all.length} drift finding${all.length === 1 ? '' : 's'} in ` +
    `${byFile.size} file${byFile.size === 1 ? '' : 's'}` +
    `${lines.join('\n')}\n`;
  return { text, count: all.length, findings: all };
}