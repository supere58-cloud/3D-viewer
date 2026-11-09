/** Shared data contracts between the parse worker and the UI thread. */

export type Vec3 = [number, number, number];

/** Colour sentinel: take the colour of the layer. */
export const BYLAYER = -1;
/** Colour sentinel: take the colour of the INSERT that references the block. */
export const BYBLOCK = -2;

/** Receives primitives in true (float64) coordinates. */
export interface GeometrySink {
  tri(
    layer: string, color: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void;
  seg(layer: string, color: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void;
  point(layer: string, color: number, x: number, y: number, z: number): void;
  text(layer: string, color: number, x: number, y: number, z: number, height: number, text: string): void;
}

export interface LayerDef {
  name: string;
  /** 0xRRGGBB or null if the file does not say. */
  color: number | null;
  /** Layer is switched off or frozen in the source file. */
  hidden: boolean;
}

export type FileFormat = 'dxf' | 'glb' | 'obj' | 'stl';

export type WarningCode =
  | 'truncated'
  | 'noEof'
  | 'malformedLines'
  | 'bulgesIgnored'
  | 'missingBlocks'
  | 'paperSpaceSkipped'
  | 'badFaces'
  | 'texturesDropped'
  | 'nonFiniteCoords'
  | 'recursionLimit'
  | 'farOutliers';

export interface Diagnostics {
  format: FileFormat;
  bytes: number;
  parseMs: number;
  /** 'ASCII', 'UTF-8', 'windows-1251', ... */
  encoding: string;
  /** Raw $DWGCODEPAGE, if present. */
  codepage: string | null;
  /** Raw $ACADVER, if present (AC1009 = R12 ... AC1032 = 2018). */
  version: string | null;
  /** Every entity type seen and how many. */
  entities: Record<string, number>;
  /** Entity types that were not converted to geometry. */
  skipped: Record<string, number>;
  malformedLines: number;
  triangles: number;
  segments: number;
  points: number;
  texts: number;
  blocks: number;
  layers: number;
  warnings: WarningCode[];
  /** True-coordinate bounding box, null when the file has no geometry. */
  bbox: { min: Vec3; max: Vec3 } | null;
}

export interface SerializedBvh {
  roots: ArrayBuffer[];
  indirect: Uint32Array | Uint16Array | null;
}

export interface PrimitiveSet {
  /** xyz triples relative to ParsedModel.origin, float32. */
  pos: Float32Array;
  /** Per-vertex RGB (0..255), present only when a layer mixes colours. */
  col: Uint8Array | null;
}

export interface ParsedLayer {
  name: string;
  /** Default colour 0xRRGGBB. */
  color: number;
  hidden: boolean;
  tri: (PrimitiveSet & { bvh: SerializedBvh | null }) | null;
  seg: PrimitiveSet | null;
  pt: PrimitiveSet | null;
}

export interface ParsedLabels {
  /** xyz relative to origin. */
  pos: Float32Array;
  height: Float32Array;
  layer: Uint32Array;
  text: string[];
}

export interface ParsedModel {
  /** Float64 origin; true coordinate = origin + local float32 offset. */
  origin: Vec3;
  layers: ParsedLayer[];
  labels: ParsedLabels;
  /** True-coordinate box of the main model, without far outliers; used to frame the view. */
  focus: { min: Vec3; max: Vec3 } | null;
  diagnostics: Diagnostics;
}

export type LoadErrorCode =
  | 'binaryDxf'
  | 'utf16Dxf'
  | 'unsupportedFormat'
  | 'glbCompressed'
  | 'glbInvalid'
  | 'notDxf'
  | 'outOfMemory'
  | 'readFailed'
  | 'parseFailed'
  | 'cancelled';

export class LoadError extends Error {
  constructor(public code: LoadErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'LoadError';
  }
}
