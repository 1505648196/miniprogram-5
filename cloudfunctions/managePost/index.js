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
const _ = db.command; // 数据库操作符（_.inc 等）；此前缺失导致浏览量上报静默失败
const COLLECTION = "baozi_posts";

// 表单能表达的字段白名单：编辑只允许改这些，其余字段（boss_style/source/published_at 等）原样保留
// 与发布侧(publishPost)字段对齐，覆盖：招工/求职 salary + 期望/到岗/诉求、转让/求店专项、设备成色、图片等。
const EDITABLE = [
  "role", "role_id", "salary",
  // 求职(jobseek)专项
  "salary_expect", "salary_note", "availability", "want_terms", "service_area",
  // 转让/求店 专属可编辑字段
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment",
  "terms", "rent_max", "area_min",
  // 二手设备 专属可编辑字段
  "cond",
  // 顺风车(carpool_car/carpool_person) 专属可编辑字段
  "from_place", "to_place", "depart_time", "depart_deadline", "seats",
  "province", "city", "district",
  "province_code", "city_code", "district_code",
  "address", "latitude", "longitude",
  "raw_text", "phone", "contact", "tags", "image",
];

// 列表只下发展示所需字段（去 phone / _openid 等敏感字段）
const LIST_KEYS = [
  "_id", "data_type", "role", "role_id", "province", "city", "district",
  "province_code", "city_code", "district_code",
  "salary", "contact", "phone_masked", "username", "credit",
  "raw_text", "tags", "published_at", "needs_review", "approved", "sec_status", "sec_label",
  // 求职专属字段
  "salary_expect", "salary_note", "availability", "want_terms", "service_area",
  // 转让/求店专属字段
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment",
  "terms", "rent_max", "area_min",
  // 二手设备专属字段
  "cond",
  // 顺风车专属字段
  "from_place", "to_place", "depart_time", "depart_deadline", "seats",
  // 地址定位 / 图片 / 时间
  "address", "latitude", "longitude", "image", "created_at", "updated_at",
  // 浏览点击量
  "views",
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

const DATA_TYPE_NAMES = {
  recruit: "招工", jobseek: "求职", transfer: "店铺转让", want_shop: "求店",
  equip_sell: "设备出售", equip_buy: "设备求购", carpool_car: "车找人",
  carpool_person: "人找车", other: "信息",
};

// 给发帖人推一条审核结果站内通知（write baozi_messages, type=review）
async function pushReviewNotify(openid, dataType, postId, content) {
  if (!openid || !postId) return;
  try {
    await db.collection("baozi_messages").add({
      data: {
        type: "review",
        to_openid: openid,
        title: "信息更新已通过审核",
        content,
        post_id: postId,
        read_by: [],
        sender: "system",
        created_at: Date.now(),
      },
    });
  } catch (e) {
    console.error("managePost 推送审核通知失败:", e && e.errMsg);
  }
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
      case "detail": return await actionDetail(openid, event);
      case "update": return await actionUpdate(openid, event);
      case "delete": return await actionDelete(openid, event);
      case "view": return await actionView(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[managePost]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 我发布的帖子：不过滤 needs_review（本人可见"审核中"状态）
// 全部分类（recruit/jobseek/transfer/want_shop/equip_sell/equip_buy/other 等）都返回，
// 不再限定 data_type —— 发布侧已支持全分类，我的发布要能看到自己发的全部信息。
async function actionListMine(openid) {
  const res = await db.collection(COLLECTION)
    .where({ _openid: openid })
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
// 附 isMine(是否本人帖子)，供详情页对本人展示"编辑/删除"。
async function actionDetail(openid, event) {
  if (!event._id) return fail("缺少 _id", "MISSING_ID");
  const res = await db.collection(COLLECTION).doc(event._id).get();
  const d = res.data;
  if (!d) return fail("帖子不存在或已被删除", "NOT_FOUND");
  // 审核权威字段已切换为 approved（true=已通过）。老数据可能缺 approved，回退 needs_review 兜底。
  if (d.approved === false || d.approved === "false" || d.needs_review === true || d.needs_review === "true") {
    return fail("帖子审核中或未通过", "FORBIDDEN");
  }
  // 仅下发展示所需字段，脱敏，不泄露完整 phone / _openid；附是否本人
  const item = stripPrivate(d);
  item.isMine = !!openid && d._openid === openid;
  return ok({ item });
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
  let reReviewPassed = false;
  if (content) {
    const sec = await checkText(content, openid);
    patch.needs_review = sec.suggest === "pass" ? false : true;
    patch.approved = !patch.needs_review; // 结果型别名：通过=true，待审=false
    patch.sec_status = sec.suggest;
    if (sec.label) patch.sec_label = sec.label;
    patch.sec_checked_at = sec.checkedAt;
    reReviewPassed = sec.suggest === "pass";
  }
  patch.updated_at = Date.now(); // published_at 不动，不刷榜
  await db.collection(COLLECTION).doc(event._id).update({ data: patch });
  // 编辑后重新审核通过 → 推站内通知（避免打扰：仅当确实触发过内容审核且通过时）
  if (reReviewPassed) {
    const typeName = DATA_TYPE_NAMES[d.data_type] || DATA_TYPE_NAMES.other;
    await pushReviewNotify(openid, d.data_type, event._id, `您的「${typeName}」信息已更新并重新审核通过。`);
  }
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

// 浏览点击量 +1（原子自增）。任何登录用户浏览帖子详情时调用。
// 防重复计数由前端节流（同一帖子 10 秒内不重复上报），此处不做去重。
async function actionView(event) {
  if (!event._id) return fail("缺少 _id", "MISSING_ID");
  try {
    await db.collection(COLLECTION).doc(event._id).update({
      data: { views: _.inc(1) },
    });
    return ok({ viewed: 1 });
  } catch (e) {
    // 帖子不存在等：不视为失败，静默返回（避免浏览上报报错影响体验）
    return ok({ viewed: 0 });
  }
}

function stripPrivate(p) {
  const o = {};
  for (const k of LIST_KEYS) if (p[k] !== undefined) o[k] = p[k];
  return o;
}
