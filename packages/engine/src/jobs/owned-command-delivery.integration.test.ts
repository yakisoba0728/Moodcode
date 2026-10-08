import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { jobInvoke, jobUntil } from "./fixtures/job.js";
import {
  ownedDeliveryFixture,
  ownedDeliveryCounts,
  ownedDeliveryProfile,
} from "./fixtures/owned-command-delivery.js";
import {
  formatOwnedCommandJobResult,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";
import type {
  OwnedCommandDeliveryRecord,
  OwnedCommandDeliveryResult,
} from "./owned-command-delivery-records.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25_000,
};
const nativeError = (failure: unknown) => failure instanceof EngineError;
type Fixture = Awaited<ReturnType<typeof ownedDeliveryFixture>>;
function release(f: Fixture, target: object) {
  jobInvoke(f.engine, "releaseOwnedCommandJobDeliveryHandle", target);
}
function get(f: Fixture, id: string) {
  return jobInvoke<OwnedCommandDeliveryRecord>(
    f.engine,
    "getOwnedCommandJobDelivery",
    f.workspace.id,
    id,
  );
}
function sourceEvents(f: Fixture) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM session_events WHERE run_id=? ORDER BY seq")
      .all(f.receipt.runId);
  } finally {
    db.close();
  }
}

test(
  "actual completed owned command delivery commits one queued input and immutable duplicate copies without extending the source Run",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t),
      settled = await f.complete(),
      target = f.capture();
    const proof = jobInvoke<OwnedCommandDeliveryTargetProof>(
      f.engine,
      "readOwnedCommandJobDeliveryTarget",
      target,
    );
    assert.equal(proof.settled.sha256, settled.sha256);
    const before = ownedDeliveryCounts(f.dbPath),
      source = sourceEvents(f),
      requestId = randomUUID();
    const result = f.deliver(target, requestId);
    assert.equal(result.kind, "accepted");
    const receipt = structuredClone(result.record);
    assert.equal(
      receipt.inputRequestId,
      `owned-command-result:${f.jobId}:${settled.sha256}`,
    );
    assert.equal(receipt.prompt, formatOwnedCommandJobResult(settled, proof));
    assert.equal(
      f.engine.store.getInput(receipt.accepted.inputId).state,
      "pending",
    );
    assert.deepEqual(sourceEvents(f), source);
    const after = ownedDeliveryCounts(f.dbPath);
    assert.equal(after.inputs, before.inputs + 1);
    assert.equal(after.deliveries, before.deliveries + 1);
    assert.equal(after.links, before.links + 1);
    assert.equal(after.anchors, before.anchors + 1);
    assert.equal(after.turns, before.turns);
    assert.equal(f.providerEntries(), 2);
    Reflect.set(
      result.record,
      "prompt",
      "Caller mutation cannot rewrite the native receipt",
    );
    const duplicate = f.deliver(target, requestId);
    assert.equal(duplicate.kind, "duplicate");
    assert.deepEqual(duplicate.record, receipt);
    Reflect.set(duplicate.record.accepted, "inputId", "changed");
    assert.deepEqual(f.deliver(target, requestId).record, receipt);
    assert.throws(() => f.deliver(f.capture(), requestId), nativeError);
    assert.deepEqual(structuredClone(get(f, receipt.id)), receipt);
    assert.deepEqual(ownedDeliveryCounts(f.dbPath), after);
    f.engine.scheduler.resume(f.session.id);
    await f.engine.waitForSession(f.session.id);
    assert.equal(f.providerEntries(), 3);
    assert.equal(
      f.engine.store.getInput(receipt.accepted.inputId).state,
      "promoted",
    );
    assert.deepEqual(sourceEvents(f), source);
  },
);

test(
  "approval, original identity, safe descriptors and cancellation are checked before any owned result admission",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    await f.complete();
    const target = f.capture(),
      before = ownedDeliveryCounts(f.dbPath);
    const input = {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      expectedRevision: 0,
      target,
      approved: true,
    };
    for (const changed of [
      { ...input, approved: false },
      { ...input, target: { ...target } },
      { ...input, expectedRevision: 1 },
      { ...input, signal: AbortSignal.abort() },
    ])
      assert.throws(
        () => jobInvoke(f.engine, "deliverOwnedCommandJobResult", changed),
        nativeError,
      );
    let traps = 0;
    const accessor = Object.defineProperty({ ...input }, "target", {
      enumerable: true,
      get() {
        traps++;
        return target;
      },
    });
    assert.throws(
      () => jobInvoke(f.engine, "deliverOwnedCommandJobResult", accessor),
      nativeError,
    );
    const proxy = new Proxy(input, {
      ownKeys() {
        traps++;
        return Reflect.ownKeys(input);
      },
      get() {
        traps++;
        return target;
      },
    });
    assert.throws(
      () => jobInvoke(f.engine, "deliverOwnedCommandJobResult", proxy),
      nativeError,
    );
    assert.equal(traps, 0);
    release(f, target);
    assert.throws(() => f.deliver(target), nativeError);
    assert.throws(
      () => jobInvoke(f.engine, "readOwnedCommandJobDeliveryTarget", target),
      nativeError,
    );
    assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
    assert.equal(f.providerEntries(), 2);
  },
);

