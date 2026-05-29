<script lang="ts">
import {
  computed, defineComponent, onMounted, ref, watch,
} from 'vue';
import { useDatasetId } from 'vue-media-annotator/provides';
import { useApi, DatasetMeta } from 'dive-common/apispec';
import StackedVirtualSidebarContainer from 'dive-common/components/StackedVirtualSidebarContainer.vue';

export default defineComponent({
  name: 'DatasetInfo',

  components: { StackedVirtualSidebarContainer },

  props: {
    width: {
      type: Number,
      default: 300,
    },
  },

  setup() {
    const datasetId = useDatasetId();
    const { loadMetadata } = useApi();
    const meta = ref<DatasetMeta | null>(null);

    const fetchMetadata = async () => {
      if (!datasetId.value) {
        meta.value = null;
        return;
      }
      meta.value = await loadMetadata(datasetId.value);
    };

    onMounted(fetchMetadata);
    watch(datasetId, fetchMetadata);

    const infoRows = computed(() => {
      const m = meta.value;
      if (!m) {
        return [];
      }
      const rows: { name: string; value: unknown }[] = [
        { name: 'Name', value: m.name },
        { name: 'Type', value: m.type },
        { name: 'FPS', value: m.fps },
      ];
      if (m.originalFps !== undefined && m.originalFps !== null) {
        rows.push({ name: 'Original FPS', value: m.originalFps });
      }
      if (m.subType) {
        rows.push({ name: 'Subtype', value: m.subType });
      }
      if (m.createdAt) {
        rows.push({ name: 'Created', value: m.createdAt });
      }
      rows.push({ name: 'ID', value: m.id });
      return rows;
    });

    return {
      infoRows,
    };
  },
});
</script>

<template>
  <StackedVirtualSidebarContainer
    :width="width"
    :enable-slot="false"
  >
    <template #default>
      <v-container>
        <v-simple-table
          v-if="infoRows.length"
          dense
        >
          <template #default>
            <tbody>
              <tr
                v-for="row in infoRows"
                :key="`datasetInfo_${row.name}`"
              >
                <td class="font-weight-medium">
                  {{ row.name }}
                </td>
                <td class="wrap-text">
                  {{ row.value !== undefined && row.value !== null ? row.value.toString() : '' }}
                </td>
              </tr>
            </tbody>
          </template>
        </v-simple-table>
        <div
          v-else
          class="pa-2 grey--text"
        >
          No dataset metadata available.
        </div>
      </v-container>
    </template>
  </StackedVirtualSidebarContainer>
</template>

<style scoped>
.wrap-text {
  white-space: normal !important;
  word-break: break-word;
}
</style>
