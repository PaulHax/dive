import csv
import io
import json

import pytest

from dive_utils.serializers import frame_metadata, viame

FRAME_KEYED_CSV = """frame,latitude,longitude,depth_m,substrate
0,36.61,-121.90,102.5,sand
1,36.62,-121.91,103.1,sand
3,36.63,-121.92,104.0,rock
""".splitlines()

FILENAME_KEYED_CSV = """filename,depth_m,altitude_m
DSC_0001.jpg,12.5,2.1
DSC_0002.jpg,13.0,2.0
DSC_0099.jpg,99.0,9.9
""".splitlines()

IMAGE_MAP = {'DSC_0001': 0, 'DSC_0002': 1, 'DSC_0003': 2}

VIAME_CSV = """# comment line
0,1.png,0,884,510,1219,737,0.9,-1,typestring,0.55
""".splitlines()


def test_sniff_frame_keyed_csv():
    assert frame_metadata.is_frame_metadata_csv(FRAME_KEYED_CSV)
    assert frame_metadata.is_frame_metadata_csv(FILENAME_KEYED_CSV)


def test_sniff_rejects_viame_csv():
    assert not frame_metadata.is_frame_metadata_csv(VIAME_CSV)


def test_sniff_rejects_headerless_table():
    assert not frame_metadata.is_frame_metadata_csv(['a,b,c', '1,2,3'])
    assert not frame_metadata.is_frame_metadata_csv([])


def test_load_frame_keyed_csv():
    values, fields, warnings = frame_metadata.load_csv(FRAME_KEYED_CSV)
    assert warnings == []
    assert set(values.keys()) == {0, 1, 3}
    assert values[0] == {
        'latitude': 36.61,
        'longitude': -121.90,
        'depth_m': 102.5,
        'substrate': 'sand',
    }
    assert fields['depth_m'] == {'name': 'depth_m', 'datatype': 'number'}
    assert fields['substrate'] == {'name': 'substrate', 'datatype': 'text'}
    assert 'frame' not in fields


def test_load_filename_keyed_csv():
    values, fields, warnings = frame_metadata.load_csv(FILENAME_KEYED_CSV, IMAGE_MAP)
    assert set(values.keys()) == {0, 1}
    assert values[1] == {'depth_m': 13.0, 'altitude_m': 2.0}
    # The row for an image not in the dataset is skipped with a warning
    assert len(warnings) == 1
    assert 'DSC_0099' in warnings[0]
    assert fields['altitude_m']['datatype'] == 'number'


def test_load_filename_keyed_csv_requires_image_map():
    with pytest.raises(ValueError):
        frame_metadata.load_csv(FILENAME_KEYED_CSV, None)


def test_load_csv_mixed_types_fall_back_to_text():
    rows = ['frame,flag', '0,true', '1,not-a-bool']
    values, fields, _ = frame_metadata.load_csv(rows)
    assert values[0]['flag'] is True
    assert fields['flag']['datatype'] == 'text'


def test_load_json_frame_keyed():
    data = {
        'frameMetadata': {
            '0': {'depth_m': 10.0},
            '1': {'depth_m': 11.0},
        },
        'frameMetadataFields': {'depth_m': {'name': 'depth_m', 'datatype': 'number', 'unit': 'm'}},
    }
    assert frame_metadata.is_frame_metadata_json(data)
    values, fields, warnings = frame_metadata.load_json(data)
    assert warnings == []
    assert values == {0: {'depth_m': 10.0}, 1: {'depth_m': 11.0}}
    # provided definitions merge over inferred ones
    assert fields['depth_m']['unit'] == 'm'


def test_load_json_filename_keyed():
    data = {'frameMetadata': {'DSC_0002.jpg': {'depth_m': 13.0}}}
    values, _, warnings = frame_metadata.load_json(data, IMAGE_MAP)
    assert values == {1: {'depth_m': 13.0}}
    assert warnings == []


def test_json_sniff_rejects_other_json():
    assert not frame_metadata.is_frame_metadata_json({'tracks': {}})
    assert not frame_metadata.is_frame_metadata_json({'frameMetadata': 'oops'})
    assert not frame_metadata.is_frame_metadata_json([1, 2])


def test_canonical_round_trip_through_csv():
    values, fields, _ = frame_metadata.load_csv(FRAME_KEYED_CSV)
    canonical = frame_metadata.to_canonical(values, fields)
    filenames = [f'{i}.png' for i in range(5)]
    exported = ''.join(frame_metadata.dump_csv(canonical, filenames))

    reimported_values, reimported_fields, warnings = frame_metadata.load_csv(exported.splitlines())
    assert warnings == []
    assert reimported_values == values
    assert reimported_fields == fields

    # filename column is present and aligned
    rows = list(csv.reader(io.StringIO(exported)))
    assert rows[0][:2] == ['frame', 'filename']
    assert rows[1][1] == '0.png'


def test_canonical_is_json_serializable_and_string_keyed():
    values, fields, _ = frame_metadata.load_csv(FRAME_KEYED_CSV)
    canonical = frame_metadata.to_canonical(values, fields)
    parsed = json.loads(json.dumps(canonical))
    assert parsed['version'] == 1
    assert set(parsed['values'].keys()) == {'0', '1', '3'}


def _make_track(frame: int) -> dict:
    return {
        'id': 0,
        'attributes': {},
        'confidencePairs': [['fish', 0.9]],
        'features': [
            {
                'frame': frame,
                'bounds': [0, 0, 10, 10],
                'keyframe': True,
                'interpolate': False,
            }
        ],
        'begin': frame,
        'end': frame,
    }


def test_viame_export_includes_frm_atr_cells():
    frame_meta = {0: {'depth_m': 102.5, 'substrate': 'sand'}}
    output = ''.join(viame.export_tracks_as_csv([_make_track(0)], frameMetadata=frame_meta))
    line = [row for row in output.splitlines() if not row.startswith('#')][0]
    assert '(frm-atr) depth_m 102.5' in line
    assert '(frm-atr) substrate sand' in line


def test_viame_export_omits_frm_atr_without_metadata():
    output = ''.join(viame.export_tracks_as_csv([_make_track(0)]))
    assert '(frm-atr)' not in output
    # frames without metadata get no cells even when other frames have some
    output = ''.join(viame.export_tracks_as_csv([_make_track(5)], frameMetadata={0: {'a': 1}}))
    assert '(frm-atr)' not in output


def test_viame_import_ignores_frm_atr_cells():
    """Inline frame metadata cells must not disturb annotation re-import."""
    frame_meta = {0: {'depth_m': 102.5}}
    exported = ''.join(viame.export_tracks_as_csv([_make_track(0)], frameMetadata=frame_meta))
    tracks, attributes, warnings, _ = viame.load_csv_as_tracks_and_attributes(exported.splitlines())
    assert len(tracks['tracks']) == 1
    track = tracks['tracks']['0']
    assert [list(p) for p in track['confidencePairs']] == [['fish', 0.9]]
    feature = track['features'][0]
    assert not feature.get('attributes')
    assert 'detection_depth_m' not in attributes
