// Counter and timestamp matchers for the frame-metadata cascade. Kept node-free (no imports) so
// the same code runs in Electron and the browser renderer, and so it stays a pure sink in the
// module graph (parser.ts -> matching.ts, with nothing imported back). The functions are generic
// over the frame key `K`: the image-sequence path instantiates `K = alignment key (string)`; a
// future video path instantiates `K = frame number` with no change here.

type MatchRow = Record<string, string>;

// A single frame's key paired with the row it claims (index into the source's data rows).
type FrameRowMatch<K> = Map<K, number>;

// -------------------------------------------------------------------------------------------------
// Counter / frame-index join (tier 2)
// -------------------------------------------------------------------------------------------------

// Trailing decimal run of a filename stem: `x_SLC00173` -> 173, `20181101.155406.00082` -> 82,
// `img001` -> 1. A stem with no trailing digits (or a run past the safe-integer range, e.g. a hash)
// has no counter and is absent from the counter index.
const TRAILING_DIGITS = /(\d+)$/;
const INTEGER_CELL = /^\d+$/;

function extractCounter(stem: string): number | undefined {
  const match = TRAILING_DIGITS.exec(stem);
  if (match === null) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

// A non-negative integer cell -> its value; anything else (decimal, signed, blank, text) -> absent.
// Leading zeros collapse to the value so a `00082` cell matches an `00082` filename counter.
function cellCounter(cell: string): number | undefined {
  if (!INTEGER_CELL.test(cell)) {
    return undefined;
  }
  const value = Number.parseInt(cell, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

// Pick the integer column that matches the most DISTINCT frames by counter, mirroring
// `selectJoinColumn` one abstraction level up (integer value vs. filename stem). Distinct-frame
// scoring keeps a constant column (`pass = 1`, one distinct frame) from outscoring a real counter
// column; the threshold `min(2, rows.length)` and strict-greater reduce (leftmost on a tie) match
// the filename join's discipline. Returns the winning column plus its first-row-wins match map.
function selectCounterColumn<K>(
  header: string[],
  rows: MatchRow[],
  counterIndex: Map<number, K>,
): { column: string; matched: FrameRowMatch<K> } | null {
  const threshold = Math.min(2, rows.length);
  let best: { column: string; matched: FrameRowMatch<K> } | null = null;
  header.forEach((column) => {
    const matched: FrameRowMatch<K> = new Map();
    rows.forEach((row, rowIndex) => {
      const counter = cellCounter(row[column] ?? '');
      if (counter === undefined) {
        return;
      }
      const key = counterIndex.get(counter);
      if (key === undefined || matched.has(key)) {
        return;
      }
      matched.set(key, rowIndex);
    });
    if (matched.size >= threshold && matched.size > 0 && (best === null || matched.size > best.matched.size)) {
      best = { column, matched };
    }
  });
  return best;
}

// -------------------------------------------------------------------------------------------------
// Row-time parser (tier 3, format detection)
// -------------------------------------------------------------------------------------------------

// Strict, range-enforcing, value-scored regexes -- never `Date.parse` (which would accept `145`,
// `4407.123`, and locale strings, misclassifying ADC and NMEA payload as time) and never header
// names (a column literally named `date` may hold ADC numbers). The three cell shapes are mutually
// exclusive, so a column qualifies for at most one format.
//
// (a) separate date + time columns; (b) combined ISO 8601 (offset optional); (c) combined
// space-separated with a required numeric offset.
const DATE_RE = /^(\d{4})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^(2[0-3]|[01]\d):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;
const ISO_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(2[0-3]|[01]\d):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:2[0-3]|[01]\d):?[0-5]\d)?$/;
const SPACE_RE = /^(\d{4})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01]) (2[0-3]|[01]\d):([0-5]\d):([0-5]\d)(?:\.(\d+))? ([+-])(2[0-3]|[01]\d):?([0-5]\d)$/;

// Wall-clock components -> epoch seconds treated as UTC, plus fractional seconds preserved as a
// float. Returns undefined for a calendar-invalid date (e.g. Feb 30): the day sub-pattern accepts
// 01-31 for every month, so a bad day would otherwise roll silently into the next month; the
// round-trip check keeps the "strict, never a wrong instant" promise. Uses Date.UTC for the
// calendar->epoch convention, matching frameTimestamp.ts:dateStampToSeconds.
function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  frac?: string,
): number | undefined {
  const millis = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(millis);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) {
    return undefined;
  }
  return millis / 1000 + (frac ? Number(`0.${frac}`) : 0);
}

