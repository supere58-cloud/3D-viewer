/** Runs one file through a parse worker, with progress and cancellation. */
import { LoadError, type ParsedModel } from '../core/types';
import type { FromWorker, LoadPhase, ToWorker } from '../worker/protocol';
import { readNativeFile } from './native';
import { removeStored } from './storage';

export type LoadSource =
  | { kind: 'file'; name: string; size: number; file: Blob }
  | { kind: 'stored'; name: string; size: number; store: string }
  | { kind: 'native'; name: string; size: number; path: string };

export interface LoadHandle {
  result: Promise<{ model: ParsedModel; stored: boolean }>;
  cancel(): void;
}

export function loadModel(
  source: LoadSource, storeAs: string | null, onProgress: (phase: LoadPhase, fraction: number) => void,
): LoadHandle {
  const worker = new Worker(new URL('../worker/parse.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let cancelled = false;
  let rejectFn: (e: unknown) => void = () => {};
  const send = (msg: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(msg, transfer);

  const result = new Promise<{ model: ParsedModel; stored: boolean }>((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      if (msg.t === 'progress') {
        onProgress(msg.phase, msg.total > 0 ? Math.min(1, msg.done / msg.total) : 0);
      } else if (msg.t === 'done') {
        settled = true;
        worker.terminate();
        resolve({ model: msg.model, stored: msg.stored });
      } else {
        settled = true;
        worker.terminate();
        if (storeAs) void removeStored(storeAs);
        reject(new LoadError(msg.code, msg.detail));
      }
    };
    worker.onerror = (ev) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (storeAs) void removeStored(storeAs);
      // A worker that dies without a message has almost always run out of memory.
      reject(new LoadError(/memory|allocation/i.test(ev.message ?? '') ? 'outOfMemory' : 'parseFailed', ev.message ?? 'worker error'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new LoadError('outOfMemory', 'transfer failed'));
    };

    if (source.kind === 'file') {
      send({ t: 'file', name: source.name, file: source.file, store: storeAs });
    } else if (source.kind === 'stored') {
      send({ t: 'opfs', name: source.name, opfsName: source.store });
    } else {
      send({ t: 'push', name: source.name, size: source.size, store: storeAs });
      readNativeFile(source.path, (buf) => { if (!settled) send({ t: 'chunk', data: buf }, [buf]); }, () => cancelled || settled)
        .then(() => { if (!settled) send({ t: 'end' }); })
        .catch((e: unknown) => {
          if (settled) return;
          settled = true;
          worker.terminate();
          if (storeAs) void removeStored(storeAs);
          reject(new LoadError('readFailed', e instanceof Error ? e.message : String(e)));
        });
    }
  });

  return {
    result,
    cancel(): void {
      if (settled) return;
      settled = true;
      cancelled = true;
      worker.terminate();
      if (storeAs) void removeStored(storeAs);
      rejectFn(new LoadError('cancelled'));
    },
  };
}
