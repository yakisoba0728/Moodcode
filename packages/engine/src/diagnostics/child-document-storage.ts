import { types } from 'node:util';
import { isAbsolute, relative, sep } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import type { ChildStorageSelectionReport } from '../child-tasks/storage-binding.js';
import { CHILD_DOCUMENT_READ_LIMITS, readChildDocumentIndex, type ChildDocumentReadFrame, type ChildDocumentReadLimits, type ChildDocumentReadStats } from '../storage/child-document-reader.js';
import type { InputDocumentIndexReport } from '../storage/input-document-index.js';

export interface ChildDocumentStorageLimits extends ChildDocumentReadLimits { maxReportBytes: number }
export const DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS: Readonly<ChildDocumentStorageLimits> = Object.freeze({ ...CHILD_DOCUMENT_READ_LIMITS,maxChildren:8,maxReportBytes:32_768 });
export interface ChildDocumentStorageRequest { sessionId:string;sourceRunId:string;taskIds:readonly string[];signal?:AbortSignal;limits?:Partial<ChildDocumentStorageLimits> }
interface ValidatedChildDocumentStorageRequest extends Omit<ChildDocumentStorageRequest,'limits'> { limits:Readonly<ChildDocumentStorageLimits> }
export interface ChildDocumentStorageItem {
  taskId:string;status:'observed'|'unchecked';authorityStatus:string;reasons:string[];
  childSessionId?:string;childRunId?:string;indexComplete?:boolean;indexedReferences?:number|null;observedReferences?:number;declaredBytes?:number|null;
  sampledJsonBytes?:number;candidateFiles:null;blobHashes:'not-read';storageLocation:'inside-root-artifacts'|'host-configured-external'|'not-verified';
}
export interface ChildDocumentStorageReport {
  schemaVersion:1;scope:'host-selected-child-document-indexes';sessionId:string;sourceRunId:string;observedAt:string;complete:boolean;
  limits:Readonly<ChildDocumentStorageLimits>;requestedChildren:number;observedChildren:number;uncheckedChildren:number;reportsOmitted:number;
  children:ChildDocumentStorageItem[];reasons:string[];stats:ChildDocumentReadStats;
  rootIndex:{status:'complete'|'incomplete'|'not-read';references:number|null;observedReferences:number|null;declaredBytes:number|null};
  declaredReferenceBytes:{root:number|null;children:number|null;sum:number|null;observedChildSubtotal:number;accounting:'declared-reference-bytes-per-physical-store';physicalFileBytes:null};
  coverage:{rootIndex:'primary-database-only';childIndexes:'explicit-selected-authority-only';filesystem:'not-scanned';blobContents:'not-read';blobIntegrity:'not-verified';orphanAssessment:'not-performed';parentChildBytes:'not-added';
    unselectedChildren:'not-discovered';externalStorage:'selected-configured-authority-only';childImages:'not-read';worktreeFiles:'not-read';cleanup:'not-performed';executionAuthority:'not-granted';
    snapshot:'separate-bounded-index-snapshots-with-physical-rechecks';deadline:'cooperative-at-filesystem-and-sql-boundaries';physicalReadBytes:null;physicalAllocatedBytes:null;rows:'charged-header-rows-and-index-body-records'};
}
function invalid():never {throw new EngineError('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS','Child document storage inspection requires exact bounded host options.');}
function plain(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  if(types.isProxy(value)||!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!allowed.includes(key)||!descriptors[key]?.enumerable||!Object.hasOwn(descriptors[key]!,'value')))invalid();
  return value as Record<string,unknown>;
}
function id(value:unknown):value is string{return typeof value==='string'&&Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=256&&!/[\u0000-\u001f\u007f]/u.test(value);}
export function validateChildDocumentStorageRequest(value:unknown):ValidatedChildDocumentStorageRequest{
  const options=plain(value,['sessionId','sourceRunId','taskIds','signal','limits']);
  if(!id(options.sessionId)||!id(options.sourceRunId)||types.isProxy(options.taskIds)||!Array.isArray(options.taskIds)||Object.getPrototypeOf(options.taskIds)!==Array.prototype||options.taskIds.length>32||Reflect.ownKeys(options.taskIds).length!==options.taskIds.length+1)invalid();
  const taskIds:string[]=[];
  for(let index=0;index<options.taskIds.length;index++){const descriptor=Object.getOwnPropertyDescriptor(options.taskIds,String(index));if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string'||!/^child_[a-f0-9]{32}$/u.test(descriptor.value)||taskIds.includes(descriptor.value))invalid();taskIds.push(descriptor.value);}
  if(types.isProxy(options.signal)||options.signal!==undefined&&!(options.signal instanceof AbortSignal))invalid();
  const limits=options.limits===undefined?{}:plain(options.limits,Object.keys(DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS));
  const selected={...DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS,...limits};
  for(const key of Object.keys(DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS) as (keyof ChildDocumentStorageLimits)[]){const max=key==='maxChildren'?32:DEFAULT_CHILD_DOCUMENT_STORAGE_LIMITS[key];if(!Number.isSafeInteger(selected[key])||selected[key]<1||selected[key]>max)invalid();}
  if(selected.maxReportBytes<4096||taskIds.length>selected.maxChildren)invalid();
  return {sessionId:options.sessionId,sourceRunId:options.sourceRunId,taskIds:Object.freeze(taskIds),...(options.signal?{signal:options.signal as AbortSignal}:{}),limits:Object.freeze(selected)};
}
/** Explicit host observation. It neither scans child trees nor changes execution/queue state. */
export async function inspectChildDocumentStorage(input:{selection:ChildStorageSelectionReport;rootIndex?:InputDocumentIndexReport;frame:ChildDocumentReadFrame;limits:Readonly<ChildDocumentStorageLimits>}):Promise<ChildDocumentStorageReport>{
  const {selection,rootIndex,frame,limits}=input, children:ChildDocumentStorageItem[]=[],reasons:string[]=[];
  let observed=0,unchecked=0,childBytes=0,childBytesKnown=true;
  if(!rootIndex)reasons.push('root-index-budget-limit');else if(!rootIndex.complete)reasons.push('root-index-incomplete');
  for(const selected of selection.selections){
    // Yield between children so close/cancel can settle and abort a long inspection.
    await new Promise<void>(resolve=>setImmediate(resolve));
    const base:ChildDocumentStorageItem={taskId:selected.taskId,status:'unchecked',authorityStatus:selected.status,reasons:[...selected.reasons],candidateFiles:null,blobHashes:'not-read',storageLocation:'not-verified'};
    let unavailable=false;
    try{frame.check();}catch(error){unavailable=true;base.reasons.push(error instanceof EngineError?error.code:'CHILD_DOCUMENT_STORAGE_INSPECTION_FAILED');}
    if(!unavailable&&selected.status==='eligible'&&selected.record){
      const observation=readChildDocumentIndex({mode:'source',record:selected.record},frame);
      base.status=observation.status;base.reasons.push(...observation.reasons);
      if(observation.index){
        const binding=selected.record.binding,index=observation.index;
        const location=relative(binding.hostIdentity.artifacts.path,binding.childrenDirectory),inside=!isAbsolute(location)&&location!=='..'&&!location.startsWith('..'+sep);
        Object.assign(base,{childSessionId:binding.child.sessionId,childRunId:binding.child.runId,indexComplete:index.complete,indexedReferences:index.complete?index.refs.length:null,observedReferences:index.refs.length,declaredBytes:index.complete?index.declaredBytes:null,sampledJsonBytes:index.sampledJsonBytes,
          storageLocation:inside?'inside-root-artifacts':'host-configured-external'});
        observed++;childBytes+=index.declaredBytes??0;
        if(!index.complete||index.declaredBytes===null)childBytesKnown=false;
        if(!index.complete)reasons.push('child-index-incomplete');
      }else{unchecked++;childBytesKnown=false;}
    }else{unchecked++;childBytesKnown=false;if(base.reasons.length===0)base.reasons.push('child-authority-unchecked');}
    children.push(base);
  }
  if(unchecked)reasons.push('selected-children-unchecked');
  const stats=frame.stats();if(stats.exhaustedReason)reasons.push(stats.exhaustedReason);
  const rootBytes=rootIndex?.complete?rootIndex.declaredBytes:null,childrenTotal=childBytesKnown?childBytes:null;
  const report:ChildDocumentStorageReport={schemaVersion:1,scope:'host-selected-child-document-indexes',sessionId:selection.sessionId,sourceRunId:selection.sourceRunId,observedAt:new Date().toISOString(),complete:selection.complete&&!!rootIndex?.complete&&!unchecked&&children.every(child=>child.indexComplete===true)&&!stats.exhaustedReason,
    limits,requestedChildren:selection.selections.length,observedChildren:observed,uncheckedChildren:unchecked,reportsOmitted:0,children,reasons:[...new Set(reasons)],stats,
    rootIndex:{status:rootIndex?rootIndex.complete?'complete':'incomplete':'not-read',references:rootIndex?.complete?rootIndex.refs.length:null,observedReferences:rootIndex?.refs.length??null,declaredBytes:rootBytes},
    declaredReferenceBytes:{root:rootBytes,children:childrenTotal,sum:rootBytes===null||childrenTotal===null?null:rootBytes+childrenTotal,observedChildSubtotal:childBytes,accounting:'declared-reference-bytes-per-physical-store',physicalFileBytes:null},
    coverage:{rootIndex:'primary-database-only',childIndexes:'explicit-selected-authority-only',filesystem:'not-scanned',blobContents:'not-read',blobIntegrity:'not-verified',orphanAssessment:'not-performed',parentChildBytes:'not-added',unselectedChildren:'not-discovered',externalStorage:'selected-configured-authority-only',childImages:'not-read',worktreeFiles:'not-read',cleanup:'not-performed',executionAuthority:'not-granted',snapshot:'separate-bounded-index-snapshots-with-physical-rechecks',deadline:'cooperative-at-filesystem-and-sql-boundaries',physicalReadBytes:null,physicalAllocatedBytes:null,rows:'charged-header-rows-and-index-body-records'}};
  while(Buffer.byteLength(JSON.stringify(report))>limits.maxReportBytes&&report.children.length){report.children.pop();report.reportsOmitted++;report.complete=false;if(!report.reasons.includes('report-byte-limit'))report.reasons.push('report-byte-limit');}
  if(Buffer.byteLength(JSON.stringify(report))>limits.maxReportBytes)throw new EngineError('CHILD_DOCUMENT_STORAGE_REPORT_LIMIT','Child document report exceeds its bounded output.');
  return report;
}
