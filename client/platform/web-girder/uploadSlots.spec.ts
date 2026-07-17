// eslint-disable-next-line import/no-extraneous-dependencies -- Vitest is only used in tests
import { describe, expect, it } from 'vitest';

import suggestUploadSlots from './uploadSlots';

function file(name: string): File {
  return new File([name], name, { type: 'application/octet-stream' });
}

function slotNames(slots: ReturnType<typeof suggestUploadSlots>): string[] {
  return [
    ...slots.mediaList,
    ...(slots.annotationFile ? [slots.annotationFile] : []),
    ...(slots.configFile ? [slots.configFile] : []),
    ...slots.frameMetadataFiles,
  ].map((f) => f.name).sort();
}

describe('suggestUploadSlots', () => {
  it('routes a reserved-name sidecar to the frame-metadata slot, images to media', () => {
    const slots = suggestUploadSlots([file('img001.png'), file('img002.png'), file('frame-metadata.csv')]);
    expect(slots.mediaList.map((f) => f.name)).toEqual(['img001.png', 'img002.png']);
    expect(slots.frameMetadataFiles.map((f) => f.name)).toEqual(['frame-metadata.csv']);
    expect(slots.annotationFile).toBeNull();
    expect(slots.configFile).toBeNull();
  });

  it('suggests a single annotation CSV and keeps it out of the media slot', () => {
    const slots = suggestUploadSlots([file('img001.png'), file('tracks.csv')]);
    expect(slots.mediaList.map((f) => f.name)).toEqual(['img001.png']);
    expect(slots.annotationFile?.name).toBe('tracks.csv');
  });

  it('detects a config JSON alongside an annotation CSV', () => {
    const slots = suggestUploadSlots([file('img001.png'), file('tracks.csv'), file('dataset.meta.json')]);
    expect(slots.configFile?.name).toBe('dataset.meta.json');
    expect(slots.annotationFile?.name).toBe('tracks.csv');
    expect(slots.mediaList.map((f) => f.name)).toEqual(['img001.png']);
  });

  it('keeps an extra CSV the suggestion cannot place in the media slot (never dropped)', () => {
    // Two arbitrary CSVs: one is suggested as the annotation, the other must remain reachable
    // so server validation still sees (and rejects) it rather than the client silently losing it.
    const slots = suggestUploadSlots([file('img001.png'), file('tracks.csv'), file('nav_2024.csv')]);
    expect(slotNames(slots)).toEqual(['img001.png', 'nav_2024.csv', 'tracks.csv']);
    expect(slots.mediaList.some((f) => f.name === 'nav_2024.csv')
      || slots.annotationFile?.name === 'nav_2024.csv').toBe(true);
  });

  it('never silently drops any picked file (every input lands in exactly one slot)', () => {
    const picked = [
      file('img001.png'), file('img002.png'),
      file('tracks.csv'), file('extra.csv'),
      file('dataset.meta.json'), file('other.json'),
      file('frame-metadata.txt'), file('nav.unknown'),
    ];
    const slots = suggestUploadSlots(picked);
    expect(slotNames(slots)).toEqual(picked.map((f) => f.name).sort());
  });
});
