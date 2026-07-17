import isFrameMetadataSourceName from 'dive-common/frameMetadata/naming';
import { JsonMetaRegEx } from 'dive-common/constants';

export interface SuggestedUploadSlots {
  mediaList: File[];
  annotationFile: File | null;
  configFile: File | null;
  frameMetadataFiles: File[];
}

/**
 * Auto-suggest a picked selection into the per-role upload slots.
 *
 * Only reserved-name frame-metadata sidecars are assigned to the frame-metadata slot here;
 * media/annotation/config placement is a convenience split the server re-validates at upload.
 * Invariant: every input file lands in exactly one slot, so nothing the user picked is ever
 * silently dropped (the PR #1741 guarantee) -- a file the split cannot confidently classify
 * stays in the media slot, where server validation still sees it and reports it.
 */
export default function suggestUploadSlots(fileList: File[]): SuggestedUploadSlots {
  const frameMetadataFiles: File[] = [];
  const rest: File[] = [];
  fileList.forEach((file) => {
    if (isFrameMetadataSourceName(file.name)) {
      frameMetadataFiles.push(file);
    } else {
      rest.push(file);
    }
  });
  const jsonFiles = rest.filter((f) => f.name.includes('.json'));
  const csvFiles = rest.filter((f) => f.name.includes('.csv'));
  let configFile: File | null = null;
  const remainingJson = [...jsonFiles];
  const metaIndex = remainingJson.findIndex((f) => JsonMetaRegEx.test(f.name));
  if (metaIndex !== -1) {
    [configFile] = remainingJson.splice(metaIndex, 1);
  }
  let annotationFile: File | null = null;
  if (remainingJson.length === 1 && csvFiles.length === 0) {
    [annotationFile] = remainingJson;
  } else if (csvFiles.length) {
    [annotationFile] = csvFiles;
  } else if (remainingJson.length > 1) {
    [annotationFile] = remainingJson;
  }
  // Every non-frame-metadata file not pulled into the annotation/config slots stays in the
  // media slot, so it still reaches server validation. The picked selection is never silently
  // dropped, even when an auto-suggestion is off (e.g. a second CSV the server will reject).
  const mediaList = rest.filter((f) => f !== annotationFile && f !== configFile);
  return {
    mediaList, annotationFile, configFile, frameMetadataFiles,
  };
}
