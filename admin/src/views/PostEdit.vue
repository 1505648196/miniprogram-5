<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <n-space align="center">
        <n-button quaternary @click="goBack">← 返回</n-button>
        <span class="title">编辑帖子</span>
      </n-space>
    </n-layout-header>

    <n-layout-content content-style="padding: 24px; max-width: 900px; margin: 0 auto">
      <n-spin :show="loading">
        <n-card v-if="form" :bordered="false">
          <DataTypeForm v-model="form" />
          <template #footer>
            <n-space>
              <n-button type="primary" :loading="saving" @click="save">保存</n-button>
              <n-button @click="goBack">取消</n-button>
            </n-space>
          </template>
        </n-card>
      </n-spin>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMessage } from "naive-ui";
import { getPost, updatePost } from "../api/cloudbase";
import { authStore } from "../stores/auth";
import DataTypeForm from "../components/DataTypeForm.vue";

const route = useRoute();
const router = useRouter();
const message = useMessage();

const loading = ref(false);
const saving = ref(false);
const form = ref(null);

async function load() {
  loading.value = true;
  try {
    const res = await getPost(route.params.id, authStore.getAuth());
    const item = res.item || {};
    // 拆出可编辑字段（新版口径，见 docs/API-云函数对接文档.md §3）
    const editable = {
      data_type: item.data_type || "",
      // 通用
      province: item.province || "",
      city: item.city || "",
      district: item.district || "",
      address: item.address || "",
      phone: item.phone || "",
      contact: item.contact || item.username || "",
      // 角色
      role: item.role || "",
      role_id: item.role_id ?? null,
      // 招工 / 求职
      salary: item.salary ?? null,
      // 求职历史数据可能只存了 salary，回填到 salary_expect
      salary_expect: item.salary_expect ?? (item.data_type === "jobseek" ? (item.salary ?? null) : null),
      salary_note: item.salary_note || "",
      availability: item.availability || "",
      service_area: item.service_area || "",
      want_terms: Array.isArray(item.want_terms) ? item.want_terms : [],
      // 转让 / 求店 / 设备
      price: item.price ?? null,
      monthly_rent: item.monthly_rent ?? null,
      area_sqm: item.area_sqm ?? null,
      daily_revenue: item.daily_revenue ?? null,
      has_equipment: !!item.has_equipment,
      rent_max: item.rent_max ?? null,
      area_min: item.area_min ?? null,
      cond: item.cond ?? null,
      terms: Array.isArray(item.terms) ? item.terms : [],
      // 顺风车
      from_place: item.from_place || "",
      to_place: item.to_place || "",
      depart_time: item.depart_time || "",
      depart_deadline: item.depart_deadline || "",
      seats: item.seats ?? null,
      // 其他
      raw_text: item.raw_text || "",
      source: item.source || "",
    };
    form.value = editable;
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await updatePost(route.params.id, form.value, authStore.getAuth());
    message.success("保存成功");
    router.push(`/post/${route.params.id}`);
  } catch (e) {
    message.error(e.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

function goBack() {
  router.back();
}

onMounted(load);
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
