import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopTestDirectory } from './desktop-test-evidence.mjs';

const directory = await createDesktopTestDirectory('codex-refresh-native');
const reportPath = resolve(process.argv[2] ?? 'artifacts/engine-account-lsp-20261010/native-broker.json');
const entry = join(directory, 'entry.mjs'), worker = join(directory, 'worker.cjs');
const hostModule = pathToFileURL(resolve('apps/desktop/dist/types/main/host.js')).href;
const workerModule = pathToFileURL(resolve('apps/desktop/dist/main/engine-worker.js')).href;
await mkdir(join(directory, 'home'), { mode: 0o700 });
await mkdir(join(directory, 'codex'), { mode: 0o700 });
await mkdir(join(directory, 'userData'), { mode: 0o700 });
await writeFile(worker, `
let calls=0;
globalThis.fetch=async(url,init)=>{
  const headers=new Headers(init.headers), ordinal=++calls;
  if(String(url)!=='https://chatgpt.com/backend-api/codex/responses'||init.method!=='POST'||init.redirect!=='error'||ordinal>2
    ||headers.get('authorization')!=='Bearer '+(ordinal===1?'fixture-native-first':'fixture-native-fresh')
    ||headers.get('chatgpt-account-id')!=='fixture-native-routing')throw new Error('FIXTURE_CREDENTIAL_MISMATCH');
  const id='fixture-response-'+ordinal,itemId='fixture-message-'+ordinal,text='Native fixture verified '+ordinal;
  const item={id:itemId,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text}]};
  const events=[{type:'response.created',response:{id,status:'in_progress'}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',item_id:itemId,output_index:0,content_index:0,delta:text},
    {type:'response.output_text.done',item_id:itemId,output_index:0,content_index:0,text},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:3,output_tokens:2}}}];
  return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
};
void import(${JSON.stringify(workerModule)});
`, { mode: 0o600 });
await writeFile(entry, `
import {app,utilityProcess} from 'electron';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {DesktopHost} from ${JSON.stringify(hostModule)};
app.setName('Moodcode native credential fixture'); app.setPath('userData',${JSON.stringify(join(directory, 'userData'))});
app.on('window-all-closed',()=>{});
globalThis.runProbe=async()=>{
  await app.whenReady();
  const root=${JSON.stringify(directory)}, credential={accessToken:'fixture-native-first',accountId:'fixture-native-routing',secrets:['fixture-native-refresh']};
  const config={providerId:'codex',modelId:'fixture-native-model',baseURL:'',codexCredential:credential};
  const view={providerId:'codex',modelId:config.modelId,baseURL:'',credentialMode:'chatgpt',accountId:'12345678-1234-4234-8234-123456789012',keyConfigured:true,keySource:'account',credentialStorage:'secure'};
  let resolves=0,requests=0,replies=0,cancels=0,aborted=0,spawned=0,releaseStarted;
  const started=new Promise(resolve=>{releaseStarted=resolve;});
  const host=new DesktopHost({settings:{load:async()=>({engineConfig:config}),getView:()=>view},
    dbPath:root+'/engine.sqlite',artifactDir:root+'/artifacts',platform:process.platform,version:'fixture',
    rpcTimeoutMs:15000,closeTimeoutMs:15000,utilityExitTimeoutMs:15000,
    resolveCodexCredential:async(account,model,signal)=>{
      assert.equal(account,view.accountId);assert.equal(model,config.modelId);resolves++;
      if(resolves===3){releaseStarted();return await new Promise((_,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(new Error('FIXTURE_CANCELLED'));},{once:true});});}
      return {...credential,accessToken:resolves===1?'fixture-native-first':'fixture-native-fresh'};
    },spawn:()=>{
      spawned++;const child=utilityProcess.fork(${JSON.stringify(worker)},[],{serviceName:'Moodcode finite native credential fixture',stdio:'pipe'});
      child.stdout?.resume();child.stderr?.resume();
      return {diagnosticSource:'original-electron-utility',postMessage:message=>{if(message.type==='codex-credential-result')replies++;child.postMessage(message);},
        onMessage:listener=>{const receive=message=>{if(message.type==='codex-credential')requests++;if(message.type==='codex-credential-cancel')cancels++;listener(message);};child.on('message',receive);return()=>child.off('message',receive);},
        onExit:listener=>{child.on('exit',listener);return()=>child.off('exit',listener);}};
    }});
  globalThis.fixtureHost=host;
  const command=async(type,payload)=>{const response=await host.command({schemaVersion:1,commandId:randomUUID(),type,payload});if(!response.ok)globalThis.fixtureErrorCode=response.error?.code;assert.equal(response.ok,true,response.error?.code);return response.result;};
  const snapshot=async(sessionId)=>command('session.getSnapshot',{sessionId});
  const wait=async(sessionId,runId)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await snapshot(sessionId);const run=value.runs.find(run=>run.id===runId);if(['completed','failed','cancelled','interrupted'].includes(run?.state))return {value,run};await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('FIXTURE_RUN_TIMEOUT');};
  try{
    globalThis.fixtureStage='initialize';assert.equal((await host.initialize()).state,'ready');await mkdir(root+'/repository');
    execFileSync('git',['init','-q','--template=',root+'/repository'],{timeout:5000,stdio:'ignore'});
    globalThis.fixtureStage='workspace-session';
    const workspace=await command('workspace.open',{path:root+'/repository'}),session=await command('session.create',{workspaceId:workspace.id,title:'Native credential fixture'});
    for(let ordinal=1;ordinal<=2;ordinal++){
      globalThis.fixtureStage='turn-'+ordinal;
      const receipt=await command('run.submit',{sessionId:session.id,requestId:'native-'+ordinal,prompt:'Return fixture verification.',config:{mode:'plan',providerId:'codex',modelId:config.modelId,limits:{maxTurns:1,maxDurationMs:15000}}});
      const result=await wait(session.id,receipt.runId);assert.equal(result.run.state,'completed',result.run.error?.code);
      assert.ok(result.value.messages.some(message=>message.content.includes('Native fixture verified '+ordinal)));
    }
    globalThis.fixtureStage='cancel';const receipt=await command('run.submit',{sessionId:session.id,requestId:'native-cancel',prompt:'Cancel before credential delivery.',config:{mode:'plan',providerId:'codex',modelId:config.modelId,limits:{maxTurns:1,maxDurationMs:15000}}});
    await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('FIXTURE_CREDENTIAL_TIMEOUT')),15000))]);
    await command('run.cancel',{runId:receipt.runId});assert.equal((await wait(session.id,receipt.runId)).run.state,'cancelled');
    await host.close();const close=host.getUtilityCloseDiagnostics();
    assert.equal(resolves,3);assert.equal(requests,3);assert.equal(replies,2);assert.equal(cancels,1);assert.equal(aborted,1);assert.equal(spawned,1);assert.equal(close.cleanupConfirmed,true);
    assert.equal(host.getStatus().generation,1);assert.equal(close.connections[0].exitCode,0);
    return {passed:true,provider:'codex',externalRequests:0,syntheticNativeTurns:2,credentialRequests:requests,privateReplies:replies,cancelMessages:cancels,abortedFlights:aborted,sameGeneration:1,originalUtilityClose:close};
  }finally{await host.close();}
};
`, { mode: 0o600 });

