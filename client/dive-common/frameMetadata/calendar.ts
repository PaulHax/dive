// Shared calendar -> epoch conversion for the frame-metadata timestamp joins. Kept as a zero-import,
// node-free leaf so both halves of the join -- the filename-time parser (dive-common/frameTimestamp)
// and the row-time parser (matching.ts) -- call one implementation of the calendar-validity rule and
// cannot drift apart.

/**
 * Wall-clock components -> epoch seconds treated as UTC, with fractional seconds preserved as a
 * float. Returns undefined for a calendar-invalid date (e.g. Feb 30): callers' day sub-patterns
 * accept 01-31 for every month, and Date.UTC would otherwise silently roll a bad day into the next
 * month (and remap a two-digit year), so the round-trip check keeps the "strict, never a wrong
 * instant" promise. Hour/minute/second ranges are the caller's responsibility -- the round-trip
 * only validates the calendar date.
 */
export default function utcSecondsFromComponents(
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
