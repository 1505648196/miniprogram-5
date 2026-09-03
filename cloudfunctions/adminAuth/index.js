/**
 * adminAuth — 包子招聘信息后台管理系统专用云函数
 * =================================================
 * Event Function，通过 event.action 分发六种操作：
 *   login     校验账号密码，返回登录成功标记
 *   list      分页+筛选查询 baozi_posts
 *   get       按 _id 查询单条详情
 *   create    新增帖子
 *   update    编辑帖子
 *   delete    删除帖子
 *   audit     审核（设置 needs_review / reviewed 状态）
 *
 * 说明：
 * - 云函数运行在 admin 上下文，可直接读写数据库，不受前端 FlexDB 权限限制。
 * - Web 前端通过 @cloudbase/js-sdk 的 callFunction 调用本函数。
 * - 出于安全，前端读取走直连 SDK（FlexDB READONLY 放行读），
 *   本函数侧重「写」操作 + 需要 admin 权限的操作。
 */

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ==================== 配置区 ====================
// 后台登录账号密码（部署后可在此修改，改完需重新上传云函数）
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";
// 数据集合名
const COLLECTION = "baozi_posts";
// ==================== 配置区结束 ====================

// ---------- 工具 ----------
function ok(data = {}) {
  return { success: true, ...data };
}

function fail(message, code = "ERROR") {
  return { success: false, code, message };
}

function requireAuth(event) {
  // 账号密码校验通过后，前端会带 adminToken（简单起见这里用用户名+密码二次校验）
  // 更安全的做法是签发短期 JWT，这里先用明文比对（适合内网/私有后台）
  const user = event.user;
  const pass = event.pass;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return true;
  }
  return false;
}

// ---------- 动作 ----------

/**
 * 登录校验
 * 返回 ok，前端据此进入后台。不做 token 签发（简化），
 * 后续每次写操作前端都会带 user/pass 由云函数再次校验。
 */
async function actionLogin(event) {
  if (event.user === ADMIN_USER && event.pass === ADMIN_PASS) {
    return ok({ authed: true, user: ADMIN_USER });
  }
  return fail("账号或密码错误", "AUTH_FAILED");
}

/**
 * 分页 + 筛选列表查询
 * 前端直连 SDK 也能读（FlexDB READONLY 放行），但为了统一分页/筛选逻辑，
 * 这里提供一个 admin 上下文的全量查询入口（不受 READONLY 只读本用户限制，
 * 注意：FlexDB READONLY 在小程序端是「只读自己」，云函数 admin 不受限）。
 */
async function actionList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 10));

    // 构造精确匹配条件
    const exact = {};
    if (event.data_type) exact.data_type = event.data_type;
    if (event.city) exact.city = event.city;
    if (event.role) exact.role = event.role;
    if (event.needs_review !== undefined && event.needs_review !== null && event.needs_review !== "") {
      exact.needs_review = event.needs_review === true || event.needs_review === "true";
    }

    // 关键词：匹配 raw_text / phone / city / role / brand / remark
    const kw = event.keyword ? String(event.keyword).trim() : "";
    let where = exact;
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      const orCond = _.or([
        { raw_text: reg },
        { phone: reg },
        { city: reg },
        { role: reg },
        { brand: reg },
        { remark: reg },
      ]);
      // 关键词与其他筛选条件取交集（原实现会覆盖其他条件）
      where = Object.keys(exact).length ? _.and([exact, orCond]) : orCond;
    }

    // 真实总数（原实现返回当页条数，导致分页页数计算错误）
    const coll = db.collection(COLLECTION);
    let total = 0;
    try {
      const countRes = Object.keys(where).length || kw
        ? await coll.where(where).count()
        : await coll.count();
      total = countRes.total;
    } catch (e) {
      // count 失败时退化为取全量长度，保证前端仍可用
      const all = Object.keys(where).length ? await coll.where(where).get() : await coll.get();
      total = (all.data || []).length;
    }

    // 排序：优先 published_at，其次 createdAt（部分老数据无 published_at）
    const query = Object.keys(where).length || kw
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);

    let res;
    try {
      res = await query.orderBy("published_at", "desc").get();
    } catch (e) {
      res = await query.orderBy("createdAt", "desc").get();
    }

    return ok({ list: res.data, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单条详情 */
async function actionGet(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const res = await db.collection(COLLECTION).doc(event._id).get();
    return ok({ item: res.data });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新增 */
async function actionCreate(event) {
  const data = sanitizeFields(event.data || {});
  try {
    const res = await db.collection(COLLECTION).add({ data });
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑 */
async function actionUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeFields(event.data || {});
  delete data._id;
  try {
    const res = await db.collection(COLLECTION).doc(event._id).update({ data });
    return ok({ updated: res.stats && res.stats.updated });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除 */
async function actionDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(COLLECTION).doc(event._id).remove();
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 审核：设置 needs_review 和 reviewed_at */
async function actionAudit(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(COLLECTION).doc(event._id).update({
      data: {
        needs_review: false,
        reviewed: true,
        reviewed_at: Date.now(),
        review_note: event.note || "",
      },
    });
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/**
 * 字段白名单清洗
 * 只保留业务字段，防止注入无关字段。
 */
const ALLOWED_FIELDS = [
  "data_type", "province", "city", "district",
  "role", "salary_low", "salary_high", "salary_note",
  "rent", "transfer_fee", "turnover_low", "turnover_high", "area_m2",
  "is_franchise", "brand",
  "budget", "shop_type",
  "equip_desc", "equip_price", "equip_region", "equip_budget",
  "phone", "phone_masked", "raw_text", "content", "remark",
  "source", "needs_review", "reviewed", "reviewed_at", "review_note",
  "published_at",
];

function sanitizeFields(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of ALLOWED_FIELDS) {
    if (input[k] !== undefined && input[k] !== null) {
      out[k] = input[k];
    }
  }
  // 数值字段转数字
  for (const k of ["salary_low", "salary_high", "rent", "transfer_fee",
    "turnover_low", "turnover_high", "area_m2", "budget",
    "equip_price", "equip_budget"]) {
    if (out[k] !== undefined && out[k] !== "" && out[k] !== null) {
      const n = Number(out[k]);
      if (!isNaN(n)) out[k] = n;
    }
  }
  // 布尔字段
  for (const k of ["is_franchise", "needs_review", "reviewed"]) {
    if (out[k] !== undefined && out[k] !== null) {
      out[k] = out[k] === true || out[k] === "true" || out[k] === 1;
    }
  }
  // 若无发布时间，自动补当前时间戳
  if (out.published_at === undefined || out.published_at === "") {
    out.published_at = Date.now();
  }
  return out;
}

// ---------- 入口 ----------
exports.main = async (event = {}) => {
  // 除 login 外的所有操作都必须通过身份校验
  const action = event.action || "list";

  if (action === "login") {
    return actionLogin(event);
  }

  // 所有业务操作（含 list/get）都要求登录
  if (!requireAuth(event)) {
    return fail("未授权：请先登录", "AUTH_FAILED");
  }

  try {
    switch (action) {
      case "list": return await actionList(event);
      case "get": return await actionGet(event);
      case "create": return await actionCreate(event);
      case "update": return await actionUpdate(event);
      case "delete": return await actionDelete(event);
      case "audit": return await actionAudit(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
};
