import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const version = process.argv[2] ?? '2026-07-28';
const timers = new Map<number, ReturnType<typeof setTimeout>>(); let cancelled = 0;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const toolNames = ['echo', 'hang', 'cancel_count', 'env_check', 'invalid_frame', 'oversize', 'list_changed', 'start_descendant'];
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/cancelled') { const timer = timers.get(request.params.requestId); if (timer) clearTimeout(timer); timers.delete(request.params.requestId); cancelled++; return; }
  if (request.id === undefined) return;
  let result: unknown;
  if (request.method === 'server/discover' && version === '2026-07-28') result = { resultType: 'complete', supportedVersions: [version], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1' } } };
  else if (request.method === 'initialize' && version === '2025-11-25') result = { protocolVersion: version, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { resultType: 'complete', tools: toolNames.map(name => ({ name, description: 'fixture tool ' + name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })) };
  else if (request.method === 'resources/list') result = { resultType: 'complete', resources: [{ uri: 'fixture://one', name: 'one' }] };
  else if (request.method === 'resources/read') result = { resultType: 'complete', contents: [{ uri: request.params.uri, text: 'fixture resource' }] };
  else if (request.method === 'tools/call') {
    const name = request.params.name;
    if (name === 'hang') { timers.set(request.id, setTimeout(() => { send({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'late' }] } }); timers.delete(request.id); }, 60_000)); return; }
    if (name === 'invalid_frame') { process.stdout.write('invalid JSON\n'); return; }
    if (name === 'oversize') { process.stdout.write('x'.repeat(1_048_577)); return; }
    if (name === 'list_changed') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    process.stderr.write('fixture private stderr is never part of tool content\n');
    const descendant = name === 'start_descendant' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
    const text = descendant ? String(descendant.pid) : name === 'cancel_count' ? String(cancelled) : name === 'env_check' ? String(process.env.MOODCODE_FIXTURE_SECRET ?? 'absent') : JSON.stringify(request.params.arguments);
    result = { resultType: 'complete', content: [{ type: 'text', text }], structuredContent: { echoed: request.params.arguments } };
  } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'fixture method unavailable' } }); return; }
  send({ jsonrpc: '2.0', id: request.id, result });
});
rl.on('close', () => { for (const timer of timers.values()) clearTimeout(timer); });
