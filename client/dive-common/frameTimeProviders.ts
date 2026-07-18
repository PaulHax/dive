import { parseFrameTimestamp } from 'dive-common/frameTimestamp';

/**
 * Frame-time derivation seam. A FrameTimeProvider maps a camera's frames to their capture time
 * (epoch seconds); the frame-metadata timestamp join consumes it to place data rows on frames by
 * wall-clock time.
 *
 * This is the extension point for per-frame time. Image sequences parse the filename today
 * (`imageSequenceFrameTimes`); a video provider (`anchor + index / fps`), EXIF, embedded KLV, or a
 * container PTS provider can register here later without touching the matcher. A frame whose time
 * cannot be derived is simply absent from the map -- never anchored to a default -- so downstream
 * matching leaves it blank rather than mis-assigning it.
 */
export type FrameTimeProvider = (mediaNames: string[]) => Map<number, number>;

/**
 * Image-sequence provider: parse each frame's capture time from its filename via
 * `parseFrameTimestamp`. Frames whose filename carries no recognized timestamp (e.g. plain
 * sequential or date-only names) are omitted from the map.
 */
export const imageSequenceFrameTimes: FrameTimeProvider = (mediaNames) => {
  const frameTimes = new Map<number, number>();
  mediaNames.forEach((name, frame) => {
    const seconds = parseFrameTimestamp(name);
    if (seconds !== undefined) {
      frameTimes.set(frame, seconds);
    }
  });
  return frameTimes;
};
