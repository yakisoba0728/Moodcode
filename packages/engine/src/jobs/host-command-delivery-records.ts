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
  HOST_COMMAND_LIMITS,
  readHostCommand,
  validateHostCommandRecord,
} from "./host-command-records.js";
import {
  HOST_COMMAND_RESULT_PROFILE,
  hostCommandSettlement,
  type HostCommandDeliveryTargetProof,
  type HostCommandSettlementPin,
} from "./host-command-result.js";

export type HostCommandDeliveryInput = CommandDeliveryInput;
export type HostCommandDeliveryRecord =
  CommandDeliveryRecord<HostCommandSettlementPin>;
export type HostCommandDeliveryResult =
  CommandDeliveryResult<HostCommandSettlementPin>;
export type HostCommandDeliveryPorts = CommandDeliveryPorts<
  HostCommandDeliveryTargetProof,
  "host.command.result_admitted"
>;

function settledSql(
  db: DatabaseSync,
  r: HostCommandDeliveryRecord,
  kit: CommandDeliveryKit,
): void {
  const current = readHostCommand(db, r.workspaceId, r.jobId);
  if (!current || current.sessionId !== r.settled.sessionId)
    kit.fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
  const h = db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) bytes FROM host_command_revisions WHERE id=? AND workspace_id=? AND job_id=?",
    )
    .get(r.settled.id, r.workspaceId, r.jobId);
  if (
    !h ||
    Number(h.bytes) < 1 ||
    Number(h.bytes) > HOST_COMMAND_LIMITS.rowBytes
  )
    kit.fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
  const raw = db
    .prepare(
      "SELECT data FROM host_command_revisions WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(r.settled.id, h.bytes!);
  if (!raw) kit.fail();
  const closed = validateHostCommandRecord(kit.parsed(raw.data));
  if (
    !same(hostCommandSettlement(closed), r.settled) ||
    !same(current.owner, closed.owner) ||
    !same(current.preview, closed.preview) ||
    current.pid !== closed.pid ||
    closed.revision > current.revision ||
    closed.jobId !== current.jobId ||
    closed.workspaceId !== current.workspaceId ||
    closed.sessionId !== current.sessionId ||
    !same(current.completion, closed.completion)
  )
    kit.fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
}

const records = createCommandDeliveryRecords({
  ...HOST_COMMAND_RESULT_PROFILE,
  code: "HOST_COMMAND_DELIVERY",
  kindPrefix: "host.command.",
  admittedEvent: "host.command.result_admitted",
  idDomain: "host-command-result-v1",
  currentSettled: (db, workspaceId, jobId) => {
    const job = readHostCommand(db, workspaceId, jobId);
    return job && hostCommandSettlement(job);
  },
  assertSettledSource: settledSql,
});
export const validateHostCommandDeliveryRecord = records.validateRecord;
export const readHostCommandDelivery = records.readDelivery;
export const readHostCommandDeliveries = records.readDeliveries;
export const findHostCommandDeliveryForInput = records.findForInput;
export const validateHostCommandDeliveryDatabase = records.validateDatabase;
export const deliverHostCommandResultAtomic = records.deliverAtomic;
export const pauseImportedHostCommandDeliveries = records.pauseImported;
