import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { OwnedCodeModeProcess } from "./process.js";
import { fixture, literal, program } from "./fixtures/engine.js";

const actual = { skip: process.platform !== "darwin", timeout: 45000 };

/** Delay only the genuine supervisor's stdout; its original IPC and process remain live. */
function holdActualStdout(corrupt?: (bytes: Buffer) => void) {
  const start = OwnedCodeModeProcess.prototype.start;
  let child: ChildProcess | undefined;
  let heldStdout: ChildProcess["stdout"];
  let originalResume: NonNullable<ChildProcess["stdout"]>["resume"] | undefined;
  let blockedResumeAttempts = 0;
  let receiveClosed!: (packet: Record<string, unknown>) => void;
  let receiveExit!: () => void;
  const closed = new Promise<Record<string, unknown>>(
    (resolve) => (receiveClosed = resolve),
  );
  const exited = new Promise<void>((resolve) => (receiveExit = resolve));
  function releaseStdout() {
    if (!heldStdout || !originalResume) return;
    heldStdout.resume = originalResume;
    originalResume = undefined;
    heldStdout.resume();
  }
  OwnedCodeModeProcess.prototype.start = async function (signal) {
    const proof = await start.call(this, signal);
    child = (this as unknown as { child: ChildProcess }).child;
    assert.ok(child.stdout);
    child.stdout.pause();
    heldStdout = child.stdout;
    originalResume = child.stdout.resume;
    // Node's child-exit flushStdio also calls resume; hold the actual bytes until release.
    child.stdout.resume = function () {
      blockedResumeAttempts++;
      return this;
    };
    if (corrupt) child.stdout.prependListener("data", corrupt);
    child.once("exit", () => setImmediate(receiveExit));
    child.on("message", (packet: unknown) => {
      if (
        packet &&
        typeof packet === "object" &&
        "type" in packet &&
        packet.type === "closed"
      )
        receiveClosed(packet as Record<string, unknown>);
    });
    return proof;
  };
  return {
    closed,
    exited,
    blockedResumeAttempts: () => blockedResumeAttempts,
    release() {
      releaseStdout();
    },
    restore() {
      OwnedCodeModeProcess.prototype.start = start;
      releaseStdout();
    },
  };
}

for (const [value, expectedError] of [
  [7, null],
  ["x".repeat(9000), "CODE_MODE_RESULT_LIMIT"],
] as const)
  test(
    `actual cleanup IPC before stdout drain preserves ${expectedError ?? "successful result"}`,
    actual,
    async (t) => {
      const f = await fixture(t);
      await f.grant();
      const gate = holdActualStdout();
      try {
        const submitted = await f.submit(
          program([{ op: "return", value: literal(value) }]),
        );
        const approval = await f.allow(submitted);
        const [physical] = await Promise.race([
          Promise.all([gate.closed, gate.exited]),
          delay(15000, undefined, { ref: false }).then(() => {
            throw new Error("genuine supervisor cleanup IPC or exit missing");
          }),
        ]);
        assert.equal(physical.cleanupConfirmed, true);
        assert.ok(gate.blockedResumeAttempts() > 0);
        assert.equal(
          f.engine.inspectCodeMode(f.workspace.id)[0]!.state,
          "running",
          "physical cleanup does not prove the stdout payload has ended",
        );
        gate.release();
        const run = await f.wait(submitted);
        const record = f.engine.inspectCodeMode(f.workspace.id)[0]!;
        assert.equal(record.source.runId, submitted.runId);
        assert.equal(record.source.approvalId, approval.id);
        assert.equal(record.outcome?.cleanupConfirmed, true);
        assert.ok(record.process?.processId);
        assert.throws(() => process.kill(record.process!.processId, 0));
        const native = f.engine.store.getSnapshot(f.session.id);
        assert.equal(native.tools.length, 1);
        assert.equal(native.tools[0]!.name, "execute_code");
        assert.equal(
          native.tools[0]!.state,
          expectedError ? "failed" : "completed",
        );
        if (expectedError) {
          assert.equal(record.state, "failed");
          assert.equal(record.errorCode, expectedError);
          assert.equal(record.result, null);
        } else {
          assert.equal(run.state, "completed", JSON.stringify(run));
          assert.equal(record.state, "completed");
          assert.equal(record.result, value);
        }
      } finally {
        gate.restore();
      }
    },
  );

for (const [fault, expectedError] of [
  ["malformed JSON", "CODE_MODE_FAILED"],
  ["unterminated frame", "CODE_MODE_PROTOCOL_INVALID"],
  ["incomplete UTF-8 tail", "ERR_ENCODING_INVALID_ENCODED_DATA"],
] as const)
  test(
    `actual drained stdout rejects ${fault} without publishing a successful result`,
    actual,
    async (t) => {
      const f = await fixture(t);
      await f.grant();
      let corrupted = false;
      const gate = holdActualStdout((bytes) => {
        // Corrupt actual transport bytes only; no frame, process or native proof is fabricated.
        if (fault === "malformed JSON" && !corrupted) {
          assert.equal(bytes[0], 0x7b);
          bytes[0] = 0x21;
          corrupted = true;
        } else if (fault !== "malformed JSON" && bytes.at(-1) === 0x0a) {
          bytes[bytes.length - 1] =
            fault === "unterminated frame" ? 0x20 : 0xc3;
          corrupted = true;
        }
      });
      try {
        const submitted = await f.submit();
        await f.allow(submitted);
        const physical = await Promise.race([
          gate.closed,
          delay(15000, undefined, { ref: false }).then(() => {
            throw new Error("genuine supervisor cleanup IPC missing");
          }),
        ]);
        assert.equal(physical.cleanupConfirmed, true);
        gate.release();
        await f.wait(submitted);
        assert.equal(corrupted, true);
        const record = f.engine.inspectCodeMode(f.workspace.id)[0]!;
        assert.equal(record.state, "failed");
        assert.equal(record.errorCode, expectedError);
        assert.equal(record.result, null);
        assert.equal(record.outcome?.cleanupConfirmed, true);
        assert.equal(
          f.engine.store.getSnapshot(f.session.id).tools[0]!.state,
          "failed",
        );
        assert.throws(() => process.kill(record.process!.processId, 0));
      } finally {
        gate.restore();
      }
    },
  );
