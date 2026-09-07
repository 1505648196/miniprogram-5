<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 用户管理</span>
        <AdminNav />
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 16px">
      <n-card class="filter-card" :bordered="false">
        <n-space align="center" :wrap="true" style="flex-wrap: wrap">
          <n-input
            v-model:value="filters.keyword"
            placeholder="昵称/手机号/openid"
            clearable
            style="width: 240px"
          />
          <n-select
            v-model:value="filters.membership"
            :options="memberOptions"
            placeholder="会员状态"
            clearable
            style="width: 140px"
          />
          <n-button type="primary" :loading="loading" @click="load(1)">查询</n-button>
          <n-button @click="resetFilters">重置</n-button>
        </n-space>
      </n-card>

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
import { ref, h } from "vue";
import { useMessage, useDialog, NButton, NTag, NSpace, NDropdown } from "naive-ui";
import { listUsers, banUser, setMember } from "../api/cloudbase";
import { formatTime } from "../utils/constants";
import AdminNav from "../components/AdminNav.vue";

const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const list = ref([]);
const total = ref(0);

const filters = ref({ keyword: "", membership: null });

const memberOptions = [
  { label: "会员", value: "vip" },
  { label: "普通", value: "normal" },
];

const planOptions = [
  { label: "月卡(30天)", key: "month" },
  { label: "季卡(90天)", key: "quarter" },
  { label: "年卡(365天)", key: "year" },
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
    const res = await listUsers({ page, pageSize: pagination.value.pageSize, ...filters.value });
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
  filters.value = { keyword: "", membership: null };
  load(1);
}

function handleBan(row) {
  const banned = row.status === "banned";
  dialog.warning({
    title: banned ? "确认解封？" : "确认封禁？",
    content: `用户「${row.username || row.nickname || row._id}」${banned ? "将恢复正常" : "将被封禁，无法登录/发布"}。`,
    positiveText: "确认",
    negativeText: "取消",
    positiveButtonProps: banned ? {} : { type: "error" },
    onPositiveClick: async () => {
      try {
        await banUser(row._id, !banned);
        message.success(banned ? "已解封" : "已封禁");
        load(pagination.value.page);
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

function handleMember(plan, row) {
  dialog.warning({
    title: "确认开通会员？",
    content: `为用户「${row.username || row.nickname || row._id}」开通「${planOptions.find((p) => p.key === plan)?.label}」？`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await setMember(row._id, "activate", plan);
        message.success("已开通");
        load(pagination.value.page);
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

function handleCancelMember(row) {
  dialog.warning({
    title: "确认取消会员？",
    content: `将取消用户「${row.username || row.nickname || row._id}」的会员资格。`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await setMember(row._id, "cancel");
        message.success("已取消");
        load(pagination.value.page);
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

const columns = [
  {
    title: "用户",
    key: "username",
    minWidth: 140,
    render: (row) => row.username || row.nickname || "-",
  },
  { title: "手机号", key: "phone", width: 130, render: (row) => row.phone || row.phone_masked || "-" },
  {
    title: "openid",
    key: "openid",
    minWidth: 120,
    render: (row) => {
      const o = row.openid_wxapp || row.unionid || "";
      return o ? o.slice(0, 8) + "…" : "-";
    },
  },
  {
    title: "会员",
    key: "membership",
    width: 130,
    render: (row) =>
      row.isVip
        ? h(NSpace, { size: 4, vertical: true }, () => [
            h(NTag, { size: "small", type: "success" }, { default: () => "会员" }),
            h("span", { style: "font-size:12px;color:#888" }, formatTime(row.membership_expire_at)),
          ])
        : h(NTag, { size: "small" }, { default: () => "普通" }),
  },
  { title: "信用分", key: "credit_score", width: 80, render: (row) => row.credit_score ?? "-" },
  {
    title: "状态",
    key: "status",
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: "small", type: row.status === "banned" ? "error" : "success" },
        { default: () => (row.status === "banned" ? "封禁" : "正常") }
      ),
  },
  {
    title: "注册时间",
    key: "created_at",
    width: 140,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: "操作",
    key: "actions",
    width: 240,
    render: (row) =>
      h(NSpace, { size: 4 }, () => [
        h(
          NDropdown,
          {
            options: planOptions,
            trigger: "click",
            onSelect: (plan) => handleMember(plan, row),
          },
          { default: () => h(NButton, { size: "small", type: "primary" }, { default: () => "开通会员" }) }
        ),
        row.isVip
          ? h(NButton, { size: "small", onClick: () => handleCancelMember(row) }, { default: () => "取消会员" })
          : null,
        h(
          NButton,
          {
            size: "small",
            type: row.status === "banned" ? "default" : "error",
            onClick: () => handleBan(row),
          },
          { default: () => (row.status === "banned" ? "解封" : "封禁") }
        ),
      ]),
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
.filter-card {
  margin-bottom: 12px;
}
.list-card {
  min-height: 400px;
}
</style>