// `+0000` | `-0800` | `+00:00` | `Z` | undefined -> seconds east of UTC. Naive (undefined) and `Z`
// are both zero; epoch(UTC) = wallclock-as-UTC - offset.
function offsetSeconds(token: string | undefined): number {
  if (!token || token === 'Z') {
    return 0;
  }
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  if (match === null) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60);
}

function parseIsoCell(cell: string): number | undefined {
  const match = ISO_RE.exec(cell);
  if (match === null) {
    return undefined;
  }
  const wall = wallClockToEpoch(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    match[7],
  );
  return wall === undefined ? undefined : wall - offsetSeconds(match[8]);
}

function parseSpaceCell(cell: string): number | undefined {
  const match = SPACE_RE.exec(cell);
  if (match === null) {
    return undefined;
  }
  const wall = wallClockToEpoch(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    match[7],
  );
  return wall === undefined ? undefined : wall - offsetSeconds(`${match[8]}${match[9]}${match[10]}`);
}

function parseDateTimeCells(dateCell: string, timeCell: string): number | undefined {
  const dateMatch = DATE_RE.exec(dateCell);
  const timeMatch = TIME_RE.exec(timeCell);
  if (dateMatch === null || timeMatch === null) {
    return undefined;
  }
  // Naive date+time: no offset, treated as the same clock as the filename times (documented limit).
  return wallClockToEpoch(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3]),
    timeMatch[4],
  );
}

// The best-scoring column for a single-cell format (leftmost on a tie), or null below threshold.
function bestColumn(
  header: string[],
  rows: MatchRow[],
  regex: RegExp,
  threshold: number,
): { column: string; score: number } | null {
  let best: { column: string; score: number } | null = null;
  header.forEach((column) => {
    const score = rows.reduce((total, row) => (regex.test(row[column] ?? '') ? total + 1 : total), 0);
    if (score >= threshold && score > 0 && (best === null || score > best.score)) {
      best = { column, score };
    }
  });
  return best;
}

interface RowTimeDetection {
  // The detected time column(s): [iso] | [space] | [date, time]. Kept as payload; used only to
  // guard against a source that is nothing but a timestamp.
  columns: string[];
  // Per-row epoch seconds (UTC), aligned to `rows`; undefined for a row whose cell does not parse.
  secondsByRow: (number | undefined)[];
}

