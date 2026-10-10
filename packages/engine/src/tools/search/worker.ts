import { Worker } from 'node:worker_threads';
import { EngineError } from '@moodcode/contracts';
interface SearchWorkerInput { kind: 'glob' | 'regex'; pattern: string; flags: string; files: { path: string; content?: string }[]; maxResults: number }
interface SearchWorkerResult { files: string[]; matches: { path: string; line: number; column: number; text: string; snippetTruncated: boolean }[]; truncated: boolean }
// This worker receives only bounded in-memory strings, and has no tool/filesystem bridge.
const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const input = workerData;
function glob(pattern) {
 let source = '^';
 for (let i = 0; i < pattern.length; i++) {
  const c = pattern[i];
  if (c === '*') { let count=1; while(pattern[i+1]==='*'){count++;i++;} if(count>1 && pattern[i+1]==='/'){ source+='(?:.*/)?';i++; } else source+=count>1 ? '.*' : '[^/]*'; }
  else if(c==='?') source+='[^/]';
  else source+='^$+?.()|{}[]'.includes(c) ? '\\\\'+c : c;
 }
 return new RegExp(source+'$','u');
}
try {
 const expression = input.kind==='glob' ? glob(input.pattern) : new RegExp(input.pattern,input.flags+'g');
 const files=[],matches=[];let truncated=false;
 outer: for(const file of input.files) {
  if(input.kind==='glob') { if(expression.test(file.path)) { if(files.length===input.maxResults){truncated=true;break;}files.push(file.path); }continue; }
  const text=file.content; expression.lastIndex=0;
  const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\\n')starts.push(i+1);
  let found; while((found=expression.exec(text))!==null) {
   if(matches.length===input.maxResults){truncated=true;break outer;}
   let lo=0,hi=starts.length-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(starts[mid]<=found.index)lo=mid;else hi=mid-1;}
   const start=starts[lo],end=text.indexOf('\\n',start);const line=text.slice(start,end<0?text.length:end).replace(/\\r$/,'');
   matches.push({path:file.path,line:lo+1,column:found.index-start+1,text:line.slice(0,512),snippetTruncated:line.length>512});
   if(found[0].length===0){if(expression.lastIndex>=text.length)break;const cp=text.codePointAt(expression.lastIndex);expression.lastIndex+=input.flags.includes('u')&&cp>65535?2:1;}
  }
 }
 parentPort.postMessage({files,matches,truncated});
} catch {parentPort.postMessage({error:'INVALID_SEARCH_PATTERN'});}
`;
export function runSearchWorker(input: SearchWorkerInput, signal: AbortSignal, timeoutMs = 250): Promise<SearchWorkerResult> {
  if (signal.aborted) return Promise.reject(new EngineError('CANCELLED', 'Search was cancelled'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(new EngineError('INVALID_SEARCH_TIMEOUT', 'Search worker timeout is out of bounds'));
  return new Promise((resolve, reject) => {
    let settled = false; const worker = new Worker(SOURCE, { eval: true, workerData: input, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    const finish = (error?: EngineError, result?: SearchWorkerResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancelled); void worker.terminate().catch(() => {}); if (error) reject(error); else resolve(result!); };
    const cancelled = () => finish(new EngineError('CANCELLED', 'Search worker cancelled'));
    const timer = setTimeout(() => finish(new EngineError('SEARCH_TIME_LIMIT', 'Pattern evaluation exceeded its bounded worker time')), timeoutMs);
    signal.addEventListener('abort', cancelled, { once: true }); if (signal.aborted) cancelled();
    worker.once('message', value => { if (value.error) finish(new EngineError('INVALID_SEARCH_PATTERN', 'Search pattern could not be evaluated')); else finish(undefined, value as SearchWorkerResult); });
    worker.once('error', () => finish(new EngineError('SEARCH_WORKER_FAILED', 'Pattern worker failed within its resource limit')));
    worker.once('exit', () => { if (!settled) finish(new EngineError('SEARCH_WORKER_FAILED', 'Pattern worker exited without a result')); });
  });
}
