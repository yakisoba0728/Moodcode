import type { DatabaseSync } from "node:sqlite";
import { sameCanonical as same } from "../shared/canonical.js";
import {
  createCommandDeliveryRecords,
  type CommandDeliveryInput,
  type CommandDeliveryKit,
  type CommandDeliveryPorts,
  type CommandDeliveryRecord,
  type CommandDeliveryResult,
} from "./command-delivery-records.js";
import {
  OWNED_COMMAND_JOB_LIMITS,
  ownedCommandJobKind,
  readOwnedCommandJob,
  verifyOwnedCommandToolClose,
  type OwnedCommandJobRecord,
} from "./owned-command-records.js";
import {
  OWNED_COMMAND_RESULT_PROFILE,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";

export type OwnedCommandDeliveryInput = CommandDeliveryInput;
export type OwnedCommandDeliveryRecord =
  CommandDeliveryRecord<OwnedCommandJobRecord>;
export type OwnedCommandDeliveryResult =
  CommandDeliveryResult<OwnedCommandJobRecord>;
export type OwnedCommandDeliveryPorts = CommandDeliveryPorts<
  OwnedCommandDeliveryTargetProof,
  "command.job.result_admitted"
>;

function settledSql(
  db: DatabaseSync,
  r: OwnedCommandDeliveryRecord,
  kit: CommandDeliveryKit,
): void {
  const saved = r.settled,
    source = saved.source,
    max = OWNED_COMMAND_JOB_LIMITS.nativeBytes;
  const run = db
    .prepare(
      "SELECT workspace_id,session_id,state,length(CAST(data AS BLOB)) bytes FROM runs WHERE id=?",
    )
    .get(source.runId);
  if (
    !run ||
    run.workspace_id !== source.workspaceId ||
    run.session_id !== source.sessionId ||
    !["completed", "failed", "cancelled", "interrupted"].includes(
      String(run.state),
    ) ||
    Number(run.bytes) < 1 ||
    Number(run.bytes) > max
  )
    kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const runRow = db
    .prepare(
      "SELECT data FROM runs WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(source.runId, run.bytes!);
  if (!runRow) kit.fail();
  const runBody = kit.parsed(runRow.data) as Record<string, unknown>;
  if (
    runBody.id !== source.runId ||
    runBody.workspaceId !== run.workspace_id ||
    runBody.sessionId !== run.session_id ||
    runBody.state !== run.state
  )
    kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const current = readOwnedCommandJob(db, r.workspaceId, r.jobId);
  if (
    !current ||
    !same(current.source, source) ||
    current.groupPid !== saved.groupPid ||
    !same(current.completion, saved.completion)
  )
    kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  kit.documentAnchor(
    db,
    source.sessionId,
    ownedCommandJobKind(r.jobId),
    saved.revision,
    JSON.stringify(saved),
  );
  const toolH = db
    .prepare(
      "SELECT session_id,run_id,state,length(CAST(data AS BLOB)) bytes FROM tools WHERE id=?",
    )
    .get(source.toolCallId);
  if (
    !toolH ||
    toolH.session_id !== source.sessionId ||
    toolH.run_id !== source.runId ||
    Number(toolH.bytes) > max
  )
    kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const toolRow = db
    .prepare(
      "SELECT data FROM tools WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(source.toolCallId, toolH.bytes!);
  if (!toolRow) kit.fail();
  const tool = kit.parsed(toolRow.data) as Record<string, unknown>;
  if (tool.state !== toolH.state)
    kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  verifyOwnedCommandToolClose(
    db,
    saved,
    tool,
    {
      mismatch: () => kit.fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID"),
      limit: () => kit.fail("OWNED_COMMAND_DELIVERY_LIMIT"),
      invalid: () => kit.fail(),
    },
    { exactlyOne: true },
  );
}

const records = createCommandDeliveryRecords({
  ...OWNED_COMMAND_RESULT_PROFILE,
  code: "OWNED_COMMAND_DELIVERY",
  kindPrefix: "command.",
  admittedEvent: "command.job.result_admitted",
  idDomain: "owned-command-result-v1",
  currentSettled: readOwnedCommandJob,
  assertSettledSource: settledSql,
});
export const ownedCommandDeliveryKind = records.deliveryKind;
export const ownedCommandInputKind = records.inputKind;
export const validateOwnedCommandDeliveryRecord = records.validateRecord;
export const readOwnedCommandDelivery = records.readDelivery;
export const readOwnedCommandDeliveries = records.readDeliveries;
export const findOwnedCommandDeliveryForInput = records.findForInput;
export const validateOwnedCommandDeliveryDatabase = records.validateDatabase;
export const deliverOwnedCommandResultAtomic = records.deliverAtomic;
export const pauseImportedOwnedCommandDeliveries = records.pauseImported;
