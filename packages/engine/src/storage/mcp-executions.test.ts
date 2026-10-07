import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord, type MessagePart, type ProviderAttempt, type ToolCallRecord, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { MCP_EXECUTION_LIMITS, canonicalMcpExecutionSha256, hasMcpExecutionUncertainty, type McpExecutionIdentity, type McpExecutionSettlement } from './mcp-executions.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const config = {providerId:'scripted',modelId:'local',mode:'build' as const,limits:{...DEFAULT_LIMITS}};
function fixture(t: TestContext) {
  const store = new SqliteStore(':memory:'), db = (store as unknown as {db:DatabaseSync}).db, stamp = new Date().toISOString();
  store.putWorkspace({id:'workspace',root:'/tmp/moodcode-mcp-evidence-unit',gitRoot:'/tmp/moodcode-mcp-evidence-unit',branch:null,createdAt:stamp});
  store.createSession({id:'session',workspaceId:'workspace',title:'MCP local receipt',createdAt:stamp});
  const accepted = store.acceptInput({sessionId:'session',requestId:'goal',prompt:'Goal',config,delivery:'queue'}), run = store.promoteInput(accepted.inputId).run;
  store.commit(run.id,'run.started',{}, {run:{state:'running'}});
  store.putContextRevision({schemaVersion:2,id:'context',sessionId:'session',runId:run.id,revision:1,kind:'baseline',sourceIds:[],text:'Pinned model input',sha256:hash('Pinned model input'),createdAt:stamp});
  const turn:TurnRecord = {schemaVersion:2,id:'turn',sessionId:'session',runId:run.id,inputIds:[accepted.inputId],index:0,state:'created',createdAt:stamp,contextRevisionId:'context'};
  const attempt:ProviderAttempt = {schemaVersion:2,id:'attempt',sessionId:'session',runId:run.id,turnId:turn.id,index:0,providerId:'scripted',modelId:'local',contextRevisionId:'context',state:'prepared',createdAt:stamp};
  store.putTurn(turn); store.putTurn({...turn,state:'streaming'}); store.putAttempt(attempt);
  store.createAttemptCleanup({attemptId:attempt.id,sessionId:'session',workspaceId:'workspace',runId:run.id,turnId:turn.id,providerId:'scripted',modelId:'local',contextRevisionId:'context',requestProjection:'engine-turn-request-v1',requestSha256:hash('model-request'),requestBytes:100});
  store.dispatchAttemptCleanup(attempt.id);store.putAttempt({...attempt,state:'dispatched',dispatchedAt:stamp});
  store.putAttemptUsage(attempt.id,{inputTokens:17,outputTokens:3});
  store.settleAttemptCleanup(attempt.id,{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'});
  store.putAttempt({...attempt,state:'completed',dispatchedAt:stamp,completedAt:stamp});store.putTurn({...turn,state:'awaiting_tools'});
  const tool:ToolCallRecord = {id:'internal-tool',sessionId:'session',runId:run.id,name:'mcp_local_effect',input:{value:'local fixture'},state:'requested'};
  store.commit(run.id,'tool.requested',{toolCallId:tool.id}, {tool});
  const part:MessagePart = {schemaVersion:2,id:'proposal-part',sessionId:'session',runId:run.id,turnId:turn.id,messageId:'model-message',index:0,revision:0,state:'open',createdAt:stamp,type:'tool',toolCallId:tool.id,providerCallId:'provider-call',name:tool.name,input:tool.input};
  store.putPart(part);
  const approval:ApprovalRecord = {id:'approval',sessionId:'session',runId:run.id,toolCallId:tool.id,toolName:tool.name,fingerprint:hash('actual-outer-prepared-request'),preview:{serverId:'local',remoteTool:'effect',arguments:tool.input,catalogueRevision:2,toolEffect:'unknown',registryRevision:4,policyVersion:1},status:'pending',createdAt:stamp};
  store.commit(run.id,'approval.requested',{}, {approval});store.commit(run.id,'approval.resolved',{}, {approval:{...approval,status:'allowed',resolvedAt:stamp}});
  store.commit(run.id,'tool.running',{toolCallId:tool.id},{tool:{...tool,state:'running'}});
  const identity:McpExecutionIdentity = {toolCallId:tool.id,sessionId:'session',workspaceId:'workspace',runId:run.id,turnId:turn.id,attemptId:attempt.id,providerId:'scripted',modelId:'local',contextRevisionId:'context',toolName:tool.name,approvalId:approval.id,approvalFingerprint:approval.fingerprint,serverId:'local',connectionId:'fixture-connection-epoch',catalogueRevision:2,remoteTool:'effect',protocolVersion:'2026-07-28',transportKind:'http',logicalRpcId:4,requestProjection:'mcp-jsonrpc-tools-call-v1',requestSha256:hash('exact-jsonrpc-envelope-with-meta'),requestBytes:200};
  const terminal:McpExecutionSettlement = {outcome:'response-terminal',reason:'response',transportCleanupConfirmed:true,responseKind:'tool-result',responseSha256:hash('correlated-response'),responseBytes:120,isError:false};
  t.after(() => store.close());
  return {store,db,run,turn,attempt,part,tool,approval,identity,terminal,
    dispatch:() => {store.createMcpExecution(identity);return store.dispatchMcpExecution(tool.id,'http-fetch');},
    preserved:() => ({attempt:store.getAttempt(attempt.id),cleanup:store.getAttemptCleanup(attempt.id),usage:db.prepare('SELECT data FROM attempt_usage WHERE attempt_id=?').get(attempt.id),context:store.getContextRevision('context')})};
}

test('exact approved native identity creates one receipt and retains provider cleanup and usage',t => {
  const f=fixture(t),before=f.preserved();assert.throws(()=>f.store.getMcpExecution(f.tool.id),code('MCP_EXECUTION_NOT_FOUND'));
  const receipt=f.store.createMcpExecution(f.identity),events=f.store.readSessionEvents('session',0);
  assert.equal(receipt.state,'prepared');assert.equal(receipt.executionBlocked,false);assert.equal(receipt.transportCleanupConfirmed,null);
  assert.equal(receipt.proposalPartId,f.part.id);assert.equal(receipt.approvalFingerprint,f.approval.fingerprint);
  assert.deepEqual(f.store.createMcpExecution({...f.identity}),receipt);assert.deepEqual(f.store.readSessionEvents('session',0),events);assert.deepEqual(f.preserved(),before);
  for(const field of ['runId','attemptId','approvalId','approvalFingerprint','serverId','remoteTool','connectionId','requestSha256','logicalRpcId','catalogueRevision'] as const) {
    const changed={...f.identity,[field]:typeof f.identity[field]==='number'?Number(f.identity[field])+1:field.includes('Sha')||field.includes('Fingerprint')?hash('changed'):'changed'};
    assert.throws(()=>f.store.createMcpExecution(changed as McpExecutionIdentity));
  }
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM mcp_executions').get()!.count,1);
});

test('dispatch intent is indexed, idempotent, and cannot change its physical/API-entry boundary',t=>{
  const f=fixture(t),intent=f.dispatch(),events=f.store.readSessionEvents('session',0);
  assert.equal(intent.state,'dispatch-intent');assert.equal(intent.effectsUncertain,true);assert.equal(intent.remoteResponseObserved,false);assert.equal(intent.dispatchBoundary,'http-fetch');
  assert.equal(f.store.hasUncertainMcpExecutions('workspace'),true);assert.equal(f.store.hasUncertainExecution('workspace'),true);
  assert.deepEqual(f.store.dispatchMcpExecution(f.tool.id,'http-fetch'),intent);assert.deepEqual(f.store.readSessionEvents('session',0),events);
  assert.throws(()=>f.store.dispatchMcpExecution(f.tool.id,'legacy-api-entry'),code('MCP_EXECUTION_CONFLICT'));
  const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM mcp_executions WHERE workspace_id=? AND (state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0) LIMIT 1").all('workspace');
  assert.ok(plan.some(row=>String(row.detail).includes('mcp_executions_workspace_blocked')));
});

test('workspace metadata drift blocks both receipt and actual Run owners in one indexed body-free query',t=>{
  const f=fixture(t);f.dispatch();const stamp=new Date().toISOString();
  f.store.putWorkspace({id:'other-workspace',root:'/tmp/moodcode-mcp-other-unit',gitRoot:'/tmp/moodcode-mcp-other-unit',branch:null,createdAt:stamp});
  f.db.prepare("UPDATE mcp_executions SET workspace_id='other-workspace'").run();
  const prepare=f.db.prepare.bind(f.db);let queries=0,bodyReads=0,sql='';
  f.db.prepare=((query:string)=>{queries++;if(/SELECT .*data FROM/u.test(query))bodyReads++;if(query.includes('UNION ALL SELECT 1 FROM runs'))sql=query;return prepare(query);}) as typeof f.db.prepare;
  try {
    assert.equal(hasMcpExecutionUncertainty(f.db,'workspace'),true);assert.equal(queries,1);assert.equal(bodyReads,0);
    const plan=prepare('EXPLAIN QUERY PLAN '+sql).all('workspace','workspace');
    assert.ok(plan.some(row=>String(row.detail).includes('mcp_executions_workspace_blocked')));assert.ok(plan.some(row=>String(row.detail).includes('mcp_executions_run')));
    queries=0;assert.equal(hasMcpExecutionUncertainty(f.db,'other-workspace'),true);assert.equal(queries,1);assert.equal(bodyReads,0);
  }finally{f.db.prepare=prepare;}
  assert.throws(()=>f.store.getMcpExecution(f.tool.id),code('MCP_EXECUTION_BINDING_MISMATCH'));
  assert.throws(()=>f.store.recoverInterrupted(),code('MCP_EXECUTION_BINDING_MISMATCH'),'Startup refuses owner drift instead of reconstructing authority');
});

test('correlated terminal tool failures and JSON-RPC errors are observations, never rollback proof',t=>{
  for(const kind of ['success','isError','rpc-error'] as const){
    const f=fixture(t),before=f.preserved();f.dispatch();
    const selected:McpExecutionSettlement={...f.terminal,...(kind==='isError'?{isError:true}:kind==='rpc-error'?{responseKind:'jsonrpc-error',isError:undefined,errorCode:'MCP_REMOTE_ERROR'}:{})};
    const receipt=f.store.settleMcpExecution(f.tool.id,selected),events=f.store.readSessionEvents('session',0);
    assert.equal(receipt.state,'response-terminal');assert.equal(receipt.remoteResponseObserved,true);assert.equal(receipt.effectsUncertain,false);assert.equal(receipt.executionBlocked,false);assert.equal(receipt.isError,kind!=='success');
    assert.deepEqual(f.store.settleMcpExecution(f.tool.id,selected),receipt);assert.deepEqual(f.store.readSessionEvents('session',0),events);assert.deepEqual(f.preserved(),before);
    assert.throws(()=>f.store.settleMcpExecution(f.tool.id,{outcome:'uncertain',reason:'timeout',transportCleanupConfirmed:true}),code('MCP_EXECUTION_IMMUTABLE'));
  }
});

test('post-intent timeout/disconnect/cancel stays uncertain even when local cleanup succeeded',t=>{
  for(const reason of ['timeout','disconnect','cancel'] as const){
    const f=fixture(t);f.dispatch();const before=f.preserved();
    const receipt=f.store.settleMcpExecution(f.tool.id,{outcome:'uncertain',reason,transportCleanupConfirmed:true,errorCode:'MCP_REQUEST_OUTCOME_UNKNOWN'});
    assert.equal(receipt.effectsUncertain,true);assert.equal(receipt.executionBlocked,true);assert.equal(receipt.transportCleanupConfirmed,true);assert.equal(receipt.remoteResponseObserved,false);
    assert.equal(f.store.getSessionControl('session').reason,'recovery_required');assert.equal(f.store.hasUncertainWorkspace('workspace'),true);assert.deepEqual(f.preserved(),before);
    assert.throws(()=>f.store.settleMcpExecution(f.tool.id,f.terminal),code('MCP_EXECUTION_IMMUTABLE'));
  }
});

test('a terminal response followed by local cleanup failure preserves distinct remote observation',t=>{
  const f=fixture(t);f.dispatch();const receipt=f.store.settleMcpExecution(f.tool.id,{...f.terminal,outcome:'uncertain',reason:'cleanup-error',transportCleanupConfirmed:false});
  assert.equal(receipt.remoteResponseObserved,true);assert.equal(receipt.effectsUncertain,false);assert.equal(receipt.executionBlocked,true);assert.equal(receipt.responseSha256,f.terminal.responseSha256);
  assert.equal(f.store.hasUncertainWorkspace('workspace'),true);
});

test('not-dispatched requires prepared frontier and can retain unconfirmed request-local cleanup',t=>{
  for(const cleanup of [true,false]){
    const f=fixture(t);f.store.createMcpExecution(f.identity);
    const receipt=f.store.settleMcpExecution(f.tool.id,{outcome:'not-dispatched',reason:'cancel',transportCleanupConfirmed:cleanup});
    assert.equal(receipt.dispatchedAt,undefined);assert.equal(receipt.effectsUncertain,false);assert.equal(receipt.remoteResponseObserved,false);assert.equal(receipt.executionBlocked,!cleanup);
    assert.equal(f.store.hasUncertainWorkspace('workspace'),!cleanup);
  }
  const dispatched=fixture(t);dispatched.dispatch();assert.throws(()=>dispatched.store.settleMcpExecution(dispatched.tool.id,{outcome:'not-dispatched',reason:'cancel',transportCleanupConfirmed:true}),code('MCP_EXECUTION_TRANSITION_INVALID'));
});

test('raw bodies, headers, accessors, proxies and unsupported proof fields are rejected without invocation',t=>{
  const f=fixture(t);let traps=0;const accessor={...f.identity};Object.defineProperty(accessor,'serverId',{enumerable:true,get(){traps++;return 'local';}});
  const coercion={toString(){traps++;return 'local';}};
  for(const candidate of [accessor,new Proxy(f.identity,{ownKeys(){traps++;throw new Error('trap');}}),{...f.identity,serverId:coercion},{...f.identity,headers:{authorization:'fixture-secret'}},{...f.identity,requestBody:'fixture raw bytes'},{...f.identity,createdAt:new Date().toISOString()},{...f.identity,[Symbol('unknown')]:true}]) assert.throws(()=>f.store.createMcpExecution(candidate as McpExecutionIdentity),code('MCP_EXECUTION_INVALID'));
  assert.equal(traps,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions').get()!.n,0);
  f.dispatch();for(const candidate of [{...f.terminal,transportCleanupConfirmed:false},{...f.terminal,responseSha256:undefined},{...f.terminal,remoteAbortConfirmed:true},{outcome:'not-dispatched',reason:'response',transportCleanupConfirmed:true}]) assert.throws(()=>f.store.settleMcpExecution(f.tool.id,candidate as McpExecutionSettlement),code('MCP_EXECUTION_INVALID'));
});

test('create and dispatch require actual allowed outer approval, native proposal and live owner',t=>{
  for(const target of ['denied','inner-fingerprint','preview-server','preview-input','part-input','part-turn','tool-name','attempt-provider','attempt-not-completed','turn-not-awaiting','run-terminal'] as const){
    const f=fixture(t);
    if(target==='denied')f.db.exec("UPDATE approvals SET status='denied',data=json_set(data,'$.status','denied')");
    if(target==='inner-fingerprint')f.db.prepare("UPDATE approvals SET data=json_set(data,'$.fingerprint',?)").run(hash('inner'));
    if(target==='preview-server')f.db.exec("UPDATE approvals SET data=json_set(data,'$.preview.serverId','other')");
    if(target==='preview-input')f.db.exec("UPDATE approvals SET data=json_set(data,'$.preview.arguments.value','other')");
    if(target==='part-input')f.db.exec("UPDATE message_parts SET data=json_set(data,'$.input.value','other')");
    if(target==='part-turn')f.db.exec("UPDATE message_parts SET data=json_set(data,'$.turnId','other')");
    if(target==='tool-name')f.db.exec("UPDATE tools SET data=json_set(data,'$.name','other')");
    if(target==='attempt-provider')f.db.exec("UPDATE provider_attempts SET data=json_set(data,'$.providerId','other')");
    if(target==='attempt-not-completed')f.db.exec("UPDATE provider_attempts SET state='streaming',data=json_remove(json_set(data,'$.state','streaming'),'$.completedAt')");
    if(target==='turn-not-awaiting')f.db.exec("UPDATE session_turns SET state='streaming',data=json_set(data,'$.state','streaming')");
    if(target==='run-terminal')f.store.commit(f.run.id,'run.failed',{}, {run:{state:'failed'}});
    assert.throws(()=>f.store.createMcpExecution(f.identity));assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_executions').get()!.n,0);
  }
});

test('receipt lookup rejects foreign owner and oversized body before payload selection',t=>{
  const f=fixture(t);f.dispatch();const prepare=f.db.prepare.bind(f.db);let payloadReads=0;
  f.db.prepare=((sql:string)=>{if(/^SELECT data FROM mcp_executions/u.test(sql))payloadReads++;return prepare(sql);}) as typeof f.db.prepare;
  try{
    assert.throws(()=>f.store.getMcpExecution(f.tool.id,'foreign'),code('MCP_EXECUTION_BINDING_MISMATCH'));assert.equal(payloadReads,0);
    f.db.exec('PRAGMA ignore_check_constraints=ON');prepare('UPDATE mcp_executions SET data=?').run('x'.repeat(MCP_EXECUTION_LIMITS.maxRecordBytes+1));f.db.exec('PRAGMA ignore_check_constraints=OFF');
    assert.throws(()=>f.store.getMcpExecution(f.tool.id),code('MCP_EXECUTION_LIMIT'));assert.equal(payloadReads,0);
  }finally{f.db.prepare=prepare;}
});

test('oversized or unsafe SQL receipt metadata is rejected before its body reaches JavaScript',t=>{
  for(const target of ['connection','catalogue','revision','logical-id'] as const){
    const f=fixture(t);f.dispatch();const prepare=f.db.prepare.bind(f.db);let bodyReads=0,maxHeaderString=0;
    if(target==='connection')prepare('UPDATE mcp_executions SET connection_id=?').run('x'.repeat(1048576));
    if(target==='logical-id')prepare('UPDATE mcp_executions SET logical_rpc_id=?').run('x'.repeat(1048576));
    if(['catalogue','revision'].includes(target)){f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.exec(`UPDATE mcp_executions SET ${target==='catalogue'?'catalogue_revision':'revision'}=9007199254740992`);f.db.exec('PRAGMA ignore_check_constraints=OFF');}
    f.db.prepare=((sql:string)=>{const stmt=prepare(sql),get=stmt.get.bind(stmt);if(/^SELECT data FROM mcp_executions/u.test(sql))bodyReads++;stmt.get=((...values:Parameters<typeof stmt.get>)=>{const row=get(...values);if(sql.includes('safe_revision')&&row)for(const value of Object.values(row))if(typeof value==='string')maxHeaderString=Math.max(maxHeaderString,Buffer.byteLength(value));return row;}) as typeof stmt.get;return stmt;}) as typeof f.db.prepare;
    try{assert.throws(()=>f.store.getMcpExecution(f.tool.id));assert.equal(bodyReads,0);assert.ok(maxHeaderString<=512);}finally{f.db.prepare=prepare;}
  }
});

test('bounded logical string RPC identities retain escaped byte representation without coercion',t=>{
  const f=fixture(t),identity={...f.identity,logicalRpcId:'\\'.repeat(128)};
  assert.equal(f.store.createMcpExecution(identity).logicalRpcId,identity.logicalRpcId);assert.equal(f.store.getMcpExecution(f.tool.id).logicalRpcId,identity.logicalRpcId);
});

test('terminal receipts revalidate immutable approval/proposal and SQL owner metadata',t=>{
  for(const target of ['receipt-sha','receipt-flags','approval-preview','proposal-provider-call','run-owner','context-owner'] as const){
    const f=fixture(t);f.dispatch();f.store.settleMcpExecution(f.tool.id,f.terminal);
    if(target==='receipt-sha')f.db.prepare("UPDATE mcp_executions SET data=json_set(data,'$.requestSha256',?)").run(hash('changed'));
    if(target==='receipt-flags')f.db.exec("UPDATE mcp_executions SET data=json_set(data,'$.executionBlocked',json('true'))");
    if(target==='approval-preview')f.db.exec("UPDATE approvals SET data=json_set(data,'$.preview.registryRevision',999)");
    if(target==='proposal-provider-call')f.db.exec("UPDATE message_parts SET data=json_set(data,'$.providerCallId','other')");
    if(target==='run-owner')f.db.exec("UPDATE runs SET data=json_set(data,'$.workspaceId','other')");
    if(target==='context-owner')f.db.exec("UPDATE context_revisions SET data=json_set(data,'$.sessionId','other')");
    assert.throws(()=>f.store.getMcpExecution(f.tool.id));
  }
});

test('post-response result projection can grow without rereading or hashing mutable result bytes',t=>{
  const f=fixture(t);f.dispatch();const receipt=f.store.settleMcpExecution(f.tool.id,f.terminal);
  f.store.putPart({...f.part,revision:1,state:'completed',completedAt:new Date().toISOString(),result:{content:'x'.repeat(2*1048576)}});
  const before=f.db.prepare.bind(f.db);let rawPartReads=0,projectionBytes=0;
  f.db.prepare=((sql:string)=>{const stmt=before(sql),get=stmt.get.bind(stmt);if(/^SELECT data FROM message_parts/u.test(sql))rawPartReads++;if(/^SELECT json_remove\(data,'\$\.result'\)/u.test(sql)){stmt.get=((...values:Parameters<typeof stmt.get>)=>{const row=get(...values);if(typeof row?.data==='string')projectionBytes+=Buffer.byteLength(row.data);return row;}) as typeof stmt.get;}return stmt;}) as typeof f.db.prepare;
  try{assert.deepEqual(f.store.getMcpExecution(f.tool.id),receipt);assert.equal(rawPartReads,0);assert.ok(projectionBytes<1024);}finally{f.db.prepare=before;}
});

test('both journal failures roll back preparation/intent/terminal state, controls and sequences',t=>{
  for(const table of ['events','session_events'] as const)for(const phase of ['prepared','dispatch_intent','uncertain','response_terminal'] as const){
    const f=fixture(t);if(phase!=='prepared')f.store.createMcpExecution(f.identity);if(['uncertain','response_terminal'].includes(phase))f.store.dispatchMcpExecution(f.tool.id,'http-fetch');
    const before=f.db.prepare('SELECT data FROM mcp_executions').all(),events=f.store.readEvents('session',0),native=f.store.readSessionEvents('session',0),control=f.store.getSessionControl('session');
    f.db.exec(`CREATE TRIGGER reject_mcp BEFORE INSERT ON ${table} WHEN NEW.type='mcp.execution.${phase}' BEGIN SELECT RAISE(ABORT,'mcp atomic fixture'); END`);
    assert.throws(()=>phase==='prepared'?f.store.createMcpExecution(f.identity):phase==='dispatch_intent'?f.store.dispatchMcpExecution(f.tool.id,'http-fetch'):f.store.settleMcpExecution(f.tool.id,phase==='response_terminal'?f.terminal:{outcome:'uncertain',reason:'timeout',transportCleanupConfirmed:true}),/mcp atomic fixture/u);
    assert.deepEqual(f.db.prepare('SELECT data FROM mcp_executions').all(),before);assert.deepEqual(f.store.readEvents('session',0),events);assert.deepEqual(f.store.readSessionEvents('session',0),native);assert.deepEqual(f.store.getSessionControl('session'),control);
  }
});

test('late owner-bound settlement preserves terminal Run and existing ordinary observations',t=>{
  const f=fixture(t);f.dispatch();f.store.commit(f.run.id,'run.failed',{}, {run:{state:'failed'}});const run=f.store.getRun(f.run.id),before=f.preserved();
  const receipt=f.store.settleMcpExecution(f.tool.id,{outcome:'uncertain',reason:'cancel',transportCleanupConfirmed:true});
  assert.equal(receipt.state,'uncertain');assert.deepEqual(f.store.getRun(f.run.id),run);assert.deepEqual(f.preserved(),before);
  assert.deepEqual(f.store.createMcpExecution(f.identity),receipt,'Exact historical identity returns its receipt before checking live execution');
});

test('startup recovers only existing receipts and keeps unknown effect distinct from provider completion',t=>{
  for(const phase of ['legacy','prepared','dispatch-intent','uncertain','response-terminal'] as const){
    const f=fixture(t);if(phase!=='legacy')f.store.createMcpExecution(f.identity);if(['dispatch-intent','uncertain','response-terminal'].includes(phase))f.store.dispatchMcpExecution(f.tool.id,'http-fetch');
    if(phase==='uncertain')f.store.settleMcpExecution(f.tool.id,{outcome:'uncertain',reason:'timeout',transportCleanupConfirmed:true});
    if(phase==='response-terminal')f.store.settleMcpExecution(f.tool.id,f.terminal);
    const before=f.preserved();f.store.recoverInterrupted();assert.deepEqual(f.preserved(),before);assert.equal(f.store.getRun(f.run.id).state,'interrupted');
    if(phase==='legacy')assert.throws(()=>f.store.getMcpExecution(f.tool.id),code('MCP_EXECUTION_NOT_FOUND'));
    else assert.equal(f.store.getMcpExecution(f.tool.id).state,phase==='prepared'?'not-dispatched':phase==='dispatch-intent'?'uncertain':phase);
    const blocked=['dispatch-intent','uncertain'].includes(phase);assert.equal(f.store.hasUncertainWorkspace('workspace'),blocked);assert.equal(f.store.getTurn('turn').state,blocked?'uncertain':'interrupted');
    assert.equal(f.store.getTurn('turn').uncertainty?.kind,blocked?'tool_effect':undefined);
    if(blocked)assert.equal(f.store.getSessionControl('session').reason,'recovery_required');
    const events=f.store.readSessionEvents('session',0);f.store.recoverInterrupted();assert.deepEqual(f.store.readSessionEvents('session',0),events);
  }
});

test('orphan terminal Run receipt re-pauses session without rewriting prior terminal Turn outcome',t=>{
  const f=fixture(t);f.dispatch();f.store.settleMcpExecution(f.tool.id,{outcome:'uncertain',reason:'disconnect',transportCleanupConfirmed:true});
  f.store.putPart({...f.part,state:'interrupted',revision:1,completedAt:new Date().toISOString()});
  f.store.putTurn({...f.turn,state:'uncertain',completedAt:new Date().toISOString(),uncertainty:{kind:'tool_effect',message:'Original tool outcome remains unknown',requiresRecovery:true}});
  f.store.commit(f.run.id,'run.failed',{}, {run:{state:'failed'}});f.store.setSessionPaused('session',false);
  const run=f.store.getRun(f.run.id),turn=f.store.getTurn('turn'),before=f.preserved(),receipt=f.store.getMcpExecution(f.tool.id);
  f.store.recoverInterrupted();assert.deepEqual(f.store.getRun(f.run.id),run);assert.deepEqual(f.store.getTurn('turn'),turn);assert.deepEqual(f.preserved(),before);assert.deepEqual(f.store.getMcpExecution(f.tool.id),receipt);
  assert.equal(f.store.getSessionControl('session').reason,'recovery_required');assert.equal(f.store.hasUncertainExecution('workspace'),true);
});

test('startup settlement and original v1 interruption roll back together on journal failure',t=>{
  const f=fixture(t);f.dispatch();const before=f.db.prepare('SELECT data FROM mcp_executions').all(),run=f.store.getRun(f.run.id),turn=f.store.getTurn('turn'),events=f.store.readEvents('session',0);
  f.db.exec("CREATE TRIGGER fail_mcp_recovery BEFORE INSERT ON events WHEN NEW.type='mcp.execution.uncertain' BEGIN SELECT RAISE(ABORT,'mcp recovery fixture'); END");
  assert.throws(()=>f.store.recoverInterrupted(),/mcp recovery fixture/u);assert.deepEqual(f.db.prepare('SELECT data FROM mcp_executions').all(),before);assert.deepEqual(f.store.getRun(f.run.id),run);assert.deepEqual(f.store.getTurn('turn'),turn);assert.deepEqual(f.store.readEvents('session',0),events);
  f.db.exec('DROP TRIGGER fail_mcp_recovery');f.store.recoverInterrupted();assert.equal(f.store.getMcpExecution(f.tool.id).state,'uncertain');
});

test('canonical receipt digest is order-independent and terminal source pins remain immutable',t=>{
  const f=fixture(t);f.dispatch();const receipt=f.store.settleMcpExecution(f.tool.id,f.terminal);
  assert.equal(canonicalMcpExecutionSha256(receipt),canonicalMcpExecutionSha256(Object.fromEntries(Object.entries(receipt).reverse()) as typeof receipt));
  assert.notEqual(canonicalMcpExecutionSha256(receipt),canonicalMcpExecutionSha256({...receipt,requestSha256:hash('other')}));
  assert.throws(()=>canonicalMcpExecutionSha256(new Proxy(receipt,{})),code('MCP_EXECUTION_INVALID'));
});
