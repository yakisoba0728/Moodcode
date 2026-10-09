import assert from "node:assert/strict";
import {
  windowsOwnedDeliverySqlFixture,
  preserveOwnedDeliveryEvidence,
} from "./fixtures/owned-command-delivery-windows.js";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { NativeSessionStorage } from "../storage/native.js";
import { ownedDeliveryFixture } from "./fixtures/owned-command-delivery.js";
import type { EngineOwnedCommandDeliveryProducer } from "./owned-command-producer.js";
import {
  ownedCommandJobKind,
  pauseImportedOwnedCommandJobs,
  type OwnedCommandJobRecord,
} from "./owned-command-records.js";
import { signJobData } from "./validation.js";
import {
  deliverOwnedCommandResultAtomic,
  findOwnedCommandDeliveryForInput,
  ownedCommandDeliveryKind,
  ownedCommandInputKind,
  pauseImportedOwnedCommandDeliveries,
  readOwnedCommandDeliveries,
  readOwnedCommandDelivery,
  validateOwnedCommandDeliveryDatabase,
  type OwnedCommandDeliveryInput,
  type OwnedCommandDeliveryPorts,
  type OwnedCommandDeliveryRecord,
} from "./owned-command-delivery-records.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const invalid = (error: unknown) => error instanceof EngineError;

/** Actual Root Originals, command/ToolPart/checkpoint and input producer; only native boundary faults are injected. */
async function fixture(t: test.TestContext) {
  const f = await ownedDeliveryFixture(t);
  const settled = await f.complete();
  assert.equal(settled.state, "completed");
  f.engine.store.setSessionPaused(f.session.id, true, "user");
  const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
  const native = Reflect.get(f.engine.store, "native") as NativeSessionStorage;
  const producer = Reflect.get(
    f.engine,
    "ownedCommandProducer",
  ) as EngineOwnedCommandDeliveryProducer;
  const target = f.capture(),
    proof = producer.readTarget(target);
  let acceptCalls = 0,
    targetReads = 0,
    wakes = 0;
  const ports: OwnedCommandDeliveryPorts = {
    readTargetOriginal(original) {
      targetReads++;
      return producer.readTarget(original);
    },
    assertTarget(original, expected) {
      producer.assertTargetCurrent(original, expected);
    },
    acceptAtomic(original, { inputRequestId, prompt }) {
      acceptCalls++;
      const handle = producer.acceptAtomic(original, {
        inputRequestId,
        prompt,
      });
      f.engine.store.publishAfterCommit(() => wakes++);
      return handle;
    },
    readAccepted(original) {
      return producer.readAccepted(original);
    },
    releaseAccepted(original) {
      producer.release(original);
    },
    writeDocument: (...args) => f.engine.store.putSessionDocument(...args),
    appendEvent: (...args) => native.appendEvent(...args),
  };
  const input: OwnedCommandDeliveryInput = {
    workspaceId: f.workspace.id,
    jobId: settled.jobId,
    requestId: "native-owned-delivery",
    expectedRevision: 0,
    targetSha256: proof.sha256,
  };
  const tx = <T>(operation: () => T): T =>
    Reflect.apply(Reflect.get(f.engine.store, "transaction"), f.engine.store, [
      operation,
    ]) as T;
  const deliver = (original = target, x = input) =>
    tx(() => deliverOwnedCommandResultAtomic(db, original, x, ports));
  const images = () => [
    db
      .prepare("SELECT * FROM session_documents ORDER BY session_id,kind")
      .all(),
    db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
    db.prepare("SELECT * FROM session_events ORDER BY session_id,seq").all(),
  ];
  const counts = () => ({ acceptCalls, targetReads, wakes });
  const probe = (fn: () => void) => {
    db.exec("SAVEPOINT owned_delivery_probe");
    try {
      fn();
    } finally {
      db.exec("ROLLBACK TO owned_delivery_probe;RELEASE owned_delivery_probe");
    }
  };
  return {
    ...f,
    db,
    native,
    proof,
    target,
    ports,
    input,
    settled,
    tx,
    deliver,
    images,
    counts,
    probe,
  };
}

