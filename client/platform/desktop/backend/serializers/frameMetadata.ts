/**
 * Per-frame metadata parser/serializer, mirrors
 * dive_utils.serializers.frame_metadata python module.
 *
 * Per-frame metadata associates arbitrary key/value data (timestamp,
 * lat/long, depth, sensor readings, ...) with each frame or image of a
 * dataset, independent of any annotations on that frame.
 *
 * Two interchange formats are recognized on import:
 *  - CSV with a header row containing a key column named one of
 *    `frame`/`frame_index`/`frame_id` or `filename`/`file_name`/`image`/`image_name`.
 *  - JSON with a top-level `frameMetadata` object mapping frame numbers or
 *    file names to `{ field: value }` records.
 *
 * The canonical form (served to the client, same shape as the web platform):
 *   { version, fields: { name: { name, datatype, unit?, pinned? } },
 *     values: { "<frame>": { field: value } } }
 */

import parseSync from 'csv-parse/lib/sync';

import { FrameMetadata, FrameMetadataField } from 'dive-common/apispec';
import { splitExt } from 'platform/desktop/backend/native/utils';

const FrameKeyColumns = ['frame', 'frame_index', 'frame_id'];
const FilenameKeyColumns = ['filename', 'file_name', 'image', 'image_name'];
const IdentityColumns = [...FrameKeyColumns, ...FilenameKeyColumns];

export const FrameMetadataVersion = 1;

export type FrameMetadataValues = Record<number, Record<string, unknown>>;
export type FrameMetadataFields = Record<string, FrameMetadataField>;

export interface ParsedFrameMetadata {
  values: FrameMetadataValues;
  fields: FrameMetadataFields;
  warnings: string[];
}

function deduceValue(value: string): boolean | number | string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }
  // Number() is strict (unlike parseFloat), matching python's float() coercion:
  // "123abc" stays text, while "13.0" and "-121.90" become numbers.
  const num = Number(trimmed);
  if (trimmed !== '' && !Number.isNaN(num)) {
    return num;
  }
  return value;
}

function datatypeOf(value: unknown): FrameMetadataField['datatype'] {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return 'text';
}

/** Look up a frame by image name, with or without its file extension. */
function resolveImage(imageMap: Map<string, number>, name: string): number | undefined {
  if (imageMap.has(name)) {
    return imageMap.get(name);
  }
  const [base] = splitExt(name);
  return imageMap.get(base);
}

/**
 * Build a field registry from parsed values, inferring each datatype.
 * A field is numeric/boolean only if every present value agrees, else text.
 */
export function inferFields(values: FrameMetadataValues): FrameMetadataFields {
  const seenTypes: Record<string, Set<string>> = {};
  Object.values(values).forEach((record) => {
    Object.entries(record).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        return;
      }
      if (!seenTypes[key]) {
        seenTypes[key] = new Set();
      }
      seenTypes[key].add(datatypeOf(value));
    });
  });
  const fields: FrameMetadataFields = {};
  Object.entries(seenTypes).forEach(([key, datatypes]) => {
    const datatype = datatypes.size === 1
      ? ([...datatypes][0] as FrameMetadataField['datatype'])
      : 'text';
    fields[key] = { name: key, datatype };
  });
  return fields;
}

function headerKeyColumn(header: string[]): { index: number; type: 'frame' | 'filename' } | null {
  for (let i = 0; i < header.length; i += 1) {
    const name = header[i].trim().toLowerCase();
    if (FrameKeyColumns.includes(name)) {
      return { index: i, type: 'frame' };
    }
    if (FilenameKeyColumns.includes(name)) {
      return { index: i, type: 'filename' };
    }
  }
  return null;
}

/**
 * Heuristically decide whether CSV text is a per-frame metadata table.
 * VIAME annotation CSVs have no header: data rows begin with a numeric track
 * id (comment rows begin with `#`).  A frame metadata table begins with a
 * header row that names a recognized key column.
 */
export function isFrameMetadataCsv(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) {
      // eslint-disable-next-line no-continue
      continue;
    }
    let row: string[];
    try {
      row = (parseSync(line, { relaxColumnCount: true })[0] as string[]) || [];
    } catch {
      return false;
    }
    if (row.length === 0) {
      return false;
    }
    if (/^\s*-?\d+\s*$/.test(row[0])) {
      // Leading numeric cell means a VIAME annotation row.
      return false;
    }
    return headerKeyColumn(row) !== null;
  }
  return false;
}

