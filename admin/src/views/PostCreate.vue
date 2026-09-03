<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <n-space align="center">
        <n-button quaternary @click="goBack">← 返回</n-button>
        <span class="title">新增帖子</span>
      </n-space>
    </n-layout-header>

    <n-layout-content content-style="padding: 24px; max-width: 900px; margin: 0 auto">
      <n-card :bordered="false">
        <DataTypeForm v-model="form" />
        <template #footer>
          <n-space>
            <n-button type="primary" :loading="saving" @click="save">创建</n-button>
            <n-button @click="goBack">取消</n-button>
          </n-space>
        </template>
      </n-card>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useMessage } from "naive-ui";
import { createPost } from "../api/cloudbase";
import { authStore } from "../stores/auth";
import DataTypeForm from "../components/DataTypeForm.vue";

const router = useRouter();
const message = useMessage();

const saving = ref(false);
const form = ref({
  data_type: "",
  city: "",
  province: "",
  district: "",
  role: "",
  salary_low: null,
  salary_high: null,
  salary_note: "",
  raw_text: "",
  source: "手工录入",
});

async function save() {
  if (!form.value.data_type) {
    message.warning("请选择业务类型");
    return;
  }
  saving.value = true;
  try {
    const data = { ...form.value };
    // 空字符串转 undefined，避免写入空值
    for (const k of Object.keys(data)) {
      if (data[k] === "") data[k] = undefined;
    }
    data.needs_review = true; // 手工新增默认待审核
    const res = await createPost(data, authStore.getAuth());
    message.success("创建成功");
    router.push(`/post/${res._id}`);
  } catch (e) {
    message.error(e.message || "创建失败");
  } finally {
    saving.value = false;
  }
}

function goBack() {
  router.back();
}
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
</style>
