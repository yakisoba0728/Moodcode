import { randomUUID } from 'node:crypto';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import { sha256Hex } from '../shared/canonical.js';
import type { ToolEffectClass } from './policy.js';
import { TOOL_EFFECTS } from './validation.js';
export interface GrantScope { workspaceId: string; sessionId: string; toolName: string; effect: ToolEffectClass; resources?: string[] }
export interface ScopedToolGrant extends GrantScope { id: string; policyVersion: number; expiresAt: number; remainingUses: number; revision: number; revoked: boolean }
export interface GrantDocumentPort {
  getSessionDocument(sessionId: string, kind: string): { revision: number; data: JsonObject } | null;
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): { revision: number; data: JsonObject };
}
const DOCUMENT_KIND = 'tool.grants';
/** Commands are exact identities; storing their hash avoids duplicating secret-bearing command text. */
function resources(scope: GrantScope): string[] {
  return [...new Set(scope.resources ?? [])].map(value => value.startsWith('command:') ? `command:sha256:${sha256Hex(value.slice(8))}` : value).sort();
}
function valid(grant: ScopedToolGrant, sessionId: string): boolean {
  return grant && typeof grant === 'object' && grant.sessionId === sessionId && [grant.id, grant.workspaceId, grant.sessionId, grant.toolName].every(value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512) && TOOL_EFFECTS.has(grant.effect) && Number.isSafeInteger(grant.policyVersion) && grant.policyVersion > 0 && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt >= 0 && Number.isSafeInteger(grant.remainingUses) && grant.remainingUses >= 0 && grant.remainingUses <= 1000 && Number.isSafeInteger(grant.revision) && grant.revision > 0 && typeof grant.revoked === 'boolean' && (grant.resources === undefined || Array.isArray(grant.resources) && grant.resources.length <= 32 && grant.resources.every(value => typeof value === 'string' && /^(?:path:|command:sha256:[a-f0-9]{64}$)/.test(value) && Buffer.byteLength(value) <= 8192));
}
/** CAS-backed grants are optional. Opaque prepared request revalidation remains mandatory. */
export class ScopedToolGrants {
  private grants = new Map<string, ScopedToolGrant>(); private current = 0;
  private documents = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly persistence?: GrantDocumentPort) {}
  get revision(): number { return this.current; }
  private load(sessionId: string): void {
    if (!this.persistence || this.documents.has(sessionId)) return;
    const document = this.persistence.getSessionDocument(sessionId, DOCUMENT_KIND);
    if (document) {
      if (document.data.schemaVersion !== 1 || !Array.isArray(document.data.grants) || document.data.grants.length > 1024) throw new EngineError('INVALID_TOOL_GRANT_DOCUMENT', 'Stored tool grants have unsupported schema');
      const records = document.data.grants as unknown as ScopedToolGrant[];
      if (records.some(grant => !valid(grant, sessionId)) || new Set(records.map(grant => grant.id)).size !== records.length || records.some(grant => this.grants.has(grant.id))) throw new EngineError('INVALID_TOOL_GRANT_DOCUMENT', 'Stored tool grant identity or scope is invalid');
      for (const grant of records) { this.grants.set(grant.id, structuredClone(grant)); this.current = Math.max(this.current, grant.revision); }
    }
    this.documents.set(sessionId, document?.revision ?? 0);
  }
  private commit(sessionId: string, updated: Map<string, ScopedToolGrant>, revision: number): void {
    if (this.persistence) {
      const grants = [...updated.values()].filter(grant => grant.sessionId === sessionId); const data = { schemaVersion: 1, grants } as unknown as JsonObject;
      if (Buffer.byteLength(JSON.stringify(data)) > 200 * 1024) throw new EngineError('TOOL_GRANT_STORAGE_LIMIT', 'Scoped grants exceed durable document budget');
      try { const stored = this.persistence.putSessionDocument(sessionId, DOCUMENT_KIND, this.documents.get(sessionId) ?? 0, data); this.documents.set(sessionId, stored.revision); }
      catch (error) {
        // CAS failure invalidates cached grants so a stale read cannot authorize another effect.
        this.documents.delete(sessionId); for (const [id, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(id);
        throw error;
      }
    }
    this.grants = updated; this.current = revision;
  }
  issue(input: GrantScope & { policyVersion: number; ttlMs: number; maxUses?: number }): ScopedToolGrant {
    if ([input.workspaceId, input.sessionId, input.toolName].some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > 512) || !TOOL_EFFECTS.has(input.effect) || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 24 * 60 * 60 * 1000 || !Number.isSafeInteger(input.maxUses ?? 1) || (input.maxUses ?? 1) < 1 || (input.maxUses ?? 1) > 1000) throw new EngineError('INVALID_TOOL_GRANT', 'Grant scope, version, expiry and uses must be bounded');
    if (input.resources !== undefined && (!Array.isArray(input.resources) || input.resources.length > 32 || input.resources.some(resource => typeof resource !== 'string' || !/^(?:path|command):/.test(resource) || Buffer.byteLength(resource) > 8192 || resource.includes('\0')))) throw new EngineError('INVALID_TOOL_GRANT', 'Grant resources must be bounded exact path/command identities');
    this.load(input.sessionId); const updated = structuredClone(this.grants);
    for (const [id, grant] of updated) if (grant.sessionId === input.sessionId && (grant.revoked || grant.remainingUses === 0 || grant.expiresAt <= this.now())) updated.delete(id);
    if (updated.size >= 1024) throw new EngineError('TOOL_GRANT_LIMIT', 'Live scoped grant limit exceeded');
    const grant: ScopedToolGrant = { workspaceId: input.workspaceId, sessionId: input.sessionId, toolName: input.toolName, effect: input.effect, ...(input.resources ? { resources: resources(input) } : {}), id: randomUUID(), policyVersion: input.policyVersion, expiresAt: this.now() + input.ttlMs, remainingUses: input.maxUses ?? 1, revision: this.current + 1, revoked: false };
    if (!valid(grant, input.sessionId)) throw new EngineError('INVALID_TOOL_GRANT', 'Grant clock or normalized scope is invalid');
    updated.set(grant.id, grant); this.commit(input.sessionId, updated, grant.revision); return structuredClone(grant);
  }
  find(scope: GrantScope, policyVersion: number): ScopedToolGrant | undefined { this.load(scope.sessionId); for (const grant of this.grants.values()) if (this.matches(grant, scope, policyVersion)) return structuredClone(grant); return undefined; }
  consume(id: string, scope: GrantScope, policyVersion: number, expectedRevision: number): ScopedToolGrant {
    this.load(scope.sessionId); const grant = this.grants.get(id); if (!grant || grant.revision !== expectedRevision || !this.matches(grant, scope, policyVersion)) throw new EngineError('TOOL_GRANT_STALE', 'Grant expired, was revoked, consumed or belongs to another scope/version');
    const updated = structuredClone(this.grants); const changed = updated.get(id)!; changed.remainingUses--; changed.revision = this.current + 1; this.commit(scope.sessionId, updated, changed.revision); return structuredClone(changed);
  }
  revoke(id: string, sessionId?: string): void {
    if (sessionId) this.load(sessionId); const grant = this.grants.get(id); if (!grant || sessionId && grant.sessionId !== sessionId) throw new EngineError('TOOL_GRANT_NOT_FOUND', 'Grant was not found'); if (grant.revoked) return;
    const updated = structuredClone(this.grants); const changed = updated.get(id)!; changed.revoked = true; changed.revision = this.current + 1; this.commit(grant.sessionId, updated, changed.revision);
  }
  clearSession(sessionId: string): void { this.load(sessionId); const updated = structuredClone(this.grants); let revision = this.current; for (const grant of updated.values()) if (grant.sessionId === sessionId && !grant.revoked) { grant.revoked = true; grant.revision = ++revision; } if (revision !== this.current) this.commit(sessionId, updated, revision); }
  private matches(grant: ScopedToolGrant, scope: GrantScope, policyVersion: number): boolean { return !grant.revoked && grant.remainingUses > 0 && grant.expiresAt > this.now() && grant.policyVersion === policyVersion && grant.workspaceId === scope.workspaceId && grant.sessionId === scope.sessionId && grant.toolName === scope.toolName && grant.effect === scope.effect && JSON.stringify(grant.resources ?? []) === JSON.stringify(resources(scope)); }
}
