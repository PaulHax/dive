/// <reference types="vitest" />
import {
  isFrameMetadataCsv, isFrameMetadataJson, loadCsv, loadJson, toCanonical,
} from 'platform/desktop/backend/serializers/frameMetadata';

const FRAME_KEYED_CSV = [
  'frame,latitude,longitude,depth_m,substrate',
  '0,36.61,-121.90,102.5,sand',
  '1,36.62,-121.91,103.1,sand',
  '3,36.63,-121.92,104.0,rock',
].join('\n');

const FILENAME_KEYED_CSV = [
  'filename,depth_m,altitude_m',
  'DSC_0001.jpg,12.5,2.1',
  'DSC_0002.jpg,13.0,2.0',
  'DSC_0099.jpg,99.0,9.9',
].join('\n');

const IMAGE_MAP = new Map<string, number>([
  ['DSC_0001', 0],
  ['DSC_0002', 1],
  ['DSC_0003', 2],
]);

const VIAME_CSV = [
  '# comment line',
  '0,1.png,0,884,510,1219,737,0.9,-1,typestring,0.55',
].join('\n');

describe('frameMetadata CSV sniffing', () => {
  it('recognizes frame- and filename-keyed tables', () => {
    expect(isFrameMetadataCsv(FRAME_KEYED_CSV)).toBe(true);
    expect(isFrameMetadataCsv(FILENAME_KEYED_CSV)).toBe(true);
  });
  it('rejects VIAME annotation CSV and headerless tables', () => {
    expect(isFrameMetadataCsv(VIAME_CSV)).toBe(false);
    expect(isFrameMetadataCsv('a,b,c\n1,2,3')).toBe(false);
    expect(isFrameMetadataCsv('')).toBe(false);
  });
});

describe('frameMetadata CSV parsing', () => {
  it('parses a frame-keyed table and infers field types', () => {
    const { values, fields, warnings } = loadCsv(FRAME_KEYED_CSV);
    expect(warnings).toEqual([]);
    expect(Object.keys(values).map(Number).sort()).toEqual([0, 1, 3]);
    expect(values[0]).toEqual({
      latitude: 36.61, longitude: -121.9, depth_m: 102.5, substrate: 'sand',
    });
    expect(fields.depth_m).toEqual({ name: 'depth_m', datatype: 'number' });
    expect(fields.substrate).toEqual({ name: 'substrate', datatype: 'text' });
    expect(fields.frame).toBeUndefined();
  });

  it('resolves filename keys through the image map and warns on unknown images', () => {
    const { values, fields, warnings } = loadCsv(FILENAME_KEYED_CSV, IMAGE_MAP);
    expect(Object.keys(values).map(Number).sort()).toEqual([0, 1]);
    expect(values[1]).toEqual({ depth_m: 13.0, altitude_m: 2.0 });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('DSC_0099');
    expect(fields.altitude_m.datatype).toBe('number');
  });

  it('throws when a filename-keyed table has no image map', () => {
    expect(() => loadCsv(FILENAME_KEYED_CSV)).toThrow();
  });

  it('falls back to text when a field has mixed value types', () => {
    const { values, fields } = loadCsv('frame,flag\n0,true\n1,not-a-bool');
    expect(values[0].flag).toBe(true);
    expect(fields.flag.datatype).toBe('text');
  });
});

describe('frameMetadata JSON parsing', () => {
  it('parses a frame-keyed object and merges provided field defs', () => {
    const data = {
      frameMetadata: { 0: { depth_m: 10.0 }, 1: { depth_m: 11.0 } },
      frameMetadataFields: { depth_m: { name: 'depth_m', datatype: 'number', unit: 'm' } },
    };
    expect(isFrameMetadataJson(data)).toBe(true);
    const { values, fields, warnings } = loadJson(data);
    expect(warnings).toEqual([]);
    expect(values).toEqual({ 0: { depth_m: 10.0 }, 1: { depth_m: 11.0 } });
    expect(fields.depth_m.unit).toBe('m');
  });

  it('resolves filename keys through the image map', () => {
    const data = { frameMetadata: { 'DSC_0002.jpg': { depth_m: 13.0 } } };
    const { values, warnings } = loadJson(data, IMAGE_MAP);
    expect(values).toEqual({ 1: { depth_m: 13.0 } });
    expect(warnings).toEqual([]);
  });

  it('rejects other json shapes', () => {
    expect(isFrameMetadataJson({ tracks: {} })).toBe(false);
    expect(isFrameMetadataJson({ frameMetadata: 'oops' })).toBe(false);
    expect(isFrameMetadataJson([1, 2])).toBe(false);
  });
});

describe('frameMetadata canonical form', () => {
  it('produces a versioned, string-keyed, sorted document', () => {
    const { values, fields } = loadCsv(FRAME_KEYED_CSV);
    const canonical = toCanonical(values, fields);
    expect(canonical.version).toBe(1);
    expect(Object.keys(canonical.values)).toEqual(['0', '1', '3']);
    // survives a JSON round trip unchanged
    expect(JSON.parse(JSON.stringify(canonical))).toEqual(canonical);
  });
});
