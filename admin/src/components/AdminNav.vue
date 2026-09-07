<template>
  <n-space align="center" :size="2">
    <n-button
      v-for="item in items"
      :key="item.path"
      quaternary
      :type="isActive(item.path) ? 'primary' : 'default'"
      @click="go(item.path)"
    >
      {{ item.label }}
    </n-button>
  </n-space>
</template>

<script setup>
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();

const items = [
  { label: "帖子", path: "/list" },
  { label: "置顶", path: "/tops" },
  { label: "公告", path: "/notice" },
  { label: "用户", path: "/users" },
  { label: "看板", path: "/stats" },
  { label: "日志", path: "/logs" },
];

function isActive(path) {
  return route.path === path;
}

function go(path) {
  if (route.path !== path) router.push(path);
}
</script>
