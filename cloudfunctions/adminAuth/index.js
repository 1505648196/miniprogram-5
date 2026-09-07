/**
 * adminAuth — 包子一哥后台管理系统专用云函数（新版字段口径）
 * ==========================================================
 * Event Function，通过 event.action 分发：
 *   login     账号密码校验（免二次校验）
 *   list      分页 + 筛选查询 baozi_posts
 *   get       按 _id 查询单条详情
 *   create    新增帖子
 *   update    编辑帖子
 *   delete    删除帖子
 *   audit     审核通过（置 needs_review:false, reviewed:true）
 *   users     用户列表（baozi_users，admin 上下文绕过 C 端 openid 鉴权）
 *   member    会员管理（按 _id/openid 开通/取消，admin 上下文）
 *   file_url  把云存储 fileID 换成临时 https URL（后台详情页展示图片用）
 *
 * 字段口径：与小程序 C 端「新版字段」对齐（docs/API-云函数对接文档.md §3）。
 * 白名单同时保留旧版字段，避免编辑历史数据时旧字段被清空。
 */

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ==================== 配置区 ====================
// §2.8 权限与安全：口令改为环境变量优先，不再明文硬编码在代码里。
// 生产环境请在云函数「环境变量」配置 ADMIN_USER / ADMIN_PASS（改完需重新部署）；
// 未配置时回落默认值，保证本地/存量部署不中断。
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
// 数据集合名
const COLLECTION = "baozi_posts";
const USERS = "baozi_users";
const TOPS = "baozi_post_tops"; // 置顶独立集合
const LOGS = "admin_logs"; // §2.8 操作日志（需先在控制台建该集合）
// ==================== 配置区结束 ====================

/** §2.8 操作日志：记录谁在什么时间做了什么。写失败不阻塞业务。 */
async function writeLog(event, action, targetId, detail) {
  try {
    await db.collection(LOGS).add({
      data: {
        operator: event.user || "",
        action,
        target_id: String(targetId || ""),
        detail: String(detail || ""),
        created_at: Date.now(),
      },
    });
  } catch (e) {
    // 集合未建或权限问题时不阻断主流程
    console.error("[adminAuth] 写操作日志失败:", e && e.errMsg);
  }
}

// ---------- 工具 ----------
function ok(data = {}) {
  return { success: true, ...data };
}

function fail(message, code = "ERROR") {
  return { success: false, code, message };
}

