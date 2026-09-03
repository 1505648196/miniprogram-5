<template>
  <div class="login-wrap">
    <n-card class="login-card" :bordered="true">
      <div class="login-title">
        <h2>🥟 包子招聘后台</h2>
        <p>信息管理平台</p>
      </div>
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="top">
        <n-form-item label="账号" path="user">
          <n-input v-model:value="form.user" placeholder="请输入账号" size="large" />
        </n-form-item>
        <n-form-item label="密码" path="pass">
          <n-input
            v-model:value="form.pass"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
            size="large"
            @keyup.enter="handleLogin"
          />
        </n-form-item>
        <n-button
          type="primary"
          block
          size="large"
          :loading="loading"
          @click="handleLogin"
        >
          登 录
        </n-button>
      </n-form>
    </n-card>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useMessage } from "naive-ui";
import { login } from "../api/cloudbase";
import { authStore } from "../stores/auth";

const router = useRouter();
const message = useMessage();

const formRef = ref(null);
const loading = ref(false);
const form = ref({ user: "", pass: "" });

const rules = {
  user: { required: true, message: "请输入账号", trigger: "blur" },
  pass: { required: true, message: "请输入密码", trigger: "blur" },
};

async function handleLogin() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  loading.value = true;
  try {
    const res = await login(form.value.user, form.value.pass);
    if (res && res.authed) {
      authStore.setLogin(form.value.user, form.value.pass);
      message.success("登录成功");
      router.push("/list");
    } else {
      message.error("账号或密码错误");
    }
  } catch (e) {
    message.error(e.message || "登录失败");
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #ff9a56 0%, #ff6a3d 100%);
}
.login-card {
  width: 380px;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
}
.login-title {
  text-align: center;
  margin-bottom: 24px;
}
.login-title h2 {
  margin: 0 0 4px;
  color: #333;
}
.login-title p {
  margin: 0;
  color: #999;
  font-size: 13px;
}
</style>