test(
  "stale actual profile and same-byte artifact replacement fence the original owned delivery target",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    const settled = await f.complete(),
      target = f.capture(),
      before = ownedDeliveryCounts(f.dbPath);
    f.engine.profiles.register({
      id: f.targetConfig.agentProfileId!,
      description: "Changed",
      instructions: "Changed actual target revision",
      tools: ["read_file"],
    });
    assert.throws(() => f.deliver(target), nativeError);
    assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
    const fresh = f.capture(),
      path = settled.completion!.stdout.path,
      preserved = join(f.base, "original-stdout");
    renameSync(path, preserved);
    copyFileSync(preserved, path);
    try {
      assert.throws(() => f.deliver(fresh), nativeError);
      assert.throws(() => f.capture(), nativeError);
      assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
    } finally {
      rmSync(path);
      renameSync(preserved, path);
    }
  },
);

test(
  "a settled command with a still-active actual source Run and an uncertain cancelled source cannot grant result delivery",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t, { holdSourceFinish: true });
    f.finishCommand();
    try {
      await jobUntil(
        () => f.settled().state === "completed",
        "Actual native Tool did not settle before the held final Turn",
      );
      assert.equal(f.engine.store.getRun(f.receipt.runId).state, "running");
      const before = ownedDeliveryCounts(f.dbPath);
      assert.throws(() => f.capture(), nativeError);
      assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
    } finally {
      f.finishSource();
      await f.engine.waitForRun(f.receipt.runId);
    }
    const other = await ownedDeliveryFixture(t);
    other.engine.coordinator.cancel(other.receipt.runId);
    await other.engine.waitForRun(other.receipt.runId);
    assert.equal(other.settled().state, "uncertain");
    const before = ownedDeliveryCounts(other.dbPath);
    assert.throws(() => other.capture(), nativeError);
    assert.deepEqual(ownedDeliveryCounts(other.dbPath), before);
  },
);

test(
  "a genuine nonzero failed command can deliver its known cleaned-up outcome as quoted observation data",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t, { exitCode: 7 }),
      settled = await f.complete();
    assert.equal(settled.state, "failed");
    assert.equal(settled.completion!.outcome.exitCode, 7);
    const result = f.deliver(f.capture());
    assert.equal(result.kind, "accepted");
    assert.ok(result.record.prompt.includes('"state":"failed"'));
    assert.equal(f.providerEntries(), 2);
  },
);

test(
  "an actual native receipt SQL fault rolls back all owned-result input, documents and event writes before any wake",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    await f.complete();
    const target = f.capture(),
      before = ownedDeliveryCounts(f.dbPath),
      source = sourceEvents(f);
    const db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER fail_owned_result BEFORE INSERT ON session_events WHEN NEW.type='command.job.result_admitted' BEGIN SELECT RAISE(ABORT,'actual owned result receipt failure'); END",
    );
    const requestId = randomUUID();
    try {
      assert.throws(() => f.deliver(target, requestId));
      assert.throws(() => f.deliver(target, requestId));
      assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
      assert.deepEqual(sourceEvents(f), source);
      assert.equal(f.providerEntries(), 2);
    } finally {
      db.exec("DROP TRIGGER fail_owned_result");
      db.close();
    }
    assert.equal(f.deliver(f.capture()).kind, "accepted");
    assert.equal(ownedDeliveryCounts(f.dbPath).inputs, before.inputs + 1);
  },
);

