// cloudfunctions/merchantApply/index.js
// 商家入驻（baozi_merchants）
//   - list   ：已通过审核的商家列表（首页包友圈商家拉取）
//   - submit：C 端提交商家入驻申请
//   - status ：查我的入驻申请（按 openid）

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLL = "baozi_merchants";

// 商家分类（与前端保持一致，便于扩展）
const CATEGORIES = [
  "供应商",
  "技术培训",
  "连锁品牌",
  "面粉辅料",
  "馅料面点",
  "饮品/其他",
  "厨具设备",
  "早餐培训",
];

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 提交通用校验
function validateSubmit(payload) {
  if (!payload) return "参数为空";
  if (!payload.name || String(payload.name).trim().length === 0) return "请填写店铺名称";
  if (String(payload.name).trim().length > 40) return "店铺名称不能超过 40 字";
  if (!payload.category || CATEGORIES.indexOf(payload.category) < 0) return "请选择有效商品分类";
  if (!payload.address || String(payload.address).trim().length === 0) return "请填写详细地址";
  if (!payload.business_hours || String(payload.business_hours).trim().length === 0) return "请填写营业时间";
  if (!payload.phone || !/^1\d{10}$/.test(String(payload.phone).trim())) return "请输入 11 位手机号";
  return null;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "list";
  try {
    switch (action) {
      case "list": return await actionList(event);
      case "detail": return await actionDetail(event);
      case "submit": return await actionSubmit(openid, event);
      case "status": return await actionStatus(openid);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[merchantApply]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// ============ list：列出已通过审核的商家（支持 keyword 搜索 + category 筛选 + tab 区分）============
async function actionList(event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 50);

  const cond = { status: "approved" };

  // 关键词：店铺名/地址/介绍 模糊匹配
  const keyword = String(event.keyword || "").trim();
  if (keyword) {
    const rx = db.RegExp({ regexp: escapeReg(keyword), options: "i" });
    cond.$or = [
      { name: rx },
      { address: rx },
      { intro: rx },
    ];
  }

  // 分类筛选（3 宫格用）
  const category = String(event.category || "").trim();
  if (category) {
    cond.category = category;
  }

  // 附近：按城市过滤（前端传 city，如「深圳市」「广州市」）
  const city = String(event.city || "").trim();
  if (city) {
    const rx = db.RegExp({ regexp: escapeReg(city.replace(/市$/, "")), options: "i" });
    cond.address = rx; // address 形如「广东省深圳市福田区」，按市名模糊匹配
  }

  // 排序：tab=newest 按 created_at 倒序（最新入驻）；推荐/附近默认也按时间倒序
  // （后续「推荐」可改为按评分/曝光等，当前统一时间倒序）
  const res = await db.collection(COLL)
    .where(cond)
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return ok({ list: res.data || [], page, pageSize });
}

// ============ detail：单商家详情（供列表点击进入）============
async function actionDetail(event) {
  const id = String(event._id || "").trim();
  if (!id) return fail("缺少商家标识", "MISSING_ID");
  let item;
  try {
    item = (await db.collection(COLL).doc(id).get()).data;
  } catch (e) {
    item = null;
  }
  if (!item) return fail("商家不存在", "NOT_FOUND");
  // 只允许看已通过审核的商家；未审核/驳回的不可公开查看
  if (item.status !== "approved") return fail("商家审核中或未通过", "FORBIDDEN");
  return ok({ item });
}

// 转义正则特殊字符（防注入/破坏）
function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============ submit：提交入驻申请 ============
async function actionSubmit(openid, event) {
  const payload = event.payload || {};
  const errMsg = validateSubmit(payload);
  if (errMsg) return fail(errMsg, "BAD_PARAM");

  const now = Date.now();

  // 同 openid 已有「待审核」记录的，直接复用并覆盖；避免重复提交产生多条 pending
  const exist = await db.collection(COLL)
    .where({ openid, status: "pending" })
    .limit(1)
    .get();
  const doc = {
    openid,
    name: String(payload.name).trim(),
    category: payload.category,
    address: String(payload.address).trim(),
    latitude: Number(payload.latitude) || null,
    longitude: Number(payload.longitude) || null,
    phone: String(payload.phone).trim(),
    business_hours: String(payload.business_hours).trim(),
    intro: String(payload.intro || "").trim(),
    avatar: payload.avatar || "",
    photos: Array.isArray(payload.photos) ? payload.photos.slice(0, 50) : [],
    wechat_qr: payload.wechat_qr || "",
    license_img: payload.license_img || "",
    invite_code: String(payload.invite_code || "").trim(),
    plan: payload.plan || "free",          // free / pro（高级版 ¥0/1年）
    agreed: payload.agreed === true,
    status: "pending",                     // pending / approved / rejected
    reject_reason: "",
    created_at: now,
    updated_at: now,
  };

  let _id;
  if (exist.data && exist.data.length) {
    _id = exist.data[0]._id;
    await db.collection(COLL).doc(_id).update({ data: { ...doc, updated_at: now } });
  } else {
    const add = await db.collection(COLL).add({ data: doc });
    _id = add._id;
  }
  return ok({ _id, status: "pending", message: "提交成功，审核中" });
}

// ============ status：查我的入驻状态 ============
async function actionStatus(openid) {
  const res = await db.collection(COLL)
    .where({ openid })
    .orderBy("created_at", "desc")
    .limit(5)
    .get();
  return ok({ list: res.data || [] });
}
