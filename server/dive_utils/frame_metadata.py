"""Frame-metadata sidecar name predicate.

DIVE reserves ``frame-metadata.csv`` and ``frame-metadata.txt`` as the preferred
declared frame-metadata sidecar files; ``frame_metadata.csv`` and
``frame_metadata.txt`` are also accepted (case-insensitive basenames). This module
is the Python mirror of the shared TypeScript predicate; it classifies by name
only and never parses frame metadata.
"""

import re

from dive_utils import asbool, constants, fromMeta

FRAME_METADATA_SOURCE_NAMES = {
    'frame-metadata.csv',
    'frame-metadata.txt',
    'frame_metadata.csv',
    'frame_metadata.txt',
}
PATH_SPLIT_RE = re.compile(r'[/\\]')

# Role value recorded in the mediaFiles association map. Mirrors the client's
# MediaFileAssociation.role literal. Distinct from the FrameMetadataMarker item-marker key
# even though they share a string value: this is a role, that is a Girder meta key.
FRAME_METADATA_ROLE = 'frameMetadata'


def is_frame_metadata_source_name(name: str) -> bool:
    """A frame metadata sidecar is declared by basename."""
    basename = PATH_SPLIT_RE.split(name)[-1]
    return basename.lower() in FRAME_METADATA_SOURCE_NAMES


def frame_metadata_source_name_query() -> dict:
    """Mongo predicate matching a declared frame-metadata sidecar by reserved basename.

    The query-side mirror of is_frame_metadata_source_name: Girder item names are basenames
    (no path separators) and ``lowerName`` is the lowercased name, so an exact ``$in`` over the
    reserved set is exactly that predicate -- and, unlike a regex, it can use the ``lowerName``
    index. Deriving it from the constant keeps the query from drifting as the reserved set changes.
    """
    return {'lowerName': {'$in': sorted(FRAME_METADATA_SOURCE_NAMES)}}


def is_declared_frame_metadata(item: dict) -> bool:
    """A folder item is a declared frame-metadata sidecar.

    Declared either by the reserved basename or by the explicit-import item marker. Both
    the discovery path and the annotation sweep exclude these from annotation classification.
    """
    return is_frame_metadata_source_name(item['name']) or asbool(
        fromMeta(item, constants.FrameMetadataMarker)
    )


def media_file_frame_metadata_names(media_files: dict) -> set:
    """Original filenames recorded as frame-metadata sidecars in a folder's mediaFiles map.

    ``mediaFiles`` is the cross-backend association of record (role + name), keyed by camera.
    The web byte-locator is the item marker; this set lets the read-time resolver honor a
    recorded sidecar even where the marker did not travel (e.g. a metadata round-trip). The
    map is untrusted input, so malformed entries are skipped rather than trusted.
    """
    names: set = set()
    for entries in (media_files or {}).values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if (
                isinstance(entry, dict)
                and entry.get('role') == FRAME_METADATA_ROLE
                and entry.get('name')
            ):
                names.add(entry['name'])
    return names
