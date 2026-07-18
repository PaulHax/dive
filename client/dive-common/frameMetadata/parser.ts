import { basicImageFileExtensions, largeImageFileExtensions } from 'dive-common/constants';
import { parseDelimitedRows } from './csvTokenizer';
import type { DelimitedTableDelimiter } from './csvTokenizer';
import {
  detectRowTime,
  matchFramesToRows,
  selectCounterColumn,
} from './matching';
import type { FrameRowMatch } from './matching';

// Shared by the desktop backend and the web client. Keep this node-free so the same parser runs
// in Electron and in the browser renderer.

type FrameMetadataRow = Record<string, string>;
type FrameAlignmentEntries = Map<string, number> | Record<string, number>;

interface ParsedFrameMetadata {
  sourceName?: string;
  // Payload column names in file order; the resolver relies on this to avoid JS object-key
  // reordering for numeric-named headers.
  columns: string[];
  records: Record<string, FrameMetadataRow>;
}

// Parser call sites share this shape so join scoring works from one normalized frame-alignment
// vocabulary instead of mixing raw filenames with normalized values.
interface FrameAlignmentIndex {
  alignmentKeys: Set<string>;
  frameByAlignmentKey: Map<string, number>;
  // Fallback join inputs, attached only on the production media-name path
  // (resolve.buildFrameAlignmentIndex) and absent on the raw-entry convenience path. Their absence
  // is what keeps the counter and timestamp tiers dormant for the existing parser corpus.
  //
  // Tier 2: a frame stem's trailing counter -> that frame's alignment key.
  alignmentKeyByCounter?: Map<number, string>;
  // Tier 3: alignment key -> frame capture time (epoch seconds); timeless frames are absent.
  secondsByAlignmentKey?: Map<string, number>;
}

// Mirror of the server's allValidLargeImageFormats (validImageFormats + validLargeImageFormats):
// the extensions normalizeAlignmentKey strips so a filename cell matches its alignment key.
const imageExtensions = new Set<string>([
  ...basicImageFileExtensions,
  ...largeImageFileExtensions,
]);

// Split a basename into (stem, lowercased extension). Mirrors node path.extname semantics: a
// leading dot is not an extension (so '.gitignore' has no extension), matching how the server
// strips one image extension from an alignment key.
function splitExtension(basename: string): { stem: string; extension: string } {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) {
    return { stem: basename, extension: '' };
  }
  return { stem: basename.slice(0, dot), extension: basename.slice(dot + 1).toLowerCase() };
}

function normalizeAlignmentKey(value: string): string {
  // Split on both separators so Windows-style path cells (images\IMG.png) normalize the same way
  // they would on a posix build. Strip exactly one image extension so a filename cell matches its
  // alignment key.
  const basename = String(value).trim().split(/[\\/]/).pop() ?? '';
  const { stem, extension } = splitExtension(basename);
  return imageExtensions.has(extension) ? stem : basename;
}

// The shared normalization/collision rule for resolver-built indexes and raw alignment maps.
export function frameAlignmentIndexFromEntries(
  entries: Iterable<[string, number]>,
): FrameAlignmentIndex {
  const alignmentKeys = new Set<string>();
  const frameByAlignmentKey = new Map<string, number>();
  Array.from(entries).forEach(([name, frame]) => {
    const key = normalizeAlignmentKey(name);
    alignmentKeys.add(key);
    frameByAlignmentKey.set(key, frame);
  });
  return { alignmentKeys, frameByAlignmentKey };
}

function normalizeFrameAlignmentEntries(
  frameAlignmentEntries: FrameAlignmentEntries,
): FrameAlignmentIndex {
  return frameAlignmentIndexFromEntries(
    frameAlignmentEntries instanceof Map
      ? frameAlignmentEntries
      : Object.entries(frameAlignmentEntries),
  );
}

function isFrameAlignmentIndex(
  value: FrameAlignmentIndex | FrameAlignmentEntries,
): value is FrameAlignmentIndex {
  return !(value instanceof Map) && (value as FrameAlignmentIndex).alignmentKeys instanceof Set;
}

function dropLeadingCommentRows(rawRows: string[][]): string[][] {
  let index = 0;
  while (index < rawRows.length && rawRows[index].length > 0 && rawRows[index][0].startsWith('#')) {
    index += 1;
  }
  return rawRows.slice(index);
}

function nullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null);
}