const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: join(directory, 'home'), CODEX_HOME: join(directory, 'codex') });
let application, processHandle;
let report = { passed: false, scope: 'original Electron utility credential transport with synthetic credentials and intercepted native HTTP', originalDirectory: directory, externalRequests: 0 };
try {
  application = await electron.launch({ args: [entry], env, timeout: 20000 }); processHandle = application.process();
  Object.assign(report, await application.evaluate(() => globalThis.runProbe()));
} catch {
  report.failure = 'NATIVE_CREDENTIAL_VERIFICATION_FAILED'; process.exitCode = 1;
  if (application) try { Object.assign(report, await application.evaluate(() => ({ stage: globalThis.fixtureStage ?? null, errorCode: globalThis.fixtureErrorCode ?? null }))); } catch { /* Original remains available if the app exited. */ }
}
finally {
  if (application) try { await application.close(); } catch { report.passed = false; report.closeFailure = true; process.exitCode = 1; }
  report.applicationExitCode = processHandle?.exitCode ?? null;
  if (report.applicationExitCode !== 0) { report.passed = false; process.exitCode = 1; }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
assert.equal(report.passed, true, 'Original native credential fixture failed; retained report identifies its boundary.');
console.log(JSON.stringify({ passed: report.passed, externalRequests: 0, sameGeneration: report.sameGeneration, credentialRequests: report.credentialRequests, applicationExitCode: report.applicationExitCode }));
