<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 运营看板</span>
        <AdminNav />
      </div>
      <div class="header-right">
        <n-button quaternary :loading="loading" @click="load">刷新</n-button>
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 16px">
      <n-spin :show="loading">
        <!-- 核心指标卡片 -->
        <n-grid :cols="4" :x-gap="12" class="mb16">
          <n-grid-item>
            <n-card size="small">
              <n-statistic label="帖子总数" :value="stats.posts_total || 0" />
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card size="small">
              <n-statistic label="待审核">
                <span :style="{ color: (stats.pending || 0) > 0 ? '#d4380d' : '#18a058' }">
                  {{ stats.pending || 0 }}
                </span>
              </n-statistic>
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card size="small">
              <n-statistic label="用户总数" :value="stats.users_total || 0" />
            </n-card>
          </n-grid-item>
          <n-grid-item>
            <n-card size="small">
              <n-statistic label="今日新增用户" :value="stats.users_new_today || 0" />
            </n-card>
          </n-grid-item>
        </n-grid>

        <n-grid :cols="3" :x-gap="12">
          <!-- 各分类帖子数 -->
          <n-grid-item>
            <n-card title="各分类帖子数" size="small">
              <n-space vertical :size="6">
                <div v-for="t in typeList" :key="t.value" class="row">
                  <span class="lbl">{{ t.label }}</span>
                  <span class="val">{{ t.count }}</span>
                </div>
              </n-space>
            </n-card>
          </n-grid-item>

          <!-- 城市分布 -->
          <n-grid-item>
            <n-card title="城市分布 TOP10" size="small">
              <n-space vertical :size="6">
                <div v-for="(c, i) in stats.cities || []" :key="i" class="row">
                  <span class="lbl">{{ c.city }}</span>
                  <span class="val">{{ c.count }}</span>
                </div>
                <n-empty v-if="!(stats.cities && stats.cities.length)" description="暂无数据" size="small" />
              </n-space>
            </n-card>
          </n-grid-item>

          <!-- 浏览量 TOP -->
          <n-grid-item>
            <n-card title="浏览量 TOP10" size="small">
              <n-space vertical :size="6">
                <div v-for="(p, i) in stats.top_views || []" :key="p._id" class="row">
                  <span class="lbl ellipsis">{{ i + 1 }}. {{ p.title || "（无标题）" }}</span>
                  <span class="val">{{ p.views }}</span>
                </div>
                <n-empty v-if="!(stats.top_views && stats.top_views.length)" description="暂无数据" size="small" />
              </n-space>
            </n-card>
          </n-grid-item>
        </n-grid>
      </n-spin>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useMessage } from "naive-ui";
import { getStats } from "../api/cloudbase";
import { DATA_TYPES } from "../utils/constants";
import AdminNav from "../components/AdminNav.vue";

const message = useMessage();
const loading = ref(false);
const stats = ref({});

const typeList = computed(() =>
  Object.entries(DATA_TYPES).map(([value, d]) => ({
    value,
    label: d.label,
    count: stats.value.posts_by_type?.[value] || 0,
  }))
);

async function load() {
  loading.value = true;
  try {
    const res = await getStats();
    stats.value = res;
  } catch (e) {
    message.error(e.message || "加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(load);
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
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
.lbl {
  color: #666;
}
.val {
  font-weight: 600;
}
.ellipsis {
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