function requireAuth(event) {
  return event.user === ADMIN_USER && event.pass === ADMIN_PASS;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 文件（云存储 fileID → 临时 URL）----------

/**
 * 把云存储 fileID 换成临时 https URL
 * 入参：file_ids 数组（或单数 file_id）
 * 用途：后台详情页展示 image 字段（fileID 是 cloud:// 协议，浏览器无法直接 <img> 显示）
 */
async function actionFileUrl(event) {
  try {
    const list = Array.isArray(event.file_ids)
      ? event.file_ids
      : (event.file_id ? [event.file_id] : []);
    if (!list.length) return fail("缺少 file_ids");
    const res = await cloud.getTempFileURL({ fileList: list.map(String) });
    const out = (res.fileList || []).map((f) => ({
      fileID: f.fileID,
      url: f.tempFileURL || "",
      status: f.status,
    }));
    return ok({ fileList: out });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 字段清洗（新版口径）----------

/**
 * 新版字段白名单（小程序 C 端口径，见 API 文档 §3）
 * 同时保留旧版字段，兼容历史数据编辑。
 */
const ALLOWED_FIELDS = [
  // 通用
  "data_type", "_openid", "userid",
  "province", "province_code", "city", "city_code",
  "district", "district_code", "address",
  "latitude", "longitude",
  "raw_text", "content",
  "phone", "phone_masked", "contact", "username",
  "image",
  "credit", "published_at", "source",
  "needs_review", "reviewed", "reviewed_at", "review_note", "approved",
  "sec_status", "sec_label", "sec_checked_at", "tags",

  // recruit / jobseek 共用
  "role", "role_id", "salary",
  // jobseek 专项
  "salary_expect", "salary_note", "availability", "service_area", "want_terms",
  // transfer 专项
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment", "terms",
  // want_shop 专项
  "rent_max", "area_min",
  // equip_sell / equip_buy
  "cond",
  // carpool_car / carpool_person
  "from_place", "to_place", "depart_time", "depart_deadline", "seats",

  // ---- 旧版字段（兼容历史数据）----
  "salary_low", "salary_high", "rent", "transfer_fee",
  "turnover_low", "turnover_high", "area_m2",
  "is_franchise", "brand", "budget", "shop_type",
  "equip_desc", "equip_price", "equip_region", "equip_budget",
  "remark",
];

/** 数值字段：空串不写，其余转 Number */
const NUMBER_FIELDS = [
  "salary", "salary_expect", "price", "monthly_rent", "area_sqm",
  "daily_revenue", "rent_max", "area_min", "cond", "role_id",
  "credit", "seats", "latitude", "longitude",
  "sec_checked_at",
  // 旧版
  "salary_low", "salary_high", "rent", "transfer_fee",
  "turnover_low", "turnover_high", "area_m2", "budget",
  "equip_price", "equip_budget",
];

/** 布尔字段 */
const BOOL_FIELDS = ["has_equipment", "needs_review", "reviewed", "approved", "is_franchise"];

/** 数组字段：字符串按中英文逗号切分 */
const ARRAY_FIELDS = ["want_terms", "terms", "tags"];

function sanitizeFields(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  for (const k of ALLOWED_FIELDS) {
    const v = input[k];
    if (v === undefined || v === null || v === "") continue;

    if (ARRAY_FIELDS.indexOf(k) >= 0) {
      out[k] = Array.isArray(v)
        ? v
        : String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (BOOL_FIELDS.indexOf(k) >= 0) {
      out[k] = v === true || v === "true" || v === 1 || v === "1";
      continue;
    }
    if (NUMBER_FIELDS.indexOf(k) >= 0) {
      const n = Number(v);
      if (!isNaN(n)) out[k] = n;
      continue;
    }
    out[k] = v;
  }

  // 结果型别名双向同步：approved = !needs_review（true=已通过，false=待审核）
  // 只要本次写入了任一字段，就同步推导另一字段，保证两字段口径永远一致。
  // 优先以 approved 为准（权威结果型字段），needs_review 反向推导。
  if (out.approved !== undefined) {
    out.needs_review = !out.approved;
  } else if (out.needs_review !== undefined) {
    out.approved = !out.needs_review;
  }

  // 求职帖冗余：salary 必须 = salary_expect（见 API 文档 §3）
  // 混排筛选统一用 salary，缺冗余会导致后台维护的求职帖在小程序端按薪资筛不出来
  if (out.salary_expect !== undefined) {
    out.salary = out.salary_expect;
  }

  // 后台手工录入只填 phone，需补脱敏号：小程序端"查看联系方式"读 phone_masked，
  // 缺失会导致后台新建的帖子在 C 端联系方式为空
  if (out.phone && !out.phone_masked) {
    out.phone_masked = String(out.phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
  }

  // 无发布时间则补当前时间
  if (out.published_at === undefined) {
    out.published_at = Date.now();
  }
  return out;
}

// ---------- 帖子动作 ----------

async function actionLogin(event) {
  if (event.user === ADMIN_USER && event.pass === ADMIN_PASS) {
    return ok({ authed: true, user: ADMIN_USER });
  }
  return fail("账号或密码错误", "AUTH_FAILED");
}

/**
 * 分页 + 筛选列表
 * 新版筛选：data_type / city / city_code / role_id / keyword /
 *          needs_review / sec_status / 价格薪资区间 / 发布时间范围
 */
async function actionList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 10));

    const exact = {};
    if (event.data_type) exact.data_type = event.data_type;
    if (event.city) exact.city = event.city;
    if (event.city_code) exact.city_code = event.city_code;
    if (event.role) exact.role = event.role;
    if (event.role_id) exact.role_id = Number(event.role_id);
    if (event.sec_status) exact.sec_status = event.sec_status;
    // §2.7 老数据识别：source="import_legacy"(老数据/平台代发) / "user"(用户发布)
    if (event.source) exact.source = event.source;
    // 审核筛选：后台传 needs_review(true=待审/false=已通过)，内部转 approved 过滤（权威字段）
    // needs_review=true(待审) → approved=false；needs_review=false(已通过) → approved=true
    if (event.needs_review !== undefined && event.needs_review !== null && event.needs_review !== "") {
      const wantReview = event.needs_review === true || event.needs_review === "true";
      exact.approved = wantReview ? false : true;
    }

    // 价格 / 薪资区间（新版：salary=招工求职，price=转让求店设备）
    const range = {};
    const salaryMin = Number(event.salary_min);
    const salaryMax = Number(event.salary_max);
    const priceMin = Number(event.price_min);
    const priceMax = Number(event.price_max);
    if (event.salary_min !== undefined && event.salary_min !== "" && !isNaN(salaryMin)) {
      range.salary = Object.assign(range.salary || {}, { $gte: salaryMin });
    }
    if (event.salary_max !== undefined && event.salary_max !== "" && !isNaN(salaryMax)) {
      range.salary = Object.assign(range.salary || {}, { $lte: salaryMax });
    }
    if (event.price_min !== undefined && event.price_min !== "" && !isNaN(priceMin)) {
      range.price = Object.assign(range.price || {}, { $gte: priceMin });
    }
    if (event.price_max !== undefined && event.price_max !== "" && !isNaN(priceMax)) {
      range.price = Object.assign(range.price || {}, { $lte: priceMax });
    }
    // 发布时间范围
    const from = Number(event.published_from);
    const to = Number(event.published_to);
    if (event.published_from && !isNaN(from)) {
      range.published_at = Object.assign(range.published_at || {}, { $gte: from });
    }
    if (event.published_to && !isNaN(to)) {
      range.published_at = Object.assign(range.published_at || {}, { $lte: to });
    }

    const conds = [];
    if (Object.keys(exact).length) conds.push(exact);
    if (Object.keys(range).length) conds.push(range);

    // 关键词模糊（新版字段）
    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([
        { raw_text: reg },
        { content: reg },
        { phone: reg },
        { contact: reg },
        { username: reg },
        { city: reg },
        { district: reg },
        { address: reg },
        { role: reg },
        { remark: reg },
      ]));
    }

    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;
    const coll = db.collection(COLLECTION);

    // 真实总数
    let total = 0;
    try {
      const countRes = hasWhere ? await coll.where(where).count() : await coll.count();
      total = countRes.total;
    }
    catch (e) {
      const all = hasWhere ? await coll.where(where).get() : await coll.get();
      total = (all.data || []).length;
    }

    // 排序 + 分页
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);

    let res;
    try {
      res = await query.orderBy("published_at", "desc").get();
    }
    catch (e) {
      res = await query.orderBy("createdAt", "desc").get();
    }

    return ok({ list: res.data, total, page, pageSize });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

