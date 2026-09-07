<template>
  <n-layout position="absolute" style="height: 100%">
    <n-layout-header bordered class="header">
      <div class="header-left">
        <span class="logo">🥟 平台公告</span>
        <AdminNav />
      </div>
    </n-layout-header>

    <n-layout-content content-style="padding: 24px; max-width: 720px; margin: 0 auto">
      <n-card :bordered="false" title="发布站内通知">
        <n-alert type="info" :bordered="false" style="margin-bottom: 16px">
          全局公告（type=global）推送给所有用户，小程序"消息"页可见并显示未读红点；
          定向通知（review/member）需填接收用户 openid。
        </n-alert>

        <n-form label-placement="top" :show-require-mark="false">
          <n-form-item label="通知类型">
            <n-radio-group v-model:value="form.type">
              <n-radio-button value="global">全局公告</n-radio-button>
              <n-radio-button value="review">审核通知(定向)</n-radio-button>
              <n-radio-button value="member">会员通知(定向)</n-radio-button>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="form.type !== 'global'" label="接收用户 openid">
            <n-input
              v-model:value="form.to_openid"
              placeholder="定向用户的 openid（global 无需填）"
            />
          </n-form-item>

          <n-form-item label="标题">
            <n-input v-model:value="form.title" placeholder="通知标题" maxlength="50" show-count />
          </n-form-item>

          <n-form-item label="内容">
            <n-input
              v-model:value="form.content"
              type="textarea"
              placeholder="通知内容"
              :autosize="{ minRows: 4, maxRows: 10 }"
              maxlength="500"
              show-count
            />
          </n-form-item>

          <n-form-item label="关联帖子 _id（可选）">
            <n-input v-model:value="form.post_id" placeholder="点击通知可跳转的帖子 _id" />
          </n-form-item>

          <n-space>
            <n-button type="primary" :loading="sending" @click="send">
              {{ form.type === "global" ? "全量推送" : "发送" }}
            </n-button>
            <n-button @click="reset">清空</n-button>
          </n-space>
        </n-form>
      </n-card>
    </n-layout-content>
  </n-layout>
</template>

<script setup>
import { ref } from "vue";
import { useMessage, useDialog } from "naive-ui";
import { sendNotice } from "../api/cloudbase";
import AdminNav from "../components/AdminNav.vue";

const message = useMessage();
const dialog = useDialog();
const sending = ref(false);

const blank = () => ({ type: "global", title: "", content: "", to_openid: "", post_id: "" });
const form = ref(blank());

function send() {
  if (!form.value.title.trim() || !form.value.content.trim()) {
    message.warning("请填写标题和内容");
    return;
  }
  if (form.value.type !== "global" && !form.value.to_openid.trim()) {
    message.warning("定向通知需填写接收用户 openid");
    return;
  }
  const isGlobal = form.value.type === "global";
  dialog.warning({
    title: isGlobal ? "确认全量推送？" : "确认发送？",
    content: isGlobal
      ? "将推送给所有用户，请确认内容无误。"
      : `将发送给 openid：${form.value.to_openid}`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: async () => {
      sending.value = true;
      try {
        await sendNotice(
          form.value.type,
          form.value.title.trim(),
          form.value.content.trim(),
          form.value.to_openid.trim(),
          form.value.post_id.trim()
        );
        message.success("已发送");
        reset();
      } catch (e) {
        message.error(e.message || "发送失败");
      } finally {
        sending.value = false;
      }
    },
  });
}

function reset() {
  form.value = blank();
}
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
</style>