// Detect which column(s) encode an absolute row time and parse every row to epoch seconds. Returns
// null when no supported format reaches `min(2, rows.length)` parsing cells. A returned detection
// means "row times parse" -- the caller's loud-failure rule keys off that.
function detectRowTime(header: string[], rows: MatchRow[]): RowTimeDetection | null {
  const threshold = Math.min(2, rows.length);

  const iso = bestColumn(header, rows, ISO_RE, threshold);
  const space = bestColumn(header, rows, SPACE_RE, threshold);
  const dateCol = bestColumn(header, rows, DATE_RE, threshold);
  const timeCol = bestColumn(header, rows, TIME_RE, threshold);

  const candidates: { format: number; score: number; columns: string[]; parse: (row: MatchRow) => number | undefined }[] = [];
  // Tie precedence encoded as `format`: iso (0) > space (1) > date-time (2).
  if (iso !== null) {
    candidates.push({
      format: 0, score: iso.score, columns: [iso.column], parse: (row) => parseIsoCell(row[iso.column] ?? ''),
    });
  }
  if (space !== null) {
    candidates.push({
      format: 1, score: space.score, columns: [space.column], parse: (row) => parseSpaceCell(row[space.column] ?? ''),
    });
  }
  if (dateCol !== null && timeCol !== null) {
    // Re-score jointly so a date column and a time column held on disjoint rows do not qualify.
    const jointScore = rows.reduce((total, row) => (
      DATE_RE.test(row[dateCol.column] ?? '') && TIME_RE.test(row[timeCol.column] ?? '') ? total + 1 : total
    ), 0);
    if (jointScore >= threshold && jointScore > 0) {
      candidates.push({
        format: 2,
        score: jointScore,
        columns: [dateCol.column, timeCol.column],
        parse: (row) => parseDateTimeCells(row[dateCol.column] ?? '', row[timeCol.column] ?? ''),
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.score - a.score || a.format - b.format);
  const winner = candidates[0];
  return { columns: winner.columns, secondsByRow: rows.map((row) => winner.parse(row)) };
}

// -------------------------------------------------------------------------------------------------
// Frame-driven nearest-row matcher (tier 3, matching)
// -------------------------------------------------------------------------------------------------

interface TimePoint {
  seconds: number;
  rowIndex: number;
}

// Between two bracketing points, the nearer to `seconds`; an exact-distance tie goes to the earlier
// row in file order (smaller rowIndex).
function nearerPoint(
  seconds: number,
  floor: TimePoint | undefined,
  ceil: TimePoint | undefined,
): TimePoint | undefined {
  if (floor === undefined) {
    return ceil;
  }
  if (ceil === undefined) {
    return floor;
  }
  const distFloor = seconds - floor.seconds;
  const distCeil = ceil.seconds - seconds;
  if (distFloor < distCeil) {
    return floor;
  }
  if (distCeil < distFloor) {
    return ceil;
  }
  return floor.rowIndex <= ceil.rowIndex ? floor : ceil;
}

function medianGap(points: TimePoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    gaps.push(points[i].seconds - points[i - 1].seconds);
  }
  // Consecutive differences of a sorted series are positive but not themselves sorted.
  gaps.sort((a, b) => a - b);
  const count = gaps.length;
  return count % 2 === 1
    ? gaps[(count - 1) / 2]
    : (gaps[count / 2 - 1] + gaps[count / 2]) / 2;
}

// Each frame claims the row closest in time, staying unmatched when its nearest row is farther than
// the tolerance. Tolerance = half the median inter-sample interval, computed over the rows collapsed
// to DISTINCT times (0 when fewer than two distinct times, giving exact-time matching). Collapsing
// first refines the design's "inter-row interval" so that a logger emitting several rows at the same
// timestamp (sub-second-tied captures) does not drag the median toward zero and shrink the tolerance
// -- the sample cadence is the distinct-time spacing, not the raw row spacing. A row may serve
// multiple frames; a frame never takes a farther row when a nearer one exists. Single sorted pass
// over both sides, in the spirit of alignedTimeline's sweep.
function matchFramesToRows<K>(
  frameTimes: Map<K, number>,
  rowSeconds: (number | undefined)[],
): FrameRowMatch<K> {
  const assignment: FrameRowMatch<K> = new Map();

  // Collapse rows to distinct times, remembering the earliest rowIndex at each (bakes in the
  // file-order tie-break and de-duplicates sub-second-tied captures).
  const earliestByTime = new Map<number, number>();
  rowSeconds.forEach((seconds, rowIndex) => {
    if (seconds === undefined) {
      return;
    }
    const current = earliestByTime.get(seconds);
    if (current === undefined || rowIndex < current) {
      earliestByTime.set(seconds, rowIndex);
    }
  });
  const points: TimePoint[] = Array.from(earliestByTime, ([seconds, rowIndex]) => ({ seconds, rowIndex }))
    .sort((a, b) => a.seconds - b.seconds);
  if (points.length === 0) {
    return assignment;
  }
  const tolerance = points.length < 2 ? 0 : medianGap(points) / 2;

  const frames = Array.from(frameTimes, ([key, seconds]) => ({ key, seconds }))
    .sort((a, b) => a.seconds - b.seconds);
  let pointer = 0;
  frames.forEach(({ key, seconds }) => {
    while (pointer < points.length && points[pointer].seconds < seconds) {
      pointer += 1;
    }
    const floor = pointer > 0 ? points[pointer - 1] : undefined;
    const ceil = pointer < points.length ? points[pointer] : undefined;
    const pick = nearerPoint(seconds, floor, ceil);
    if (pick !== undefined && Math.abs(pick.seconds - seconds) <= tolerance) {
      assignment.set(key, pick.rowIndex);
    }
  });
  return assignment;
}

export {
  extractCounter,
  selectCounterColumn,
  detectRowTime,
  matchFramesToRows,
};

// FrameRowMatch is re-used by parser.ts; MatchRow and RowTimeDetection stay module-private
// (MatchRow is a local alias for parser.ts's FrameMetadataRow, kept unexported so this module
// remains a pure sink with no import back into parser.ts).
export type {
  FrameRowMatch,
};
