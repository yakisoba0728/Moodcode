import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSummarySql, summaryHotpathFixture } from './fixtures/summary-hotpath-benchmark.js';

const stamp='2026-10-07T00:00:00.000Z';
function fixture(count:number) {
  const f=summaryHotpathFixture(count);
  f.store.settleSummaryAttempt('target',{state:'uncertain',cleanupConfirmed:false,errorCode:'CLEANUP_UNCERTAIN'});
  for (const id of ['unrelated','clear']) f.store.putWorkspace({id,root:`/fake/quarantine-${id}`,gitRoot:`/fake/quarantine-${id}`,branch:null,createdAt:stamp});
  f.store.createSession({id:'session-unrelated',workspaceId:'unrelated',title:'Unrelated uncertainty',createdAt:stamp});
  const config=f.store.getRun(f.runId).config, runId=f.store.admit({sessionId:'session-unrelated',requestId:'unrelated',prompt:'Unrelated fixture',config}).runId;
  f.store.commit(runId,'run.started',{}, {run:{state:'running'}});
  f.store.createSummaryAttempt({id:'unrelated-target',scope:'completed-history',sessionId:'session-unrelated',workspaceId:'unrelated',runId,providerId:config.providerId,modelId:config.modelId,
    sourceProjection:'conversation-text-v1',sourceSha256:'3'.repeat(64),requestSha256:'4'.repeat(64),requestBytes:1024,expectedMemoryRevision:0});
  f.store.dispatchSummaryAttempt('unrelated-target');f.store.settleSummaryAttempt('unrelated-target',{state:'uncertain',cleanupConfirmed:false,errorCode:'CLEANUP_UNCERTAIN'});
  // Quarantine admission must not load either this large context document or a transcript.
  f.store.putSessionDocument('session','context.head',0,{opaqueContextPadding:'c'.repeat(240000)});
  f.store.getSnapshot=()=>{throw new Error('Quarantine predicate attempted a full snapshot');};
  return f;
}

test('1k/10k typed records use the dedicated workspace uncertainty index and return bounded predicate evidence',t=>{
  const results=[];
  for(const count of [1000,10000]) {
    const f=fixture(count);
    try {
      assert.equal(f.store.getSummaryAttempt('target').retainedTextBytes,65536);
      assert.equal(f.store.getSummaryAttempt('target').state,'uncertain');
      const query="SELECT 1 FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT 1";
      const plan=f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('workspace');
      assert.ok(plan.some(row=>String(row.detail).includes('summary_workspace_uncertain')),JSON.stringify(plan));
      const scopes=['workspace','unrelated','clear'].map(workspace=>{
        const observed=measureSummarySql(f.db,()=>f.store.hasUncertainSummaries(workspace));
        assert.equal(observed.result,workspace!=='clear');assert.equal(observed.measurement.queries,4,'Workspace size, epoch, body and indexed summary predicate only');
        assert.equal(observed.measurement.summaryFullPayloadReads,0);assert.equal(observed.measurement.summaryTextBytesReturned,0);
        assert.equal(observed.measurement.writeStatements,0);assert.ok(observed.measurement.returnedSqlBytes<1024);
        return{workspace,blocked:observed.result,...observed.measurement};
      });
      results.push({count,scopes});
    } finally { f.store.close(); }
  }
  for(let index=0;index<3;index++) {
    assert.ok(Math.abs(results[0]!.scopes[index]!.returnedSqlBytes-results[1]!.scopes[index]!.returnedSqlBytes)<=1,'Only the additional decimal digit in total_changes metadata may vary');
    assert.equal(results[0]!.scopes[index]!.queries,results[1]!.scopes[index]!.queries);
  }
  t.diagnostic(JSON.stringify({scope:'SQL-values-returned-to-JavaScript;not-physical-I/O',results}));
});

