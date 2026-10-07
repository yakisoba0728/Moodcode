import { randomUUID } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import { RoleResourcePolicy, type RoleResourcePolicySnapshot } from './role-resources.js';

export interface RoleResourcePolicyGeneration {
  readonly registryId: string;
  readonly registryRevision: number;
  readonly policyRevision: number;
  readonly policySha256: string;
}
/** Host-only opaque capture. A detached copy describes a generation but authorizes nothing. */
export interface RoleResourcePolicyCapture extends RoleResourcePolicyGeneration {
  readonly policy: RoleResourcePolicy;
}

/** One shared host authority for parent/child runtimes; retains only its current strong capture. */
export class RoleResourcePolicyRegistry {
  readonly id = randomUUID();
  #current: RoleResourcePolicyCapture;
  readonly #captures = new WeakSet<object>();
  constructor(initialSnapshot: RoleResourcePolicySnapshot = { revision: 1, rules: [] }) {
    this.#current = this.issue(1, new RoleResourcePolicy(initialSnapshot));
    Object.freeze(this);
  }
  get revision(): number { return this.#current.registryRevision; }
  capture(): RoleResourcePolicyCapture { return this.#current; }
  /** CAS is on the registry generation, never on a ToolPolicy/tool-catalogue/policy snapshot number. */
  replace(expectedRegistryRevision: number, snapshot: RoleResourcePolicySnapshot): RoleResourcePolicyCapture {
    if (!Number.isSafeInteger(expectedRegistryRevision) || expectedRegistryRevision < 1) throw new EngineError('INVALID_ROLE_POLICY_REVISION', 'Role registry revision must be a positive safe integer');
    if (expectedRegistryRevision !== this.revision) throw new EngineError('ROLE_POLICY_REGISTRY_CONFLICT', 'Role policy registry changed before host replacement');
    if (this.revision === Number.MAX_SAFE_INTEGER) throw new EngineError('ROLE_POLICY_REGISTRY_LIMIT', 'Role policy registry generation limit reached');
    const policy = new RoleResourcePolicy(snapshot);
    // Validation rejects accessors/proxies; a failed replacement leaves the old capture unchanged.
    if (expectedRegistryRevision !== this.revision) throw new EngineError('ROLE_POLICY_REGISTRY_CONFLICT', 'Role policy registry changed during host replacement');
    this.#current = this.issue(this.revision + 1, policy); return this.#current;
  }
  assertCurrent(capture: RoleResourcePolicyCapture): void {
    // Do not inspect a caller's properties: arbitrary cloned objects and proxies are not authority.
    if (!capture || typeof capture !== 'object' || !this.#captures.has(capture) || capture !== this.#current) throw new EngineError('ROLE_POLICY_REGISTRY_STALE', 'Role policy capture belongs to another registry or an old generation');
  }
  private issue(registryRevision: number, policy: RoleResourcePolicy): RoleResourcePolicyCapture {
    const capture = Object.freeze({ registryId: this.id, registryRevision, policyRevision: policy.revision, policySha256: policy.sha256, policy });
    this.#captures.add(capture); return capture;
  }
}
