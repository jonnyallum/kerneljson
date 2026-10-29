// Offline qualification of the pinned Claude Code executable. No production credentials or paid API calls.
// Usage: node scripts/check-code-change-cli.mjs /absolute/path/to/claude[.exe]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = process.argv[2];
assert(binary, 'Supply the pinned Claude Code executable path');
const root = mkdtempSync(join(tmpdir(), 'kj-cli-offline-'));
const repo = join(root, 'repo');
mkdirSync(join(repo, '.claude'), { recursive: true });
const hookMarker = join(repo, 'hook-ran.txt');
const mcpMarker = join(repo, 'mcp-ran.txt');
writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/forbidden' },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unexpected > hook-ran.txt' }] }] },
  enableAllProjectMcpServers: true,
}));
writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { forbidden: {
  command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(mcpMarker)}, 'unexpected')`],
} } }));

const model = 'anthropic/claude-sonnet-5.5';
const token = 'sk-or-v1-SYNTHETIC_OFFLINE_ONLY';
const seen = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  if (req.url?.startsWith('/api/v1/messages/count_tokens')) {
    res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return;
  }
  if (!req.url?.startsWith('/api/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"type":"not_found_error","message":"offline fixture route"}}'); return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  seen.push({ model: body.model, tools: (body.tools ?? []).map(t => t.name), bearer: req.headers.authorization === `Bearer ${token}` });
  const message = { id: 'msg_offline', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OFFLINE_GATEWAY_OK' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  event('message_stop', {});
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TMP: root, TEMP: root,
  CLAUDE_CONFIG_DIR: join(root, 'profile'), CI: 'true',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
  ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
try {
  const version = spawnSync(resolve(binary), ['--version'], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(version.status, 0, 'CLI version probe failed');
  assert.match(version.stdout, /^2\.1\.296\b/, 'Use the workflow-pinned CLI version');
  const args = ['-p', 'Respond OFFLINE_GATEWAY_OK.', '--model', model, '--max-turns', '1',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Edit,Write,Glob,Grep', '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    '--disallowedTools', 'Bash,WebFetch,WebSearch,mcp__*', '--output-format', 'json'];
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(resolve(binary), args, { cwd: repo, env, windowsHide: true, timeout: 60_000 });
    child.stdin.end();
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
  writeFileSync(join(root, 'cli-output.json'), JSON.stringify(result));
  assert.equal(result.code, 0, `CLI failed; synthetic-only diagnostics in ${root}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.is_error, false);
  assert.equal(output.result, 'OFFLINE_GATEWAY_OK');
  assert(seen.length > 0, 'No local gateway request observed');
  const permitted = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'EndConversation']);
  for (const request of seen) {
    assert.equal(request.model, model);
    assert.equal(request.bearer, true);
    assert(request.tools.length > 0);
    assert(request.tools.every(t => permitted.has(t)), `Unexpected tool names: ${request.tools.join(',')}`);
  }
  assert.equal(existsSync(hookMarker), false, 'Repository hook executed');
  assert.equal(existsSync(mcpMarker), false, 'Repository MCP command executed');
  console.log(JSON.stringify({ status: 'PASS', version: version.stdout.trim(), requests: seen, hooksBlocked: true, mcpBlocked: true, diagnostics: root }));
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
