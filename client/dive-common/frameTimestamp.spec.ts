import type { FrameImage } from 'dive-common/apispec';
import { attachFrameTimestamps, parseFrameTimestamp } from 'dive-common/frameTimestamp';

describe('parseFrameTimestamp', () => {
  it('parses a YYYYMMDD_HHMMSS datestamp', () => {
    expect(parseFrameTimestamp('left_20230615_143022.png')).toBe(1686839422);
  });

  it('parses a real flight filename with microsecond precision', () => {
    // Confirmed convention from real sample data (data/test_data).
    expect(parseFrameTimestamp('calibration_fl02_C_20240407_130757.206341_ir.tif'))
      .toBeCloseTo(1712495277.206341, 6);
  });

  it('parses a datestamp with a fractional-second suffix', () => {
    expect(parseFrameTimestamp('left_20230615_143022.500.png')).toBe(1686839422.5);
  });

  it('parses a bare epoch-milliseconds filename', () => {
    expect(parseFrameTimestamp('img_1719843225123.tif')).toBeCloseTo(1719843225.123, 6);
  });

  it('parses a bare epoch-seconds filename', () => {
    expect(parseFrameTimestamp('img_1719843225.tif')).toBe(1719843225);
  });

  it('returns undefined for a plain sequential filename', () => {
    expect(parseFrameTimestamp('img_00001.png')).toBeUndefined();
  });

  it('returns undefined for a short frame-counter filename', () => {
    expect(parseFrameTimestamp('frame042.tif')).toBeUndefined();
  });

  it('returns undefined for an implausible-range digit run', () => {
    expect(parseFrameTimestamp('img_0000000001.png')).toBeUndefined();
  });

  it('rejects an impossible calendar date instead of rolling it forward', () => {
    // Jun 31 and Feb 30 do not exist; Date.UTC would silently roll them into the
    // next month, so the round-trip guard must reject them (never a wrong instant).
    expect(parseFrameTimestamp('cam_20250631_120000.jpg')).toBeUndefined();
    expect(parseFrameTimestamp('cam_20250230_120000.jpg')).toBeUndefined();
    // The last valid day of each still parses.
    expect(parseFrameTimestamp('cam_20250630_120000.jpg')).toBe(Date.UTC(2025, 5, 30, 12, 0, 0) / 1000);
  });

  it('is extension-agnostic (same stem, different extension)', () => {
    expect(parseFrameTimestamp('left_20230615_143022.tif'))
      .toBe(parseFrameTimestamp('left_20230615_143022.png'));
  });
});

describe('parseFrameTimestamp -- dot-separated nav convention', () => {
  it('parses YYYYMMDD.HHMMSS.<counter> to the integer-second instant', () => {
    // 2018-11-01 15:54:06 UTC; the ".00082" is a frame counter, NOT fractional seconds.
    expect(parseFrameTimestamp('20181101.155406.00082.jpg')).toBe(1541087646);
  });

  it('ignores the counter value (same instant, different counter)', () => {
    expect(parseFrameTimestamp('20181101.155406.00001.jpg')).toBe(1541087646);
  });

  it('does not read the counter as fractional seconds', () => {
    // A frac-consuming parse would yield 1541087646.00082; assert the exact integer instead.
    expect(parseFrameTimestamp('20181101.155406.00082.jpg')).not.toBeCloseTo(1541087646.00082, 6);
  });

  it('tolerates a camera/prefix segment before the datestamp', () => {
    expect(parseFrameTimestamp('port_20181101.155406.00082.jpg')).toBe(1541087646);
  });

  it('parses an end-of-day time with a wide counter', () => {
    // 2020-06-30 23:59:59 UTC.
    expect(parseFrameTimestamp('dive_20200630.235959.99999.png')).toBe(1593561599);
  });

  it('is not fooled by a 10-digit counter (beats the epoch fallback)', () => {
    expect(parseFrameTimestamp('20181101.155406.1234567890.jpg')).toBe(1541087646);
  });

  it('leaves a two-part YYYYMMDD.HHMMSS (no counter) unmatched', () => {
    expect(parseFrameTimestamp('20181101.155406.jpg')).toBeUndefined();
  });

  it('leaves a date-only stem unmatched (no midnight anchor)', () => {
    // No time-of-day; the counter tier -- not parseFrameTimestamp -- serves this data.
    expect(parseFrameTimestamp('cam1_20240708_seq00173.jpg')).toBeUndefined();
  });

  it('rejects an out-of-range time via the shared plausibility guard', () => {
    // hour 25 -> dateStampToSeconds returns undefined; no epoch fallback matches.
    expect(parseFrameTimestamp('20181101.256080.00082.jpg')).toBeUndefined();
  });
});

describe('attachFrameTimestamps', () => {
  it('populates timestamp in place from each frame filename', () => {
    const frames: FrameImage[] = [
      { url: 'a', filename: 'left_20230615_143022.png' },
      { url: 'b', filename: 'img_00001.png' },
    ];
    attachFrameTimestamps(frames);
    expect(frames[0].timestamp).toBe(1686839422);
    expect(frames[1].timestamp).toBeUndefined();
  });
});
