import type { EventEmitter } from 'node:events';
import { UtilityWorker, type UtilityWorkerOptions } from './core.js';
import type { WorkerPush, WorkerResponse } from './protocol.js';

export interface UtilityPort extends Pick<EventEmitter, 'on' | 'removeListener'> { postMessage(message: WorkerResponse | WorkerPush): void }
export interface UtilityLifecycle extends Pick<EventEmitter, 'on' | 'removeListener'> { exit(code?: number): never | void }

/** Concurrent request handling keeps cancellation and approval controls responsive. */
export function attachUtilityWorker(port: UtilityPort, lifecycle: UtilityLifecycle, options: Pick<UtilityWorkerOptions, 'createEngine'> = {}): { worker: UtilityWorker; shutdown(): Promise<void> } {
  let shutdownPromise: Promise<void> | undefined;
  let exiting = false;
  const worker = new UtilityWorker({ ...options, emit: push => port.postMessage(push) });
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= worker.close().then(() => {
      port.removeListener('message', message);
      port.removeListener('close', disconnected);
      lifecycle.removeListener('disconnect', disconnected);
      lifecycle.removeListener('SIGINT', interrupted);
      lifecycle.removeListener('SIGTERM', interrupted);
    });
    return shutdownPromise;
  };
  const exitAfterClose = (): void => {
    if (exiting) return;
    exiting = true;
    void shutdown().then(() => lifecycle.exit(0), () => lifecycle.exit(1));
  };
  const disconnected = (): void => exitAfterClose();
  const interrupted = (): void => exitAfterClose();
  const message = (event: { data: unknown }): void => {
    void worker.handle(event.data).then(response => {
      try { port.postMessage(response); }
      catch { exitAfterClose(); return; }
      const request = event.data as { type?: unknown } | null;
      if (response.ok && request?.type === 'close') {
        // Yield once so the close acknowledgement can leave the parent port before exit.
        setImmediate(exitAfterClose);
      }
    }).catch(exitAfterClose);
  };
  port.on('message', message);
  port.on('close', disconnected);
  lifecycle.on('disconnect', disconnected);
  lifecycle.on('SIGINT', interrupted);
  lifecycle.on('SIGTERM', interrupted);
  return { worker, shutdown };
}
