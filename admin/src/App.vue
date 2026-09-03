<template>
  <n-config-provider :theme="null">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
</script>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  background: #f5f6f8;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* {
  box-sizing: border-box;
}
</style>
