<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 置顶管理</span>
        <AdminNav />
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 16px">
      <!-- 新增置顶 -->
      <n-card title="设置置顶" size="small" class="mb16">
        <n-space align="end" :wrap="true" style="flex-wrap: wrap">
          <n-form-item label="帖子 _id" :show-require-mark="false">
            <n-input v-model:value="topForm.post_id" placeholder="帖子 _id" style="width: 240px" />
          </n-form-item>
          <n-form-item label="板块" :show-require-mark="false">
            <n-select
              v-model:value="topForm.data_type"
              :options="typeOptions"
              placeholder="板块"
              style="width: 140px"
            />
          </n-form-item>
          <n-form-item label="优先级(越大越前)" :show-require-mark="false">
            <n-input-number v-model:value="topForm.level" :min="1" style="width: 130px" />
          </n-form-item>
          <n-form-item label="置顶天数(0=永久)" :show-require-mark="false">
            <n-input-number v-model:value="topForm.days" :min="0" style="width: 150px" />
          </n-form-item>
          <n-button type="primary" :loading="setting" @click="setTopNow">置顶</n-button>
        </n-space>
      </n-card>

      <!-- 置顶列表 -->
      <n-card title="当前置顶" size="small">
        <n-data-table
          :columns="columns"
          :data="list"
          :loading="loading"
          :bordered="false"
          :row-key="(row) => row._id"
          :pagination="{ pageSize: 20 }"
        />
      </n-card>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref, h } from "vue";
import { useRoute } from "vue-router";
import { useMessage, useDialog, NButton, NTag, NSpace } from "naive-ui";
import { listTops, setTop, cancelTop } from "../api/cloudbase";
import { DATA_TYPE_OPTIONS, DATA_TYPES, formatTime } from "../utils/constants";
import AdminNav from "../components/AdminNav.vue";

const route = useRoute();
const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const setting = ref(false);
const list = ref([]);

const typeOptions = DATA_TYPE_OPTIONS;

const topForm = ref({ post_id: "", data_type: null, level: 1, days: 0 });

// 从帖子列表「置顶」按钮带入参数，预填表单
if (route.query.post_id) topForm.value.post_id = String(route.query.post_id);
if (route.query.data_type) topForm.value.data_type = String(route.query.data_type);

async function load() {
  loading.value = true;
  try {
    const res = await listTops({ page: 1, pageSize: 100 });
    list.value = res.list || [];
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

async function setTopNow() {
  if (!topForm.value.post_id.trim()) {
    message.warning("请填写帖子 _id");
    return;
  }
  if (!topForm.value.data_type) {
    message.warning("请选择板块");
    return;
  }
  setting.value = true;
  try {
    await setTop(topForm.value.post_id.trim(), {
      data_type: topForm.value.data_type,
      level: topForm.value.level,
      days: topForm.value.days,
      top_type: "admin",
    });
    message.success("已置顶");
    topForm.value.post_id = "";
    load();
  } catch (e) {
    message.error(e.message || "置顶失败");
  } finally {
    setting.value = false;
  }
}

function handleCancel(row) {
  dialog.warning({
    title: "确认取消置顶？",
    content: `将取消帖子「${row.post_title}」的置顶。`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await cancelTop(row.post_id);
        message.success("已取消置顶");
        load();
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

const columns = [
  {
    title: "帖子",
    key: "post_title",
    minWidth: 220,
    render: (row) =>
      row.post_missing
        ? h(NTag, { size: "small", type: "error" }, { default: () => "（帖子已删除）" })
        : `${row.post_city || ""} ${row.post_role || ""} ${row.post_title}`.trim() || row.post_id,
  },
  {
    title: "板块",
    key: "data_type",
    width: 110,
    render: (row) =>
      h(NTag, { size: "small", type: "info" }, { default: () => DATA_TYPES[row.data_type]?.label || row.data_type }),
  },
  { title: "优先级", key: "level", width: 80, render: (row) => row.level ?? 1 },
  {
    title: "到期时间",
    key: "expire_at",
    width: 150,
    render: (row) => (row.expire_at ? formatTime(row.expire_at) : "永久"),
  },
  { title: "置顶时间", key: "created_at", width: 150, render: (row) => formatTime(row.created_at) },
  {
    title: "操作",
    key: "actions",
    width: 110,
    render: (row) =>
      h(
        NSpace,
        { size: 4 },
        () => [
          h(NButton, { size: "small", type: "error", onClick: () => handleCancel(row) }, { default: () => "取消置顶" }),
        ]
      ),
  },
];

load();
</script>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  height: 56px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.logo {
  font-size: 17px;
  font-weight: 600;
  color: #d4380d;
}
.mb16 {
  margin-bottom: 16px;
}
</style>
