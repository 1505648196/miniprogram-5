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
    // 拆出可编辑字段
    const editable = {
      data_type: item.data_type || "",
      city: item.city || "",
      province: item.province || "",
      district: item.district || "",
      role: item.role || "",
      salary_low: item.salary_low ?? null,
      salary_high: item.salary_high ?? null,
      salary_note: item.salary_note || "",
      rent: item.rent ?? null,
      transfer_fee: item.transfer_fee ?? null,
      turnover_low: item.turnover_low ?? null,
      turnover_high: item.turnover_high ?? null,
      area_m2: item.area_m2 ?? null,
      is_franchise: !!item.is_franchise,
      brand: item.brand || "",
      budget: item.budget ?? null,
      shop_type: item.shop_type || "",
      equip_desc: item.equip_desc || "",
      equip_price: item.equip_price ?? null,
      equip_region: item.equip_region || "",
      equip_budget: item.equip_budget ?? null,
      phone: item.phone || "",
      phone_masked: item.phone_masked || "",
      raw_text: item.raw_text || "",
      source: item.source || "",
      remark: item.remark || "",
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
