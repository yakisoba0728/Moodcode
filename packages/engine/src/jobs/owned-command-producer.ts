import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  EngineCommandDeliveryProducer,
  type CommandDeliveryRuntime,
} from "./command-delivery-input.js";
import type { OwnedCommandJobHost } from "./owned-command-host.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";
import {
  OWNED_COMMAND_RESULT_PROFILE,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";

export class EngineOwnedCommandDeliveryProducer extends EngineCommandDeliveryProducer<
  OwnedCommandJobRecord,
  OwnedCommandDeliveryTargetProof
> {
  constructor(
    engine: CommandDeliveryRuntime,
    checkBinding: (workspaceId: string) => KnowledgeHostBinding,
    enabled: () => boolean,
    source: OwnedCommandJobHost,
  ) {
    super(
      engine,
      checkBinding,
      enabled,
      source,
      OWNED_COMMAND_RESULT_PROFILE,
      (store, input) => store.findOwnedCommandDeliveryForInput(input),
    );
  }
}