function buildTable(
  headerCells: string[],
  dataRows: string[][],
): { header: string[]; rows: FrameMetadataRow[] } {
  const rawHeader = headerCells.map((cell) => cell.trim());
  // Empty header cells usually come from pandas indexes or trailing commas.
  const keptIndices = rawHeader.reduce<number[]>((indices, cell, index) => {
    if (cell.length > 0) {
      indices.push(index);
    }
    return indices;
  }, []);
  if (keptIndices.length === 0) {
    return { header: [], rows: [] };
  }
  const header = keptIndices.map((index) => rawHeader[index]);

  const rows: FrameMetadataRow[] = [];
  dataRows.forEach((rawRow) => {
    const values = rawRow.map((cell) => cell.trim());
    if (!values.some((cell) => cell.length > 0)) {
      return;
    }
    const row = nullPrototypeRecord<string>();
    keptIndices.forEach((index, position) => {
      row[header[position]] = values[index] || '';
    });
    rows.push(row);
  });
  return { header, rows };
}

// Sidecars may include multiple image columns; score by alignment-key matches so each camera can use
// its own column while ties remain stable in file order.
function selectJoinColumn(
  header: string[],
  rows: FrameMetadataRow[],
  alignmentKeys: Set<string>,
): { joinColumn: string | null; candidates: string[] } {
  const threshold = Math.min(2, rows.length);
  const scores = header.map((column) => ({
    column,
    score: rows.reduce((total, row) => (
      row[column] && alignmentKeys.has(normalizeAlignmentKey(row[column])) ? total + 1 : total
    ), 0),
  }));
  const candidates = scores.filter(({ score }) => score >= threshold && score > 0);
  if (candidates.length === 0) {
    return { joinColumn: null, candidates: [] };
  }
  const joinColumn = candidates.reduce((best, candidate) => (
    candidate.score > best.score ? candidate : best
  )).column;
  return { joinColumn, candidates: candidates.map(({ column }) => column) };
}

function selectHeaderAndRows(rawRows: string[][]): { header: string[]; rows: FrameMetadataRow[] } {
  const body = dropLeadingCommentRows(rawRows);
  if (body.length === 0) {
    return { header: [], rows: [] };
  }
  return buildTable(body[0], body.slice(1));
}

function projectRecord(row: FrameMetadataRow, fields: string[]): FrameMetadataRow {
  const record = nullPrototypeRecord<string>();
  fields.forEach((field) => {
    record[field] = row[field] || '';
  });
  return record;
}

// Tier 1: filename-column join. A row's join-column cell normalizes to an alignment key; the record
// is emitted under that key. Primary for image sequences and unchanged from the original behavior.
function matchByFilename(
  header: string[],
  rows: FrameMetadataRow[],
  alignmentKeys: Set<string>,
  sourceName?: string,
): ParsedFrameMetadata | null {
  const { joinColumn, candidates: joinCandidates } = selectJoinColumn(header, rows, alignmentKeys);
  if (joinColumn === null) {
    return null;
  }

  const payloadColumns = header.filter((column) => !joinCandidates.includes(column));
  if (payloadColumns.length === 0) {
    return null;
  }

  const otherJoinCandidates = new Set(joinCandidates.filter((column) => column !== joinColumn));
  const recordFields = header.filter((column) => !otherJoinCandidates.has(column));

  const records = nullPrototypeRecord<FrameMetadataRow>();
  rows.forEach((row) => {
    const key = normalizeAlignmentKey(row[joinColumn] || '');
    if (alignmentKeys.has(key) && !(key in records)) {
      records[key] = projectRecord(row, recordFields);
    }
  });

  if (Object.keys(records).length === 0) {
    return null;
  }

  return { sourceName, columns: recordFields, records };
}

// Emit records keyed by the matched frame's alignment key, so the resolver's key -> frame mapping
// and column-merge logic are untouched. The counter/timestamp tiers keep every column as payload:
// an integer or timestamp column is ordinary data, not a redundant multi-camera join key the way a
// second image-filename column is, so nothing is dropped.
function recordsFromMatch(
  matched: FrameRowMatch<string>,
  rows: FrameMetadataRow[],
  recordFields: string[],
): Record<string, FrameMetadataRow> {
  const records = nullPrototypeRecord<FrameMetadataRow>();
  matched.forEach((rowIndex, key) => {
    records[key] = projectRecord(rows[rowIndex], recordFields);
  });
  return records;
}

