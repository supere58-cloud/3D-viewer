import { describe, expect, it } from 'vitest';
import ru from '../src/i18n/ru.json';
import en from '../src/i18n/en.json';

describe('string resources', () => {
  it('has the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
  it('keeps placeholders in sync', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(ru) as (keyof typeof ru)[]) expect(holes(en[k]), k).toEqual(holes(ru[k]));
  });
  it('has a message for every load error and warning code', () => {
    const errors = ['binaryDxf', 'utf16Dxf', 'unsupportedFormat', 'glbCompressed', 'glbInvalid', 'notDxf', 'outOfMemory', 'readFailed', 'parseFailed', 'cancelled'];
    const warnings = ['truncated', 'noEof', 'malformedLines', 'bulgesIgnored', 'missingBlocks', 'paperSpaceSkipped', 'badFaces', 'texturesDropped', 'nonFiniteCoords', 'recursionLimit', 'farOutliers', 'solidsSkipped'];
    for (const e of errors) expect(ru, e).toHaveProperty('err.' + e);
    for (const w of warnings) expect(ru, w).toHaveProperty('warn.' + w);
  });
});
