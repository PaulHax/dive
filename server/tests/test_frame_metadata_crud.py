import json
from unittest.mock import patch

from dive_server import crud, crud_dataset
from dive_utils import constants
from dive_utils.serializers import frame_metadata

FIELDS = {'depth_m': {'name': 'depth_m', 'datatype': 'number', 'unit': 'm'}}
VALUES = {0: {'depth_m': 12.5}, 3: {'depth_m': 14.0}}


def test_save_frame_metadata_uploads_canonical_and_sets_registry():
    folder = {'_id': 'ds', 'meta': {}}
    user = {'login': 'tester'}
    with (
        patch.object(crud, 'get_or_create_auxiliary_folder', return_value={'_id': 'aux'}),
        patch('dive_server.crud_dataset.Folder') as folder_model,
        patch('dive_server.crud_dataset.Item') as item_model,
        patch('dive_server.crud_dataset.Upload') as upload_model,
    ):
        folder_model.return_value.childItems.return_value = []
        upload_model.return_value.uploadFromFile.return_value = {'itemId': 'item1'}
        item_model.return_value.load.return_value = {'_id': 'item1', 'meta': {}}

        crud_dataset.save_frame_metadata(folder, user, VALUES, FIELDS)

        # The uploaded payload is the canonical, string-keyed document
        upload_args = upload_model.return_value.uploadFromFile.call_args
        payload = json.loads(upload_args[0][0].read().decode())
        assert payload['values'] == {'0': {'depth_m': 12.5}, '3': {'depth_m': 14.0}}
        assert payload['fields'] == FIELDS
        assert upload_args[0][2] == constants.FrameMetadataFileName

        # The values item is marked so it can be found on read
        saved_item = item_model.return_value.save.call_args[0][0]
        assert saved_item['meta'][constants.FrameMetadataMarker] is True

        # The field registry lands in folder metadata
        registry = folder['meta'][constants.FrameMetadataFieldsMarker]
        assert registry['depth_m']['datatype'] == 'number'
        assert registry['depth_m']['unit'] == 'm'
        assert folder_model.return_value.save.called


def test_save_frame_metadata_replaces_previous_values_item():
    folder = {'_id': 'ds', 'meta': {}}
    user = {'login': 'tester'}
    stale_item = {'_id': 'stale', 'meta': {constants.FrameMetadataMarker: True}}
    with (
        patch.object(crud, 'get_or_create_auxiliary_folder', return_value={'_id': 'aux'}),
        patch('dive_server.crud_dataset.Folder') as folder_model,
        patch('dive_server.crud_dataset.Item') as item_model,
        patch('dive_server.crud_dataset.Upload') as upload_model,
    ):
        folder_model.return_value.childItems.return_value = [stale_item]
        upload_model.return_value.uploadFromFile.return_value = {'itemId': 'item1'}
        item_model.return_value.load.return_value = {'_id': 'item1', 'meta': {}}

        crud_dataset.save_frame_metadata(folder, user, VALUES, FIELDS)
        item_model.return_value.remove.assert_called_once_with(stale_item)


def test_load_frame_metadata_round_trip():
    canonical = frame_metadata.to_canonical(VALUES, FIELDS)
    data = json.dumps(canonical).encode('utf-8')
    with (
        patch.object(crud, 'getCloneRoot', return_value={'_id': 'root'}),
        patch('dive_server.crud_dataset.Folder') as folder_model,
        patch('dive_server.crud_dataset.Item') as item_model,
        patch('dive_server.crud_dataset.File') as file_model,
    ):
        folder_model.return_value.childFolders.return_value = [{'_id': 'aux'}]
        folder_model.return_value.childItems.return_value = [{'_id': 'item1'}]
        item_model.return_value.childFiles.return_value = [{'_id': 'file1'}]
        file_model.return_value.download.return_value = lambda: iter([data])

        loaded = crud_dataset.load_frame_metadata({'_id': 'ds'}, {'login': 'tester'})
        assert loaded == canonical


def test_load_frame_metadata_absent():
    with (
        patch.object(crud, 'getCloneRoot', return_value={'_id': 'root'}),
        patch('dive_server.crud_dataset.Folder') as folder_model,
    ):
        # No auxiliary folder at all
        folder_model.return_value.childFolders.return_value = []
        assert crud_dataset.load_frame_metadata({'_id': 'ds'}, {'login': 'tester'}) is None

        # Auxiliary folder exists but holds no marked values item
        folder_model.return_value.childFolders.return_value = [{'_id': 'aux'}]
        folder_model.return_value.childItems.return_value = []
        assert crud_dataset.load_frame_metadata({'_id': 'ds'}, {'login': 'tester'}) is None
