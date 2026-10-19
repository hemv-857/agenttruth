// Inline escape hatches.
//
// A checker with no way to say "yes, this one is fine" is a checker people
// uninstall. Three forms, all invisible in rendered markdown:
//
//   <!-- agenttruth-disable-next-line -->
//   <!-- agenttruth-disable-line reason: vendored at build time -->
//   <!-- agenttruth-disable-file reason: docs mirror an external site -->
//
// `disable-next-line` applies to the next NON-EMPTY line, so a directive can
// sit directly above a fenced block that starts on the following line.

const DIRECTIVE =
  /<!--\s*agenttruth-(disable-file|disable-line|disable-next-line)(?:\s+reason:\s*([\s\S]*?))?\s*-->/;

// `disable-next-line` applies to the next NON-EMPTY line, and — when that line
// opens a fenced block — to the whole block. A directive above
//
//   <!-- agenttruth-disable-next-line reason: Makefile is vendored -->
//   ```bash
//   make test
//   ```
//
// must silence the `make test` on the third line, not just the opening fence.

const FENCE_OPEN = /^\s*(`{3,})/;

function blockEnd(lines, start) {
  const open = lines[start].match(FENCE_OPEN)[1];
  for (let k = start + 1; k < lines.length; k++) {
    const close = lines[k].match(FENCE_OPEN);
    if (close && close[1].length >= open.length && lines[k].trim().match(/^`{3,}\s*$/)) {
      return k;
    }
  }
  return start;
}

export function parseDisables(file, text) {
  const lines = text.split('\n');
  const disabledLines = new Set();
  const reasons = [];
  let fileDisabled = false;

  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]);
    if (!m) continue;
    const kind = m[1];
    if (m[2]) reasons.push({ line: i + 1, reason: m[2] });

    if (kind === 'disable-file') {
      fileDisabled = true;
      continue;
    }
    if (kind === 'disable-line') {
      disabledLines.add(i + 1);
      continue;
    }
    // disable-next-line: walk forward to the next line that carries content,
    // consuming any further directives along the way.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    while (j < lines.length) {
      const next = DIRECTIVE.exec(lines[j]);
      if (next) {
        if (next[1] === 'disable-line') disabledLines.add(j + 1);
        j++;
        continue;
      }
      disabledLines.add(j + 1);
      if (FENCE_OPEN.test(lines[j])) {
        const end = blockEnd(lines, j);
        for (let k = j + 1; k <= end; k++) disabledLines.add(k + 1);
      }
      break;
    }
  }

  return { file: fileDisabled, lines: disabledLines, reasons };
}

export function applyDisables(findings, disablesByFile) {
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    const d = disablesByFile.get(f.file);
    if (d && (d.file || d.lines.has(f.line))) {
      suppressed.push(f);
      continue;
    }
    kept.push(f);
  }
  return { kept, suppressed };
}