"""
Per-frame metadata serializer.

Per-frame metadata associates arbitrary key/value data (timestamp, lat/long,
depth, sensor readings, ...) with each frame or image of a dataset,
independent of any annotations on that frame.

Two interchange formats are supported on import:

* CSV with a header row.  The header must contain a key column named one of
  ``frame`` / ``frame_index`` / ``frame_id`` (integer frame numbers) or
  ``filename`` / ``file_name`` / ``image`` / ``image_name`` (image sequence
  file names).  Every other column becomes a metadata field.
* JSON with a top-level ``frameMetadata`` object mapping frame numbers or
  file names to ``{field: value}`` records.  An optional
  ``frameMetadataFields`` object carries field definitions.

The canonical stored form (and the JSON shape served to clients) is::

    {
        "version": 1,
        "fields": {"depth": {"name": "depth", "datatype": "number"}},
        "values": {"0": {"depth": 12.1}, "1": {"depth": 12.4}}
    }

where ``values`` is keyed by stringified frame number.
"""

import csv
import io
import os
import re
from typing import Any, Dict, Generator, List, Optional, Tuple

FRAME_KEY_COLUMNS = ('frame', 'frame_index', 'frame_id')
FILENAME_KEY_COLUMNS = ('filename', 'file_name', 'image', 'image_name')

FrameValues = Dict[int, Dict[str, Any]]
FieldRegistry = Dict[str, Dict[str, Any]]

VERSION = 1


def _deduce_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    lowered = value.strip().lower()
    if lowered == 'true':
        return True
    if lowered == 'false':
        return False
    try:
        return float(value)
    except ValueError:
        return value


def _resolve_image(image_map: Dict[str, int], name: str) -> Optional[int]:
    """Look up a frame by image name, with or without its file extension.

    image maps produced by ``crud.valid_image_names_dict`` are keyed by name
    without extension.
    """
    if name in image_map:
        return image_map[name]
    return image_map.get(os.path.splitext(name)[0])


def _datatype_of(value: Any) -> str:
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, (int, float)):
        return 'number'
    return 'text'


def infer_fields(values: FrameValues) -> FieldRegistry:
    """Build a field registry from parsed values, inferring each datatype.

    A field is numeric/boolean only if every present value agrees; otherwise
    it falls back to text.
    """
    fields: FieldRegistry = {}
    seen_types: Dict[str, set] = {}
    for record in values.values():
        for key, value in record.items():
            if value is None:
                continue
            seen_types.setdefault(key, set()).add(_datatype_of(value))
    for key, datatypes in seen_types.items():
        datatype = datatypes.pop() if len(datatypes) == 1 else 'text'
        fields[key] = {'name': key, 'datatype': datatype}
    return fields


def _header_key_column(header: List[str]) -> Optional[Tuple[int, str]]:
    """Find the key column in a CSV header.  Returns (index, 'frame'|'filename')."""
    for i, cell in enumerate(header):
        name = cell.strip().lower()
        if name in FRAME_KEY_COLUMNS:
            return i, 'frame'
        if name in FILENAME_KEY_COLUMNS:
            return i, 'filename'
    return None


def is_frame_metadata_csv(rows: List[str]) -> bool:
    """Heuristically decide whether a CSV is a per-frame metadata table.

    VIAME annotation CSVs have no header: data rows begin with a numeric
    track id (comment rows begin with ``#``).  A frame metadata table begins
    with a header row that names a recognized key column.
    """
    for line in rows:
        if line.strip() == '' or line.strip().startswith('#'):
            continue
        row = next(csv.reader(io.StringIO(line)), None)
        if not row:
            return False
        # A leading numeric cell means a VIAME annotation row.
        if re.match(r'^\s*-?\d+\s*$', row[0]):
            return False
        return _header_key_column(row) is not None
    return False


