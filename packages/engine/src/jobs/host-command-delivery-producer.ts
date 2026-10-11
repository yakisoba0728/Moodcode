import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  EngineCommandDeliveryProducer,
  type CommandDeliveryRuntime,
} from "./command-delivery-input.js";
import type { EngineHostCommandDeliverySource } from "./host-command-delivery-source.js";
import {
  HOST_COMMAND_RESULT_PROFILE,
  type HostCommandDeliveryTargetProof,
  type HostCommandSettlementPin,
} from "./host-command-result.js";

export class EngineHostCommandDeliveryProducer extends EngineCommandDeliveryProducer<
  HostCommandSettlementPin,
  HostCommandDeliveryTargetProof
> {
  constructor(
    engine: CommandDeliveryRuntime,
    checkBinding: (workspaceId: string) => KnowledgeHostBinding,
    enabled: () => boolean,
    source: EngineHostCommandDeliverySource,
  ) {
    super(
      engine,
      checkBinding,
      enabled,
      source,
      HOST_COMMAND_RESULT_PROFILE,
      (store, input) => store.findHostCommandDeliveryForInput(input),
    );
  }
}
