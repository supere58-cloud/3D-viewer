/**
 * Everything the app remembers lives on the device: small settings in
 * localStorage, copies of opened files in the Origin Private File System.
 */
import type { LayerSettings } from '../viewer/viewer';
import { STORE_DIR } from '../worker/protocol';
import type { Note } from '../ui/notes';
import type { Slice } from '../ui/slices';

export interface Settings {
  lang: 'ru' | 'en';
  grid: boolean;
  labels: boolean;
  ortho: boolean;
  keepCopies: boolean;
  /** Offer the walkthrough when the app starts. */
  tutorial: boolean;
}

export interface RecentFile {
  key: string;
  name: string;
  size: number;
  ts: number;
  /** Name of the private copy, or null if the file has to be picked again. */
  store: string | null;
}

const MAX_RECENTS = 12;
const DEFAULTS: Settings = { lang: 'ru', grid: true, labels: true, ortho: false, keepCopies: true, tutorial: true };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the app still works, it just forgets */
  }
}

export function fileKey(name: string, size: number): string {
  return name + '|' + size;
}

/** Stable short name for the private copy of a file. */
export function storeName(key: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return 'f_' + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '.bin';
}

export const store = {
  loadSettings(): Settings {
    return { ...DEFAULTS, ...read<Partial<Settings>>('mv.settings', {}) };
  },
  saveSettings(s: Settings): void {
    write('mv.settings', s);
  },

  layerSettings(key: string): Record<string, LayerSettings> | null {
    return read<Record<string, LayerSettings> | null>('mv.layers.' + key, null);
  },
  saveLayerSettings(key: string, value: Record<string, LayerSettings>): void {
    write('mv.layers.' + key, value);
  },

  slices(): Slice[] {
    const list = read<Slice[]>('mv.slices', []);
    return Array.isArray(list) ? list : [];
  },
  saveSlices(slices: Slice[]): void {
    write('mv.slices', slices);
  },

  notes(): Note[] {
    const list = read<Note[]>('mv.notes', []);
    return Array.isArray(list) ? list : [];
  },
  saveNotes(notes: Note[]): void {
    write('mv.notes', notes);
  },

  /** Keys of the files that were open last, to offer "continue where I left off". */
  session(): string[] {
    const list = read<string[]>('mv.session', []);
    return Array.isArray(list) ? list : [];
  },
  saveSession(keys: string[]): void {
    write('mv.session', keys);
  },

  recents(): RecentFile[] {
    const list = read<RecentFile[]>('mv.recents', []);
    return Array.isArray(list) ? list : [];
  },

  /** Adds or refreshes an entry; returns entries that fell off the list. */
  touchRecent(entry: RecentFile): void {
    const list = this.recents().filter((r) => r.key !== entry.key);
    list.unshift(entry);
    const dropped = list.splice(MAX_RECENTS);
    write('mv.recents', list);
    for (const d of dropped) this.forget(d, false);
  },

  forget(entry: RecentFile, updateList = true): void {
    if (updateList) write('mv.recents', this.recents().filter((r) => r.key !== entry.key));
    try { localStorage.removeItem('mv.layers.' + entry.key); } catch { /* ignore */ }
    if (entry.store) void removeStored(entry.store);
  },

  clearRecents(): void {
    for (const r of this.recents()) this.forget(r, false);
    write('mv.recents', []);
  },
};

export function privateStorageAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

export async function removeStored(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORE_DIR);
    await dir.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function storedExists(name: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORE_DIR);
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}
