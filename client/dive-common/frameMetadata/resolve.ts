import type { ResolvedFrameMetadata } from 'dive-common/apispec';
import { imageSequenceFrameTimes } from 'dive-common/frameTimeProviders';
import {
  frameAlignmentIndexFromEntries,
  normalizeAlignmentKey,
  parseFrameMetadataSource,
} from './parser';
import type { FrameAlignmentIndex, ParsedFrameMetadata } from './parser';
import { extractCounter } from './matching';

type CameraCandidateTexts = Record<string, [sourceName: string, rawText: string][]>;
type CameraFrameAlignmentIndexes = Record<string, FrameAlignmentIndex>;

// The read path must tolerate duplicate basenames because rejecting here would hide all metadata
// for the camera. Later media entries win for consistency with the ordered media list.
//
// Alongside the filename index, derive the counter index (trailing digit-run -> alignment key) and
// the frame-time map (alignment key -> capture seconds via the image-sequence provider) that power
// the counter and timestamp fallback joins. Both are attached here, on the media-name path only, so
// the raw-entry parser path leaves those tiers dormant. Duplicate stems: later media wins, matching
// frameByAlignmentKey.
function buildFrameAlignmentIndex(mediaNames: string[]): FrameAlignmentIndex {
  const base = frameAlignmentIndexFromEntries(mediaNames.map((name, frame) => [name, frame]));
  const frameTimes = imageSequenceFrameTimes(mediaNames);
  const alignmentKeyByCounter = new Map<number, string>();
  const secondsByAlignmentKey = new Map<string, number>();
  mediaNames.forEach((name, frame) => {
    const key = normalizeAlignmentKey(name);
    const counter = extractCounter(key);
    if (counter !== undefined) {
      alignmentKeyByCounter.set(counter, key);
    }
    const seconds = frameTimes.get(frame);
    if (seconds !== undefined) {
      secondsByAlignmentKey.set(key, seconds);
    }
  });
  return { ...base, alignmentKeyByCounter, secondsByAlignmentKey };
}

function unionColumns(sources: ParsedFrameMetadata[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  sources.forEach((source) => {
    source.columns.forEach((column) => {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    });
  });
  return columns;
}

function resolveCameras(
  cameraTexts: CameraCandidateTexts,
  alignmentIndexesByCamera: CameraFrameAlignmentIndexes,
): ResolvedFrameMetadata {
  const cameras: ResolvedFrameMetadata['cameras'] = {};
  const sources: ResolvedFrameMetadata['sources'] = {};
  const columns: ResolvedFrameMetadata['columns'] = {};

  Object.entries(cameraTexts).forEach(([camera, candidates]) => {
    const index = alignmentIndexesByCamera[camera];
    if (index === undefined) {
      return;
    }

    const parsed = candidates
      .map(([sourceName, text]) => parseFrameMetadataSource(text, index, sourceName))
      .filter((source): source is ParsedFrameMetadata => source !== null);
    if (parsed.length === 0) {
      return;
    }

    const cameraColumns = unionColumns(parsed);

    // Column-level first-wins: for each frame and column, the value comes from the first source
    // (in precedence order) that defines the column in its header and has a row for that frame.
    // A defined column claims its cell even when the value is empty, so a higher-precedence blank
    // is not overwritten, while columns a source never defines stay open for fallback locations.
    //
    // Single precedence-ordered pass: walk each source's records once and, for every column that
    // source defines, fill the frame's cell unless a higher-precedence source already claimed that
    // (frame, column). Equivalent to a column-outer loop but visits each record cell once instead
    // of re-walking every source's full record set once per output column.
    const positionByColumn = new Map<string, number>();
    cameraColumns.forEach((column, position) => positionByColumn.set(column, position));
    const records: Record<number, string[]> = {};
    const claimedColumnsByFrame = new Map<number, Set<number>>();
    parsed.forEach((source) => {
      // cameraColumns is the union of every source's columns, so each column here has a position.
      const sourceColumns = source.columns.map((column) => ({
        column,
        position: positionByColumn.get(column) as number,
      }));
      Object.entries(source.records).forEach(([alignmentKey, values]) => {
        const frame = index.frameByAlignmentKey.get(alignmentKey);
        if (frame === undefined) {
          return;
        }
        // records[frame] and its claimed-column set are born together on first sight of the frame.
        let claimedSet = claimedColumnsByFrame.get(frame);
        if (claimedSet === undefined) {
          records[frame] = cameraColumns.map(() => '');
          claimedSet = new Set<number>();
          claimedColumnsByFrame.set(frame, claimedSet);
        }
        const claimed = claimedSet;
        sourceColumns.forEach(({ column, position }) => {
          if (claimed.has(position)) {
            return;
          }
          claimed.add(position);
          records[frame][position] = values[column] ?? '';
        });
      });
    });

    cameras[camera] = records;
    columns[camera] = cameraColumns;
    sources[camera] = parsed
      .map((source) => source.sourceName)
      .filter((name): name is string => name !== undefined);
  });

  return { cameras, sources, columns };
}

export {
  buildFrameAlignmentIndex,
  resolveCameras,
};

export type {
  CameraCandidateTexts,
  CameraFrameAlignmentIndexes,
  FrameAlignmentIndex,
  ResolvedFrameMetadata,
};