def load_csv(
    rows: List[str],
    image_map: Optional[Dict[str, int]] = None,
) -> Tuple[FrameValues, FieldRegistry, List[str]]:
    """Parse a headered CSV into canonical per-frame metadata.

    :param rows: lines of the file
    :param image_map: image name (with and without extension) -> frame number,
        required to resolve filename-keyed tables
    :returns: (values keyed by frame, inferred field registry, warnings)
    """
    warnings: List[str] = []
    values: FrameValues = {}
    reader = csv.reader(
        line for line in rows if line.strip() != '' and not line.strip().startswith('#')
    )
    header = next(reader, None)
    if header is None:
        raise ValueError('Frame metadata CSV is empty')
    key = _header_key_column(header)
    if key is None:
        raise ValueError(
            'Frame metadata CSV must contain a key column named one of '
            f'{FRAME_KEY_COLUMNS + FILENAME_KEY_COLUMNS}'
        )
    key_index, key_type = key
    field_names = [cell.strip() for cell in header]
    # Exclude every identity column from the data fields: a table keyed by
    # frame may also carry a redundant filename column (and vice versa).
    key_indices = {
        i
        for i, name in enumerate(field_names)
        if name.lower() in FRAME_KEY_COLUMNS + FILENAME_KEY_COLUMNS
    }

    for row in reader:
        if len(row) <= key_index or row[key_index].strip() == '':
            continue
        key_cell = row[key_index].strip()
        if key_type == 'frame':
            try:
                frame = int(float(key_cell))
            except ValueError:
                warnings.append(f'Skipped row with non-numeric frame "{key_cell}"')
                continue
        else:
            if image_map is None:
                raise ValueError('Filename-keyed frame metadata requires an image-sequence dataset')
            resolved = _resolve_image(image_map, key_cell)
            if resolved is None:
                warnings.append(f'Skipped row for unknown image "{key_cell}"')
                continue
            frame = resolved
        record: Dict[str, Any] = {}
        for i, cell in enumerate(row):
            if i in key_indices or i >= len(field_names) or field_names[i] == '':
                continue
            if cell.strip() == '':
                continue
            record[field_names[i]] = _deduce_value(cell)
        if record:
            values[frame] = {**values.get(frame, {}), **record}

    return values, infer_fields(values), warnings


def is_frame_metadata_json(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get('frameMetadata'), dict)


def load_json(
    data: Dict[str, Any],
    image_map: Optional[Dict[str, int]] = None,
) -> Tuple[FrameValues, FieldRegistry, List[str]]:
    """Parse a ``{"frameMetadata": {...}}`` document into canonical form.

    Records may be keyed by frame number (int or numeric string) or by image
    file name.
    """
    warnings: List[str] = []
    values: FrameValues = {}
    for key, record in data['frameMetadata'].items():
        if not isinstance(record, dict):
            warnings.append(f'Skipped non-object record for key "{key}"')
            continue
        frame: Optional[int] = None
        if isinstance(key, int) or re.match(r'^\d+$', str(key)):
            frame = int(key)
        elif image_map is not None:
            frame = _resolve_image(image_map, str(key))
        if frame is None:
            warnings.append(f'Skipped record for unresolvable key "{key}"')
            continue
        cleaned = {k: _deduce_value(v) for k, v in record.items() if v is not None}
        if cleaned:
            values[frame] = {**values.get(frame, {}), **cleaned}

    fields = infer_fields(values)
    # Imported field definitions take precedence over inferred ones.
    provided = data.get('frameMetadataFields')
    if isinstance(provided, dict):
        for key, definition in provided.items():
            if isinstance(definition, dict) and key in fields:
                fields[key] = {**fields[key], **definition}
    return values, fields, warnings


def to_canonical(values: FrameValues, fields: FieldRegistry) -> Dict[str, Any]:
    return {
        'version': VERSION,
        'fields': fields,
        'values': {str(frame): record for frame, record in sorted(values.items())},
    }


def dump_csv(
    canonical: Dict[str, Any],
    filenames: Optional[List[str]] = None,
) -> Generator[str, None, None]:
    """Stream the canonical form as a CSV sidecar (frame[, filename], fields...)."""
    fields = sorted(canonical.get('fields', {}).keys())
    values: Dict[str, Dict[str, Any]] = canonical.get('values', {})
    csv_file = io.StringIO()
    writer = csv.writer(csv_file)
    header = ['frame']
    if filenames:
        header.append('filename')
    header.extend(fields)
    writer.writerow(header)
    for frame_str in sorted(values.keys(), key=int):
        frame = int(frame_str)
        record = values[frame_str]
        row: List[Any] = [frame]
        if filenames:
            row.append(filenames[frame] if frame < len(filenames) else '')
        for field in fields:
            value = record.get(field, '')
            row.append(value if value is not None else '')
        writer.writerow(row)
        yield csv_file.getvalue()
        csv_file.seek(0)
        csv_file.truncate(0)
