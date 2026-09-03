<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 包子招聘后台</span>
      </div>
      <div class="header-right">
        <n-button quaternary @click="goCreate">＋ 新增</n-button>
        <n-button quaternary @click="handleLogout">退出</n-button>
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 16px">
      <!-- 筛选栏 -->
      <n-card class="filter-card" :bordered="false">
        <n-space align="center" :wrap="true" style="flex-wrap: wrap">
          <n-select
            v-model:value="filters.data_type"
            :options="typeOptionsWithAll"
            placeholder="全部类型"
            clearable
            style="width: 150px"
          />
          <n-input
            v-model:value="filters.city"
            placeholder="城市（如：贵阳）"
            clearable
            style="width: 150px"
          />
          <n-input
            v-model:value="filters.role"
            placeholder="岗位（如：大师傅）"
            clearable
            style="width: 150px"
          />
          <n-select
            v-model:value="filters.needs_review"
            :options="reviewOptions"
            placeholder="审核状态"
            clearable
            style="width: 150px"
          />
          <n-input
            v-model:value="filters.keyword"
            placeholder="关键词搜索（原文/电话/城市/岗位）"
            clearable
            style="width: 260px"
          />
          <n-button type="primary" :loading="loading" @click="load(1)">查询</n-button>
          <n-button @click="resetFilters">重置</n-button>
        </n-space>
      </n-card>

      <!-- 列表 -->
      <n-card :bordered="false" class="list-card">
        <n-data-table
          :columns="columns"
          :data="list"
          :loading="loading"
          :pagination="pagination"
          :bordered="false"
          :row-key="(row) => row._id"
          @update:page="onPageChange"
        />
      </n-card>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref, h, computed } from "vue";
import { useRouter } from "vue-router";
import { useMessage, useDialog, NButton, NTag, NSpace } from "naive-ui";
import { listPosts, deletePost, auditPost } from "../api/cloudbase";
import { authStore } from "../stores/auth";
import {
  DATA_TYPES,
  DATA_TYPE_OPTIONS,
  formatSalary,
  formatTime,
  summarize,
} from "../utils/constants";

const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const list = ref([]);
const total = ref(0);

const filters = ref({
  data_type: null,
  city: "",
  role: "",
  needs_review: null,
  keyword: "",
});

const typeOptionsWithAll = computed(() => [
  { label: "全部类型", value: null },
  ...DATA_TYPE_OPTIONS,
]);

const reviewOptions = [
  { label: "待审核", value: true },
  { label: "已审核", value: false },
];

const pagination = ref({
  page: 1,
  pageSize: 10,
  itemCount: 0,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange: (page) => onPageChange(page),
  onUpdatePageSize: (size) => {
    pagination.value.pageSize = size;
    load(1);
  },
});

async function load(page = 1) {
  loading.value = true;
  pagination.value.page = page;
  try {
    const res = await listPosts({
      page,
      pageSize: pagination.value.pageSize,
      ...filters.value,
    });
    list.value = res.list || [];
    total.value = res.total || 0;
    pagination.value.itemCount = total.value;
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

function onPageChange(page) {
  load(page);
}

function resetFilters() {
  filters.value = { data_type: null, city: "", role: "", needs_review: null, keyword: "" };
  load(1);
}

function goCreate() {
  router.push("/create");
}

function goDetail(id) {
  router.push(`/post/${id}`);
}

function goEdit(id) {
  router.push(`/post/${id}/edit`);
}

function handleAudit(row) {
  dialog.warning({
    title: "确认审核通过？",
    content: `「${summarize(row)}」将标记为已审核并上线展示。`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await auditPost(row._id, "后台审核通过", authStore.getAuth());
        message.success("已审核通过");
        load(pagination.value.page);
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

function handleDelete(row) {
  dialog.warning({
    title: "确认删除？",
    content: `将永久删除「${summarize(row)}」，此操作不可恢复。`,
    positiveText: "删除",
    negativeText: "取消",
    positiveButtonProps: { type: "error" },
    onPositiveClick: async () => {
      try {
        await deletePost(row._id, authStore.getAuth());
        message.success("已删除");
        load(pagination.value.page);
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

function handleLogout() {
  authStore.logout();
  router.push("/login");
}

const columns = [
  { title: "摘要", key: "summary", minWidth: 240, render: (row) => summarize(row) },
  {
    title: "类型",
    key: "data_type",
    width: 120,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: "info" },
        { default: () => DATA_TYPES[row.data_type]?.label || row.data_type }
      ),
  },
  { title: "城市", key: "city", width: 90 },
  { title: "薪资", key: "salary", width: 110, render: (row) => formatSalary(row) },
  { title: "电话", key: "phone", width: 120, render: (row) => row.phone || row.phone_masked || "-" },
  {
    title: "发布时间",
    key: "published_at",
    width: 150,
    render: (row) => formatTime(row.published_at),
  },
  {
    title: "状态",
    key: "needs_review",
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.needs_review ? "warning" : "success" },
        { default: () => (row.needs_review ? "待审核" : "已审核") }
      ),
  },
  {
    title: "操作",
    key: "actions",
    width: 220,
    render: (row) =>
      h(NSpace, { size: 4 }, () => [
        h(NButton, { size: "small", onClick: () => goDetail(row._id) }, { default: () => "详情" }),
        h(NButton, { size: "small", type: "primary", onClick: () => goEdit(row._id) }, { default: () => "编辑" }),
        row.needs_review
          ? h(NButton, { size: "small", type: "success", onClick: () => handleAudit(row) }, { default: () => "审核" })
          : null,
        h(NButton, { size: "small", type: "error", onClick: () => handleDelete(row) }, { default: () => "删除" }),
      ]),
  },
];
</script>

<style scoped>
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  height: 56px;
}
.logo {
  font-size: 17px;
  font-weight: 600;
  color: #d4380d;
}
.filter-card {
  margin-bottom: 12px;
}
.list-card {
  min-height: 400px;
}
</style>