async function actionGet(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const res = await db.collection(COLLECTION).doc(event._id).get();
    return ok({ item: res.data });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

async function actionCreate(event) {
  const data = sanitizeFields(event.data || {});
  try {
    const res = await db.collection(COLLECTION).add({ data });
    await writeLog(event, "post_create", res._id, data.data_type || "");
    return ok({ _id: res._id });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

async function actionUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeFields(event.data || {});
  delete data._id;
  try {
    const res = await db.collection(COLLECTION).doc(event._id).update({ data });
    await writeLog(event, "post_update", event._id, "");
    return ok({ updated: res.stats && res.stats.updated });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

async function actionDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(COLLECTION).doc(event._id).remove();
    await writeLog(event, "post_delete", event._id, "");
    return ok();
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 审核通过 */
async function actionAudit(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    // 先取帖子，审核通过后给发帖人推站内通知（需要 _openid）
    let post = null;
    try {
      post = (await db.collection(COLLECTION).doc(event._id).get()).data;
    }
    catch (e) {
      post = null;
    }

    await db.collection(COLLECTION).doc(event._id).update({
      data: {
        needs_review: false,
        approved: true, // 结果型别名：通过=true
        reviewed: true,
        reviewed_at: Date.now(),
        review_note: event.note || "",
      },
    });

    // 审核通过 → 站内通知发帖人（API 文档 §5.3）
    // 老数据（source=import_legacy）_openid 为空，跳过以免产生无归属的垃圾通知
    const toOpenid = post && post._openid;
    if (toOpenid) {
      try {
        await db.collection("baozi_messages").add({
          data: {
            type: "review",
            to_openid: toOpenid,
            title: "帖子审核通过",
            content: `您发布的帖子已通过审核并公开展示。${event.note ? `审核备注：${event.note}` : ""}`,
            post_id: event._id,
            read_by: [],
            sender: "admin",
            created_at: Date.now(),
          },
        });
      }
      catch (e) {
        console.error("adminAuth 推送 review 通知失败:", e && e.errMsg);
      }
    }

    await writeLog(event, "post_audit", event._id, event.note || "");
    return ok({ notified: !!toOpenid });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 置顶管理（独立集合 baozi_post_tops）----------
// 置顶采用独立集合，避免把置顶字段塞进帖子表拖慢普通查询。
// 结构：{ post_id, data_type, level, top_type, expire_at, created_at }
//   - expire_at=0 表示永不过期；否则到期后由 C 端查询时惰性过滤 / 定时清理。

async function actionListTops(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 10));
    const coll = db.collection("baozi_post_tops");
    const conds = [];
    if (event.data_type) conds.push({ data_type: event.data_type });
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const countRes = hasWhere ? await coll.where(where).count() : await coll.count();
    const total = countRes.total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    const res = await query.orderBy("created_at", "desc").get();
    // 附帖子摘要，便于后台识别（避免只显示一串 post_id）
    const list = [];
    for (const t of res.data || []) {
      let post = null;
      try {
        post = (await db.collection(COLLECTION).doc(t.post_id).get()).data;
      } catch (e) {
        post = null;
      }
      list.push({
        ...t,
        post_title: post ? String(post.raw_text || "").slice(0, 30) : "（帖子已删除）",
        post_city: post ? post.city || "" : "",
        post_role: post ? post.role || "" : "",
        post_missing: !post,
      });
    }
    return ok({ list, total, page, pageSize });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/**
 * 设置 / 取消置顶
 * 入参：post_id(帖子ID), data_type, level(优先级，越大越前), days(置顶天数，0=永久), op(set/cancel)
 * 说明：set 时若同帖同类型已有置顶记录则更新，否则新建；cancel 删除该帖所有置顶记录。
 */
async function actionTop(event) {
  try {
    const op = event.op || "set";
    const coll = db.collection("baozi_post_tops");

    if (op === "cancel") {
      if (!event.post_id) return fail("缺少 post_id");
      await coll.where({ post_id: event.post_id }).remove();
      await writeLog(event, "top_cancel", event.post_id, event.data_type || "");
      return ok({ cancelled: true });
    }

    // set：需要 post_id + data_type
    if (!event.post_id) return fail("缺少 post_id");
    if (!event.data_type) return fail("缺少 data_type");

    const days = Number(event.days) || 0; // 0=永久
    const now = Date.now();
    const expire_at = days > 0 ? now + days * 86400000 : 0;
    const level = Number(event.level) || 1;
    const top_type = event.top_type || "admin";

    // 已有同帖同类型记录则更新，否则新增
    const exist = await coll.where({ post_id: event.post_id, data_type: event.data_type }).limit(1).get();
    if (exist.data && exist.data.length) {
      await coll.doc(exist.data[0]._id).update({
        data: { level, top_type, expire_at, updated_at: now },
      });
      await writeLog(event, "top_set", event.post_id, `${event.data_type} 天数=${days}`);
      return ok({ set: true, _id: exist.data[0]._id, expire_at });
    }

    const res = await coll.add({
      data: { post_id: event.post_id, data_type: event.data_type, level, top_type, expire_at, created_at: now },
    });
    await writeLog(event, "top_set", event.post_id, `${event.data_type} 天数=${days}`);
    return ok({ set: true, _id: res._id, expire_at });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 用户 / 会员（admin 上下文，绕过 C 端 openid 鉴权）----------

/**
 * 用户列表
 * 入参：page, pageSize, keyword(昵称/手机号/openid), membership(vip/normal)
 */
async function actionUsers(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 10));
    const coll = db.collection(USERS);

    const conds = [];
    if (event.membership === "vip" || event.membership === "normal") {
      conds.push({ membership: event.membership });
    }
    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([
        { username: reg },
        { nickname: reg },
        { phone: reg },
        { openid_wxapp: reg },
      ]));
    }
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const countRes = hasWhere ? await coll.where(where).count() : await coll.count();
    const total = countRes.total;

    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);

    let res;
    try {
      res = await query.orderBy("created_at", "desc").get();
    }
    catch (e) {
      res = await query.get();
    }

    // 派生会员是否有效
    const now = Date.now();
    const list = (res.data || []).map((u) => {
      const expire = Number(u.membership_expire_at) || 0;
      return Object.assign({}, u, {
        isVip: u.membership === "vip" && expire > now,
      });
    });

    return ok({ list, total, page, pageSize });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/**
 * 会员管理（后台代用户开通/取消）
 * 入参：_id(用户文档ID) 或 openid；plan(month/quarter/year)；op(activate/cancel)
 */
const PLAN_DAYS = { month: 30, quarter: 90, year: 365 };
const PLAN_NAMES = { month: "月卡", quarter: "季卡", year: "年卡" };

async function actionMember(event) {
  try {
    const op = event.op || "activate";
    const coll = db.collection(USERS);

    // 定位用户
    let user = null;
    if (event._id) {
      user = (await coll.doc(event._id).get()).data;
      if (user) user._id = event._id;
    }
    else if (event.openid) {
      const r = await coll.where({ openid_wxapp: event.openid }).limit(1).get();
      if (r.data && r.data.length) user = r.data[0];
    }
    if (!user) return fail("未找到该用户", "NOT_FOUND");

    const now = Date.now();

    if (op === "cancel") {
      await coll.doc(user._id).update({
        data: { membership: "normal", membership_expire_at: 0, updated_at: now },
      });
      await writeLog(event, "member_cancel", user._id, user.openid_wxapp || "");
      return ok({ isVip: false });
    }

    // 开通 / 续期
    const plan = String(event.plan || "month").trim();
    const days = PLAN_DAYS[plan] || PLAN_DAYS.month;
    const planName = PLAN_NAMES[plan] || "月卡";
    const base = user.membership === "vip" && Number(user.membership_expire_at) > now
      ? Number(user.membership_expire_at)
      : now;
    const newExpire = base + days * 86400000;

    await coll.doc(user._id).update({
      data: { membership: "vip", membership_expire_at: newExpire, updated_at: now },
    });
    await writeLog(event, "member_activate", user._id, `${planName} 到期=${fmtDate(newExpire)}`);

    // 推一条 member 站内通知
    try {
      await db.collection("baozi_messages").add({
        data: {
          type: "member",
          to_openid: user.openid_wxapp || "",
          title: "会员开通成功",
          content: `恭喜您开通「${planName}」，会员有效期至 ${fmtDate(newExpire)}。`,
          post_id: "",
          read_by: [],
          sender: "admin",
          created_at: now,
        },
      });
    }
    catch (e) {
      console.error("adminAuth 推送 member 通知失败:", e && e.errMsg);
    }

    return ok({ isVip: true, plan, planName, expire_at: newExpire, expireText: fmtDate(newExpire) });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 统计看板（§3）----------

/**
 * 运营看板指标
 * 返回：帖子总数/各分类数、待审核数、用户总数/新增数、浏览量 TOP、城市分布
 */
async function actionStats(event) {
  const out = {};
  const day = 86400000;
  const now = Date.now();
  const posts = db.collection(COLLECTION);

  // 1. 帖子总数 + 各分类数
  try {
    out.posts_total = (await posts.count()).total;
  } catch (e) {
    out.posts_total = 0;
  }
  const TYPES = [
    "recruit", "jobseek", "transfer", "want_shop",
    "equip_sell", "equip_buy", "carpool_car", "carpool_person", "other",
  ];
  out.posts_by_type = {};
  for (const t of TYPES) {
    try {
      out.posts_by_type[t] = (await posts.where({ data_type: t }).count()).total;
    } catch (e) {
      out.posts_by_type[t] = 0;
    }
  }

  // 2. 待审核（审核权威字段已切换为 approved：false=未通过/待审）
  try {
    out.pending = (await posts.where({ approved: false }).count()).total;
  } catch (e) {
    out.pending = 0;
  }

  // 3. 用户总数 + 今日新增
  try {
    out.users_total = (await db.collection(USERS).count()).total;
  } catch (e) {
    out.users_total = 0;
  }
  try {
    out.users_new_today = (
      await db.collection(USERS).where({ created_at: _.gte(now - day) }).count()
    ).total;
  } catch (e) {
    out.users_new_today = 0;
  }

  // 4. 浏览量 TOP10
  try {
    const r = await posts.orderBy("views", "desc").limit(10).get();
    out.top_views = (r.data || []).map((p) => ({
      _id: p._id,
      data_type: p.data_type,
      city: p.city || "",
      title: String(p.raw_text || "").slice(0, 30),
      views: p.views || 0,
    }));
  } catch (e) {
    out.top_views = [];
  }

  // 5. 城市分布 TOP10（聚合，失败则置空）
  try {
    const agg = db.command.aggregate;
    const r = await posts
      .aggregate()
      .group({ _id: "$city", count: agg.sum(1) })
      .sort({ count: -1 })
      .limit(10)
      .end();
    out.cities = (r.list || []).map((x) => ({
      city: x._id || "未知",
      count: x.count,
    }));
  } catch (e) {
    out.cities = [];
    console.error("[adminAuth] 城市分布聚合失败:", e && e.errMsg);
  }

  return ok(out);
}

// ---------- 用户封禁（§2.4）----------

/** 封禁 / 解封用户：banned=true→banned，false→active */
async function actionUserBan(event) {
  if (!event._id) return fail("缺少 _id");
  const banned = event.banned === true || event.banned === "true";
  try {
    await db.collection(USERS).doc(event._id).update({
      data: { status: banned ? "banned" : "active", updated_at: Date.now() },
    });
    await writeLog(event, banned ? "user_ban" : "user_unban", event._id, "");
    return ok({ banned, status: banned ? "banned" : "active" });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 操作日志查询（§2.8）----------

async function actionLogs(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(LOGS);
    const total = (await coll.count()).total;
    const res = await coll
      .orderBy("created_at", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    return ok({ list: res.data, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 入口 ----------
exports.main = async (event = {}) => {
  const action = event.action || "list";

  if (action === "login") {
    return actionLogin(event);
  }

  // 所有业务操作（含 list/get/users/member）都要求登录
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
      case "list_tops": return await actionListTops(event);
      case "top": return await actionTop(event);
      case "users": return await actionUsers(event);
      case "member": return await actionMember(event);
      case "file_url": return await actionFileUrl(event);
      case "stats": return await actionStats(event);
      case "user_ban": return await actionUserBan(event);
      case "logs": return await actionLogs(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
};
