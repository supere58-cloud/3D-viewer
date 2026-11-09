/**
 * Glue to the native shells (Capacitor). Everything here is a no-op in the
 * browser / PWA build. File bytes always arrive through the plugin bridge,
 * never over HTTP, so the page can keep connect-src 'none'.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Filesystem } from '@capacitor/filesystem';

export interface IncomingFile { path: string; name: string; size: number }

interface FileIntakePlugin {
  /** Files the app was opened with (launch intent, or intents received while JS was not ready). */
  getPending(): Promise<{ files: IncomingFile[]; failed: number }>;
  /** Deletes the cache copies once they have been imported. */
  release(options: { paths: string[] }): Promise<void>;
  addListener(event: 'files', cb: (data: { files: IncomingFile[]; failed: number }) => void): Promise<PluginListenerHandle>;
}

const FileIntake = registerPlugin<FileIntakePlugin>('FileIntake');

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();

const CHUNK = 3 * 1024 * 1024;

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Streams a native file to `onChunk`. Resolves when the whole file was delivered. */
export function readNativeFile(path: string, onChunk: (data: ArrayBuffer) => void, stopped: () => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    Filesystem.readFileInChunks({ path, chunkSize: CHUNK }, (chunk, err) => {
      if (finished) return;
      if (err) { finished = true; reject(err instanceof Error ? err : new Error(String((err as { message?: string })?.message ?? err))); return; }
      const data = chunk?.data;
      if (typeof data !== 'string' || data.length === 0) { finished = true; resolve(); return; }
      if (stopped()) return;
      try {
        onChunk(decodeBase64(data));
      } catch (e) {
        finished = true;
        reject(e);
      }
    }).catch((e: unknown) => { if (!finished) { finished = true; reject(e); } });
  });
}

function nameFromUrl(url: string): string {
  const last = url.split(/[\\/]/).pop() ?? 'file';
  try { return decodeURIComponent(last); } catch { return last; }
}

async function fromFileUrl(url: string): Promise<IncomingFile | null> {
  if (!/^file:/i.test(url)) return null;
  let size = 0;
  try { size = (await Filesystem.stat({ path: url })).size; } catch { /* size stays unknown */ }
  return { path: url, name: nameFromUrl(url), size };
}

export interface NativeHooks {
  onFiles(files: IncomingFile[], failed: number): void;
  onPause(): void;
  onResume(): void;
  /** Return true if the back press was consumed by the UI. */
  onBack(): boolean;
}

export async function initNative(hooks: NativeHooks): Promise<void> {
  if (!isNative) return;
  void CapApp.addListener('pause', () => hooks.onPause());
  void CapApp.addListener('resume', () => hooks.onResume());
  void CapApp.addListener('backButton', () => {
    if (!hooks.onBack()) void CapApp.minimizeApp();
  });

  if (platform === 'android') {
    await FileIntake.addListener('files', (d) => hooks.onFiles(d.files ?? [], d.failed ?? 0));
    try {
      const pending = await FileIntake.getPending();
      if (pending.files?.length || pending.failed) hooks.onFiles(pending.files ?? [], pending.failed ?? 0);
    } catch { /* plugin missing: the in-app picker still works */ }
  } else {
    // iOS / iPadOS: "Open in..." and the share sheet deliver a file URL.
    void CapApp.addListener('appUrlOpen', (ev) => {
      void fromFileUrl(ev.url).then((f) => { if (f) hooks.onFiles([f], 0); });
    });
    try {
      const launch = await CapApp.getLaunchUrl();
      const f = launch?.url ? await fromFileUrl(launch.url) : null;
      if (f) hooks.onFiles([f], 0);
    } catch { /* ignore */ }
  }
}

/** Removes the temporary copies made for an incoming file. */
export async function releaseNative(paths: string[]): Promise<void> {
  if (!isNative || paths.length === 0) return;
  try {
    if (platform === 'android') await FileIntake.release({ paths });
    else for (const p of paths) await Filesystem.deleteFile({ path: p });
  } catch { /* best effort */ }
}
