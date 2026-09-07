<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 包子招聘后台</span>
        <AdminNav />
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
          <n-select
            v-model:value="filters.sec_status"
            :options="secOptions"
            placeholder="安全检测"
            clearable
            style="width: 150px"
          />
          <n-select
            v-model:value="filters.source"
            :options="sourceOptions"
            placeholder="来源"
            clearable
            style="width: 130px"
          />
          <n-input-number
            v-model:value="filters.salary_min"
            placeholder="薪资≥"
            clearable
            style="width: 100px"
          />
          <n-input-number
            v-model:value="filters.salary_max"
            placeholder="薪资≤"
            clearable
            style="width: 100px"
          />
          <n-input-number
            v-model:value="filters.price_min"
            placeholder="价格≥"
            clearable
            style="width: 100px"
          />
          <n-input-number
            v-model:value="filters.price_max"
            placeholder="价格≤"
            clearable
            style="width: 100px"
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
  formatMoney,
  formatTime,
  summarize,
} from "../utils/constants";
import AdminNav from "../components/AdminNav.vue";

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
  sec_status: null,
  source: null, // §2.7 老数据识别
  salary_min: null,
  salary_max: null,
  price_min: null,
  price_max: null,
  keyword: "",
});

const typeOptionsWithAll = computed(() => [
  { label: "全部类型", value: null },
  ...DATA_TYPE_OPTIONS,
]);

// needs_review: true=待人工复核(前端不展示)，false=已通过/可展示
const reviewOptions = [
  { label: "待审核", value: true },
  { label: "已通过", value: false },
];

// sec_status: 微信内容安全检测结果
const secOptions = [
  { label: "通过(pass)", value: "pass" },
  { label: "疑似(risky)", value: "risky" },
  { label: "违规(reject)", value: "reject" },
];

// §2.7 来源：user=用户发布 / import_legacy=老数据(平台代发)
const sourceOptions = [
  { label: "用户发布", value: "user" },
  { label: "老数据迁移", value: "import_legacy" },
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
  filters.value = {
    data_type: null,
    city: "",
    role: "",
    needs_review: null,
    sec_status: null,
    source: null,
    salary_min: null,
    salary_max: null,
    price_min: null,
    price_max: null,
    keyword: "",
  };
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

// 跳置顶页并预填该帖 _id + 板块
function goTop(row) {
  router.push({ path: "/tops", query: { post_id: row._id, data_type: row.data_type } });
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
    content: `${row.source === "import_legacy" ? "⚠️ 该帖为老数据（无归属用户，平台代发）。\n" : ""}将永久删除「${summarize(row)}」，此操作不可恢复。`,
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
  {
    title: "来源",
    key: "source",
    width: 110,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.source === "import_legacy" ? "warning" : "default" },
        {
          default: () =>
            row.source === "import_legacy"
              ? "老数据"
              : row.source === "user"
              ? "用户"
              : "-",
        }
      ),
  },
  { title: "价格/薪资", key: "money", width: 120, render: (row) => formatMoney(row) },
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
        // 口径：needs_review=false 仅表示「已通过/可展示」
        //（可能是微信安全检测自动放行或老数据导入），不等于人工审核过
        { default: () => (row.needs_review ? "待审核" : "已通过") }
      ),
  },
  {
    title: "安全检测",
    key: "sec_status",
    width: 130,
    render: (row) => {
      const map = {
        pass: { type: "success", label: "通过" },
        risky: { type: "warning", label: "疑似" },
        reject: { type: "error", label: "违规" },
      };
      const s = map[row.sec_status];
      if (!s) return "-";
      return h(
        NTag,
        { size: "small", type: s.type },
        { default: () => (row.sec_label ? `${s.label}·${row.sec_label}` : s.label) }
      );
    },
  },
  {
    title: "操作",
    key: "actions",
    width: 280,
    render: (row) =>
      h(NSpace, { size: 4 }, () => [
        h(NButton, { size: "small", onClick: () => goDetail(row._id) }, { default: () => "详情" }),
        h(NButton, { size: "small", type: "primary", onClick: () => goEdit(row._id) }, { default: () => "编辑" }),
        row.needs_review
          ? h(NButton, { size: "small", type: "success", onClick: () => handleAudit(row) }, { default: () => "审核" })
          : null,
        h(NButton, { size: "small", onClick: () => goTop(row) }, { default: () => "置顶" }),
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
