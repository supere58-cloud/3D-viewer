/// <reference lib="webworker" />
/**
 * Parse worker: reads a file as a stream of chunks, parses it, builds the
 * picking BVH per layer and transfers the buffers to the UI thread. One
 * worker handles one file and is terminated afterwards; cancelling a load is
 * simply terminating the worker.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ModelLoader, toLoadError } from '../core/load';
import { LoadError, type ParsedModel } from '../core/types';
import { STORE_DIR, type FromWorker, type ToWorker } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const CHUNK = 4 * 1024 * 1024;

interface SyncHandle { write(data: Uint8Array, opts?: { at: number }): number; flush(): void; close(): void }

let loader: ModelLoader | null = null;
let store: SyncHandle | null = null;
let storeFailed = false;
let storeAt = 0;
let total = 0;
let done = 0;
let lastReport = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function fail(err: unknown): void {
  closeStore();
  const e = toLoadError(err);
  post({ t: 'error', code: e.code, detail: e.message });
}

async function openStore(name: string | null): Promise<void> {
  if (!name) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORE_DIR, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    store = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  } catch {
    // Private storage is optional (old WebView, private mode, quota).
    store = null;
    storeFailed = true;
  }
}

function closeStore(): void {
  if (!store) return;
  try { store.flush(); store.close(); } catch { /* ignore */ }
  store = null;
}

function feed(chunk: Uint8Array): void {
  if (!loader) return;
  loader.push(chunk);
  if (store) {
    try {
      store.write(chunk, { at: storeAt });
      storeAt += chunk.length;
    } catch {
      closeStore();
      storeFailed = true;
    }
  }
  done += chunk.length;
  const now = Date.now();
  if (now - lastReport > 80) {
    lastReport = now;
    post({ t: 'progress', phase: 'read', done, total });
  }
}

function buildIndex(model: ParsedModel): void {
  let all = 0;
  for (const l of model.layers) if (l.tri) all += l.tri.pos.length;
  let before = 0;
  for (const l of model.layers) {
    const tri = l.tri;
    if (!tri) continue;
    const n = tri.pos.length;
    try {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(tri.pos, 3));
      const bvh = new MeshBVH(geo, {
        indirect: true,
        targetLeafSize: 12,
        onProgress: (p: number) => {
          const now = Date.now();
          if (now - lastReport > 80) {
            lastReport = now;
            post({ t: 'progress', phase: 'index', done: before + n * p, total: all });
          }
        },
      });
      const s = MeshBVH.serialize(bvh, { cloneBuffers: false });
      tri.bvh = { version: (s as unknown as { version?: number }).version ?? 1, roots: s.roots, indirect: s.indirectBuffer };
    } catch {
      // Without an index picking still works, only slower.
      tri.bvh = null;
    }
    before += n;
  }
}

function finish(): void {
  if (!loader) return;
  const model = loader.finish();
  loader = null;
  const stored = store !== null && !storeFailed;
  closeStore();
  post({ t: 'progress', phase: 'index', done: 0, total: 1 });
  buildIndex(model);
  const transfer: Transferable[] = [model.labels.pos.buffer, model.labels.height.buffer, model.labels.layer.buffer];
  for (const l of model.layers) {
    for (const set of [l.tri, l.seg, l.pt]) {
      if (!set) continue;
      transfer.push(set.pos.buffer);
      if (set.col) transfer.push(set.col.buffer);
    }
    if (l.tri?.bvh) {
      transfer.push(...l.tri.bvh.roots);
      if (l.tri.bvh.indirect) transfer.push(l.tri.bvh.indirect.buffer);
    }
  }
  post({ t: 'done', model, stored }, transfer);
}

async function readBlob(name: string, blob: Blob, storeName: string | null): Promise<void> {
  total = blob.size;
  loader = new ModelLoader(name, total);
  await openStore(storeName);
  if (blob.size === 0) throw new LoadError('readFailed', 'empty file');
  for (let off = 0; off < blob.size; off += CHUNK) {
    let buf: ArrayBuffer;
    try {
      buf = await blob.slice(off, Math.min(blob.size, off + CHUNK)).arrayBuffer();
    } catch (e) {
      throw new LoadError('readFailed', e instanceof Error ? e.message : String(e));
    }
    feed(new Uint8Array(buf));
  }
  finish();
}

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.t) {
    case 'file':
      await readBlob(msg.name, msg.file, msg.store);
      break;
    case 'opfs': {
      let file: File;
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(STORE_DIR);
        file = await (await dir.getFileHandle(msg.opfsName)).getFile();
      } catch (e) {
        throw new LoadError('readFailed', e instanceof Error ? e.message : String(e));
      }
      await readBlob(msg.name, file, null);
      break;
    }
    case 'push':
      total = msg.size;
      loader = new ModelLoader(msg.name, total);
      await openStore(msg.store);
      break;
    case 'chunk':
      feed(new Uint8Array(msg.data));
      break;
    case 'end':
      if (done === 0) throw new LoadError('readFailed', 'empty file');
      finish();
      break;
  }
}

// Messages are handled strictly in order, also across the async setup steps.
let queue: Promise<void> = Promise.resolve();
let dead = false;
ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  queue = queue.then(async () => {
    if (dead) return;
    try {
      await handle(ev.data);
    } catch (err) {
      dead = true;
      loader = null;
      fail(err);
    }
  });
};