test(
  "accepted owned results survive default-off restart and explicit resume while archive import retains paused history without restoring source grants",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    await f.complete();
    const target = f.capture(),
      accepted = f.deliver(target).record,
      before = ownedDeliveryCounts(f.dbPath);
    await f.engine.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "owned-result-archive"),
    });
    for (const jobs of [false, true]) {
      const imported = await importEngineArchive({
        directory: archive.directory,
        destination: join(
          f.base,
          jobs ? "owned-result-import-on" : "owned-result-import-off",
        ),
      });
      let entries = 0;
      const provider: ProviderAdapter = {
        id: f.config.providerId,
        async *streamTurn(): AsyncIterable<ProviderEvent> {
          entries++;
          yield { type: "finish", reason: "stop" };
        },
      };
      const engine = createEngine({
        ...f.configuration,
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
        providers: [provider],
        agentProfiles: [
          ownedDeliveryProfile,
          ...f.configuration.agentProfiles!,
        ],
        jobs,
      });
      f.engines.add(engine);
      const record = jobInvoke<OwnedCommandDeliveryRecord>(
        engine,
        "getOwnedCommandJobDelivery",
        f.workspace.id,
        accepted.id,
      );
      assert.equal(record.state, "paused-import");
      assert.deepEqual(structuredClone(record.accepted), accepted.accepted);
      assert.throws(
        () =>
          jobInvoke(engine, "captureOwnedCommandJobDeliveryTarget", {
            workspaceId: f.workspace.id,
            jobId: f.jobId,
            config: f.targetConfig,
          }),
        nativeError,
      );
      assert.throws(
        () =>
          jobInvoke(engine, "deliverOwnedCommandJobResult", {
            workspaceId: f.workspace.id,
            requestId: randomUUID(),
            expectedRevision: 0,
            target,
            approved: true,
          }),
        nativeError,
      );
      try {
        engine.scheduler.resume(f.session.id);
        await engine.waitForSession(f.session.id);
      } catch (failure) {
        assert.ok(nativeError(failure));
      }
      assert.equal(entries, 0);
      assert.deepEqual(ownedDeliveryCounts(imported.dbPath), before);
      assert.equal(
        engine.store.getInput(accepted.accepted.inputId).state,
        "pending",
      );
      await engine.close();
    }
    let entries = 0;
    const provider: ProviderAdapter = {
      id: f.config.providerId,
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        entries++;
        yield { type: "finish", reason: "stop" };
      },
    };
    const engine = createEngine({
      ...f.configuration,
      providers: [provider],
      agentProfiles: [ownedDeliveryProfile, ...f.configuration.agentProfiles!],
      jobs: false,
    });
    f.engines.add(engine);
    assert.deepEqual(
      structuredClone(
        jobInvoke(
          engine,
          "getOwnedCommandJobDelivery",
          f.workspace.id,
          accepted.id,
        ),
      ),
      accepted,
    );
    assert.throws(
      () =>
        jobInvoke(engine, "captureOwnedCommandJobDeliveryTarget", {
          workspaceId: f.workspace.id,
          jobId: f.jobId,
          config: f.targetConfig,
        }),
      nativeError,
    );
    assert.equal(entries, 0);
    // Root can opt in again without recovering any Original source; only its already accepted input is resumed.
    await engine.close();
    const enabled = createEngine({
      ...f.configuration,
      providers: [provider],
      agentProfiles: [ownedDeliveryProfile, ...f.configuration.agentProfiles!],
      jobs: true,
    });
    f.engines.add(enabled);
    enabled.scheduler.resume(f.session.id);
    await enabled.waitForSession(f.session.id);
    assert.equal(entries, 1);
    assert.equal(
      enabled.store.getInput(accepted.accepted.inputId).state,
      "promoted",
    );
    assert.equal(ownedDeliveryCounts(f.dbPath).inputs, before.inputs);
  },
);

test(
  "a changed actual target profile fences an already accepted owned result before promotion without rewriting or consuming it",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    await f.complete();
    const record = f.deliver(f.capture()).record,
      before = ownedDeliveryCounts(f.dbPath);
    f.engine.profiles.register({
      id: f.targetConfig.agentProfileId!,
      description: "Changed after admission",
      instructions: "No inherited configuration authority",
      tools: ["read_file", "bash"],
    });
    f.engine.scheduler.resume(f.session.id);
    await f.engine.waitForSession(f.session.id).catch(() => {});
    assert.equal(f.providerEntries(), 2);
    assert.equal(
      f.engine.store.getInput(record.accepted.inputId).state,
      "pending",
    );
    assert.deepEqual(ownedDeliveryCounts(f.dbPath), before);
    assert.equal(get(f, record.id).sha256, record.sha256);
  },
);

test(
  "fully rehashed owned delivery document edits cannot contradict the independent actual admission anchor",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t);
    await f.complete();
    const record = f.deliver(f.capture()).record;
    const db = new DatabaseSync(f.dbPath);
    db.exec("SAVEPOINT actual_owned_delivery_probe");
    try {
      const h = db
        .prepare(
          "SELECT kind,data FROM session_documents WHERE session_id=? AND json_extract(data,'$.id')=?",
        )
        .get(f.session.id, record.id)!;
      const changed = JSON.parse(String(h.data)) as OwnedCommandDeliveryRecord;
      Reflect.set(changed, "requestId", "fully-rehashed-other-request");
      Reflect.set(
        changed,
        "requestSha256",
        knowledgeHash({
          workspaceId: f.workspace.id,
          jobId: f.jobId,
          requestId: changed.requestId,
          expectedRevision: 0,
          targetSha256: changed.targetSha256,
        }),
      );
      const { sha256: _sha, ...body } = changed;
      Reflect.set(changed, "sha256", knowledgeHash(body));
      const encoded = JSON.stringify(changed),
        encodedSha = createHash("sha256").update(encoded).digest("hex");
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(encoded, f.session.id, h.kind!);
      db.prepare(
        "UPDATE session_events SET data=json_set(data,'$.payload.sha256',?) WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=1",
      ).run(encodedSha, f.session.id, h.kind!);
      // Commit corruption while preserving the genuine result_admitted receipt to exercise the actual Root reader.
      db.exec("RELEASE actual_owned_delivery_probe");
      assert.throws(() => get(f, record.id), nativeError);
      assert.throws(
        () =>
          jobInvoke(
            f.engine,
            "inspectOwnedCommandJobDeliveries",
            f.workspace.id,
          ),
        nativeError,
      );
    } finally {
      db.close();
    }
  },
);
