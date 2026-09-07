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

    <!-- 通用字段 -->
    <template v-if="model.data_type">
      <n-divider title-placement="left">基础信息</n-divider>
      <n-grid :cols="2" :x-gap="16">
        <n-grid-item v-for="f in COMMON_FIELDS" :key="f.field">
          <n-form-item :label="f.label">
            <n-input
              v-model:value="model[f.field]"
              :placeholder="f.placeholder || f.label"
            />
          </n-form-item>
        </n-grid-item>
      </n-grid>
    </template>

    <!-- 类型专属字段 -->
    <template v-if="activeFields.length">
      <n-divider title-placement="left">分类信息</n-divider>
      <n-grid :cols="2" :x-gap="16">
        <n-grid-item v-for="f in activeFields" :key="f.field">
          <n-form-item :label="f.label">
            <!-- 数字 -->
            <n-input-number
              v-if="f.type === 'number'"
              v-model:value="model[f.field]"
              :placeholder="f.placeholder || f.label"
              style="width: 100%"
            />
            <!-- 开关 -->
            <n-switch
              v-else-if="f.type === 'switch'"
              :value="!!model[f.field]"
              @update:value="(v) => (model[f.field] = v)"
            />
            <!-- 枚举下拉（role_id） -->
            <n-select
              v-else-if="f.type === 'select'"
              v-model:value="model[f.field]"
              :options="f.options"
              :placeholder="f.placeholder || f.label"
              clearable
            />
            <!-- 字符串数组（want_terms / terms） -->
            <n-dynamic-tags
              v-else-if="f.type === 'array'"
              :value="Array.isArray(model[f.field]) ? model[f.field] : []"
              :max="10"
              @update:value="(v) => (model[f.field] = v)"
            />
            <!-- 多行文本 -->
            <n-input
              v-else-if="f.type === 'textarea'"
              v-model:value="model[f.field]"
              type="textarea"
              :placeholder="f.placeholder || f.label"
              :autosize="{ minRows: 2, maxRows: 5 }"
            />
            <!-- 单行文本 -->
            <n-input
              v-else
              v-model:value="model[f.field]"
              :placeholder="f.placeholder || f.label"
            />
          </n-form-item>
        </n-grid-item>
      </n-grid>
    </template>

    <n-divider title-placement="left">其他</n-divider>
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
import { DATA_TYPE_OPTIONS, TYPE_FIELDS, COMMON_FIELDS } from "../utils/constants";

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

// 切换类型时保留的字段（基础信息 + 其他），其余按新类型白名单清理
const KEEP_KEYS = new Set([
  "data_type",
  "raw_text",
  "source",
  ...COMMON_FIELDS.map((f) => f.field),
]);

function onTypeChange() {
  const current = TYPE_FIELDS[model.value.data_type]?.fields || [];
  const validFields = new Set(current.map((f) => f.field));
  for (const key of Object.keys(model.value)) {
    if (!KEEP_KEYS.has(key) && !validFields.has(key)) {
      delete model.value[key];
    }
  }
  // 新类型的数组字段初始化，避免 undefined 传给 n-dynamic-tags
  for (const f of current) {
    if (f.type === "array" && !Array.isArray(model.value[f.field])) {
      model.value[f.field] = [];
    }
  }
  emit("update:modelValue", { ...model.value });
}
</script>
