/**
 * 登录态管理（localStorage 持久化）
 * 注意：adminAuth 云函数每次写操作都会用 user/pass 二次校验，
 * 这里只是前端会话记忆，真正的鉴权在云函数端。
 */

const AUTHD_KEY = "baozi_admin_authed";
const USER_KEY = "baozi_admin_user";

export const authStore = {
  get authed() {
    return localStorage.getItem(AUTHD_KEY) === "true";
  },
  get user() {
    return localStorage.getItem(USER_KEY) || "";
  },
  get pass() {
    // 密码存 sessionStorage，浏览器关闭即失效，降低泄露风险
    return sessionStorage.getItem("baozi_admin_pass") || "";
  },
  setLogin(user, pass) {
    localStorage.setItem(AUTHD_KEY, "true");
    localStorage.setItem(USER_KEY, user);
    sessionStorage.setItem("baozi_admin_pass", pass);
  },
  logout() {
    localStorage.removeItem(AUTHD_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem("baozi_admin_pass");
  },
  getAuth() {
    if (!this.authed) return null;
    return { user: this.user, pass: this.pass };
  },
};
