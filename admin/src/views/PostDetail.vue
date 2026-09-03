<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <n-space align="center">
        <n-button quaternary @click="goBack">← 返回</n-button>
        <span class="title">帖子详情</span>
      </n-space>
    </n-layout-header>

    <n-layout-content content-style="padding: 24px; max-width: 900px; margin: 0 auto">
      <n-spin :show="loading">
        <n-card v-if="item" :bordered="false">
          <template #header>
            <n-space align="center">
              <n-tag type="info">{{ typeLabel }}</n-tag>
              <n-tag :type="item.needs_review ? 'warning' : 'success'">
                {{ item.needs_review ? "待审核" : "已审核" }}
              </n-tag>
              <span class="summary">{{ summarize(item) }}</span>
            </n-space>
          </template>

          <n-descriptions bordered :column="2" size="small">
            <n-descriptions-item label="类型">{{ typeLabel }}</n-descriptions-item>
            <n-descriptions-item label="城市">{{ item.city || "-" }}</n-descriptions-item>
            <n-descriptions-item label="省份">{{ item.province || "-" }}</n-descriptions-item>
            <n-descriptions-item label="区县">{{ item.district || "-" }}</n-descriptions-item>
            <n-descriptions-item label="岗位/角色">{{ item.role || "-" }}</n-descriptions-item>
            <n-descriptions-item label="薪资">{{ formatSalary(item) }}</n-descriptions-item>
            <n-descriptions-item label="电话">{{ item.phone || item.phone_masked || "-" }}</n-descriptions-item>
            <n-descriptions-item label="发布时间">{{ formatTime(item.published_at) }}</n-descriptions-item>
            <n-descriptions-item label="来源">{{ item.source || "-" }}</n-descriptions-item>
          </n-descriptions>

          <!-- 类型专属字段 -->
          <n-descriptions v-if="extraFields.length" bordered :column="2" size="small" class="mt16">
            <n-descriptions-item v-for="f in extraFields" :key="f.field" :label="f.label">
              {{ displayField(f) }}
            </n-descriptions-item>
          </n-descriptions>

          <!-- 原文 -->
          <n-card v-if="item.raw_text" title="原文" class="mt16" size="small">
            <pre class="raw-text">{{ item.raw_text }}</pre>
          </n-card>

          <!-- 备注 -->
          <n-card v-if="item.remark" title="备注" class="mt16" size="small">
            <div>{{ item.remark }}</div>
          </n-card>

          <template #footer>
            <n-space>
              <n-button type="primary" @click="goEdit">编辑</n-button>
              <n-button
                v-if="item.needs_review"
                type="success"
                @click="handleAudit"
              >
                审核通过
              </n-button>
              <n-button type="error" @click="handleDelete">删除</n-button>
            </n-space>
          </template>
        </n-card>
      </n-spin>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMessage, useDialog } from "naive-ui";
import { getPost, auditPost, deletePost } from "../api/cloudbase";
import { authStore } from "../stores/auth";
import { DATA_TYPES, TYPE_FIELDS, formatSalary, formatTime, summarize } from "../utils/constants";

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const item = ref(null);

const typeLabel = computed(() => (item.value ? DATA_TYPES[item.value.data_type]?.label || item.value.data_type : ""));

const typeFields = computed(() => TYPE_FIELDS[item.value?.data_type]?.fields || []);
const extraFields = computed(() => typeFields.value);

async function load() {
  loading.value = true;
  try {
    const res = await getPost(route.params.id, authStore.getAuth());
    item.value = res.item;
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

function displayField(f) {
  const v = item.value?.[f.field];
  if (v === undefined || v === null || v === "") return "-";
  if (f.type === "switch") return v ? "是" : "否";
  return String(v);
}

function goBack() {
  router.back();
}
function goEdit() {
  router.push(`/post/${item.value._id}/edit`);
}
function handleAudit() {
  dialog.warning({
    title: "确认审核通过？",
    content: "此帖子将标记为已审核并上线展示。",
    positiveText: "确认",
    onPositiveClick: async () => {
      try {
        await auditPost(item.value._id, "后台审核通过", authStore.getAuth());
        message.success("已审核通过");
        load();
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}
function handleDelete() {
  dialog.warning({
    title: "确认删除？",
    content: "此操作不可恢复。",
    positiveText: "删除",
    positiveButtonProps: { type: "error" },
    onPositiveClick: async () => {
      try {
        await deletePost(item.value._id, authStore.getAuth());
        message.success("已删除");
        router.push("/list");
      } catch (e) {
        message.error(e.message);
      }
    },
  });
}

load();
</script>

<style scoped>
.header {
  padding: 0 16px;
  height: 56px;
}
.title {
  font-size: 16px;
  font-weight: 600;
}
.summary {
  color: #666;
  font-size: 14px;
}
.mt16 {
  margin-top: 16px;
}
.raw-text {
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  font-family: inherit;
  line-height: 1.7;
  color: #333;
}
</style>
