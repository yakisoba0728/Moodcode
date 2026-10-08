import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { jobGroupProcessInfo, jobGroupUntil, processPresent, stoppedJobGroupFixture } from "./fixtures/job-group.js";

const native = { skip: process.platform !== "darwin", timeout: 10_000 };

test("stopped interactive PTY shell cannot turn a live separate job group into confirmed cleanup", native, async t => {
  const f = await stoppedJobGroupFixture(t, "job-groups");
  const pids = f.observedPids();
  const groups = jobGroupProcessInfo(pids, "pid,pgid").split("\n").map(line => line.trim().split(/\s+/).map(Number));
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0]![1], groups[1]![1]);
  await f.service.cancel(f.terminalId, f.owner);
  const result = f.service.get(f.terminalId, f.owner);
  await jobGroupUntil(() => pids.every(pid => !processPresent(pid)), "Every originally observed PTY job group must be physically absent");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.state, "cancelled");
  await f.close();
  assert.deepEqual(f.readJournal()!.record, result);
});

test("losing the actual PTY supervisor cannot reconstruct confirmed cleanup from its original group", native, async t => {
  const f = await stoppedJobGroupFixture(t, "lost-supervisor");
  f.killSupervisor();
  await jobGroupUntil(() => f.service.get(f.terminalId, f.owner).state !== "running", "Actual supervisor loss settled the source");
  const result = f.service.get(f.terminalId, f.owner);
  assert.equal(result.state, "uncertain");
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.reason, "supervisor_lost");
  await f.close();
  assert.deepEqual(f.readJournal()!.record, result);
});

test("copied numeric PTY observations used as a receiver cannot retarget original fixture closure at another live child", native, async t => {
  const f = await stoppedJobGroupFixture(t, "copied-observation");
  const other = childProcess.spawn(process.execPath, ["-e", "process.on('message',m=>{if(m==='ping')process.send('pong')});process.send('ready');"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const otherClosed = once(other, "close");
  t.after(async () => { if (other.exitCode === null && other.signalCode === null) other.kill("SIGKILL"); await otherClosed; });
  let ready = false, pongs = 0;
  other.on("message", message => { if (message === "ready") ready = true; if (message === "pong") pongs++; });
  await jobGroupUntil(() => ready, "Original controlled unrelated child became ready");
  f.killSupervisor();
  await jobGroupUntil(() => f.service.get(f.terminalId, f.owner).state !== "running", "Actual original supervisor loss settled");
  const original = f.service.get(f.terminalId, f.owner);
  const copied = { ...structuredClone(original), pid: other.pid, pids: [other.pid], dbPath: "borrowed-record-path", controlPath: "borrowed-record-path" };
  const signal = process.kill;
  let unrelatedSignals = 0;
  process.kill = ((pid: number, request?: NodeJS.Signals | number) => {
    if (pid === other.pid && request !== 0) unrelatedSignals++;
    return signal(pid, request);
  }) as typeof process.kill;
  try { await Reflect.apply(f.close, copied, []); }
  finally { process.kill = signal; }
  other.send("ping");
  await jobGroupUntil(() => pongs === 1, "Controlled unrelated child answered after original fixture closure");
  assert.equal(unrelatedSignals, 0);
  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null);
  assert.equal(original.state, "uncertain");
  assert.equal(original.cleanupConfirmed, false);
  assert.deepEqual(f.readJournal()!.record, original);
});

test("actual evidence write failure stays failed while original owned PTY cleanup completes", native, t => {
  const source = import.meta.url.endsWith(".ts");
  const helper = new URL(`./fixtures/job-group.${source ? "ts" : "js"}`, import.meta.url).href;
  const child = childProcess.spawnSync(process.execPath, [
    ...process.execArgv, "--test-reporter=tap", "--input-type=module", "-e", `
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stoppedJobGroupFixture, jobGroupUntil, processPresent } from ${JSON.stringify(helper)};
test('Original evidence failure', {timeout: 10000}, async t => {
  const f = await stoppedJobGroupFixture(t, 'evidence-write-failure');
  f.killSupervisor();
  await jobGroupUntil(() => f.service.get(f.terminalId, f.owner).state !== 'running', 'Native supervisor loss settled');
  const original = f.service.get(f.terminalId, f.owner);
  assert.equal(original.state, 'uncertain');
  assert.equal(original.cleanupConfirmed, false);
  mkdirSync(join(f.base, 'before-close.json'), {mode: 0o700});
  let firstError;
  await assert.rejects(f.close(), error => { firstError = error; return error.code === 'EISDIR'; });
  await assert.rejects(f.close(), error => error === firstError);
  assert.equal(readFileSync(join(f.base, 'release'))[0], 1);
  assert.ok(f.observedPids().every(pid => !processPresent(pid)));
  assert.deepEqual(f.readJournal().record, original);
  const failure = JSON.parse(readFileSync(join(f.base, 'close-failure.json'), 'utf8'));
  assert.deepEqual(failure.native.record, original);
  assert.match(failure.error, /EISDIR/);
  console.log('OWNED-WRITE-FAULT:' + JSON.stringify({base: f.base, code: firstError.code, native: original, release: true, originalJobsAbsent: true, sameError: true}));
});
`,
  ], { encoding: "utf8", timeout: 9000, maxBuffer: 524288, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const match = /OWNED-WRITE-FAULT:(\{[^\n]+\})/.exec(child.stdout);
  assert.ok(match, `${child.stdout}\n${child.stderr}`);
  const evidence = JSON.parse(match[1]!);
  writeFileSync(join(evidence.base, "expected-failed-child.log"), `${child.stdout}\n${child.stderr}`, { mode: 0o600 });
  assert.equal(child.status, 1, "The genuine helper write/after-hook failure must remain a failed child");
  assert.equal(child.signal, null);
  assert.match(child.stdout, /hookFailed/);
  assert.equal(evidence.code, "EISDIR");
  assert.equal(evidence.native.state, "uncertain");
  assert.equal(evidence.native.cleanupConfirmed, false);
  assert.deepEqual(JSON.parse(readFileSync(join(evidence.base, "close-failure.json"), "utf8")).native.record, evidence.native);
  t.diagnostic(`Retained actual expected write-failure fixture/journal: ${evidence.base}`);
});
