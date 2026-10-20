import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprint as fingerprintOf } from '../src/baseline.js';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agenttruth-mcp.js');

function tmpdir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttruth-mcp-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// Drive the server over stdio exactly as an MCP client would.
function rpc(dir, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [MCP], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const out = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
        if (out.length === messages.length) {
          child.kill();
          resolve(out);
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    setTimeout(() => {
      child.kill();
      reject(new Error(`timeout; got ${out.length}/${messages.length} replies`));
    }, 20000);
  });
}

const SRC_100 = Array.from({ length: 100 }, (_, i) => `check("a${i}");`).join('\n');
const driftDir = () =>
  tmpdir({ 'README.md': 'Covered by all 120-checks in CI, running every day.\n', 'test.js': SRC_100 });

test('mcp: initialize returns protocol and server info', async () => {
  const [r] = await rpc('.', [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  ]);
  assert.equal(r.id, 1);
  assert.equal(r.result.serverInfo.name, 'agenttruth');
  assert.ok(r.result.protocolVersion);
  assert.ok(r.result.capabilities.tools);
});

test('mcp: tools/list exposes every tool with a schema and description', async () => {
  const [r] = await rpc('.', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['baseline_drift', 'check_drift', 'fix_drift', 'list_agent_docs']);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
});

test('mcp: check_drift reports real drift', async () => {
  const dir = driftDir();
  const [r] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  const text = r.result.content[0].text;
  assert.match(text, /drift finding/);
  assert.match(text, /numeric-claim/);
  assert.match(text, /README\.md:\d+/);
  assert.equal(r.result.isError, false);
});

test('mcp: check_drift is clean on a clean repo', async () => {
  const dir = tmpdir({
    'README.md': 'Covered by all 100-checks in CI, running every day.\n',
    'test.js': SRC_100,
  });
  const [r] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  assert.match(r.result.content[0].text, /No drift found/);
});

test('mcp: check_drift honours the baseline unless asked otherwise', async () => {
  const dir = driftDir();
  const f = { file: 'README.md', line: 1, rule: 'numeric-claim', message: 'claims "120 check" — repo has 100' };
  fs.writeFileSync(
    path.join(dir, '.agenttruth-baseline.json'),
    JSON.stringify({ version: 1, fingerprints: [fingerprintOf(f)] })
  );
  const [suppressed] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  assert.match(suppressed.result.content[0].text, /No drift found/);
  assert.match(suppressed.result.content[0].text, /suppressed by baseline/);

  const [full] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir: dir, include_baselined: true } } },
  ]);
  assert.match(full.result.content[0].text, /drift finding/);
});

test('mcp: unknown tool returns isError, not a crash', async () => {
  const [r] = await rpc('.', [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
  ]);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown tool/);
});

test('mcp: unknown method returns a JSON-RPC error', async () => {
  const [r] = await rpc('.', [{ jsonrpc: '2.0', id: 7, method: 'does/not/exist' }]);
  assert.equal(r.error.code, -32601);
});

test('mcp: list_agent_docs names the files it inspects', async () => {
  const dir = driftDir();
  const [r] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_agent_docs', arguments: { dir } } },
  ]);
  assert.match(r.result.content[0].text, /README\.md/);
});

test('mcp: nested agent files are listed and checked', async () => {
  const dir = tmpdir({ 'src/x/AGENTS.md': 'See `config/policy.json` at startup.\n' });
  const [listed, checked] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_agent_docs', arguments: { dir } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  assert.match(listed.result.content[0].text, /src\/x\/AGENTS\.md/);
  const body = checked.result.content[0].text;
  assert.match(body, /src\/x\/AGENTS\.md/);
  assert.match(body, /policy\.json/);
});


// ---------- fix_drift / baseline_drift ----------

test('mcp: fix_drift dry_run reports without writing', async () => {
  const dir = driftDir();
  const before = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const [r] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fix_drift', arguments: { dir, dry_run: true } } },
  ]);
  assert.match(r.result.content[0].text, /Would rewrite/);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before);
});

test('mcp: fix_drift rewrites and the repo then reads clean', async () => {
  const dir = driftDir();
  const [fix] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fix_drift', arguments: { dir } } },
  ]);
  assert.match(fix.result.content[0].text, /Rewrote/);
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /100-checks/);

  const [check] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  assert.match(check.result.content[0].text, /No drift found/);
});

test('mcp: fix_drift is honest when there is nothing unambiguous to fix', async () => {
  const dir = tmpdir({
    'README.md': 'See [gone](./nope.md)\n',
    'other.md': '# Other\n',
  });
  const [r] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fix_drift', arguments: { dir } } },
  ]);
  assert.match(r.result.content[0].text, /Nothing to auto-fix/);
  assert.equal(r.result.isError, false);
});

test('mcp: baseline_drift records findings that check_drift then suppresses', async () => {
  const dir = driftDir();
  const [b] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baseline_drift', arguments: { dir } } },
  ]);
  assert.match(b.result.content[0].text, /Recorded \d+ finding/);
  assert.ok(fs.existsSync(path.join(dir, '.agenttruth-baseline.json')));

  const [c] = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_drift', arguments: { dir } } },
  ]);
  assert.match(c.result.content[0].text, /No drift found/);
  assert.match(c.result.content[0].text, /suppressed by baseline/);
});

test('mcp: tools/list advertises all four tools with descriptions', async () => {
  const [r] = await rpc('.', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['baseline_drift', 'check_drift', 'fix_drift', 'list_agent_docs']);
  for (const t of r.result.tools) assert.ok(t.description.length > 20);
});
