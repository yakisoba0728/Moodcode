import { attachUtilityWorker } from './runtime.js';

if (!process.parentPort) throw new Error('The desktop engine worker requires an Electron utility parent port.');
attachUtilityWorker(process.parentPort, process);
