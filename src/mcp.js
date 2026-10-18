#!/usr/bin/env node
// MCP stdio server: lets an agent verify the instruction files it is about to
// obey. Speaks line-delimited JSON-RPC 2.0 directly so the package keeps its
// zero-dependency promise — the four methods below are the whole protocol
// surface a tools-only server needs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkNumericClaims } from './checks/numeric.js';
import { checkFileReferences, buildFileIndex } from './checks/filerefs.js';
import { loadConfig } from './config.js';
import { loadBaseline, partition } from './baseline.js';

const PROTOCOL_VERSION = '2025-06-18';

function analyze(root) {
  const cfg = loadConfig(root);
  const fileIndex = buildFileIndex(root);
  const sources = [];
  const exts = new Set([
    '.swift', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.rs', '.go',
    '.rb', '.java', '.kt', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs',
  ]);
  for (const [, full] of fileIndex) {
    if (!exts.has(path.extname(full))) continue;
    try {
      if (fs.statSync(full).size > 1_500_000) continue;
      sources.push(fs.readFileSync(full, 'utf8'));
    } catch {}
  }

  const ignore = new Set(cfg.ignore);
  const docs = [];
  for (const rel of cfg.docs) {
    if (ignore.has(rel)) continue;
    const full = path.join(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) docs.push({ rel, full });
  }
  const docsDir = path.join(root, cfg.docsDir);
  if (fs.existsSync(docsDir)) {
    for (const e of fs.readdirSync(docsDir)) {
      if (!e.endsWith('.md')) continue;
      const rel = `${cfg.docsDir}/${e}`;
      if (ignore.has(rel)) continue;
      const full = path.join(docsDir, e);
      if (!docs.some((d) => d.full === full)) docs.push({ rel, full });
    }
  }

  const results = [];
  for (const { rel, full } of docs) {
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (cfg.checks.includes('numeric-claim')) {
      results.push(checkNumericClaims(rel, text, sources, root));
    }
    if (cfg.checks.includes('missing-file')) {
      results.push(checkFileReferences(rel, text, root, fileIndex));
    }
  }
  return { cfg, docs, results, filesIndexed: fileIndex.size };
}

function textOf(payload, root) {
  const all = payload.flatMap((r) => r.findings);
  if (all.length === 0) return 'No drift found. Documentation matches the code.';
  const lines = all.map(
    (f) => `${f.file}:${f.line}  ${f.rule}  ${f.message}`
  );
  return `${all.length} drift finding(s):\n${lines.join('\n')}`;
}

const TOOLS = [
  {
    name: 'check_drift',
    description:
      'Check whether this repo\'s CLAUDE.md / AGENTS.md / README still matches the code. ' +
      'Use before relying on an instruction file: stale instructions silently misdirect every run. ' +
      'Returns drift findings with file and line.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Repo root to scan. Defaults to the current directory.',
        },
        include_baselined: {
          type: 'boolean',
          description: 'Include findings recorded in .agenttruth-baseline.json. Default false.',
        },
      },
    },
  },
  {
    name: 'list_agent_docs',
    description:
      'List the instruction files agenttruth inspects in this repo, and whether each exists.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repo root. Defaults to cwd.' },
      },
    },
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agenttruth', version: '0.2.0' },
      });

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const root = path.resolve(args.dir || process.cwd());
      if (!fs.existsSync(root)) {
        return reply({
          content: [{ type: 'text', text: `No such directory: ${root}` }],
          isError: true,
        });
      }
      const { cfg, docs, results } = analyze(root);

      if (name === 'check_drift') {
        const all = results.flatMap((r) => r.findings);
        let payload = results;
        let suppressed = 0;
        if (!args.include_baselined) {
          const { fresh, known } = partition(all, loadBaseline(root));
          suppressed = known.length;
          payload = fresh.length ? [{ file: 'drift', findings: fresh }] : [];
        }
        const body = textOf(payload, root);
        const suffix =
          suppressed > 0
            ? `\n\n(${suppressed} known finding(s) suppressed by baseline — fix and re-baseline to see them.)`
            : '';
        return reply({
          content: [{ type: 'text', text: body + suffix }],
          isError: false,
        });
      }

      if (name === 'list_agent_docs') {
        const lines = docs.length
          ? docs.map((d) => `- ${d.rel}`).join('\n')
          : '- (none found)';
        return reply({
          content: [
            {
              type: 'text',
              text:
                `agenttruth checks these docs in ${root} ` +
                `(config: ${cfg.source ?? 'defaults'}):\n${lines}`,
            },
          ],
          isError: false,
        });
      }

      return reply({
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
      );
      continue;
    }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
});