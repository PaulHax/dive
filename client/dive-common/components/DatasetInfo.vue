<script lang="ts">
import {
  computed, defineComponent, ref, watch,
} from 'vue';
import { useDatasetId, useReadOnlyMode } from 'vue-media-annotator/provides';
import { useApi, DatasetMeta } from 'dive-common/apispec';
import { usePrompt } from 'dive-common/vue-utilities/prompt-service';
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
    const readOnlyMode = useReadOnlyMode();
    const { loadMetadata, saveMetadata } = useApi();
    const { prompt } = usePrompt();
    const meta = ref<DatasetMeta | null>(null);
    const customMeta = ref<Record<string, unknown>>({});
    const newKey = ref('');
    const newValue = ref('');

    const fetchMetadata = async () => {
      if (!datasetId.value) {
        meta.value = null;
        customMeta.value = {};
        return;
      }
      meta.value = await loadMetadata(datasetId.value);
      customMeta.value = { ...(meta.value.datasetInfo || {}) };
    };

    watch(datasetId, fetchMetadata, { immediate: true });

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

    const customMetaKeys = computed(() => Object.keys(customMeta.value));

    const persist = async () => {
      if (!datasetId.value) {
        return;
      }
      try {
        await saveMetadata(datasetId.value, { datasetInfo: { ...customMeta.value } });
      } catch (err) {
        const saveErr = err as { response?: { status?: number } };
        const status = saveErr.response?.status;
        const text = status === 403 || status === 401
          ? 'You do not have permission to save metadata to this dataset.'
          : 'Unable to save dataset metadata.';
        // Keep the user's edits on screen and let them retry the save manually.
        const retry = await prompt({
          title: 'Error while Saving Metadata',
          text,
          positiveButton: 'Retry',
          negativeButton: 'Dismiss',
          confirm: true,
        });
        if (retry) {
          await persist();
        }
      }
    };

    const applyMeta = (next: Record<string, unknown>) => {
      customMeta.value = next;
      persist();
    };

    const updateEntry = (key: string, value: string) => {
      applyMeta({ ...customMeta.value, [key]: value });
    };

    const removeEntry = (key: string) => {
      const next = { ...customMeta.value };
      delete next[key];
      applyMeta(next);
    };

    const addEntry = () => {
      const key = newKey.value.trim();
      if (!key) {
        return;
      }
      updateEntry(key, newValue.value);
      newKey.value = '';
      newValue.value = '';
    };

    return {
      readOnlyMode,
      infoRows,
      customMeta,
      customMetaKeys,
      newKey,
      newValue,
      updateEntry,
      removeEntry,
      addEntry,
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
                  {{ row.value?.toString() ?? '' }}
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

        <div class="text-subtitle-2 px-1 pt-3 pb-1">
          Custom Metadata
        </div>
        <v-divider />

        <div
          v-if="!customMetaKeys.length && readOnlyMode"
          class="pa-2 grey--text"
        >
          No custom metadata.
        </div>

        <v-list
          dense
          class="py-0"
        >
          <v-list-item
            v-for="key in customMetaKeys"
            :key="`customMeta_${key}`"
            class="px-1"
          >
            <v-list-item-content class="py-1">
              <v-list-item-subtitle class="font-weight-medium wrap-text">
                {{ key }}
              </v-list-item-subtitle>
              <v-text-field
                v-if="!readOnlyMode"
                :value="customMeta[key]"
                dense
                hide-details
                single-line
                class="pt-0 mt-0"
                @change="updateEntry(key, $event)"
              />
              <span
                v-else
                class="wrap-text"
              >
                {{ customMeta[key] }}
              </span>
            </v-list-item-content>
            <v-list-item-action v-if="!readOnlyMode">
              <v-btn
                icon
                small
                @click="removeEntry(key)"
              >
                <v-icon small>
                  mdi-delete
                </v-icon>
              </v-btn>
            </v-list-item-action>
          </v-list-item>
        </v-list>

        <div
          v-if="!readOnlyMode"
          class="d-flex align-center px-1 pt-1"
        >
          <v-text-field
            v-model="newKey"
            label="Field"
            dense
            hide-details
            single-line
            class="pt-0 mt-0 mr-1"
          />
          <v-text-field
            v-model="newValue"
            label="Value"
            dense
            hide-details
            single-line
            class="pt-0 mt-0 mr-1"
            @keyup.enter="addEntry"
          />
          <v-btn
            icon
            small
            :disabled="!newKey.trim()"
            @click="addEntry"
          >
            <v-icon>mdi-plus</v-icon>
          </v-btn>
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
