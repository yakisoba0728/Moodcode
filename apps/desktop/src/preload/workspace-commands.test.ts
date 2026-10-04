import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CommandEnvelope, JsonObject } from '@moodcode/contracts';
import { DESKTOP_CHANNELS } from '../main/ipc-channels.js';
import { createDesktopApi, validateDesktopCommand } from './api.js';
import type { DesktopTransport } from './api.js';

const fingerprint = 'a'.repeat(64);
const commands: readonly CommandEnvelope[] = [
  { schemaVersion: 1, commandId: 'file-list', type: 'file.list', payload: { workspaceId: 'workspace', path: '' } },
  { schemaVersion: 1, commandId: 'file-read', type: 'file.read', payload: { workspaceId: 'workspace', path: 'math.mjs' } },
  { schemaVersion: 1, commandId: 'workspace-status', type: 'workspace.getStatus', payload: { workspaceId: 'workspace' } },
  { schemaVersion: 1, commandId: 'restore-preview', type: 'review.previewRestore', payload: { runId: 'run', checkpointId: 'checkpoint' } },
  { schemaVersion: 1, commandId: 'restore-confirm', type: 'review.restore', payload: { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: fingerprint } },
  { schemaVersion: 1, commandId: 'review-history', type: 'review.history', payload: { runId: 'run' } },
];

class TransportDouble extends EventEmitter implements DesktopTransport {
  invocations: { channel: string; args: unknown[] }[] = [];
  async invoke(channel: string, ...args: unknown[]) {
    this.invocations.push({ channel, args });
    return { ok: true, value: { schemaVersion: 1, commandId: (args[0] as CommandEnvelope).commandId, ok: true, result: null } };
  }
}

function withPayload(command: CommandEnvelope, payload: JsonObject): CommandEnvelope {
  return { ...command, payload };
}
function safeInvalid(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT' && !error.message.includes('fixture-secret');
}

test('file, status, restore and history commands cross only the command channel with isolated payloads', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const accepted = [...commands,
    { schemaVersion: 1 as const, commandId: 'file-list-root', type: 'file.list', payload: { workspaceId: 'workspace' } },
    { schemaVersion: 1 as const, commandId: 'file-list-directory', type: 'file.list', payload: { workspaceId: 'workspace', path: 'src/components' } },
  ];
  for (const command of accepted) {
    Object.freeze(command.payload);
    Object.freeze(command);
    const normalized = validateDesktopCommand(command);
    assert.deepEqual(normalized, command);
    assert.notEqual(normalized, command);
    assert.notEqual(normalized.payload, command.payload);
    const result = await api.command(command);
    assert.equal(result.commandId, command.commandId);
    assert.equal(result.ok, true);
    const sent = transport.invocations.at(-1);
    assert.equal(sent?.channel, DESKTOP_CHANNELS.command);
    assert.deepEqual(sent?.args, [command]);
    assert.notEqual(sent?.args[0], command);
  }
  assert.equal(transport.invocations.length, accepted.length);
});

test('new command IDs and workspace, run and checkpoint IDs reject missing, unbounded and control values before IPC', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const command of commands) {
    for (const commandId of ['', 'x'.repeat(257), '한'.repeat(100), 'fixture-secret\n']) {
      await assert.rejects(api.command({ ...command, commandId }), safeInvalid);
    }
    for (const field of ['workspaceId', 'runId', 'checkpointId']) {
      if (!Object.hasOwn(command.payload, field)) continue;
      const absent = { ...command.payload };
      delete absent[field];
      await assert.rejects(api.command(withPayload(command, absent)), safeInvalid);
      for (const value of [null, 42, '', 'x'.repeat(257), '한'.repeat(100), 'fixture-secret\n']) {
        await assert.rejects(api.command(withPayload(command, { ...command.payload, [field]: value })), safeInvalid);
      }
    }
  }
  assert.equal(transport.invocations.length, 0);
});

test('file paths and restore fingerprints reject missing, oversized and invalid values before IPC', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const command of commands.filter(value => value.type === 'file.list' || value.type === 'file.read')) {
    const invalidPaths = [null, 42, 'x'.repeat(4097), '한'.repeat(1400), 'fixture-secret\0', 'fixture-secret\n',
      '.', '..', '../fixture-secret', '/fixture-secret', 'src//fixture-secret', 'src/../fixture-secret',
      'src\\fixture-secret', 'C:/fixture-secret', 'fixture-secret\u007f', 'fixture-secret\u0085', 'fixture-secret\ud800'];
    if (command.type === 'file.read') invalidPaths.push('');
    for (const path of invalidPaths) {
      await assert.rejects(api.command(withPayload(command, { ...command.payload, path })), safeInvalid);
    }
    if (command.type === 'file.read') {
      const absent = { ...command.payload };
      delete absent.path;
      await assert.rejects(api.command(withPayload(command, absent)), safeInvalid);
    }
  }
  const restore = commands.find(command => command.type === 'review.restore')!;
  const absent = { ...restore.payload };
  delete absent.previewFingerprint;
  await assert.rejects(api.command(withPayload(restore, absent)), safeInvalid);
  for (const previewFingerprint of [null, 42, '', 'x'.repeat(513), '한'.repeat(200), 'fixture-secret\n', 'fixture-secret\0',
    'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)]) {
    await assert.rejects(api.command(withPayload(restore, { ...restore.payload, previewFingerprint })), safeInvalid);
  }
  assert.equal(transport.invocations.length, 0);
});

test('new command payloads reject unsupported fields and credential attempts without echoing them', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const command of commands) {
    for (const field of ['apiKey', 'authorization', 'providerConfig', 'extra']) {
      await assert.rejects(api.command(withPayload(command, { ...command.payload, [field]: 'fixture-secret' })), safeInvalid);
    }
    await assert.rejects(api.command({ ...command, payload: { get fixtureSecret(): string { throw new Error('fixture-secret'); } } }), safeInvalid);
  }
  assert.equal(transport.invocations.length, 0);
});
