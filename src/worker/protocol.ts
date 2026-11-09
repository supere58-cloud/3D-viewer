import type { LoadErrorCode, ParsedModel } from '../core/types';

export type ToWorker =
  /** Read a File/Blob; optionally copy it into private storage under `store`. */
  | { t: 'file'; name: string; file: Blob; store: string | null }
  /** Re-open a copy kept in private storage. */
  | { t: 'opfs'; name: string; opfsName: string }
  /** Bytes will be pushed with 'chunk' messages (native file intake). */
  | { t: 'push'; name: string; size: number; store: string | null }
  | { t: 'chunk'; data: ArrayBuffer }
  | { t: 'end' };

export type LoadPhase = 'read' | 'index';

export type FromWorker =
  | { t: 'progress'; phase: LoadPhase; done: number; total: number }
  | { t: 'done'; model: ParsedModel; stored: boolean }
  | { t: 'error'; code: LoadErrorCode; detail: string };

/** Directory inside the Origin Private File System that holds recent files. */
export const STORE_DIR = 'models';
