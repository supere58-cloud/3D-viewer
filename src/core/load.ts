/**
 * Format-independent load pipeline: bytes in (streamed), ParsedModel out.
 * Runs inside the parse worker; has no DOM or three.js dependency so the
 * unit tests can run it in Node.
 */
import { LoadError, type Diagnostics, type FileFormat, type LayerDef, type ParsedModel, type WarningCode } from './types';
import { DxfParser, isBinaryDxf, type DxfInfo } from './dxf/parser';
import { ModelBuilder } from './model/builder';
import { ObjParser } from './formats/obj';
import { StlParser } from './formats/stl';
import { parseGlb, type GlbInfo } from './formats/glb';

export function formatFromName(name: string): FileFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  switch (m?.[1].toLowerCase()) {
    case 'dxf': return 'dxf';
    case 'glb': return 'glb';
    case 'obj': return 'obj';
    case 'stl': return 'stl';
    default: return null;
  }
}

function sniff(head: Uint8Array): FileFormat | null {
  if (head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return 'glb';
  if (isBinaryDxf(head)) return 'dxf';
  let text = '';
  for (let i = 0; i < Math.min(head.length, 512); i++) text += String.fromCharCode(head[i]);
  if (/^﻿?\s*(0|999)\s*\r?\n\s*(SECTION|[^\r\n]*)\r?\n/.test(text.replace(/^\xEF\xBB\xBF/, '')) && /SECTION|999/.test(text)) return 'dxf';
  if (/^\s*solid\b/i.test(text)) return 'stl';
  if (/^(#[^\n]*\n|\s)*(v|vn|vt|o|g|mtllib)\s/m.test(text)) return 'obj';
  return null;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]*$/, '') || name;
}

export class ModelLoader {
  private builder = new ModelBuilder();
  private format: FileFormat | null;
  private started = false;
  private dxf: DxfParser | null = null;
  private obj: ObjParser | null = null;
  private stl: StlParser | null = null;
  private whole: Uint8Array | null = null;
  private wholeLen = 0;
  private bytes = 0;
  private t0 = Date.now();

  constructor(private name: string, private totalBytes: number) {
    this.format = formatFromName(name);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.bytes += chunk.length;
    if (!this.started) {
      this.started = true;
      chunk = this.begin(chunk);
    }
    try {
      if (this.dxf) this.dxf.push(chunk);
      else if (this.obj) this.obj.push(chunk);
      else if (this.stl) this.stl.push(chunk);
      else this.appendWhole(chunk);
    } catch (err) {
      throw toLoadError(err);
    }
  }

  private begin(first: Uint8Array): Uint8Array {
    const sniffed = sniff(first);
    // Content wins over a wrong extension; the extension decides when unsure.
    if (sniffed === 'glb' || !this.format) this.format = sniffed ?? this.format;
    if (!this.format) throw new LoadError('unsupportedFormat', this.name);
    const layer = baseName(this.name);
    switch (this.format) {
      case 'dxf': {
        if (isBinaryDxf(first)) throw new LoadError('binaryDxf');
        if (first.length >= 2 && ((first[0] === 0xff && first[1] === 0xfe) || (first[0] === 0xfe && first[1] === 0xff))) {
          throw new LoadError('utf16Dxf');
        }
        if (first.length >= 4 && (first[1] === 0 || first[0] === 0) && (first[3] === 0 || first[2] === 0)) throw new LoadError('utf16Dxf');
        this.dxf = new DxfParser(this.builder);
        if (first.length >= 3 && first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) return first.subarray(3);
        return first;
      }
      case 'obj': this.obj = new ObjParser(this.builder, layer); return first;
      case 'stl': this.stl = new StlParser(this.builder, layer, this.totalBytes); return first;
      case 'glb': return first;
    }
  }

  private appendWhole(chunk: Uint8Array): void {
    if (!this.whole) this.whole = new Uint8Array(Math.max(this.totalBytes, chunk.length));
    if (this.wholeLen + chunk.length > this.whole.length) {
      const grown = new Uint8Array(Math.max(this.whole.length * 2, this.wholeLen + chunk.length));
      grown.set(this.whole.subarray(0, this.wholeLen));
      this.whole = grown;
    }
    this.whole.set(chunk, this.wholeLen);
    this.wholeLen += chunk.length;
  }

  finish(): ParsedModel {
    if (!this.started || !this.format) throw new LoadError('unsupportedFormat', this.name);
    try {
      return this.finishInner(this.format);
    } catch (err) {
      throw toLoadError(err);
    }
  }

  private finishInner(format: FileFormat): ParsedModel {
    const warnings = new Set<WarningCode>();
    let defs: LayerDef[] = [];
    let entities: Record<string, number> = {};
    let skipped: Record<string, number> = {};
    let dxfInfo: DxfInfo | null = null;
    let malformed = 0;

    if (this.dxf) {
      dxfInfo = this.dxf.finish();
      defs = dxfInfo.layers;
      entities = { ...dxfInfo.entities };
      skipped = { ...dxfInfo.skipped };
      malformed = dxfInfo.malformedLines;
      dxfInfo.warnings.forEach((w) => warnings.add(w));
      const total = Object.keys(entities).length;
      if (total === 0 && defs.length === 0 && dxfInfo.version === null && this.builder.primitiveCount === 0) {
        // Nothing that looks like DXF was found at all.
        throw new LoadError('notDxf');
      }
    } else if (this.obj) {
      this.obj.finish();
      entities = { ...this.obj.statements };
      for (const k of Object.keys(entities)) {
        if (!['v', 'f', 'l', 'p', 'o', 'g'].includes(k)) skipped[k] = entities[k];
      }
      if (this.obj.badFaces > 0) { warnings.add('badFaces'); skipped['(bad index)'] = this.obj.badFaces; }
    } else if (this.stl) {
      this.stl.finish();
      entities = { facet: this.stl.triangles };
    } else {
      const data = this.whole ? this.whole.subarray(0, this.wholeLen) : new Uint8Array(0);
      const info: GlbInfo = parseGlb(data, this.builder, baseName(this.name));
      this.whole = null;
      entities = { mesh: info.meshes, primitive: info.primitives };
      skipped = { ...info.skipped };
      if (info.texturesDropped) warnings.add('texturesDropped');
    }

    const built = this.builder.finish(defs);
    if (built.farOutliers) warnings.add('farOutliers');
    if (built.nonFinite > 0) { warnings.add('nonFiniteCoords'); skipped['(bad coordinates)'] = built.nonFinite; }
    const diagnostics: Diagnostics = {
      format,
      bytes: this.bytes,
      parseMs: Date.now() - this.t0,
      encoding: dxfInfo ? dxfInfo.encoding : format === 'obj' ? 'UTF-8' : '-',
      codepage: dxfInfo?.codepage ?? null,
      version: dxfInfo?.version ?? null,
      entities,
      skipped,
      malformedLines: malformed,
      triangles: built.triangles,
      segments: built.segments,
      points: built.points,
      texts: built.texts,
      blocks: dxfInfo?.blocks ?? 0,
      layers: built.layers.length,
      warnings: [...warnings],
      bbox: built.bbox,
    };
    return { origin: built.origin, layers: built.layers, labels: built.labels, focus: built.focus, diagnostics };
  }
}

export function toLoadError(err: unknown): LoadError {
  if (err instanceof LoadError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof RangeError || /allocation|out of memory|invalid array length|array buffer/i.test(msg)) {
    return new LoadError('outOfMemory', msg);
  }
  return new LoadError('parseFailed', msg);
}

/** Convenience for tests and small inputs. */
export function loadFromBytes(name: string, data: Uint8Array, chunkSize = 0): ParsedModel {
  const loader = new ModelLoader(name, data.length);
  if (chunkSize > 0) {
    for (let i = 0; i < data.length; i += chunkSize) loader.push(data.subarray(i, Math.min(data.length, i + chunkSize)));
  } else {
    loader.push(data);
  }
  return loader.finish();
}
