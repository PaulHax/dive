<script lang="ts">
import {
  computed, defineComponent, ref, watch,
} from 'vue';
import { useDatasetId, useTime } from 'vue-media-annotator/provides';
import { useApi, DatasetMeta, FrameMetadata } from 'dive-common/apispec';

export default defineComponent({
  name: 'FrameInfo',

  setup() {
    const datasetId = useDatasetId();
    const { frame } = useTime();
    const { loadMetadata, loadFrameMetadata } = useApi();
    const meta = ref<DatasetMeta | null>(null);
    const frameMetadata = ref<FrameMetadata | null>(null);
    const loadError = ref(false);

    const fetchData = async () => {
      meta.value = null;
      frameMetadata.value = null;
      loadError.value = false;
      if (!datasetId.value) {
        return;
      }
      try {
        meta.value = await loadMetadata(datasetId.value);
        if (loadFrameMetadata) {
          frameMetadata.value = await loadFrameMetadata(datasetId.value);
        }
      } catch {
        loadError.value = true;
      }
    };

    watch(datasetId, fetchData, { immediate: true });

    const supported = computed(() => loadFrameMetadata !== undefined);

    const hasAnyMetadata = computed(
      () => Object.keys(frameMetadata.value?.values ?? {}).length > 0,
    );

    const filename = computed(
      () => meta.value?.imageData?.[frame.value]?.filename ?? null,
    );

    const currentRows = computed(() => {
      const data = frameMetadata.value;
      if (!data) {
        return [];
      }
      const record = data.values[String(frame.value)] ?? {};
      // Pinned fields first, then alphabetical by name.
      return Object.keys(record)
        .sort((a, b) => {
          const pinnedA = data.fields[a]?.pinned ? 0 : 1;
          const pinnedB = data.fields[b]?.pinned ? 0 : 1;
          return pinnedA - pinnedB || a.localeCompare(b);
        })
        .map((key) => ({
          name: key,
          value: record[key],
          unit: data.fields[key]?.unit ?? '',
        }));
    });

    return {
      frame,
      filename,
      supported,
      hasAnyMetadata,
      currentRows,
      loadError,
    };
  },
});
</script>

<template>
  <div>
    <v-container>
      <v-list
        dense
        class="py-0"
      >
        <v-list-item class="px-1">
          <v-list-item-content class="d-block py-1">
            <v-list-item-subtitle class="font-weight-medium">
              Frame
            </v-list-item-subtitle>
            <div>{{ frame }}</div>
          </v-list-item-content>
        </v-list-item>
        <v-list-item
          v-if="filename"
          class="px-1"
        >
          <v-list-item-content class="d-block py-1">
            <v-list-item-subtitle class="font-weight-medium">
              Filename
            </v-list-item-subtitle>
            <div class="wrap-text">
              {{ filename }}
            </div>
          </v-list-item-content>
        </v-list-item>
      </v-list>

      <div class="text-subtitle-1 font-weight-medium px-1 pt-3 pb-1">
        Frame Metadata
      </div>
      <v-divider />

      <div
        v-if="loadError"
        class="pa-2 grey--text"
      >
        Unable to load frame metadata.
      </div>
      <div
        v-else-if="!supported"
        class="pa-2 grey--text"
      >
        Frame metadata is not available on this platform.
      </div>
      <div
        v-else-if="!hasAnyMetadata"
        class="pa-2 grey--text"
      >
        No frame metadata for this dataset.
        Import a CSV with a <code>frame</code> or <code>filename</code>
        column to associate metadata with each frame.
      </div>
      <div
        v-else-if="!currentRows.length"
        class="pa-2 grey--text"
      >
        No metadata for this frame.
      </div>
      <v-list
        v-else
        dense
        class="py-0"
      >
        <v-list-item
          v-for="row in currentRows"
          :key="`frameMeta_${row.name}`"
          class="px-1"
        >
          <v-list-item-content class="d-block py-1">
            <v-list-item-subtitle class="font-weight-medium wrap-text">
              {{ row.name }}
            </v-list-item-subtitle>
            <div class="wrap-text">
              {{ row.value }}<span
                v-if="row.unit"
                class="grey--text"
              > {{ row.unit }}</span>
            </div>
          </v-list-item-content>
        </v-list-item>
      </v-list>
    </v-container>
  </div>
</template>

<style scoped>
.wrap-text {
  white-space: normal !important;
  overflow-wrap: anywhere;
}
</style>