test(
  "native owned result and its exact real input commit once; released Original is unnecessary for dedupe history",
  posix,
  async (t) => {
    const f = await fixture(t),
      before = f.counts(),
      result = f.deliver();
    assert.equal(result.kind, "accepted");
    assert.equal(result.record.revision, 1);
    assert.equal(
      f.engine.store.getInput(result.record.accepted.inputId).state,
      "pending",
    );
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1);
    assert.deepEqual(f.counts(), {
      acceptCalls: before.acceptCalls + 1,
      targetReads: before.targetReads + 1,
      wakes: 1,
    });
    validateOwnedCommandDeliveryDatabase(f.db);
    const image = f.images(),
      counts = f.counts(),
      copy = structuredClone(result.record);
    (copy as { prompt: string }).prompt = "caller mutation";
    const duplicate = f.deliver({});
    assert.equal(duplicate.kind, "duplicate");
    assert.deepEqual(duplicate.record, result.record);
    assert.deepEqual(f.images(), image);
    const queries: string[] = [],
      prepare = f.db.prepare;
    Reflect.set(f.db, "prepare", (sql: string) => {
      queries.push(sql);
      return Reflect.apply(prepare, f.db, [sql]);
    });
    try {
      assert.equal(
        findOwnedCommandDeliveryForInput(f.db, {
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          inputId: f.receipt.inputId,
          requestId: f.engine.store.getRun(f.receipt.runId).requestId,
        }),
        null,
      );
    } finally {
      Reflect.set(f.db, "prepare", prepare);
    }
    assert.ok(
      !queries.some(
        (sql) =>
          sql.includes("sum(length") ||
          sql.includes("SELECT data FROM session_documents"),
      ),
      "An ordinary input miss must not aggregate or parse all delivery bodies",
    );
    assert.deepEqual(f.counts(), counts);
    assert.throws(() => {
      (result.record as { state: string }).state = "paused-import";
    }, TypeError);
    assert.throws(
      () => f.deliver({}, { ...f.input, targetSha256: "f".repeat(64) }),
      invalid,
    );
    assert.deepEqual(f.images(), image);
  },
);

test(
  "native descriptor, proxy and Original failures occur before real input acceptance",
  posix,
  async (t) => {
    const f = await fixture(t),
      before = f.images();
    let getters = 0;
    assert.throws(
      () =>
        f.tx(() =>
          deliverOwnedCommandResultAtomic(
            f.db,
            f.target,
            {
              ...f.input,
              get requestId() {
                getters++;
                return "bad";
              },
            },
            f.ports,
          ),
        ),
      invalid,
    );
    assert.equal(getters, 0);
    assert.throws(() => f.deliver(new Proxy({}, {})), invalid);
    assert.throws(() => f.deliver({}), invalid);
    assert.throws(
      () => deliverOwnedCommandResultAtomic(f.db, f.target, f.input, f.ports),
      invalid,
    );
    assert.equal(f.counts().acceptCalls, 0);
    assert.deepEqual(f.images(), before);
  },
);

test(
  "real SQL receipt, link and admission faults roll back the actual input and all native output with zero postcommit wake",
  posix,
  async (t) => {
    const f = await fixture(t),
      before = f.images();
    for (const condition of [
      "NEW.type='command.job.result_admitted'",
      "NEW.type='session.document.updated' AND json_extract(NEW.data,'$.payload.kind') GLOB 'command.delivery.*'",
      "NEW.type='session.document.updated' AND json_extract(NEW.data,'$.payload.kind') GLOB 'command.input.*'",
    ]) {
      f.db.exec(
        `CREATE TEMP TRIGGER native_owned_delivery_fault BEFORE INSERT ON session_events WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Actual combined native transaction fault'); END`,
      );
      try {
        assert.throws(() => f.deliver());
        assert.deepEqual(f.images(), before);
        assert.equal(f.counts().wakes, 0);
      } finally {
        f.db.exec("DROP TRIGGER native_owned_delivery_fault");
      }
    }
    assert.equal(f.deliver().kind, "accepted");
    assert.equal(f.counts().wakes, 1);
  },
);

