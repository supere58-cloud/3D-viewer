import { describe, expect, it } from 'vitest';
import { imageCorners, imageSize, isImageName, pairKey, parseGrf, pixelToWorld } from '../src/core/formats/grf';

// A vertical section running east, 0.05 m per pixel, top-left at (654000, 7654000, 500).
const GRF = ['654000.0', '7654000.0', '500.0', '0.05', '0.05', '1', '0', '0', '0', '0', '1',
  '100 200 654005.0 7654000.0 490.0 1', '2000 200 654100.0 7654000.0 490.0 1', ''].join('\r\n');

describe('Micromine .grf georeference', () => {
  const g = parseGrf(GRF)!;
  it('reads origin, pixel size and axes', () => {
    expect(g.origin).toEqual([654000, 7654000, 500]);
    expect(g.pixelX).toBe(0.05);
    expect(g.xAxis).toEqual([1, 0, 0]);
    expect(g.upAxis).toEqual([0, 0, 1]);
  });
  it('places pixels: right along the X axis, down against the up axis', () => {
    expect(pixelToWorld(g, 100, 200)).toEqual([654005, 7654000, 490]);
    const c = imageCorners(g, 2000, 4000);
    expect(c[0]).toEqual([654000, 7654000, 500]);
    expect(c[1]).toEqual([654100, 7654000, 500]);
    expect(c[2]).toEqual([654100, 7654000, 300]);
    expect(c[3]).toEqual([654000, 7654000, 300]);
  });
  it('rejects text that is not a georeference', () => {
    expect(parseGrf('hello')).toBeNull();
    expect(parseGrf(GRF.replace('0.05', '0'))).toBeNull();
    expect(parseGrf(GRF.replace('\r\n1\r\n0\r\n0\r\n0\r\n0\r\n1', '\r\n5\r\n0\r\n0\r\n0\r\n0\r\n1'))).toBeNull();
    expect(parseGrf(['1 2', '2', '3', '1', '1', '1', '0', '0', '0', '0', '1'].join('\n'))).toBeNull();
  });
  it('pairs files by name without extension', () => {
    expect(pairKey('Разрез 6-61.JPG')).toBe(pairKey('разрез 6-61.grf'));
    expect(isImageName('a.jpeg') && isImageName('a.PNG') && !isImageName('a.tif') && !isImageName('a.grf')).toBe(true);
  });
});

describe('image size from the file header', () => {
  it('reads PNG', () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, 5412); new DataView(b.buffer).setUint32(20, 7290);
    expect(imageSize(b)).toEqual({ width: 5412, height: 7290 });
  });
  it('reads JPEG past an APP segment', () => {
    const b = new Uint8Array(40);
    b.set([0xff, 0xd8, 0xff, 0xe0, 0, 6, 1, 2, 3, 4, 0xff, 0xc4, 0, 4, 9, 9, 0xff, 0xc2, 0, 17, 8]);
    new DataView(b.buffer).setUint16(21, 3244); new DataView(b.buffer).setUint16(23, 2237);
    expect(imageSize(b)).toEqual({ width: 2237, height: 3244 });
  });
  it('returns null for anything else', () => {
    expect(imageSize(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]))).toBeNull();
  });
});
