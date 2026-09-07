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
// 字段口径：新版（见 docs/API-云函数对接文档.md §3）
const form = ref({
  data_type: "",
  // 通用
  province: "",
  city: "",
  district: "",
  address: "",
  phone: "",
  contact: "",
  // 角色
  role: "",
  role_id: null,
  // 招工 / 求职
  salary: null,
  salary_expect: null,
  salary_note: "",
  availability: "",
  service_area: "",
  want_terms: [],
  // 转让 / 求店 / 设备
  price: null,
  monthly_rent: null,
  area_sqm: null,
  daily_revenue: null,
  has_equipment: false,
  rent_max: null,
  area_min: null,
  cond: null,
  terms: [],
  // 顺风车
  from_place: "",
  to_place: "",
  depart_time: "",
  depart_deadline: "",
  seats: null,
  // 其他
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
