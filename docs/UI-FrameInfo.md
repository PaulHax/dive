# Frame Info Panel

The Frame Info panel displays per-frame metadata — values such as timestamp,
latitude/longitude, water depth, vehicle altitude, or any other sensor reading
associated with each frame or image of a dataset — alongside the current frame
while annotating.

Open it from the context sidebar dropdown (the same panel switcher that hosts
[Dataset Info](UI-DatasetInfo.md), threshold controls, and the group manager)
by selecting **Frame Info**.

The panel always shows the current frame number and, for image sequences, the
current image file name. Below that, it lists the metadata record for the
current frame and updates as you play or seek. Fields marked as *pinned* in
the field registry sort to the top of the list.

## Associating metadata with frames

Per-frame metadata is imported the same way annotation files are: upload a
file alongside your media (or import it later with the annotation import
action), and DIVE recognizes it by its content.

**CSV** — a table with a header row. The header must contain a key column
named one of `frame`, `frame_index`, `frame_id` (integer frame numbers) or
`filename`, `file_name`, `image`, `image_name` (image file names, with or
without extension). Every other column becomes a metadata field, with numeric
and boolean types detected automatically:

```csv
filename,timestamp,latitude,longitude,depth_m,altitude_m
DSC_0001.jpg,2024-06-01T12:30:00Z,36.61,-121.90,102.5,2.1
DSC_0002.jpg,2024-06-01T12:30:05Z,36.62,-121.91,103.1,2.0
```

**JSON** — an object with a top-level `frameMetadata` key mapping frame
numbers or image file names to records. An optional `frameMetadataFields`
object refines field definitions (for example a display `unit` or `pinned`
flag):

```json
{
  "frameMetadata": {
    "0": { "depth_m": 102.5, "substrate": "sand" },
    "1": { "depth_m": 103.1, "substrate": "sand" }
  },
  "frameMetadataFields": {
    "depth_m": { "name": "depth_m", "datatype": "number", "unit": "m", "pinned": true }
  }
}
```

Re-importing replaces the dataset's existing per-frame metadata.

The panel works on both the web and desktop versions.

## Storage and export

* Values are stored in a `frame_metadata.json` file — in the dataset's
  auxiliary folder on the web (served by `GET dive_dataset/{id}/frame_metadata`),
  or in the project directory on desktop. The field registry is stored in the
  dataset's [configuration](DataFormats.md#dive-configuration-json) under
  `frameMetadataFields` on both platforms.
* VIAME CSV exports inline each frame's metadata onto its detection rows as
  `(frm-atr) name value` cells, linking metadata directly to predictions.
  See [VIAME CSV](DataFormats.md#viame-csv).
* On the web, full dataset (zip) exports also include a `frame_metadata.csv`
  sidecar that can be re-imported directly.
