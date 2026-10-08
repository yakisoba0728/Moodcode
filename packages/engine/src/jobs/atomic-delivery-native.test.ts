import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { jobFixture, jobInvoke } from "./fixtures/job.js";
import {
  JobStorage,
  validateJobDatabase,
  type CommandJob,
  type DeliverJobResultAtomicInput,
  type JobRequestResult,
  type JobStoragePorts,
} from "./store.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { signJobData } from "./validation.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;

/** Genuine Root/Git/PTY admission and input proofs; only faults are injected at native boundaries. */
async function settled(t: test.TestContext) {
  const f = await jobFixture(t),
    attached = f.attach();
  await f.finish();
  const result = jobInvoke<JobRequestResult<CommandJob>>(
    f.engine,
    "settleTerminalJob",
    attached.original,
    {
      workspaceId: f.workspace.id,
      jobId: attached.result.record.jobId,
      requestId: "native-atomic-settle",
      expectedRevision: 1,
    },
  );
  f.engine.store.setSessionPaused(f.session.id, true, "user");
  const native = Reflect.get(f.engine, "jobRecords") as JobStorage;
  assert.ok(native instanceof JobStorage);
  const ports = Reflect.get(native, "ports") as JobStoragePorts;
  assert.equal(typeof ports.acceptAtomicInput, "function");
  const target = () =>
    jobInvoke<object>(f.engine, "captureCommandJobDeliveryTarget", {
      workspaceId: f.workspace.id,
      jobId: result.record.jobId,
      config: f.config,
    });
  // First genuine profile selection persists its session document before any delivery transaction.
  jobInvoke(f.engine, "releaseCommandJobHandle", target());
  const input: DeliverJobResultAtomicInput = {
    workspaceId: f.workspace.id,
    jobId: result.record.jobId,
    requestId: "native-atomic-deliver",
    expectedRevision: 0,
  };
  const image = () =>
    ["job_revisions", "job_heads", "session_inputs", "session_events"].map(
      (table) =>
        native.db
          .prepare(
            `SELECT * FROM ${table} ORDER BY ${table === "session_events" ? "session_id,seq" : table === "job_heads" ? "workspace_id,kind,entity_id" : "id"}`,
          )
          .all(),
    );
  return { f, native, ports, target, input, image, job: result.record };
}

test(
  "native atomic delivery commits the exact actual pending input and returns immutable dedupe history without a fresh Original",
  posix,
  async (t) => {
    const { f, native, target, input, image, job } = await settled(t);
    const before = image(),
      result = native.deliverJobResultAtomic(target(), input);
    assert.equal(result.record.state, "accepted");
    assert.equal(result.record.revision, 3);
    assert.equal(
      result.record.deliveryId,
      knowledgeHash([
        "job-result-delivery-v1",
        input.workspaceId,
        input.jobId,
        job.sha256,
      ]),
    );
    assert.equal(
      result.record.accepted!.requestId,
      `job-result:${input.jobId}:${job.sha256}`,
    );
    assert.equal(f.rows("session_inputs").length, 1);
    assert.equal(
      f.engine.store.getInput(result.record.accepted!.inputId).state,
      "pending",
    );
    assert.equal(image()[0]!.length - before[0]!.length, 6);
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 0);
    validateJobDatabase(native.db);
    const accepted = image();
    assert.throws(() => {
      (result.record as unknown as { state: string }).state = "uncertain";
    }, TypeError);
    const callerCopy = structuredClone(result.record) as unknown as {
      state: string;
    };
    callerCopy.state = "uncertain";
    const duplicate = native.deliverJobResultAtomic(Object.freeze({}), input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.state, "accepted");
    assert.deepEqual(image(), accepted);
    assert.throws(
      () =>
        native.deliverJobResultAtomic({}, { ...input, expectedRevision: 1 }),
      code("JOB_REQUEST_CONFLICT"),
    );
    assert.deepEqual(image(), accepted);
    assert.equal(f.providerCalls.length, 0);
    // Self-signed wrappers cannot change the original atomic request or its preparation chain.
    native.db.exec("SAVEPOINT atomic_history_probe");
    try {
      const receipt = structuredClone(duplicate.receipt);
      const requestInput = structuredClone(receipt.requestInput);
      (requestInput.atomicRequest as Record<string, unknown>).expectedRevision =
        1;
      const changed = signJobData({
        ...receipt,
        requestInput,
        requestSha256: knowledgeHash(requestInput),
      });
      native.db
        .prepare(
          "UPDATE job_revisions SET data=?,sha256=?,request_sha256=? WHERE id=?",
        )
        .run(
          JSON.stringify(changed),
          changed.sha256,
          changed.requestSha256,
          changed.id,
        );
      native.db
        .prepare("UPDATE job_revisions SET request_sha256=? WHERE id=?")
        .run(changed.requestSha256, duplicate.record.id);
      assert.throws(
        () => validateJobDatabase(native.db),
        code("JOB_REQUEST_CONFLICT"),
      );
    } finally {
      native.db.exec(
        "ROLLBACK TO atomic_history_probe;RELEASE atomic_history_probe",
      );
    }
    validateJobDatabase(native.db);
  },
);

