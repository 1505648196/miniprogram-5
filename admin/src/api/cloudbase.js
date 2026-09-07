/**
 * CloudBase 后台 API 封装
 * ========================
 * 通过 HTTP 调用云函数 adminAuth（复用 monitor_cloud.py 的调用模式）：
 *   POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{fnName}
 *   Authorization: Bearer <publishable_key>
 *
 * 鉴权说明：
 * - 用 Publishable Key（可在浏览器暴露）作为网关凭证，让前端能匿名调用云函数。
 * - 云函数运行在 admin 上下文，无论谁调用内部都是管理员权限。
 * - 业务层的账号密码校验由云函数内比对完成，前端不承担真正鉴权。
 */

const ENV_ID = import.meta.env.VITE_TCB_ENV_ID || "cloud1-9gcxv3wk28637b62";
const FN_NAME = import.meta.env.VITE_ADMIN_FUNCTION || "adminAuth";
const PUBLISHABLE_KEY = import.meta.env.VITE_TCB_PUBLISHABLE_KEY || "";

import { authStore } from "../stores/auth";

/**
 * 底层：调用指定云函数
 * @param {string} fnName 云函数名
 * @param {string} action 操作名
 * @param {object} payload 附加参数
 * @param {object} auth 登录凭证 {user, pass}（null=免鉴权，如 notifyMsg.send）
 */
async function postTo(fnName, action, payload = {}, auth = null) {
  const body = { action, ...payload };
  if (auth) {
    body.user = auth.user;
    body.pass = auth.pass;
  }

  const url = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/functions/${fnName}`;

  const headers = { "Content-Type": "application/json" };
  if (PUBLISHABLE_KEY) {
    headers.Authorization = `Bearer ${PUBLISHABLE_KEY}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("网络错误，请检查网络连接或环境ID配置");
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error("云函数返回异常（非 JSON）");
  }

  // CloudBase HTTP API 返回格式：{ result: <业务数据> }
  const result = json.result !== undefined ? json.result : json;

  if (result && result.success === false) {
    throw new Error(result.message || "操作失败");
  }
  return result || {};
}

/** 调用后台云函数 adminAuth（带鉴权） */
export async function callFunction(action, payload = {}, auth = null) {
  return postTo(FN_NAME, action, payload, auth);
}

/** 调用任意云函数（免鉴权，如 notifyMsg.send 公告/通知推送） */
export async function callAny(fnName, action, payload = {}) {
  return postTo(fnName, action, payload, null);
}

// ---------- 业务封装 ----------

/** 登录 */
export function login(user, pass) {
  return callFunction("login", {}, { user, pass });
}

/** 分页 + 筛选列表 */
export function listPosts(params = {}) {
  return callFunction("list", params, authStore.getAuth());
}

/** 单条详情 */
export function getPost(_id, auth) {
  return callFunction("get", { _id }, auth);
}

/** 新增 */
export function createPost(data, auth) {
  return callFunction("create", { data }, auth);
}

/** 编辑 */
export function updatePost(_id, data, auth) {
  return callFunction("update", { _id, data }, auth);
}

/** 删除 */
export function deletePost(_id, auth) {
  return callFunction("delete", { _id }, auth);
}

/** 审核 */
export function auditPost(_id, note, auth) {
  return callFunction("audit", { _id, note }, auth);
}

// ---------- 用户 / 会员（§2.4 / §2.5）----------

/** 用户列表（分页 + 关键词 + 会员筛选） */
export function listUsers(params = {}) {
  return callFunction("users", params, authStore.getAuth());
}

/** 封禁 / 解封用户 */
export function banUser(_id, banned) {
  return callFunction("user_ban", { _id, banned }, authStore.getAuth());
}

/** 会员开通/取消/续期 */
export function setMember(_id, op, plan) {
  return callFunction("member", { _id, op, plan }, authStore.getAuth());
}

// ---------- 置顶（§2.6）----------

/** 置顶列表 */
export function listTops(params = {}) {
  return callFunction("list_tops", params, authStore.getAuth());
}

/** 设置置顶 */
export function setTop(post_id, data) {
  return callFunction("top", { op: "set", post_id, ...data }, authStore.getAuth());
}

/** 取消置顶 */
export function cancelTop(post_id) {
  return callFunction("top", { op: "cancel", post_id }, authStore.getAuth());
}

// ---------- 公告（§2.3）：notifyMsg.send 免鉴权 ----------

/** 全量公告（type=global）或定向通知（review/member） */
export function sendNotice(type, title, content, to_openid = "", post_id = "") {
  return callAny("notifyMsg", "send", { type, title, content, to_openid, post_id });
}

// ---------- 看板 / 日志（§3 / §2.8）----------

/** 运营看板指标 */
export function getStats() {
  return callFunction("stats", {}, authStore.getAuth());
}

/** 操作日志 */
export function getLogs(params = {}) {
  return callFunction("logs", params, authStore.getAuth());
}
