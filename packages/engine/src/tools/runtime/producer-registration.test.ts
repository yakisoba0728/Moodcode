import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolDefinition } from '../../ports.js';
import { ScopedToolRuntime } from './index.js';

function producer(): ToolDefinition {
  return { name: 'run_command', description: 'Host producer identity fixture', effectClass: 'execute', inputSchema: { type: 'object' },
    async prepare() { throw new Error('Producer must not be dispatched by identity observation'); }, async execute() { throw new Error('Producer must not be dispatched by identity observation'); } };
}
test('producer witness pins the original registration and respects the authenticated profile capture', () => {
  const runtime = new ScopedToolRuntime(), original = producer(); runtime.register('engine', original);
  const witness = runtime.captureRegistration('engine', original.name, original), catalogue = runtime.catalogue('engine');
  runtime.assertRegistrationCurrent(catalogue, witness);
  assert.throws(() => runtime.captureRegistration('engine', original.name, producer()), { code: 'TOOL_PRODUCER_MISMATCH' });
  assert.throws(() => runtime.assertRegistrationCurrent(catalogue, { ...witness }), { code: 'TOOL_PRODUCER_MISMATCH' });
  assert.throws(() => runtime.assertRegistrationCurrent(runtime.catalogue('engine', 'build', []), witness), { code: 'TOOL_NOT_FOUND' });
  const another = new ScopedToolRuntime(); another.register('engine', original);
  assert.throws(() => another.assertRegistrationCurrent(another.catalogue('engine'), witness), { code: 'TOOL_PRODUCER_MISMATCH' });
});
test('same-name and same-schema replacement cannot become the captured producer', () => {
  const runtime = new ScopedToolRuntime(), original = producer(); runtime.register('engine', original);
  const witness = runtime.captureRegistration('engine', original.name, original), previous = runtime.catalogue('engine');
  runtime.clearScope('engine'); runtime.register('engine', producer());
  assert.throws(() => runtime.assertRegistrationCurrent(previous, witness), { code: 'TOOL_CATALOGUE_STALE' });
  assert.throws(() => runtime.assertRegistrationCurrent(runtime.catalogue('engine'), witness), { code: 'TOOL_PRODUCER_MISMATCH' });
});