// Tier 2: counter / frame-index join. The best-scoring integer column (by distinct matched frames)
// binds rows to frames; every column stays payload. Requires a column beyond the matched counter so
// a bare counter list has something to show -- the same payload guard tier 1 uses.
function matchByCounter(
  header: string[],
  rows: FrameMetadataRow[],
  alignmentKeyByCounter: Map<number, string>,
  sourceName?: string,
): ParsedFrameMetadata | null {
  const hit = selectCounterColumn(header, rows, alignmentKeyByCounter);
  if (hit === null) {
    return null;
  }
  if (header.every((column) => column === hit.column)) {
    return null;
  }
  // hit is non-null only when it matched >= 1 distinct frame, so records is always non-empty here.
  return { sourceName, columns: header, records: recordsFromMatch(hit.matched, rows, header) };
}

// Tier 3: timestamp join. Detect a row-time column, place each frame on its nearest row within
// tolerance, and require a column beyond the detected time column(s). Loud-failure (decision 5): a
// detected time column that matches fewer than min(2, rows) distinct frames resolves to nothing
// rather than degrading -- timestamp is the terminal tier before null, so a systematic clock offset
// has no lower join to silently fall through into.
function matchByTimestamp(
  header: string[],
  rows: FrameMetadataRow[],
  secondsByAlignmentKey: Map<string, number>,
  sourceName?: string,
): ParsedFrameMetadata | null {
  const detected = detectRowTime(header, rows);
  if (detected === null) {
    return null;
  }
  if (header.every((column) => detected.columns.includes(column))) {
    return null;
  }
  const matched = matchFramesToRows(secondsByAlignmentKey, detected.secondsByRow);
  if (matched.size < Math.min(2, rows.length)) {
    return null;
  }
  // The threshold above guarantees >= 1 matched frame, so records is always non-empty here.
  return { sourceName, columns: header, records: recordsFromMatch(matched, rows, header) };
}

function parseFrameMetadataSource(
  text: string,
  alignmentIndex: FrameAlignmentIndex | FrameAlignmentEntries,
  sourceName?: string,
): ParsedFrameMetadata | null {
  const index = isFrameAlignmentIndex(alignmentIndex)
    ? alignmentIndex
    : normalizeFrameAlignmentEntries(alignmentIndex);

  if (text.includes('\0')) {
    return null;
  }
  const content = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const rawRows = readRows(content);
  if (rawRows.length === 0) {
    return null;
  }

  const { header, rows } = selectHeaderAndRows(rawRows);
  if (header.length === 0 || rows.length === 0) {
    return null;
  }

  // Cascade: filename join (primary) -> counter join -> timestamp join -> null. Each tier is an
  // evidence-based value join; the first that matches wins. The counter and timestamp tiers fire
  // only when the resolver supplied their maps (the production media-name path), so the raw-entry
  // corpus keeps ending at null exactly as before.
  const filenameMatch = matchByFilename(header, rows, index.alignmentKeys, sourceName);
  if (filenameMatch !== null) {
    return filenameMatch;
  }

  const counterMatch = index.alignmentKeyByCounter !== undefined
    ? matchByCounter(header, rows, index.alignmentKeyByCounter, sourceName)
    : null;
  if (counterMatch !== null) {
    return counterMatch;
  }

  const timestampMatch = index.secondsByAlignmentKey !== undefined
    ? matchByTimestamp(header, rows, index.secondsByAlignmentKey, sourceName)
    : null;
  if (timestampMatch !== null) {
    return timestampMatch;
  }

  return null;
}

function readRows(text: string): string[][] {
  const sniff = sniffLine(text);
  if (sniff === null) {
    return [];
  }

  const delimiter = sniffDelimiter(sniff);
  if (delimiter === null) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/));
  }

  try {
    // Drop delimiter-only rows before header selection; otherwise `,,,` becomes the header.
    return parseDelimitedRows(text, delimiter).filter((row) => row.some((cell) => cell.length > 0));
  } catch {
    // NUL bytes, oversized fields, etc. are treated as "not a frame metadata source" instead of
    // surfacing a parse error.
    return [];
  }
}

// Ignore leading prose comments while sniffing so commas inside prose do not override TSV data.
function sniffLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => !line.startsWith('#')) ?? lines[0] ?? null;
}

function sniffDelimiter(line: string): DelimitedTableDelimiter | null {
  // Count-based so a tab-delimited header whose field names contain commas
  // (e.g. a parenthesized unit like "Position (lat, lon)") still sniffs as TSV.
  const commas = line.split(',').length - 1;
  const tabs = line.split('\t').length - 1;
  if (tabs > commas) {
    return '\t';
  }
  if (commas > 0) {
    return ',';
  }
  return null;
}

export {
  FrameMetadataRow,
  FrameAlignmentIndex,
  FrameAlignmentEntries,
  ParsedFrameMetadata,
  normalizeAlignmentKey,
  parseFrameMetadataSource,
};