export function loadCsv(text: string, imageMap?: Map<string, number>): ParsedFrameMetadata {
  const warnings: string[] = [];
  const values: FrameMetadataValues = {};
  const records: string[][] = parseSync(text, {
    relaxColumnCount: true,
    skipEmptyLines: true,
    comment: '#',
  });
  if (records.length === 0) {
    throw new Error('Frame metadata CSV is empty');
  }
  const header = records[0];
  const key = headerKeyColumn(header);
  if (key === null) {
    throw new Error(
      `Frame metadata CSV must contain a key column named one of ${IdentityColumns.join(', ')}`,
    );
  }
  const fieldNames = header.map((cell) => cell.trim());
  // Exclude every identity column from data fields: a frame-keyed table may
  // also carry a redundant filename column (and vice versa).
  const keyIndices = new Set<number>();
  fieldNames.forEach((name, i) => {
    if (IdentityColumns.includes(name.toLowerCase())) {
      keyIndices.add(i);
    }
  });

  for (let r = 1; r < records.length; r += 1) {
    const row = records[r];
    if (row.length <= key.index || row[key.index].trim() === '') {
      // eslint-disable-next-line no-continue
      continue;
    }
    const keyCell = row[key.index].trim();
    let frame: number | undefined;
    if (key.type === 'frame') {
      const parsed = Number(keyCell);
      if (!Number.isFinite(parsed)) {
        warnings.push(`Skipped row with non-numeric frame "${keyCell}"`);
        // eslint-disable-next-line no-continue
        continue;
      }
      frame = Math.trunc(parsed);
    } else {
      if (imageMap === undefined) {
        throw new Error('Filename-keyed frame metadata requires an image-sequence dataset');
      }
      frame = resolveImage(imageMap, keyCell);
      if (frame === undefined) {
        warnings.push(`Skipped row for unknown image "${keyCell}"`);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    const record: Record<string, unknown> = {};
    row.forEach((cell, i) => {
      if (keyIndices.has(i) || i >= fieldNames.length || fieldNames[i] === '') {
        return;
      }
      if (cell.trim() === '') {
        return;
      }
      record[fieldNames[i]] = deduceValue(cell);
    });
    if (Object.keys(record).length) {
      values[frame] = { ...(values[frame] || {}), ...record };
    }
  }

  return { values, fields: inferFields(values), warnings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isFrameMetadataJson(data: any): boolean {
  return (
    data !== null
    && typeof data === 'object'
    && typeof data.frameMetadata === 'object'
    && data.frameMetadata !== null
    && !Array.isArray(data.frameMetadata)
  );
}

export function loadJson(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  imageMap?: Map<string, number>,
): ParsedFrameMetadata {
  const warnings: string[] = [];
  const values: FrameMetadataValues = {};
  Object.entries(data.frameMetadata as Record<string, unknown>).forEach(([key, record]) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      warnings.push(`Skipped non-object record for key "${key}"`);
      return;
    }
    let frame: number | undefined;
    if (/^\d+$/.test(key)) {
      frame = Number(key);
    } else if (imageMap !== undefined) {
      frame = resolveImage(imageMap, key);
    }
    if (frame === undefined) {
      warnings.push(`Skipped record for unresolvable key "${key}"`);
      return;
    }
    const cleaned: Record<string, unknown> = {};
    Object.entries(record as Record<string, unknown>).forEach(([k, v]) => {
      if (v !== null && v !== undefined) {
        cleaned[k] = v;
      }
    });
    if (Object.keys(cleaned).length) {
      values[frame] = { ...(values[frame] || {}), ...cleaned };
    }
  });

  const fields = inferFields(values);
  // Imported field definitions take precedence over inferred ones.
  const provided = data.frameMetadataFields;
  if (provided !== null && typeof provided === 'object') {
    Object.entries(provided as Record<string, FrameMetadataField>).forEach(([key, definition]) => {
      if (definition && typeof definition === 'object' && fields[key]) {
        fields[key] = { ...fields[key], ...definition };
      }
    });
  }
  return { values, fields, warnings };
}

export function toCanonical(values: FrameMetadataValues, fields: FrameMetadataFields): FrameMetadata {
  const stringKeyed: Record<string, Record<string, unknown>> = {};
  Object.keys(values)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((frame) => {
      stringKeyed[`${frame}`] = values[frame];
    });
  return {
    version: FrameMetadataVersion,
    fields,
    values: stringKeyed,
  };
}

export function emptyFrameMetadata(): FrameMetadata {
  return { version: FrameMetadataVersion, fields: {}, values: {} };
}
