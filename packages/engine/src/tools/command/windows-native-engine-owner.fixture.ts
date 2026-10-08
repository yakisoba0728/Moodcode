import { readFileSync } from 'node:fs';
import { createEngine } from '../../engine.js';
import { treePids, until, windowsCommand } from './windows-native-test-helpers.fixture.js';

const options = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  dbPath: string; artifactDir: string; workspaceId: string; sessionId: string; directory: string;
};
const engine = createEngine({ dbPath: options.dbPath, artifactDir: options.artifactDir, hostCommands: true, providers: [] });
const preview = await engine.previewHostCommand({
  workspaceId: options.workspaceId, sessionId: options.sessionId,
  command: windowsCommand('tree-hold', options.directory), limits: { maxDurationMs: 20_000, maxOutputBytes: 65_536 },
});
const record = await engine.startHostCommand({
  workspaceId: options.workspaceId, requestId: 'native-windows-crash', preview,
  fingerprint: engine.readHostCommandPreview(preview).fingerprint, approved: true,
});
await until(() => treePids(options.directory).length === 3, 'Actual engine-owned native tree did not start');
process.send?.({ type: 'running', ownerPid: process.pid, jobId: record.jobId, pids: treePids(options.directory) });
await engine.waitForHostCommand({ workspaceId: options.workspaceId, jobId: record.jobId });
throw new Error('Actual engine owner was not killed before native settlement');