test(
  "asynchronous or failing genuine producer callbacks cannot commit a partial native receipt",
  posix,
  async (t) => {
    const f = await fixture(t),
      before = f.images();
    for (const name of [
      "assertTarget",
      "readAccepted",
      "releaseAccepted",
      "writeDocument",
      "appendEvent",
    ] as const) {
      const original = f.ports[name];
      Reflect.set(f.ports, name, (...args: unknown[]) => {
        const value = Reflect.apply(original, f.ports, args);
        return Promise.resolve(value);
      });
      try {
        assert.throws(() => f.deliver(), invalid);
        assert.deepEqual(f.images(), before);
        assert.equal(f.counts().wakes, 0);
      } finally {
        Reflect.set(f.ports, name, original);
      }
    }
    assert.equal(f.deliver().kind, "accepted");
  },
);

test(
  "independent birth admission rejects a fully rehashed paused receipt with forged command outcome or target",
  posix,
  async (t) => {
    const f = await fixture(t),
      r = f.deliver().record;
    for (const mutation of ["outcome", "target"]) {
      f.probe(() => {
        const job =
          mutation === "outcome"
            ? signJobData({
                ...r.settled,
                completion: {
                  ...r.settled.completion!,
                  stdout: {
                    ...r.settled.completion!.stdout,
                    sha256: "e".repeat(64),
                  },
                },
              })
            : r.settled;
        const target =
          mutation === "target"
            ? { ...r.target, capabilitiesSha256: "e".repeat(64) }
            : r.target;
        const proof = signJobData(
          { ...f.proof, settled: job, jobSha256: job.sha256, target },
          131072,
        );
        const { sha256: _hash, ...body } = r;
        const forged = signJobData(
          {
            ...body,
            revision: 2,
            state: "paused-import",
            importArchiveSha256: "a".repeat(64),
            target,
            targetSha256: proof.sha256,
            settled: job,
          },
          131072,
        );
        f.ports.writeDocument(
          r.accepted.sessionId,
          ownedCommandDeliveryKind(r.id),
          1,
          forged as unknown as JsonObject,
        );
        assert.throws(
          () => validateOwnedCommandDeliveryDatabase(f.db),
          invalid,
        );
      });
    }
    validateOwnedCommandDeliveryDatabase(f.db);
  },
);

