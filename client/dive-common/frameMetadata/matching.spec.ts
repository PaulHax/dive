/// <reference types="vitest" />

import {
  detectRowTime,
  extractCounter,
  matchFramesToRows,
  selectCounterColumn,
} from './matching';

type Row = Record<string, string>;

function rows(...records: Row[]): Row[] {
  return records;
}

describe('extractCounter', () => {
  it('reads the trailing decimal run of a stem', () => {
    expect(extractCounter('cam_00173')).toBe(173);
    expect(extractCounter('20181101.155406.00082')).toBe(82);
    expect(extractCounter('img001')).toBe(1);
    expect(extractCounter('img12_34')).toBe(34);
    expect(extractCounter('00042')).toBe(42);
  });

  it('returns undefined when a stem has no trailing digits', () => {
    expect(extractCounter('frame')).toBeUndefined();
    expect(extractCounter('SLC')).toBeUndefined();
    expect(extractCounter('')).toBeUndefined();
  });

  it('drops a digit run past the safe-integer range (hash tails)', () => {
    expect(extractCounter('h_1234567890123456789012')).toBeUndefined();
  });
});

describe('selectCounterColumn', () => {
  it('picks the integer column matching the most distinct frames', () => {
    const counterIndex = new Map<number, string>([[173, 'a'], [174, 'b'], [175, 'c']]);
    const hit = selectCounterColumn(
      ['frame_count', 'pass'],
      rows(
        { frame_count: '173', pass: '1' },
        { frame_count: '174', pass: '1' },
        { frame_count: '175', pass: '1' },
      ),
      counterIndex,
    );

    expect(hit).not.toBeNull();
    // Distinct-count scoring: frame_count hits 3 distinct frames, the constant `pass` hits 1 and
    // falls below the threshold, so it can never win.
    expect(hit?.column).toBe('frame_count');
    expect(hit?.matched).toEqual(new Map([['a', 0], ['b', 1], ['c', 2]]));
  });

  it('never treats a decimal column as a counter', () => {
    const counterIndex = new Map<number, string>([[145, 'a'], [146, 'b']]);
    // Column of ADC-style decimals named `date` -- the classic landmine: value-scored, so it is
    // not a counter (nor, elsewhere, a timestamp).
    const hit = selectCounterColumn(
      ['date', 'lat'],
      rows({ date: '145.00', lat: '-124.60' }, { date: '146.00', lat: '46.57' }),
      counterIndex,
    );

    expect(hit).toBeNull();
  });

  it('requires min(2, rows) distinct matches for multi-row sources', () => {
    const counterIndex = new Map<number, string>([[900, 'x']]);
    // Five rows all resolve to the single frame 900 -> 1 distinct < threshold 2.
    const hit = selectCounterColumn(
      ['frame_count'],
      rows(...Array.from({ length: 5 }, () => ({ frame_count: '900' }))),
      counterIndex,
    );

    expect(hit).toBeNull();
  });

  it('accepts a single distinct match for a single-row source', () => {
    const counterIndex = new Map<number, string>([[900, 'x']]);
    const hit = selectCounterColumn(['frame_count'], rows({ frame_count: '900' }), counterIndex);

    expect(hit?.column).toBe('frame_count');
    expect(hit?.matched).toEqual(new Map([['x', 0]]));
  });

  it('breaks a score tie toward the leftmost column', () => {
    const counterIndex = new Map<number, string>([[10, 'a'], [20, 'b'], [30, 'c']]);
    const hit = selectCounterColumn(
      ['frame_count', 'mirror'],
      rows(
        { frame_count: '10', mirror: '10' },
        { frame_count: '20', mirror: '20' },
        { frame_count: '30', mirror: '30' },
      ),
      counterIndex,
    );

    expect(hit?.column).toBe('frame_count');
  });

  it('keeps the first row when two rows resolve to the same frame', () => {
    const counterIndex = new Map<number, string>([[5, 'a'], [6, 'b']]);
    const hit = selectCounterColumn(
      ['count'],
      rows({ count: '5' }, { count: '5' }, { count: '6' }),
      counterIndex,
    );

    expect(hit?.matched).toEqual(new Map([['a', 0], ['b', 2]]));
  });

  it('leaves other-site rows unmatched (honest partial coverage)', () => {
    const counterIndex = new Map<number, string>([[173, 'a'], [174, 'b']]);
    const hit = selectCounterColumn(
      ['frame_count'],
      rows({ frame_count: '173' }, { frame_count: '174' }, { frame_count: '900' }),
      counterIndex,
    );

    // Only the two in-range counters land; the disjoint 900 row is simply absent.
    expect(hit?.matched).toEqual(new Map([['a', 0], ['b', 1]]));
  });
});

