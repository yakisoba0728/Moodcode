import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type MessagePart, type ProviderAttempt, type ToolCallRecord, type TurnRecord } from '@moodcode/contracts';
import { canonical } from '../recovery/snapshot.js';
import { SqliteStore } from './index.js';
import { TOOL_RECOVERY_FRONTIER_LIMITS } from './tool-recovery-frontier.js';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const code = (value:string) => (error:unknown) => error instanceof EngineError && error.code === value;
function fixture(t:TestContext, state:ToolCallRecord['state']='running') {
  const store=new SqliteStore(':memory:'),db=(store as unknown as {db:DatabaseSync}).db,now=new Date().toISOString();
  store.putWorkspace({id:'workspace',root:'/tmp/moodcode-tool-frontier-unit',gitRoot:'/tmp/moodcode-tool-frontier-unit',branch:null,createdAt:now});
  store.createSession({id:'session',workspaceId:'workspace',title:'Tool frontier',createdAt:now});
  const config={providerId:'fixture',modelId:'local',mode:'build' as const,limits:{...DEFAULT_LIMITS}},input=store.acceptInput({sessionId:'session',requestId:'goal',prompt:'Original goal',config,delivery:'queue'}),run=store.promoteInput(input.inputId).run;
  store.commit(run.id,'run.started',{}, {run:{state:'running'}});
  store.putContextRevision({schemaVersion:2,id:'context',sessionId:'session',runId:run.id,kind:'baseline',revision:1,sourceIds:[],text:'Original context',sha256:hash('Original context'),createdAt:now});
  const turn:TurnRecord={schemaVersion:2,id:'turn',sessionId:'session',runId:run.id,inputIds:[input.inputId],index:0,state:'created',createdAt:now,contextRevisionId:'context'};
  store.putTurn(turn);store.putTurn({...turn,state:'streaming'});
  const attempt:ProviderAttempt={schemaVersion:2,id:'attempt',sessionId:'session',runId:run.id,turnId:turn.id,index:0,providerId:'fixture',modelId:'local',contextRevisionId:'context',state:'prepared',createdAt:now};
  store.putAttempt(attempt);store.createAttemptCleanup({attemptId:attempt.id,sessionId:'session',workspaceId:'workspace',runId:run.id,turnId:turn.id,providerId:'fixture',modelId:'local',contextRevisionId:'context',requestProjection:'engine-turn-request-v1',requestSha256:hash('exact local model request'),requestBytes:100});
  store.dispatchAttemptCleanup(attempt.id);store.putAttempt({...attempt,state:'dispatched',dispatchedAt:now});store.putAttemptUsage(attempt.id,{inputTokens:13,outputTokens:5});store.settleAttemptCleanup(attempt.id,{outcome:'confirmed',method:'iterator-next-done',reason:'natural-done'});
  store.putAttempt({...attempt,state:'completed',dispatchedAt:now,completedAt:now});store.putTurn({...turn,state:'awaiting_tools'});
  function addTool(id:string,inputValue:ToolCallRecord['input']={path:'authored.txt'},partIndex=0) {
    const tool:ToolCallRecord={id,sessionId:'session',runId:run.id,name:'read_file',state:'requested',input:inputValue};
    store.commit(run.id,'tool.requested',{}, {tool});
    const part:MessagePart={schemaVersion:2,id:'part-'+id,sessionId:'session',runId:run.id,turnId:turn.id,messageId:'message',index:partIndex,type:'tool',toolCallId:id,providerCallId:'provider-'+id,name:tool.name,input:tool.input,state:'open',revision:0,createdAt:now};
    store.putPart(part);
    const approval={id:'approval-'+id,sessionId:'session',runId:run.id,toolCallId:id,toolName:tool.name,fingerprint:hash('outer-'+id),status:'allowed' as const,preview:{serverId:'fixture-server',remoteTool:'read',arguments:tool.input,catalogueRevision:2},createdAt:now,resolvedAt:now};
    store.commit(run.id,'approval.allowed',{}, {approval});
    if(state!=='requested')store.commit(run.id,'tool.'+state,{}, {tool:{...tool,state}});
    return {tool:{...tool,state},part,approval};
  }
  const selected=addTool('tool');
  t.after(()=>store.close());
  const snapshot=()=>({attempt:store.getAttempt(attempt.id),cleanup:store.getAttemptCleanup(attempt.id),usage:db.prepare('SELECT data FROM attempt_usage WHERE attempt_id=?').get(attempt.id),context:store.getContextRevision('context'),input:store.getInput(input.inputId),approval:store.getApproval(selected.approval.id)});
  const databaseSnapshot=()=>Object.fromEntries(['runs','tools','approvals','session_turns','provider_attempts','message_parts','attempt_cleanup','mcp_executions','session_sequences','session_controls','events','session_events'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
  const mcp=()=>store.createMcpExecution({toolCallId:selected.tool.id,sessionId:'session',workspaceId:'workspace',runId:run.id,turnId:turn.id,attemptId:attempt.id,providerId:'fixture',modelId:'local',contextRevisionId:'context',toolName:selected.tool.name,approvalId:selected.approval.id,approvalFingerprint:selected.approval.fingerprint,serverId:'fixture-server',connectionId:'connection',catalogueRevision:2,remoteTool:'read',protocolVersion:'2026-07-28',transportKind:'http',logicalRpcId:5,requestProjection:'mcp-jsonrpc-tools-call-v1',requestSha256:hash('exact local MCP envelope'),requestBytes:150});
  return {store,db,run,turn,attempt,...selected,addTool,snapshot,databaseSnapshot,mcp};
}

test('running native intent is captured once in both journals before rewrite without proving any effect',t=>{
  const f=fixture(t),before=f.snapshot(),originalTool=f.store.getToolCall(f.tool.id),originalTurn=f.store.getTurn(f.turn.id),originalAttempt=f.store.getAttempt(f.attempt.id);
  f.store.recoverInterrupted();
  const v1=f.store.readEvents('session',0,100),v2=f.store.readSessionEvents('session',0,100),a=v1.filter(e=>e.type==='tool.recovery_frontier'),b=v2.filter(e=>e.type==='tool.recovery_frontier');
  assert.equal(a.length,1);assert.equal(b.length,1);assert.deepEqual(a[0]!.payload,b[0]!.payload);
  const frontier=a[0]!.payload.frontier as Record<string,unknown>;
  assert.equal(frontier.toolRecordSha256,hash(canonical(originalTool)));assert.equal(frontier.turnRecordSha256,hash(canonical(originalTurn)));assert.equal(frontier.attemptRecordSha256,hash(canonical(originalAttempt)));
  assert.equal(frontier.originalToolState,'running');assert.equal(frontier.effectOutcome,'unknown');assert.equal(frontier.callbackEntry,'unverified');assert.equal(frontier.scope,'native-running-tool-intent');
  assert.ok(a[0]!.seq<v1.find(e=>e.type==='tool.interrupted')!.seq);assert.ok(b[0]!.seq<v2.find(e=>e.type==='message.part.interrupted')!.seq);
  assert.equal(f.store.getTurn(f.turn.id).state,'uncertain');assert.equal(f.store.getTurn(f.turn.id).uncertainty?.kind,'tool_effect');assert.equal(f.store.hasUncertainWorkspace('workspace'),true);
  assert.equal(f.store.getToolCall(f.tool.id).state,'interrupted');assert.deepEqual(f.snapshot(),before);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM mcp_executions').get()!.count,0);
  const eventsBefore=[v1,v2];f.store.recoverInterrupted();assert.deepEqual([f.store.readEvents('session',0,100),f.store.readSessionEvents('session',0,100)],eventsBefore);
});

for(const state of ['requested','awaiting_approval','interrupted'] as const)test('never-started or already interrupted '+state+' records do not manufacture a frontier',t=>{
  const f=fixture(t,state);f.store.recoverInterrupted();assert.equal(f.store.hasUncertainWorkspace('workspace'),false);
  assert.equal(f.store.readEvents('session',0,100).filter(e=>e.type.startsWith('tool.recovery_frontier')).length,0);
  assert.equal(f.store.getTurn(f.turn.id).state,'interrupted');
});

test('proposal-only controls do not count as a started tool',t=>{
  const f=fixture(t,'requested');f.db.prepare('DELETE FROM approvals WHERE tool_call_id=?').run(f.tool.id);f.db.prepare('DELETE FROM tools WHERE id=?').run(f.tool.id);
  f.store.recoverInterrupted();assert.equal(f.store.hasUncertainWorkspace('workspace'),false);assert.equal(f.store.getTurn(f.turn.id).state,'interrupted');
});

for(const state of ['prepared','not-dispatched','response-terminal'] as const)test('exact validated MCP '+state+' with confirmed local cleanup excludes generic completion speculation',t=>{
  const f=fixture(t);f.mcp();
  if(state==='not-dispatched')f.store.settleMcpExecution(f.tool.id,{outcome:'not-dispatched',reason:'preflight-error',transportCleanupConfirmed:true});
  if(state==='response-terminal'){f.store.dispatchMcpExecution(f.tool.id,'http-fetch');f.store.settleMcpExecution(f.tool.id,{outcome:'response-terminal',reason:'response',transportCleanupConfirmed:true,responseKind:'tool-result',responseSha256:hash('response'),responseBytes:100});}
  const before=f.snapshot();f.store.recoverInterrupted();assert.equal(f.store.hasUncertainWorkspace('workspace'),false);assert.equal(f.store.getTurn(f.turn.id).state,'interrupted');assert.deepEqual(f.snapshot(),before);
  assert.equal(f.store.readEvents('session',0,100).filter(e=>e.type==='tool.recovery_frontier').length,0);assert.equal(f.store.getMcpExecution(f.tool.id).transportCleanupConfirmed,true);
});

test('a mere MCP prepared receipt or not-dispatched unknown local cleanup cannot waive recovery uncertainty',t=>{
  const f=fixture(t);f.mcp();f.store.settleMcpExecution(f.tool.id,{outcome:'not-dispatched',reason:'cancel',transportCleanupConfirmed:false});
  f.store.recoverInterrupted();assert.equal(f.store.hasUncertainWorkspace('workspace'),true);assert.equal(f.store.getTurn(f.turn.id).uncertainty?.kind,'tool_effect');
});

test('missing native proposal, foreign SQL owner or oversized selected body rolls back startup before body return',t=>{
  for(const target of ['missing','foreign','oversized-tool','oversized-part'] as const){
    const f=fixture(t);
    if(target==='missing')f.db.prepare('DELETE FROM message_parts WHERE id=?').run(f.part.id);
    if(target==='foreign'){f.db.exec('PRAGMA foreign_keys=OFF');f.db.prepare("UPDATE message_parts SET session_id='foreign' WHERE id=?").run(f.part.id);f.db.exec('PRAGMA foreign_keys=ON');}
    if(target==='oversized-tool')f.db.prepare('UPDATE tools SET data=? WHERE id=?').run(JSON.stringify({...f.tool,input:{text:'x'.repeat(TOOL_RECOVERY_FRONTIER_LIMITS.maxOwnerBytes)}}),f.tool.id);
    if(target==='oversized-part')f.db.prepare('UPDATE message_parts SET data=? WHERE id=?').run(JSON.stringify({...f.part,input:{text:'x'.repeat(TOOL_RECOVERY_FRONTIER_LIMITS.maxOwnerBytes)}}),f.part.id);
    const before=f.databaseSnapshot(),prepare=f.db.prepare.bind(f.db);let returnedBodies=0;
    f.db.prepare=sql=>{const statement=prepare(sql);if(/^SELECT (?:data|json_remove\(data,'\$\.result'\) AS data) FROM/u.test(sql)){const get=statement.get.bind(statement);statement.get=(...values)=>{const value=Reflect.apply(get,statement,values) as ReturnType<typeof statement.get>;if(value?.data!==undefined)returnedBodies++;return value;};}return statement;};
    try{assert.throws(()=>f.store.recoverInterrupted());assert.equal(returnedBodies,0,'Header owner and byte guards reject before any selected raw body is returned');}finally{f.db.prepare=prepare;}
    assert.deepEqual(f.databaseSnapshot(),before);
  }
});

test('duplicate proposals and terminal unresolved owner cannot rewrite old immutable outcomes',t=>{
  const duplicate=fixture(t);duplicate.store.putPart({...duplicate.part,id:'second',index:1});const before=duplicate.databaseSnapshot();assert.throws(()=>duplicate.store.recoverInterrupted(),code('TOOL_RECOVERY_FRONTIER_BINDING_MISMATCH'));assert.deepEqual(duplicate.databaseSnapshot(),before);
  const terminal=fixture(t);terminal.store.putPart({...terminal.part,state:'completed',revision:1,completedAt:new Date().toISOString()});terminal.store.putTurn({...terminal.store.getTurn(terminal.turn.id),state:'completed',completedAt:new Date().toISOString()});
  const terminalBefore=terminal.databaseSnapshot();assert.throws(()=>terminal.store.recoverInterrupted(),code('TOOL_RECOVERY_FRONTIER_UNSETTLED_OWNER'));assert.deepEqual(terminal.databaseSnapshot(),terminalBefore);
});

test('existing terminal uncertain owner is preserved with no redundant frontier capture',t=>{
  const f=fixture(t);f.store.putTurn({...f.store.getTurn(f.turn.id),state:'uncertain',completedAt:new Date().toISOString(),uncertainty:{kind:'tool_effect',message:'Prior durable unknown effect',requiresRecovery:true}});const before=f.store.getTurn(f.turn.id);
  f.store.recoverInterrupted();assert.deepEqual(f.store.getTurn(f.turn.id),before);assert.equal(f.store.hasUncertainWorkspace('workspace'),true);assert.equal(f.store.readEvents('session',0,100).filter(e=>e.type==='tool.recovery_frontier').length,0);
});

for(const journal of ['events','session_events'] as const)test('frontier '+journal+' failure rolls back both domains and prior MCP startup settlement',t=>{
  const f=fixture(t);f.mcp();f.addTool('second',{path:'next.txt'},1);const before=f.databaseSnapshot(),prepare=f.db.prepare.bind(f.db);let injected=false;
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO '+journal+'(')){const run=statement.run.bind(statement);statement.run=(...values)=>{if(values.some(value=>typeof value==='string'&&value==='tool.recovery_frontier')){injected=true;throw new Error('authored frontier journal failure');}return Reflect.apply(run,statement,values) as ReturnType<typeof statement.run>;};}return statement;};
  try{assert.throws(()=>f.store.recoverInterrupted());assert.equal(injected,true);}finally{f.db.prepare=prepare;}
  assert.deepEqual(f.databaseSnapshot(),before);assert.equal(f.store.getMcpExecution(f.tool.id).state,'prepared');
});

test('shared selected JSON budget is enforced before the final body returns or any frontier commits',t=>{
  const f=fixture(t),input={text:'x'.repeat(740000)};f.db.prepare('UPDATE tools SET data=? WHERE id=?').run(JSON.stringify({...f.tool,input}),f.tool.id);f.db.prepare('UPDATE message_parts SET data=? WHERE id=?').run(JSON.stringify({...f.part,input}),f.part.id);
  for(let index=1;index<6;index++)f.addTool('large-'+index,input,index);
  const before=f.databaseSnapshot();assert.throws(()=>f.store.recoverInterrupted(),code('RECOVERY_EVIDENCE_LIMIT'));assert.deepEqual(f.databaseSnapshot(),before);
});

test('true legacy running rows report unchecked native coverage without fabricating owner records',t=>{
  const f=fixture(t);f.db.exec('PRAGMA foreign_keys=OFF');f.db.prepare('DELETE FROM message_parts').run();f.db.prepare('DELETE FROM attempt_usage').run();f.db.prepare('DELETE FROM attempt_cleanup').run();f.db.prepare('DELETE FROM provider_attempts').run();f.db.prepare('DELETE FROM session_turns').run();f.db.exec('PRAGMA foreign_keys=ON');
  f.store.recoverInterrupted();assert.equal(f.store.hasUncertainWorkspace('workspace'),false);assert.equal(f.store.listTurns(f.run.id).length,0);
  const event=f.store.readEvents('session',0,100).find(e=>e.type==='tool.recovery_frontier.unchecked');assert.equal(event?.payload.coverage,'unchecked-no-native-execution');assert.equal(event?.payload.effectOutcome,'unknown');assert.equal(f.db.prepare('SELECT count(*) AS count FROM mcp_executions').get()!.count,0);
});

test('native proposal selection reuses the existing DB9 expression index',t=>{
  const f=fixture(t);const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM message_parts WHERE json_extract(data,'$.type')='tool' AND json_extract(data,'$.toolCallId')=? LIMIT 2").all(f.tool.id);
  assert.ok(plan.some(row=>String(row.detail).includes('mcp_native_tool_proposals')));
});