test(
  "prepare, dispatch, actual input and accepted-row SQLite failures roll back the whole native atomic delivery",
  posix,
  async (t) => {
    const { f, native, target, input, image } = await settled(t);
    const before = image();
    for (const [table, predicate] of [
      [
        "job_revisions",
        "NEW.kind='delivery' AND json_extract(NEW.data,'$.state')='prepared'",
      ],
      [
        "job_revisions",
        "NEW.kind='delivery' AND json_extract(NEW.data,'$.state')='dispatching'",
      ],
      ["session_inputs", "1"],
      [
        "job_revisions",
        "NEW.kind='delivery' AND json_extract(NEW.data,'$.state')='accepted'",
      ],
    ]) {
      native.db.exec(
        `CREATE TEMP TRIGGER atomic_fault BEFORE INSERT ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT,'atomic SQLite fault'); END`,
      );
      try {
        assert.throws(
          () => native.deliverJobResultAtomic(target(), input),
          /atomic SQLite fault/,
        );
        assert.equal(native.db.isTransaction, false);
        assert.deepEqual(image(), before);
        assert.deepEqual(
          native.db.prepare("PRAGMA foreign_key_check").all(),
          [],
        );
        validateJobDatabase(native.db);
      } finally {
        native.db.exec("DROP TRIGGER atomic_fault");
      }
    }
    assert.equal(
      native.deliverJobResultAtomic(target(), input).record.state,
      "accepted",
    );
    assert.equal(f.rows("session_inputs").length, 1);
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "an outer commit failure discards actual pending input and all accepted receipts, then a fresh Original can retry once",
  posix,
  async (t) => {
    const { f, native, ports, target, input, image } = await settled(t);
    const before = image(),
      write = ports.writeTx;
    ports.writeTx = (operation) =>
      write(() => {
        operation();
        throw new Error("atomic commit boundary fault");
      });
    try {
      assert.throws(
        () => native.deliverJobResultAtomic(target(), input),
        /atomic commit boundary fault/,
      );
      assert.deepEqual(image(), before);
      assert.equal(native.db.isTransaction, false);
    } finally {
      ports.writeTx = write;
    }
    const result = native.deliverJobResultAtomic(target(), input);
    assert.equal(result.record.state, "accepted");
    assert.equal(f.rows("session_inputs").length, 1);
    assert.equal(f.providerCalls.length, 0);
    validateJobDatabase(native.db);
  },
);

test(
  "atomic native inputs reject accessors, copied Originals, stale CAS and an unavailable acceptance port without effects",
  posix,
  async (t) => {
    const { f, native, ports, target, input, image } = await settled(t);
    const before = image();
    let getters = 0;
    assert.throws(() =>
      native.deliverJobResultAtomic(target(), {
        ...input,
        get jobId() {
          getters++;
          return input.jobId;
        },
      }),
    );
    assert.equal(getters, 0);
    assert.throws(
      () => native.deliverJobResultAtomic({}, input),
      code("JOB_ORIGINAL_REQUIRED"),
    );
    assert.throws(
      () =>
        native.deliverJobResultAtomic(target(), {
          ...input,
          expectedRevision: 1,
        }),
      code("JOB_REVISION_CONFLICT"),
    );
    const accept = ports.acceptAtomicInput;
    ports.acceptAtomicInput = undefined;
    try {
      assert.throws(
        () => native.deliverJobResultAtomic(target(), input),
        code("JOB_ATOMIC_DELIVERY_UNSUPPORTED"),
      );
    } finally {
      ports.acceptAtomicInput = accept;
    }
    assert.deepEqual(image(), before);
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "atomic delivery never resumes an existing legacy uncertain dispatch intent",
  posix,
  async (t) => {
    const { f, native, target, input, job, image } = await settled(t);
    const original = target(),
      deliveryId = knowledgeHash([
        "job-result-delivery-v1",
        input.workspaceId,
        input.jobId,
        job.sha256,
      ]);
    const prepared = native.prepareJobDelivery(original, {
      ...input,
      deliveryId,
    });
    const { formatJobResult } = await import("./delivery.js");
    const intent = native.dispatchJobDelivery(original, {
      workspaceId: input.workspaceId,
      deliveryId,
      requestId: "legacy-intent",
      expectedRevision: prepared.record.revision,
      inputRequestId: `job-result:${job.jobId}:${job.sha256}`,
      prompt: formatJobResult(job, prepared.record.target),
    });
    native.abandonJobDelivery({
      workspaceId: input.workspaceId,
      deliveryId,
      requestId: "legacy-uncertain",
      expectedRevision: intent.record.revision,
      operation: "uncertain",
      errorCode: "TEST_GAP",
    });
    const before = image();
    assert.throws(
      () => native.deliverJobResultAtomic({}, input),
      code("JOB_DELIVERY_EXISTS"),
    );
    assert.deepEqual(image(), before);
    assert.equal(f.rows("session_inputs").length, 0);
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "Promise acceptance, proof or release callbacks cannot publish an atomic accepted receipt",
  posix,
  async (t) => {
    const { f, native, ports, target, input, image } = await settled(t);
    const before = image(),
      accept = ports.acceptAtomicInput!,
      release = ports.releaseAtomicInput!;
    ports.acceptAtomicInput = (original, planned) =>
      Promise.resolve(accept(original, planned));
    try {
      assert.throws(
        () => native.deliverJobResultAtomic(target(), input),
        code("JOB_ATOMIC_INPUT_INVALID"),
      );
      assert.deepEqual(image(), before);
    } finally {
      ports.acceptAtomicInput = accept;
    }
    const read = ports.readAccepted;
    ports.readAccepted = (original) =>
      Promise.resolve(read(original)) as unknown as ReturnType<typeof read>;
    try {
      assert.throws(
        () => native.deliverJobResultAtomic(target(), input),
        (error: unknown) => error instanceof EngineError,
      );
      assert.deepEqual(image(), before);
    } finally {
      ports.readAccepted = read;
    }
    ports.releaseAtomicInput = (original) => {
      release(original);
      return Promise.resolve();
    };
    try {
      assert.throws(
        () => native.deliverJobResultAtomic(target(), input),
        code("JOB_ATOMIC_INPUT_INVALID"),
      );
      assert.deepEqual(image(), before);
    } finally {
      ports.releaseAtomicInput = release;
    }
    assert.equal(f.rows("session_inputs").length, 0);
    assert.equal(f.providerCalls.length, 0);
    validateJobDatabase(native.db);
  },
);