test(
  "input linkage detects deletion, aliases, changed request IDs and erased accepted pointers",
  posix,
  async (t) => {
    const f = await fixture(t),
      r = f.deliver().record;
    const lookup = () =>
      findOwnedCommandDeliveryForInput(f.db, {
        workspaceId: r.workspaceId,
        sessionId: r.accepted.sessionId,
        inputId: r.accepted.inputId,
        requestId: r.inputRequestId,
      });
    assert.deepEqual(lookup(), r);
    for (const kind of [
      ownedCommandInputKind(r.accepted.inputId),
      ownedCommandDeliveryKind(r.id),
    ]) {
      f.probe(() => {
        f.db
          .prepare(
            "DELETE FROM session_documents WHERE session_id=? AND kind=?",
          )
          .run(r.accepted.sessionId, kind);
        assert.throws(lookup, invalid);
        assert.throws(
          () => validateOwnedCommandDeliveryDatabase(f.db),
          invalid,
        );
      });
    }
    f.probe(() => {
      const kind = ownedCommandInputKind(r.accepted.inputId),
        row = f.engine.store.getSessionDocument(r.accepted.sessionId, kind)!;
      f.ports.writeDocument(
        r.accepted.sessionId,
        kind,
        1,
        signJobData({ ...row.data, inputId: "authentic-input-alias" }),
      );
      assert.throws(lookup, invalid);
    });
    f.probe(() => {
      f.db
        .prepare(
          "UPDATE session_inputs SET request_id='ordinary',data=json_set(data,'$.requestId','ordinary') WHERE id=?",
        )
        .run(r.accepted.inputId);
      assert.throws(
        () =>
          findOwnedCommandDeliveryForInput(f.db, {
            workspaceId: r.workspaceId,
            sessionId: r.accepted.sessionId,
            inputId: r.accepted.inputId,
            requestId: "ordinary",
          }),
        invalid,
      );
    });
    for (const rewrite of [
      "UPDATE session_inputs SET state='cancelled' WHERE id=?",
      "UPDATE session_inputs SET data=json_set(data,'$.state','promoted','$.runId','forged-run','$.promotedSeq',admitted_seq+1) WHERE id=?",
      "UPDATE session_inputs SET data=json_set(data,'$.attachments',json('[]')) WHERE id=?",
      "UPDATE session_inputs SET data=json_set(data,'$.documents',json('[]')) WHERE id=?",
    ])
      f.probe(() => {
        f.db.prepare(rewrite).run(r.accepted.inputId);
        assert.throws(lookup, invalid);
      });
    f.probe(() => {
      const { sha256: _hash, ...body } = r;
      f.ports.writeDocument(
        r.accepted.sessionId,
        ownedCommandDeliveryKind(r.id),
        1,
        signJobData(
          {
            ...body,
            revision: 2,
            state: "paused-import",
            importArchiveSha256: "a".repeat(64),
            accepted: null,
          },
          131072,
        ) as unknown as JsonObject,
      );
      assert.throws(lookup, invalid);
    });
    validateOwnedCommandDeliveryDatabase(f.db);
    f.probe(() => {
      f.db
        .prepare("UPDATE runs SET state='running' WHERE id=?")
        .run(r.settled.source.runId);
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
    f.probe(() => {
      f.db
        .prepare(
          "UPDATE runs SET data=json_set(data,'$.state','running') WHERE id=?",
        )
        .run(r.settled.source.runId);
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
    f.probe(() => {
      pauseImportedOwnedCommandJobs(f.db, f.workspace.id, "a".repeat(64), {
        writeDocument: f.ports.writeDocument,
      });
      f.db
        .prepare(
          "UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',false) WHERE run_id=? AND type='tool.completed'",
        )
        .run(r.settled.source.runId);
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
  },
);

test(
  "import pauses delivery while preserving its original full completion snapshot and native input without creating a Run",
  posix,
  async (t) => {
    const f = await fixture(t),
      r = f.deliver().record,
      birth = f.db
        .prepare(
          "SELECT * FROM session_events WHERE type='command.job.result_admitted'",
        )
        .all(),
      counts = f.counts();
    f.tx(() => {
      pauseImportedOwnedCommandJobs(f.db, f.workspace.id, "a".repeat(64), {
        writeDocument: f.ports.writeDocument,
      });
      assert.equal(
        pauseImportedOwnedCommandDeliveries(
          f.db,
          f.workspace.id,
          "a".repeat(64),
          { writeDocument: f.ports.writeDocument },
        ),
        1,
      );
    });
    const paused = readOwnedCommandDelivery(f.db, f.workspace.id, r.id)!;
    assert.equal(paused.state, "paused-import");
    assert.equal(paused.revision, 2);
    assert.deepEqual(paused.settled, r.settled);
    assert.deepEqual(paused.accepted, r.accepted);
    assert.deepEqual(
      f.db
        .prepare(
          "SELECT * FROM session_events WHERE type='command.job.result_admitted'",
        )
        .all(),
      birth,
    );
    assert.equal(
      f.tx(() =>
        pauseImportedOwnedCommandDeliveries(
          f.db,
          f.workspace.id,
          "a".repeat(64),
          { writeDocument: f.ports.writeDocument },
        ),
      ),
      0,
    );
    assert.equal(f.deliver({}).kind, "duplicate");
    assert.deepEqual(f.counts(), counts);
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1);
    assert.equal(f.engine.store.getInput(r.accepted.inputId).state, "pending");
    validateOwnedCommandDeliveryDatabase(f.db);
  },
);

test(
  "metadata caps reject oversized native documents and excessive heads before parsing forged bodies",
  posix,
  async (t) => {
    const f = await fixture(t),
      r = f.deliver().record;
    f.probe(() => {
      f.db
        .prepare("UPDATE session_documents SET data=? WHERE kind=?")
        .run("x".repeat(131073), ownedCommandDeliveryKind(r.id));
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
    f.probe(() => {
      for (let i = 0; i < 128; i++)
        f.db
          .prepare(
            "INSERT INTO session_documents(session_id,kind,revision,data) VALUES(?,?,1,'malformed-body')",
          )
          .run(
            f.session.id,
            `command.delivery.${i.toString(16).padStart(32, "0")}`,
          );
      assert.throws(
        () => readOwnedCommandDeliveries(f.db, f.workspace.id),
        invalid,
      );
    });
    validateOwnedCommandDeliveryDatabase(f.db);
  },
);

test(
  "a later generic command document rewrite cannot bypass the original sealed completion and old settled document revision",
  posix,
  async (t) => {
    const f = await fixture(t),
      r = f.deliver().record;
    f.probe(() => {
      const { sha256: _hash, ...body } = r.settled;
      const forged = signJobData({
        ...body,
        revision: r.settled.revision + 1,
        completion: {
          ...r.settled.completion!,
          stdout: { ...r.settled.completion!.stdout, sha256: "f".repeat(64) },
        },
      });
      f.ports.writeDocument(
        f.session.id,
        ownedCommandJobKind(f.settled.jobId),
        f.settled.revision,
        forged as unknown as JsonObject,
      );
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
    f.probe(() => {
      f.db
        .prepare(
          "DELETE FROM session_events WHERE type='session.document.updated' AND instr(data,?)>0",
        )
        .run(JSON.stringify(ownedCommandJobKind(r.jobId)));
      assert.throws(
        () => readOwnedCommandDelivery(f.db, f.workspace.id, r.id),
        invalid,
      );
    });
    validateOwnedCommandDeliveryDatabase(f.db);
    assert.equal(
      f.providerEntries(),
      2,
      "Delivery must preserve the already completed source Run without provider replay",
    );
  },
);

test("Windows-shaped native SQL accepts absent interrupted cleanup only with exact approval, physical close, Tool and Part", (t) => {
  const f = windowsOwnedDeliverySqlFixture(t),
    original = f.images();
  const userVersion = Number(f.db.prepare("PRAGMA user_version").get()!.user_version);
  assert.equal(userVersion, 23);
  preserveOwnedDeliveryEvidence("windows-sql-original", {
    classification:
      "trusted Windows-shaped SQL; no native Windows process proof",
    original,
    settled: f.settled,
    userVersion,
  });
  const before = f.counts(),
    result = f.deliver();
  assert.equal(result.kind, "accepted");
  assert.equal(
    f.store.getInput(result.record.accepted.inputId).state,
    "pending",
  );
  assert.equal(result.record.settled.sha256, f.settled.sha256);
  assert.deepEqual(f.counts(), { accepts: before.accepts + 1, wakes: 1 });
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM session_events WHERE type='command.job.result_admitted'",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.delivery.*'",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.input.*'",
      )
      .get()!.n,
    1,
  );
  validateOwnedCommandDeliveryDatabase(f.db);
  const image = f.images(),
    counts = f.counts();
  assert.equal(f.deliver({ sqlFixture: true }).kind, "duplicate");
  assert.deepEqual(f.images(), image);
  assert.deepEqual(f.counts(), counts);
  preserveOwnedDeliveryEvidence("windows-sql-accepted", {
    classification: "trusted Windows-shaped SQL",
    result,
    image,
    counts,
  });
});

for (const [name, mutation] of [
  [
    "explicit false cleanup",
    "UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',false) WHERE type='tool.interrupted'",
  ],
  [
    "foreign Tool",
    "UPDATE events SET data=json_set(data,'$.payload.toolCallId','foreign') WHERE type='tool.interrupted'",
  ],
  [
    "reopened Part",
    "UPDATE message_parts SET state='open',data=json_set(data,'$.state','open') WHERE id='part'",
  ],
  [
    "missing physical close",
    "DELETE FROM session_events WHERE type='command.job.closed_observed'",
  ],
  [
    "POSIX approval",
    "UPDATE approvals SET data=json_set(data,'$.preview.platform','darwin','$.preview.termination','posix-process-group') WHERE id='approval'",
  ],
  [
    "duplicate interrupted event",
    "INSERT INTO events(session_id,seq,event_id,run_id,type,data) SELECT session_id,(SELECT max(seq)+1 FROM events WHERE session_id='session'),'duplicate-interrupted-event',run_id,type,json_set(data,'$.eventId','duplicate-interrupted-event','$.seq',(SELECT max(seq)+1 FROM events WHERE session_id='session')) FROM events WHERE type='tool.interrupted'",
  ],
] as const)
  test(`Windows-shaped native SQL rejects ${name} and rolls back all delivery/input effects`, (t) => {
    const f = windowsOwnedDeliverySqlFixture(t);
    f.db.exec(mutation);
    const before = f.images();
    assert.throws(() => f.deliver(), invalid);
    assert.deepEqual(f.images(), before);
    assert.equal(f.counts().wakes, 0);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM session_events WHERE type='command.job.result_admitted'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.delivery.*' OR kind GLOB 'command.input.*'",
        )
        .get()!.n,
      0,
    );
  });
