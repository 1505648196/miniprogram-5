<template>
  <n-form :model="model" label-placement="top" :show-require-mark="false">
    <n-form-item label="业务类型">
      <n-select
        v-model:value="model.data_type"
        :options="typeOptions"
        placeholder="请选择业务类型"
        @update:value="onTypeChange"
      />
    </n-form-item>

    <n-grid :cols="2" :x-gap="16">
      <n-grid-item v-for="f in activeFields" :key="f.field">
        <n-form-item :label="f.label">
          <n-input-number
            v-if="f.type === 'number'"
            v-model:value="model[f.field]"
            :placeholder="f.placeholder || f.label"
            style="width: 100%"
          />
          <n-switch
            v-else-if="f.type === 'switch'"
            v-model:value="model[f.field]"
          />
          <n-input
            v-else-if="f.type === 'textarea'"
            v-model:value="model[f.field]"
            type="textarea"
            :placeholder="f.placeholder || f.label"
            :autosize="{ minRows: 2, maxRows: 5 }"
          />
          <n-input
            v-else
            v-model:value="model[f.field]"
            :placeholder="f.placeholder || f.label"
          />
        </n-form-item>
      </n-grid-item>
    </n-grid>

    <n-form-item label="原文（raw_text）">
      <n-input
        v-model:value="model.raw_text"
        type="textarea"
        placeholder="完整原始文本"
        :autosize="{ minRows: 3, maxRows: 8 }"
      />
    </n-form-item>

    <n-form-item label="来源">
      <n-input v-model:value="model.source" placeholder="如：微信/小程序/手工录入" />
    </n-form-item>
  </n-form>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { DATA_TYPE_OPTIONS, TYPE_FIELDS } from "../utils/constants";

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
});

const emit = defineEmits(["update:modelValue"]);

const typeOptions = DATA_TYPE_OPTIONS;

const model = ref({ ...props.modelValue });

watch(
  () => props.modelValue,
  (v) => {
    model.value = { ...v };
  }
);

watch(
  model,
  (v) => {
    emit("update:modelValue", { ...v });
  },
  { deep: true }
);

const activeFields = computed(() => {
  if (!model.value.data_type) return [];
  return TYPE_FIELDS[model.value.data_type]?.fields || [];
});

function onTypeChange() {
  // 清空旧类型的专属字段，避免残留脏数据
  const current = TYPE_FIELDS[model.value.data_type]?.fields || [];
  const validFields = new Set(current.map((f) => f.field));
  for (const key of Object.keys(model.value)) {
    if (
      !["data_type", "city", "province", "district", "raw_text", "source", "remark"].includes(key) &&
      !validFields.has(key)
    ) {
      delete model.value[key];
    }
  }
  emit("update:modelValue", { ...model.value });
}
</script>