test('configured recovery retains a conservative first-unacknowledged predicate without reading full summary or context payload',t=>{
  const results=[];
  for(const count of [1000,10000]) {
    const f=fixture(count);
    try {
      f.store.configureSummaryRecovery(()=> '5'.repeat(64));
      const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM summary_attempts s LEFT JOIN summary_recovery_acknowledgments a ON a.summary_attempt_id=s.id AND a.binding_scope=? WHERE s.workspace_id=? AND s.state='uncertain' AND a.id IS NULL LIMIT 1").all('5'.repeat(64),'workspace');
      assert.ok(plan.some(row=>String(row.detail).includes('summary_workspace_uncertain')),JSON.stringify(plan));
      const scopes=['workspace','unrelated','clear'].map(workspace=>{
        const observed=measureSummarySql(f.db,()=>f.store.hasUncertainSummaries(workspace));
        assert.equal(observed.result,workspace!=='clear');assert.equal(observed.measurement.summaryTextBytesReturned,0);
        assert.ok(observed.measurement.queries>=2,'Measurement must include the actual SQL uncertainty predicate, not only workspace lookup');
        assert.equal(observed.measurement.summaryFullPayloadReads,0);assert.equal(observed.measurement.writeStatements,0);
        assert.ok(observed.measurement.returnedSqlBytes<8192,'A first unacknowledged candidate needs bounded metadata rather than retained output/context');
        return{workspace,blocked:observed.result,...observed.measurement};
      });
      results.push({count,scopes});
    } finally { f.store.close(); }
  }
  for(let index=0;index<3;index++) {
    assert.ok(Math.abs(results[0]!.scopes[index]!.returnedSqlBytes-results[1]!.scopes[index]!.returnedSqlBytes)<=1,'Only the additional decimal digit in total_changes metadata may vary');
    assert.equal(results[0]!.scopes[index]!.queries,results[1]!.scopes[index]!.queries);
  }
  t.diagnostic(JSON.stringify({scope:'SQL-values-returned-to-JavaScript;not-physical-I/O',configured:true,results}));
});

test('10k uncertain candidates block immediately when unacknowledged and conservatively at the acknowledged candidate cap',t=>{
  const f=fixture(10000);
  try {
    // Synthetic historical cardinality; the primary target above uses the real lifecycle API.
    f.db.exec("UPDATE summary_attempts SET state='uncertain',data=json_set(data,'$.state','uncertain','$.publication','discarded','$.cleanupConfirmed',json('false'),'$.completedAt','2026-10-07T00:00:00.000Z') WHERE workspace_id='workspace' AND state='streaming'");
    f.store.configureSummaryRecovery(()=> '5'.repeat(64));
    const observed=measureSummarySql(f.db,()=>f.store.hasUncertainSummaries('workspace'));
    assert.equal(observed.result,true);assert.equal(observed.measurement.summaryFullPayloadReads,0);assert.equal(observed.measurement.summaryTextBytesReturned,0);
    assert.ok(observed.measurement.returnedSqlBytes<8192,'The first unacknowledged candidate must block before loading a candidate page');
    assert.equal(observed.measurement.writeStatements,0);
    t.diagnostic(JSON.stringify({scope:'first-unacknowledged-SQL-evidence;not-physical-I/O',count:10000,...observed.measurement}));
    // Synthetic ledger cardinality does not establish a valid acknowledgment.
    // It exercises the metadata cap before any ledger/source/text validation;
    // even a matching row for every candidate cannot make excessive coverage clear.
    const scope=f.store.getSummaryRecoveryPreview('session','target').bindingScope;
    f.db.prepare(`INSERT INTO summary_recovery_acknowledgments
      (id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,proof_version,data)
      SELECT 'ledger-'||id,id,session_id,workspace_id,run_id,'request-'||id,?,json_extract(data,'$.revision'),?,?,NULL,?,2,'{}'
      FROM summary_attempts WHERE workspace_id='workspace' AND state='uncertain'`).run(scope,'6'.repeat(64),'7'.repeat(64),'8'.repeat(64));
    const capped=measureSummarySql(f.db,()=>f.store.hasUncertainSummaries('workspace'));
    assert.equal(capped.result,true);assert.equal(capped.measurement.summaryFullPayloadReads,0);
    assert.equal(capped.measurement.summaryTextBytesReturned,0);assert.equal(capped.measurement.writeStatements,0);
    assert.equal(capped.measurement.queries,6,'Workspace size, epoch and body, indexed uncertainty preflight, unmatched-ack predicate, and bounded candidate metadata page only');
    assert.ok(capped.measurement.returnedSqlBytes<8192,'Only 65 short candidate identities may cross into JavaScript before conservative rejection');
    t.diagnostic(JSON.stringify({scope:'synthetic-acknowledgment-candidate-cap;not-physical-I/O',count:10000,...capped.measurement}));
  } finally { f.store.close(); }
});
