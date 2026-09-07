<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 操作日志</span>
        <AdminNav />
      </div>
      <div class="header-right">
        <n-button quaternary :loading="loading" @click="load(1)">刷新</n-button>
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 16px">
      <n-card :bordered="false" class="list-card">
        <n-alert v-if="!list.length && !loading" type="info" :bordered="false" style="margin-bottom: 12px">
          暂无日志。请先在 CloudBase 控制台创建 <code>admin_logs</code> 集合。
        </n-alert>
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
import { useMessage, NTag } from "naive-ui";
import { getLogs } from "../api/cloudbase";
import { formatTime } from "../utils/constants";
import AdminNav from "../components/AdminNav.vue";

const message = useMessage();
const loading = ref(false);
const list = ref([]);

const pagination = ref({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange: (page) => onPageChange(page),
  onUpdatePageSize: (size) => {
    pagination.value.pageSize = size;
    load(1);
  },
});

const ACTION_LABEL = {
  post_create: "新增帖子",
  post_update: "编辑帖子",
  post_delete: "删除帖子",
  post_audit: "审核通过",
  user_ban: "封禁用户",
  user_unban: "解封用户",
};

async function load(page = 1) {
  loading.value = true;
  pagination.value.page = page;
  try {
    const res = await getLogs({ page, pageSize: pagination.value.pageSize });
    list.value = res.list || [];
    pagination.value.itemCount = res.total || 0;
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

function onPageChange(page) {
  load(page);
}

const columns = [
  { title: "时间", key: "created_at", width: 170, render: (row) => formatTime(row.created_at) },
  { title: "操作人", key: "operator", width: 120, render: (row) => row.operator || "-" },
  {
    title: "动作",
    key: "action",
    width: 140,
    render: (row) =>
      h(NTag, { size: "small", type: "info" }, { default: () => ACTION_LABEL[row.action] || row.action }),
  },
  { title: "对象 _id", key: "target_id", minWidth: 200, render: (row) => row.target_id || "-" },
  { title: "备注", key: "detail", minWidth: 120, render: (row) => row.detail || "-" },
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
.list-card {
  min-height: 400px;
}
</style>