describe('detectRowTime', () => {
  it('detects separate date + time columns (naive UTC)', () => {
    const detected = detectRowTime(
      ['date', 'time', 'depth'],
      rows(
        { date: '2018/11/01', time: '15:54:06.5217', depth: '88.4' },
        { date: '2018/11/01', time: '15:54:14.27', depth: '88.7' },
      ),
    );

    expect(detected?.columns).toEqual(['date', 'time']);
    expect(detected?.secondsByRow[0]).toBeCloseTo(1541087646.5217, 4);
    expect(detected?.secondsByRow[1]).toBeCloseTo(1541087654.27, 4);
  });

  it('detects a combined ISO 8601 column, offset honored', () => {
    const detected = detectRowTime(
      ['timestamp', 'depth'],
      rows(
        { timestamp: '2024-06-01T12:30:00Z', depth: '1' },
        { timestamp: '2024-06-01T12:30:00+05:00', depth: '2' },
      ),
    );

    expect(detected?.columns).toEqual(['timestamp']);
    expect(detected?.secondsByRow[0]).toBe(1717245000);
    expect(detected?.secondsByRow[1]).toBe(1717227000);
  });

  it('detects a combined space-separated column with a numeric offset', () => {
    const detected = detectRowTime(
      ['utc_time', 'depth'],
      rows(
        { utc_time: '2024-07-08 20:37:46 +0000', depth: '1' },
        { utc_time: '2024-07-08 12:00:00 -0800', depth: '2' },
      ),
    );

    expect(detected?.columns).toEqual(['utc_time']);
    expect(detected?.secondsByRow[0]).toBe(1720471066);
    expect(detected?.secondsByRow[1]).toBe(1720468800);
  });

  it('ignores a numeric column named "date" (ADC values), never Date.parse', () => {
    const detected = detectRowTime(
      ['date', 'lat'],
      rows({ date: '145.00', lat: '4407.123' }, { date: '146.30', lat: '4407.550' }),
    );

    expect(detected).toBeNull();
  });

  it('rejects a bare epoch and a time-of-day-only column', () => {
    expect(detectRowTime(['ts'], rows({ ts: '1719843225' }, { ts: '1719843230' }))).toBeNull();
    // A time column with no date column cannot form the date+time format.
    expect(detectRowTime(['time'], rows({ time: '15:54:06' }, { time: '15:54:14' }))).toBeNull();
  });

  it('rejects a space-separated cell without an offset', () => {
    const detected = detectRowTime(
      ['ts', 'x'],
      rows({ ts: '2024-07-08 20:37:46', x: '1' }, { ts: '2024-07-08 20:37:50', x: '2' }),
    );

    expect(detected).toBeNull();
  });

  it('does not roll a calendar-invalid date silently into the next month', () => {
    const detected = detectRowTime(
      ['ts', 'x'],
      rows({ ts: '2024-02-30T00:00:00Z', x: '1' }, { ts: '2024-06-01T12:30:00Z', x: '2' }),
    );

    // The column is still detected by shape, but Feb 30 must not parse to a (wrong) March 1 instant.
    expect(detected?.secondsByRow[0]).toBeUndefined();
    expect(detected?.secondsByRow[1]).toBe(1717245000);
  });

  it('requires min(2, rows) parsing cells for a multi-row source', () => {
    const detected = detectRowTime(
      ['ts', 'x'],
      rows({ ts: '2024-06-01T12:30:00Z', x: '1' }, { ts: 'n/a', x: '2' }, { ts: 'n/a', x: '3' }),
    );

    expect(detected).toBeNull();
  });
});

describe('matchFramesToRows', () => {
  const frameTimes = (entries: [string, number][]) => new Map(entries);

  it('gives each frame its nearest sample when telemetry is denser than frames', () => {
    const rowSeconds = Array.from({ length: 11 }, (_, i) => i); // t = 0..10, gap 1 -> tol 0.5
    const matched = matchFramesToRows(
      frameTimes([['FA', 0.4], ['FB', 4.6], ['FC', 8.5]]),
      rowSeconds,
    );

    // FC is an exact 0.5/0.5 tie at the inclusive boundary -> earlier row (t=8).
    expect(matched).toEqual(new Map([['FA', 0], ['FB', 5], ['FC', 8]]));
  });

  it('covers dense frames from sparse telemetry, leaving out-of-range frames blank', () => {
    const matched = matchFramesToRows(
      frameTimes([['a', 0], ['b', 3], ['c', 5], ['d', 7], ['e', 12], ['f', 30]]),
      [0, 10, 20], // gaps 10,10 -> median 10 -> tol 5
    );

    expect(matched.get('a')).toBe(0);
    expect(matched.get('b')).toBe(0);
    expect(matched.get('c')).toBe(0); // midpoint tie -> earlier row
    expect(matched.get('d')).toBe(1);
    expect(matched.get('e')).toBe(1);
    expect(matched.has('f')).toBe(false); // 10 > tol 5
  });

  it('leaves a frame inside a telemetry gap blank', () => {
    const matched = matchFramesToRows(
      frameTimes([['x', 6], ['y', 0.3], ['z', 10.2]]),
      [0, 1, 2, 10, 11, 12], // gaps 1,1,8,1,1 -> median 1 -> tol 0.5
    );

    expect(matched.has('x')).toBe(false); // nearest bracket is 4s away
    expect(matched.get('y')).toBe(0);
    expect(matched.get('z')).toBe(3);
  });

  it('breaks an exact-distance tie toward the earlier row', () => {
    const matched = matchFramesToRows(
      frameTimes([['a', 15], ['b', 15.0001], ['c', 14.9999]]),
      [10, 20], // tol 5
    );

    expect(matched.get('a')).toBe(0);
    expect(matched.get('b')).toBe(1);
    expect(matched.get('c')).toBe(0);
  });

  it('uses exact-time matching when there is a single distinct row time', () => {
    // tolerance 0: a row may still serve several frames whose time equals it exactly.
    const matched = matchFramesToRows(
      frameTimes([['a', 30], ['b', 30], ['c', 31]]),
      [30, 30, 30],
    );

    expect(matched).toEqual(new Map([['a', 0], ['b', 0]])); // earliest representative row 0
  });

  it('ignores frames with no known time', () => {
    // Partial frame times: the timeless frame never appears (never force-matched).
    const matched = matchFramesToRows(frameTimes([['F0', 0.1], ['F2', 10.1]]), [0, 5, 10]);

    expect(matched).toEqual(new Map([['F0', 0], ['F2', 2]]));
  });

  it('returns nothing when no rows carry a time', () => {
    expect(matchFramesToRows(frameTimes([['a', 1]]), [undefined, undefined])).toEqual(new Map());
  });
});
