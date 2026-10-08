import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let binding;

function unavailable(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'WINDOWS_JOB_BACKEND_UNAVAILABLE' });
}

/** Importing the package is portable; creating an owned job requires the native binary. */
export function loadBinding() {
  if (binding) return binding;
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) || Number(process.versions.napi) < 8) {
    throw unavailable('Windows Job Objects require Windows 10 or newer, x64/arm64 and Node-API 8.');
  }
  let native;
  try { native = require('./build/Release/windows_job.node'); }
  catch (cause) { throw unavailable('The Windows Job Object native binary is unavailable. Run prepare:windows-job on Windows.', cause); }
  const info = native.nativeInfo?.();
  if (info?.bindingVersion !== 1 || info.napiVersion !== 8 || info.platform !== 'win32' || info.arch !== process.arch || info.atomicJobAssignment !== true || typeof native.createJob !== 'function') {
    throw unavailable('The Windows Job Object native binary has an incompatible interface.');
  }
  binding = Object.freeze(native);
  return binding;
}

export function isAvailable() {
  try { loadBinding(); return true; }
  catch { return false; }
}

export const createJob = () => loadBinding().createJob();
export const nativeInfo = () => Object.freeze(loadBinding().nativeInfo());
export const currentProcessHandleCount = () => loadBinding().currentProcessHandleCount();
