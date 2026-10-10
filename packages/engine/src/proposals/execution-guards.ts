import type { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { EngineError } from '@moodcode/contracts';
import type { KnowledgeHostBinding } from '../knowledge/types.js';
import { knowledgeHash, immutableKnowledgeJson, validateBinding, identifier } from '../knowledge/validation.js';
import { inspectExecutionLock, reconcileStoppedExecutionLock, type ExecutionLockMarker } from '../tools/command/execution-lock.js';
import type { ProposalApplyGuard, ProposalApplyOwner } from './apply-types.js';

export const PROPOSAL_APPLY_GUARD_TABLE = 'proposal_apply_execution_guards';
export const PROPOSAL_APPLY_GUARD_SCHEMA_SQL = `CREATE TABLE proposal_apply_execution_guards (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL REFERENCES proposal_apply_owners(id),
 lock_path TEXT NOT NULL, marker_owner_pid INTEGER NOT NULL CHECK(marker_owner_pid>0), marker_updated_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=4096), UNIQUE(lock_path,marker_owner_pid,marker_updated_at)
) STRICT, WITHOUT ROWID;`;
function fail(): never { throw new EngineError('PROPOSAL_APPLY_GUARD_INVALID', 'Proposal apply requires its exact native owner and original physical execution guard'); }
function physical(path: string) {
  const stat = lstatSync(path,{bigint:true});
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || realpathSync(path) !== path) fail();
  return { path,device:stat.dev.toString(),inode:stat.ino.toString() };
}
function valid(input: unknown): ProposalApplyGuard {
  const value=immutableKnowledgeJson(input) as ProposalApplyGuard;
  if (!value || Object.keys(value).sort().join(',')!=='binding,id,lock,marker,ownerId,sha256,workspaceId'
    || value.id!==value.ownerId || value.binding.workspaceId!==value.workspaceId) fail();
  identifier(value.id); identifier(value.workspaceId); validateBinding(value.binding);
  if (!value.lock || Object.keys(value.lock).sort().join(',')!=='device,inode,path' || !value.lock.path.startsWith('/')
    || !/^\d+$/u.test(value.lock.device) || !/^\d+$/u.test(value.lock.inode)) fail();
  if (!value.marker || Object.keys(value.marker).sort().join(',')!=='active,groupPid,ownerPid,updatedAt' || value.marker.active!==true
    || value.marker.groupPid!==null || !Number.isSafeInteger(value.marker.ownerPid) || value.marker.ownerPid<=0
    || !Number.isFinite(Date.parse(value.marker.updatedAt))) fail();
  const {sha256,...body}=value;if(knowledgeHash(body)!==sha256)fail();return value;
}
export function validateProposalApplyExecutionGuards(db: DatabaseSync, check:()=>void=()=>{}):void {
  for (const header of db.prepare(`SELECT id,workspace_id,owner_id,lock_path,marker_owner_pid,marker_updated_at,length(CAST(data AS BLOB)) AS bytes FROM ${PROPOSAL_APPLY_GUARD_TABLE} ORDER BY id`).iterate()) {
    check(); if (Number(header.bytes)>4096) fail();
    const guard=valid(JSON.parse(String(db.prepare(`SELECT data FROM ${PROPOSAL_APPLY_GUARD_TABLE} WHERE id=?`).get(String(header.id))?.data)));
    if (guard.id!==header.id || guard.workspaceId!==header.workspace_id || guard.ownerId!==header.owner_id || guard.lock.path!==header.lock_path
      || guard.marker.ownerPid!==header.marker_owner_pid || guard.marker.updatedAt!==header.marker_updated_at) fail();
    const owner=db.prepare("SELECT workspace_id,json_extract(data,'$.binding') AS binding FROM proposal_apply_owners WHERE id=?").get(guard.ownerId);
    if(!owner || owner.workspace_id!==guard.workspaceId || knowledgeHash(JSON.parse(String(owner.binding)))!==knowledgeHash(guard.binding))fail();
  }
}
export class ProposalApplyExecutionGuards {
  readonly #originals=new WeakMap<object,ProposalApplyGuard>();
  constructor(private readonly db:DatabaseSync,private readonly ports:{writeTx<T>(operation:()=>T):T;checkBinding(workspaceId:string):KnowledgeHostBinding;getOwner(workspaceId:string,id:string):ProposalApplyOwner}){}
  reserve(bindingInput:KnowledgeHostBinding,ownerId:string,path:string,markerInput:Readonly<ExecutionLockMarker>):object {
    const binding=validateBinding(bindingInput),marker=immutableKnowledgeJson(markerInput);identifier(ownerId);
    const guard=this.ports.writeTx(()=>{
      const owner=this.ports.getOwner(binding.workspaceId,ownerId);
      if(owner.state!=='prepared' || knowledgeHash(owner.binding)!==knowledgeHash(binding) || knowledgeHash(this.ports.checkBinding(binding.workspaceId))!==knowledgeHash(binding))fail();
      const body={id:ownerId,workspaceId:binding.workspaceId,ownerId,binding,lock:physical(path),marker};
      const guard=valid({...body,sha256:knowledgeHash(body)});
      this.db.prepare(`INSERT INTO ${PROPOSAL_APPLY_GUARD_TABLE}(id,workspace_id,owner_id,lock_path,marker_owner_pid,marker_updated_at,data) VALUES(?,?,?,?,?,?,?)`).run(guard.id,guard.workspaceId,guard.ownerId,path,guard.marker.ownerPid,guard.marker.updatedAt,JSON.stringify(guard));return guard;
    });
    const original=Object.freeze({id:guard.id});this.#originals.set(original,guard);return original;
  }
  readOriginal(original:object):ProposalApplyGuard {const guard=this.#originals.get(original);if(!guard)fail();const stored=this.get(guard.workspaceId,guard.ownerId);if(!stored||stored.sha256!==guard.sha256)fail();return structuredClone(guard);}
  get(workspaceId:string,ownerId:string):ProposalApplyGuard|undefined {
    identifier(workspaceId);identifier(ownerId);
    const header=this.db.prepare(`SELECT length(CAST(data AS BLOB)) AS bytes FROM ${PROPOSAL_APPLY_GUARD_TABLE} WHERE workspace_id=? AND id=?`).get(workspaceId,ownerId);
    if(!header)return undefined;if(Number(header.bytes)>4096)fail();const guard=valid(JSON.parse(String(this.db.prepare(`SELECT data FROM ${PROPOSAL_APPLY_GUARD_TABLE} WHERE workspace_id=? AND id=?`).get(workspaceId,ownerId)?.data)));
    if(guard.workspaceId!==workspaceId||guard.ownerId!==ownerId)fail();return guard;
  }
  matching(path:string,workspaceId?:string):ProposalApplyGuard|undefined {
    const observed=inspectExecutionLock(path);if(observed.status!=='uncertain')return undefined;
    const headers=this.db.prepare(`SELECT workspace_id,owner_id FROM ${PROPOSAL_APPLY_GUARD_TABLE} WHERE lock_path=? AND marker_owner_pid=? AND marker_updated_at=? LIMIT 2`).all(path,observed.marker.ownerPid,observed.marker.updatedAt);
    if(headers.length>1)fail();for(const header of headers){if(workspaceId!==undefined&&header.workspace_id!==workspaceId)continue;const guard=this.get(String(header.workspace_id),String(header.owner_id));if(!guard)fail();
      if(knowledgeHash(guard.marker)!==knowledgeHash(observed.marker)||knowledgeHash(guard.lock)!==knowledgeHash(physical(path)))continue;
      const owner=this.ports.getOwner(guard.workspaceId,guard.ownerId);
      if(!['prepared','dispatched','uncertain','cancelled'].includes(owner.state)||knowledgeHash(owner.binding)!==knowledgeHash(guard.binding)||knowledgeHash(this.ports.checkBinding(guard.workspaceId))!==knowledgeHash(guard.binding))fail();return guard;
    }return undefined;
  }
  reconcile(workspaceId:string,path:string):void {const observed=inspectExecutionLock(path);if(observed.status==='available'||observed.status==='not_initialized')return;
    if(observed.status==='busy')throw new EngineError('COMMAND_EFFECTS_BUSY','A command supervisor still holds the execution lock.');const guard=this.matching(path,workspaceId);if(!guard)fail();reconcileStoppedExecutionLock(path,guard.marker);}
}
