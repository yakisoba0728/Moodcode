import {
  CommandResultDelivery,
  type CommandResultDeliveryPorts,
} from "./command-delivery-input.js";
import {
  HOST_COMMAND_RESULT_PROFILE,
  type HostCommandDeliveryTargetProof,
  type HostCommandSettlementPin,
} from "./host-command-result.js";

/** Explicit Root delivery consumes a completed observation; its independent physical source keeps its immutable execution history. */
export class HostCommandDelivery extends CommandResultDelivery<
  HostCommandSettlementPin,
  HostCommandDeliveryTargetProof
> {
  constructor(
    ports: CommandResultDeliveryPorts<
      HostCommandSettlementPin,
      HostCommandDeliveryTargetProof
    >,
  ) {
    super(ports, HOST_COMMAND_RESULT_PROFILE);
  }
}
