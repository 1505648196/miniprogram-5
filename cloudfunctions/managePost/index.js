// cloudfunctions/managePost/index.js
// 用户管理"自己发布的帖子"（C 端，与后台 adminAuth 相对）
//  - list_mine：我发布的帖子（含待审核，标 sec_status / 审核中）
//  - get：单条详情（本人可见完整手机号，编辑预填用）
//  - update：保存修改（归属校验 + 字段白名单 + 只更新变化字段 + 编辑内容过内容安全审核）
//  - delete：删除（归属校验）
// 安全前提：publishPost / recruitAI 入库时已显式写入 _openid
const cloud = require("wx-server-sdk");
const { checkText } = require("./secCheck.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = "baozi_posts";

// 表单能表达的字段白名单：编辑只允许改这些，其余字段（boss_style/source/published_at 等）原样保留
const EDITABLE = [
  "role", "role_id", "salary",
  "province", "city", "district",
  "province_code", "city_code", "district_code",
  "address", "latitude", "longitude",
  "raw_text", "phone", "contact", "tags",
];

// 列表只下发展示所需字段（去 phone / _openid 等敏感字段）
const LIST_KEYS = [
  "_id", "data_type", "role", "role_id", "province", "city", "district",
  "province_code", "city_code", "district_code",
  "salary", "contact", "phone_masked", "username", "credit",
  "raw_text", "tags", "published_at", "needs_review", "sec_status", "sec_label",
  // 求职专属字段
  "salary_expect", "salary_note", "availability", "want_terms", "service_area",
  // 地址定位 / 图片 / 时间
  "address", "latitude", "longitude", "image", "created_at", "updated_at",
];

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

function maskPhone(p) {
  const s = String(p || "").trim();
  return /^1\d{10}$/.test(s) ? s.slice(0, 3) + "****" + s.slice(7) : "";
}

// null 与 undefined 视为等价（避免回填 null 覆盖已有值造成噪音更新）
function same(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

async function getOwned(openid, id) {
  const res = await db.collection(COLLECTION).doc(id).get();
  const d = res.data;
  if (!d || d._openid !== openid) return null;
  return d;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "list_mine";
  try {
    switch (action) {
      case "list_mine": return await actionListMine(openid);
      case "get": return await actionGet(openid, event);
      case "detail": return await actionDetail(event);
      case "update": return await actionUpdate(openid, event);
      case "delete": return await actionDelete(openid, event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[managePost]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 我发布的帖子：不过滤 needs_review（本人可见"审核中"状态）
async function actionListMine(openid) {
  const res = await db.collection(COLLECTION)
    .where({ data_type: "recruit", _openid: openid })
    .orderBy("published_at", "desc")
    .limit(50)
    .get();
  return ok({ list: (res.data || []).map(stripPrivate) });
}

async function actionGet(openid, event) {
  if (!event._id) return fail("缺少 _id");
  const d = await getOwned(openid, event._id);
  if (!d) return fail("无权查看或帖子不存在", "FORBIDDEN");
  return ok({ item: d }); // 本人可见完整手机号（编辑预填用）
}

// 公开详情(兜底)：任何人可查一条"已过审/非待审"帖子的详情。
// 与 feedPosts 白名单对齐(含求职专属字段/图片/地址)，用于详情页在
// "列表缓存未命中"(如从分享/收藏直达)时按 _id 二次查库；正常列表点进来走缓存、零额外请求。
async function actionDetail(event) {
  if (!event._id) return fail("缺少 _id", "MISSING_ID");
  const res = await db.collection(COLLECTION).doc(event._id).get();
  const d = res.data;
  if (!d) return fail("帖子不存在或已被删除", "NOT_FOUND");
  if (d.needs_review === true || d.needs_review === "true") {
    return fail("帖子审核中或未通过", "FORBIDDEN");
  }
  // 仅下发展示所需字段，脱敏，不泄露完整 phone / _openid
  return ok({ item: stripPrivate(d) });
}

async function actionUpdate(openid, event) {
  if (!event._id) return fail("缺少 _id");
  const d = await getOwned(openid, event._id);
  if (!d) return fail("无权修改或帖子不存在", "FORBIDDEN");
  const f = event.form || {};
  const patch = {};
  for (const k of EDITABLE) {
    if (f[k] !== undefined) patch[k] = f[k];
  }
  // 电话变更 → 重新脱敏（改了号才重算，避免脱敏号与真实号不同步）
  if (patch.phone !== undefined) {
    const p = String(patch.phone).trim();
    if (!/^1\d{10}$/.test(p)) return fail("请输入 11 位手机号");
    patch.phone = p;
    if (p !== d.phone) patch.phone_masked = maskPhone(p);
  }
  // 只更新与现值不同的字段（null/undefined 等价），避免空覆盖
  for (const k of Object.keys(patch)) {
    if (k === "phone_masked") continue;
    if (same(patch[k], d[k])) delete patch[k];
  }
  // 编辑内容同样要过内容安全审核（防止绕过审核通道）
  const content = [patch.raw_text, patch.address, patch.contact, patch.role]
    .filter((v) => v != null && String(v).trim())
    .join("\n");
  if (content) {
    const sec = await checkText(content, openid);
    patch.needs_review = sec.suggest === "pass" ? false : true;
    patch.sec_status = sec.suggest;
    if (sec.label) patch.sec_label = sec.label;
    patch.sec_checked_at = sec.checkedAt;
  }
  patch.updated_at = Date.now(); // published_at 不动，不刷榜
  await db.collection(COLLECTION).doc(event._id).update({ data: patch });
  return ok({
    updated: 1,
    needs_review: !!patch.needs_review,
    sec_status: patch.sec_status || d.sec_status || "pass",
  });
}

async function actionDelete(openid, event) {
  if (!event._id) return fail("缺少 _id");
  const d = await getOwned(openid, event._id);
  if (!d) return fail("无权删除或帖子不存在", "FORBIDDEN");
  await db.collection(COLLECTION).doc(event._id).remove();
  return ok({ deleted: 1 });
}

function stripPrivate(p) {
  const o = {};
  for (const k of LIST_KEYS) if (p[k] !== undefined) o[k] = p[k];
  return o;
}
