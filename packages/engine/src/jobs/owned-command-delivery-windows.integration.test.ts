import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  nativeWindowsOwnedDeliveryFixture,
  preserveOwnedDeliveryEvidence,
} from "./fixtures/owned-command-delivery-windows.js";

test(
  "native Windows cancelled owned command delivers its actual interrupted result once after physical join",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeWindowsOwnedDeliveryFixture(t);
    assert.equal(
      f.engine.getCapabilities().runtime.commandExecution,
      "windows-job-object",
    );
    const before = f.engine.store.getSnapshot(f.session.id).runs.length,
      requestId = randomUUID();
    preserveOwnedDeliveryEvidence("windows-native-original", {
      classification: "actual Windows Job Object",
      settled: f.settled,
      event: f.event,
      part: f.part,
      physicalPids: f.physicalPids,
    });
    const result = await f.engine.deliverOwnedCommandJobResult({
      workspaceId: f.workspace.id,
      requestId,
      expectedRevision: 0,
      target: f.target,
      approved: true,
    });
    assert.equal(result.kind, "accepted");
    assert.equal(result.record.settled.sha256, f.settled.sha256);
    assert.equal(
      f.engine.store.getInput(result.record.accepted.inputId).state,
      "pending",
    );
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, before);
    assert.equal(f.entries(), 1);
    const duplicate = await f.engine.deliverOwnedCommandJobResult({
      workspaceId: f.workspace.id,
      requestId,
      expectedRevision: 0,
      target: f.target,
      approved: true,
    });
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(
      duplicate.record.accepted.inputId,
      result.record.accepted.inputId,
    );
    let afterSeq = 0,
      scannedEvents = 0,
      admittedEvents = 0,
      exhausted = false;
    while (scannedEvents < 1024) {
      const page = f.engine.store.readSessionEvents(
        f.session.id,
        afterSeq,
        Math.min(100, 1024 - scannedEvents),
      );
      if (page.length === 0) {
        exhausted = true;
        break;
      }
      for (const event of page) {
        assert.ok(event.seq > afterSeq, "session event cursor must advance");
        afterSeq = event.seq;
        scannedEvents++;
        if (event.type === "command.job.result_admitted") admittedEvents++;
      }
    }
    assert.equal(exhausted, true, "session event scan exhausted its row budget");
    assert.equal(admittedEvents, 1);
    assert.equal(f.entries(), 1);
    preserveOwnedDeliveryEvidence("windows-native-delivered", {
      classification: "actual Windows Job Object",
      result,
      duplicate,
      sourceCalls: f.entries(),
    });
  },
);
