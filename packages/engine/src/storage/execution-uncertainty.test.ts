import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSummarySql, summaryHotpathFixture } from './fixtures/summary-hotpath-benchmark.js';

function fixture(count: number) {
  const f = summaryHotpathFixture(1), stamp = '2026-10-07T00:00:00.000Z';
  // Synthetic historical cardinality only; no model requests or cleanup proof
  // are implied by these metadata rows. Positive proof uses actual integration.
  const insertTurn = f.db.prepare('INSERT INTO session_turns(id,session_id,run_id,turn_index,state,data) VALUES(?,?,?,?,?,?)');
  const insertAttempt = f.db.prepare('INSERT INTO provider_attempts(id,session_id,run_id,turn_id,attempt_index,state,data) VALUES(?,?,?,?,?,?,?)');
  f.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index=0; index<count; index++) {
      const turn = { schemaVersion:2,id:`turn-${index}`,sessionId:'session',runId:f.runId,inputIds:['fixture-input'],index,state:'completed',createdAt:stamp,completedAt:stamp };
      const attempt = { schemaVersion:2,id:`attempt-${index}`,sessionId:'session',runId:f.runId,turnId:turn.id,index:0,providerId:'scripted',modelId:'local',state:'completed',createdAt:stamp,dispatchedAt:stamp,completedAt:stamp };
      insertTurn.run(turn.id,'session',f.runId,index,'completed',JSON.stringify(turn));
      insertAttempt.run(attempt.id,'session',f.runId,turn.id,0,'completed',JSON.stringify(attempt));
    }
    f.db.exec('COMMIT');
  } catch (error) { f.db.exec('ROLLBACK'); f.store.close(); throw error; }
  f.store.getSnapshot=()=>{throw new Error('Persistent uncertainty must not load a full snapshot');};
  return f;
}

test('1k/10k ordinary records use indexed persistent predicates and never load historical provider bodies', t => {
  const results=[];
  for(const count of [1000,10000]) {
    const f=fixture(count);
    try {
      const clear=measureSummarySql(f.db,()=>f.store.hasUncertainExecution('workspace'));
      assert.equal(clear.result,false);assert.ok(clear.measurement.returnedSqlBytes<1024);assert.equal(clear.measurement.writeStatements,0);
      f.db.prepare("UPDATE provider_attempts SET state='uncertain',data=json_set(data,'$.state','uncertain','$.uncertainty',json(?)) WHERE id=?")
        .run(JSON.stringify({kind:'provider_dispatch',message:'Synthetic unknown outcome',requiresRecovery:true}),`attempt-${count-1}`);
      const blocked=measureSummarySql(f.db,()=>f.store.hasUncertainExecution('workspace'));
      assert.equal(blocked.result,true);assert.equal(blocked.measurement.queries,2);assert.ok(blocked.measurement.returnedSqlBytes<1024);assert.equal(blocked.measurement.writeStatements,0);
      results.push({count,clear:clear.measurement,blocked:blocked.measurement});
    } finally { f.store.close(); }
  }
  for(const operation of ['clear','blocked'] as const) {
    assert.equal(results[0]![operation].returnedSqlBytes,results[1]![operation].returnedSqlBytes);
    assert.equal(results[0]![operation].queries,results[1]![operation].queries);
  }
  t.diagnostic(JSON.stringify({scope:'ordinary-execution-SQL-values-returned-to-JavaScript;not-physical-I/O',results}));
});

test('oversized uncertain Turn is blocked at its byte header before full evidence is fetched', () => {
  const f=fixture(1);
  try {
    f.db.prepare("UPDATE session_turns SET state='uncertain',data=? WHERE id='turn-0'").run(JSON.stringify({opaque:'x'.repeat(1_048_576)}));
    const observed=measureSummarySql(f.db,()=>f.store.hasUncertainExecution('workspace'));
    assert.equal(observed.result,true);assert.ok(observed.measurement.returnedSqlBytes<2048);assert.equal(observed.measurement.writeStatements,0);
  } finally { f.store.close(); }
});

test('65 synthetic uncertain Turns conservatively block before reading any dependency payload', t => {
  const f=fixture(65);
  try {
    f.db.exec("UPDATE session_turns SET state='uncertain',data='{}'");
    const observed=measureSummarySql(f.db,()=>f.store.hasUncertainExecution('workspace'));
    assert.equal(observed.result,true);assert.equal(observed.measurement.queries,5);assert.ok(observed.measurement.returnedSqlBytes<16384);assert.equal(observed.measurement.writeStatements,0);
    t.diagnostic(JSON.stringify({scope:'synthetic-ordinary-turn-metadata-cap;not-physical-I/O',...observed.measurement}));
  } finally { f.store.close(); }
});
