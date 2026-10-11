import {
  CommandResultDelivery,
  type CommandResultDeliveryPorts,
  type DeliverCommandJobResultInput,
} from "./command-delivery-input.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import {
  OWNED_COMMAND_RESULT_PROFILE,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";

export type DeliverOwnedCommandJobResultInput = DeliverCommandJobResultInput;

/** Explicit Root delivery consumes a completed observation; the source Run keeps its execution history. */
export class OwnedCommandDelivery extends CommandResultDelivery<
  OwnedCommandJobRecord,
  OwnedCommandDeliveryTargetProof
> {
  constructor(
    ports: CommandResultDeliveryPorts<
      OwnedCommandJobRecord,
      OwnedCommandDeliveryTargetProof
    >,
  ) {
    super(ports, OWNED_COMMAND_RESULT_PROFILE);
  }
}
