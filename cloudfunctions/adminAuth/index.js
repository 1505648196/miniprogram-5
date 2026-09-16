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
const crypto = require("crypto");

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
// 管理员 openid 白名单集合（替代环境变量 ADMIN_OPENIDS，后台可动态增删、纯数据库操作）
const ADMIN_OPENIDS = "admin_openids";
const TOPS = "baozi_post_tops"; // 置顶独立集合
const LOGS = "admin_logs"; // §2.8 操作日志（需先在控制台建该集合）
const ADS = "advertisements"; // §2.9 广告运营位（广告内容）
const AD_SLOTS = "ad_slots"; // §2.9 广告位定义（方案 C：数据驱动）
const GROUPS = "baozi_groups"; // 包友群（C 端只读，管理端增删改）
const MERCHANTS = "baozi_merchants"; // 包友圈商家（C 端提交/浏览，管理端审核）
const MESSAGES = "baozi_messages"; // 站内通知 / 平台公告（与 notifyMsg 同集合）
const IDENTITIES = "baozi_identities"; // 身份认证申请（店主/师傅，管理端审核）
const SETTINGS = "baozi_settings"; // 全局配置集合（key/value，如「包友圈展示」开关）

// ---- RBAC：管理员账号 / 角色（多人分级权限）----
const ADMIN_ACCOUNTS = "admin_accounts"; // 管理员账号表（username 唯一）
const ADMIN_ROLES = "admin_roles"; // 角色权限表（role 唯一）
// ==================== 配置区结束 ====================

/**
 * 统一「小程序端」管理员判定（C 端 openid 通道）：
 *   ① admin_openids 白名单集合命中 → 直接为管理员（后台可动态增删，纯数据库操作）
 *   ② 未命中 → 查 baozi_users 里 role === 'admin'（向后兼容：历史以 role 授管理员的方式仍有效）
 * 与 wxTask / adminChat 三处保持同一口径；改一处务必同步另两处。
 */
async function isAdminOpenid(openid) {
  if (!openid) return false;
  // ① 白名单集合
  try {
    const r = await db
      .collection(ADMIN_OPENIDS)
      .where({ openid })
      .limit(1)
      .get();
    if (r.data && r.data.length) return true;
  } catch (e) {
    console.error("[adminAuth] 查 admin_openids 白名单失败:", e && e.errMsg);
  }
  // ② 角色兜底
  try {
    const r = await db
      .collection(USERS)
      .where({ openid_wxapp: openid, role: "admin" })
      .limit(1)
      .get();
    return !!(r.data && r.data.length);
  } catch (e) {
    console.error("[adminAuth] isAdminOpenid 查 role 失败:", e && e.errMsg);
    return false;
  }
}

// ==================== RBAC 权限点 ====================
// permission 粒度对应业务模块，action → permission 映射见 ACTION_PERM。
// super_admin 角色无需查表，直接全量放行（避免权限表被误改导致超管失效）。
const SUPER_ROLE = "super_admin";

/** action → 所需权限点。未列出的 action 默认不校验（如 login/check_admin）。 */
const ACTION_PERM = {
  // 帖子查看
  list: "post.view",
  get: "post.view",
  post_phone: "post.view", // 管理员取帖子完整手机号（转发用）
  // 帖子增删改
  create: "post.edit",
  update: "post.edit",
  delete: "post.edit",
  // 审核 / 上下架
  audit: "post.audit",
  reject: "post.audit",
  offline: "post.audit",
  online: "post.audit",
  // 置顶
  list_tops: "post.top",
  top: "post.top",
  // 用户 / 会员 / 封禁
  users: "user.manage",
  member: "user.manage",
  user_ban: "user.manage",
  user_role: "user.manage", // 授予/撤销小程序管理员（role: user|admin）
  // 广告运营位
  ad_list: "ad.manage",
  ad_create: "ad.manage",
  ad_update: "ad.manage",
  ad_delete: "ad.manage",
  ad_toggle: "ad.manage",
  ad_slot_list: "ad.manage",
  ad_slot_create: "ad.manage",
  ad_slot_update: "ad.manage",
  ad_slot_delete: "ad.manage",
  ad_slot_toggle: "ad.manage",
  // 支付数据
  pay_orders: "pay.view",
  pay_records: "pay.view",
  pay_stats: "pay.view",
  // 包友群管理（baozi_groups）
  group_list: "group.manage",
  group_create: "group.manage",
  group_update: "group.manage",
  group_delete: "group.manage",
  group_toggle: "group.manage",
  // 包友圈商家管理（baozi_merchants）
  merchant_list: "merchant.manage",
  merchant_get: "merchant.manage",
  merchant_create: "merchant.manage",
  merchant_update: "merchant.manage",
  merchant_delete: "merchant.manage",
  merchant_audit: "merchant.manage", // 审核通过 / 驳回
  // 全局配置开关（如「包友圈展示」），归属商家管理权限
  setting_get: "merchant.manage",
  setting_set: "merchant.manage",
  // 举报 / 意见反馈管理（baozi_feedback）
  feedback_list: "feedback.manage",
  feedback_handle: "feedback.manage",
  feedback_count: "feedback.manage",
  // 平台公告管理（baozi_messages 中 type=global）
  notice_list: "notice.manage",
  notice_create: "notice.manage",
  notice_update: "notice.manage",
  notice_delete: "notice.manage",
  notice_toggle: "notice.manage",
  // 身份认证管理（baozi_identities，店主/师傅认证）
  identity_list: "identity.manage",
  identity_get: "identity.manage",
  identity_audit: "identity.manage",
  identity_delete: "identity.manage",
  // 日志 / 概览
  logs: "log.view",
  stats: "log.view",
  event_stats: "log.view",
  user_events: "log.view",
  // 账号 / 角色管理（仅超管）
  admin_list: "admin.manage",
  admin_create: "admin.manage",
  admin_update: "admin.manage",
  admin_delete: "admin.manage",
  role_list: "admin.manage",
  role_save: "admin.manage",
};

// ==================== 密码哈希工具 ====================
/**
 * 密码哈希：sha256(salt + pass) 十六进制串。
 * 与数据库 admin_accounts.pass_hash 写入时所用的算法保持一致。
 */
function hashPass(pass, salt) {
  return crypto.createHash("sha256").update(String(salt) + String(pass)).digest("hex");
}

/** 生成随机盐（16 字节 hex） */
function genSalt() {
  return crypto.randomBytes(16).toString("hex");
}

/** §2.8 操作日志：记录谁在什么时间做了什么。写失败不阻塞业务。 */
async function writeLog(event, action, targetId, detail) {
  try {
    const role = (event && event.__role) || "";
    await db.collection(LOGS).add({
      data: {
        operator: event.user || "",
        operator_role: role,
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

// ==================== RBAC 鉴权 ====================
/**
 * RBAC 鉴权：查账号 → 校验密码哈希 → 查角色权限 → 判断当前 action 是否被允许。
 * 返回：{ acct, role, perms } 通过；{ forbidden:true, acct, role } 无权限；null 账号/密码错误。
 * 说明：超级管理员（super_admin）跳过权限表校验，直接全量放行。
 */
async function authorize(event) {
  const username = String(event.user || "").trim();
  const pass = String(event.pass || "");
  if (!username || !pass) return null;

  let acct = null;
  try {
    const r = await db
      .collection(ADMIN_ACCOUNTS)
      .where({ username, status: "active" })
      .limit(1)
      .get();
    acct = (r.data && r.data[0]) || null;
  } catch (e) {
    console.error("[adminAuth] 查询管理员账号失败:", e && e.errMsg);
    return null;
  }
  if (!acct) return null;
  if (hashPass(pass, acct.salt) !== acct.pass_hash) return null;

  const role = acct.role || "";
  if (role === SUPER_ROLE) return { acct, role, perms: null };

  let perms = [];
  try {
    const rr = await db.collection(ADMIN_ROLES).where({ role }).limit(1).get();
    perms = (rr.data && rr.data[0] && rr.data[0].permissions) || [];
  } catch (e) {
    console.error("[adminAuth] 查询角色权限失败:", e && e.errMsg);
  }

  const need = ACTION_PERM[event.action];
  if (need && perms.indexOf(need) < 0) {
    return { forbidden: true, acct, role, perms, need };
  }
  return { acct, role, perms };
}

/** 兼容旧调用：仅判断账密是否有效（不带 action 权限判定） */
async function requireAuth(event) {
  const ctx = await authorize({ ...event, action: "" });
  return !!ctx && !ctx.forbidden;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 管理员身份校验（小程序端「管理员 AI 入口」显隐用）----------

/**
 * check_admin：判断当前登录用户是否为管理员（小程序端统一入口）
 * - 用服务端 getWXContext 的 OPENID（用户无法伪造）
 * - 判定口径：ADMIN_OPENIDS 白名单命中 → 是；否则查 baozi_users.role === 'admin'
 * - 免口令：任何登录用户都可调用（只返回 true/false，不泄露任何业务数据）
 * - 返回：{ success, isAdmin, openid }（非管理员时 openid 为空字符串）
 */
async function actionCheckAdmin() {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return ok({ isAdmin: false, openid: "" });
  const admin = await isAdminOpenid(openid);
  return ok({ isAdmin: admin, openid: admin ? openid : "" });
}

// ---------- 管理员取帖子完整手机号（转发到朋友圈用）----------

/**
 * post_phone：取指定帖子的完整手机号 —— **管理员专属**。
 * 入参：{ postId }
 * 返回：{ success, phone }（帖子不存在时 phone 为空串）
 *
 * 为什么单独开这个 action？
 *   - C 端 payForPhone.reveal 有付费/会员门槛 + 单日频控（防批量抓号），管理员转发会被拦；
 *     而转发到朋友圈必须带真号（脱敏号发出去没法联系）。
 *   - 此前该能力挂在 wxTask（朋友圈转发任务中心）里，职责错配，且 wxTask 用 @cloudbase/node-sdk
 *     取小程序 openid 不可靠。现统一收到 adminAuth：
 *     · 它本身就是管理员专用云函数，鉴权走 exports.main 已统一的双通道（账密 RBAC / openid 管理员）；
 *     · 用 wx-server-sdk，getWXContext().OPENID 取值稳定。
 *   - 注意：本 action 在 switch 内分发，进入前已通过统一鉴权，无需再自行判权。
 */
async function actionPostPhone(event) {
  const postId = String(event.postId || event._id || "").trim();
  if (!postId) return fail("缺少 postId");
  try {
    const r = await db.collection(COLLECTION).doc(postId).get();
    const doc = r && r.data;
    const phone = String((doc && doc.phone) || "").trim();
    return ok({ phone });
  } catch (e) {
    // 帖子不存在 / 已被删除：返回空串而非报错，调用方可沿用脱敏号
    return ok({ phone: "" });
  }
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
  "credit_score", "published_at", "source",
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
  "credit_score", "seats", "latitude", "longitude",
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
  const username = String(event.user || "").trim();
  const pass = String(event.pass || "");
  if (!username || !pass) return fail("请输入账号和密码", "AUTH_FAILED");

  let acct = null;
  try {
    const r = await db
      .collection(ADMIN_ACCOUNTS)
      .where({ username })
      .limit(1)
      .get();
    acct = (r.data && r.data[0]) || null;
  } catch (e) {
    return fail("登录失败：" + String(e && e.message ? e.message : e));
  }
  if (!acct) return fail("账号或密码错误", "AUTH_FAILED");
  if (acct.status !== "active") return fail("该账号已被停用", "ACCOUNT_DISABLED");
  if (hashPass(pass, acct.salt) !== acct.pass_hash) {
    return fail("账号或密码错误", "AUTH_FAILED");
  }

  // 查角色权限（super_admin 直接返回全部权限点，供前端菜单/按钮控制）
  let roleName = "";
  let perms = [];
  try {
    const rr = await db.collection(ADMIN_ROLES).where({ role: acct.role }).limit(1).get();
    const roleDoc = (rr.data && rr.data[0]) || null;
    roleName = roleDoc ? roleDoc.name || "" : "";
    perms = (roleDoc && roleDoc.permissions) || [];
  } catch (e) {
    console.error("[adminAuth] 登录查询角色失败:", e && e.errMsg);
  }
  if (acct.role === SUPER_ROLE) {
    perms = Object.values(ACTION_PERM).filter((v, i, a) => a.indexOf(v) === i);
  }

  // 记录最后登录时间（失败不阻断）
  try {
    await db.collection(ADMIN_ACCOUNTS).doc(acct._id).update({
      data: { last_login_at: Date.now() },
    });
  } catch (e) {
    console.error("[adminAuth] 更新最后登录时间失败:", e && e.errMsg);
  }

  return ok({
    authed: true,
    user: acct.username,
    nickname: acct.nickname || acct.username,
    role: acct.role,
    role_name: roleName,
    permissions: perms,
  });
}

// ---------- 管理员账号 / 角色管理（仅 super_admin，action 映射 admin.manage）----------

/** 账号列表（不返回密码哈希/盐） */
async function actionAdminList(event) {
  try {
    let r;
    try {
      r = await db
        .collection(ADMIN_ACCOUNTS)
        .orderBy("created_at", "desc")
        .limit(200)
        .get();
    } catch (e) {
      // created_at 无索引时降级为普通查询
      r = await db.collection(ADMIN_ACCOUNTS).limit(200).get();
    }
    const list = (r.data || []).map((a) => ({
      _id: a._id,
      username: a.username,
      nickname: a.nickname || "",
      role: a.role,
      status: a.status || "active",
      last_login_at: a.last_login_at || 0,
      created_at: a.created_at || 0,
    }));
    return ok({ list, total: list.length });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新建管理员账号 */
async function actionAdminCreate(event) {
  const username = String(event.username || "").trim();
  // ⚠️ 初始密码字段用 new_pass（pass 是登录凭证字段，会被网关调用覆盖）
  const pass = String(event.new_pass !== undefined ? event.new_pass : "");
  const role = String(event.role || "").trim();
  if (!username) return fail("缺少登录名");
  if (!pass || pass.length < 6) return fail("密码至少 6 位");
  if (!role) return fail("缺少角色");
  try {
    // 用户名查重
    const dup = await db.collection(ADMIN_ACCOUNTS).where({ username }).count();
    if (dup.total > 0) return fail("登录名已存在");
    // 角色必须存在
    const roleOk = await db.collection(ADMIN_ROLES).where({ role }).count();
    if (roleOk.total === 0) return fail("角色不存在");
    const salt = genSalt();
    const now = Date.now();
    const res = await db.collection(ADMIN_ACCOUNTS).add({
      data: {
        username,
        pass_hash: hashPass(pass, salt),
        salt,
        role,
        nickname: String(event.nickname || username),
        status: "active",
        last_login_at: 0,
        created_at: now,
        updated_at: now,
      },
    });
    await writeLog(event, "admin_create", res._id, `${username}/${role}`);
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑账号：昵称 / 角色 / 状态 / 重置密码 */
async function actionAdminUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const cur = (await db.collection(ADMIN_ACCOUNTS).doc(event._id).get()).data;
    if (!cur) return fail("账号不存在");

    const data = {};
    if (event.nickname !== undefined) data.nickname = String(event.nickname);
    if (event.status !== undefined) {
      data.status = event.status === "disabled" ? "disabled" : "active";
      // 不允许停用自己，避免锁死
      if (cur.username === String(event.user)) return fail("不能停用当前登录账号");
    }
    if (event.role !== undefined && event.role !== "") {
      // 不允许把唯一的超管改成其他角色
      if (cur.role === SUPER_ROLE && event.role !== SUPER_ROLE) {
        const cnt = await db.collection(ADMIN_ACCOUNTS).where({ role: SUPER_ROLE }).count();
        if (cnt.total <= 1) return fail("至少保留一个超级管理员");
      }
      data.role = String(event.role);
    }
    // 重置密码
    // ⚠️ 新密码字段用 new_pass，不能用 pass：pass 是登录凭证字段，
    // 网关调用时前端会把登录密码写到 body.pass，若新密码也用 pass 会被覆盖导致「改了无效」。
    const newPass = event.new_pass !== undefined ? event.new_pass : event.pass;
    if (newPass !== undefined && newPass !== "") {
      if (String(newPass).length < 6) return fail("密码至少 6 位");
      const salt = genSalt();
      data.salt = salt;
      data.pass_hash = hashPass(String(newPass), salt);
    }
    if (!Object.keys(data).length) return fail("没有可更新的字段");
    data.updated_at = Date.now();

    await db.collection(ADMIN_ACCOUNTS).doc(event._id).update({ data });
    await writeLog(event, "admin_update", event._id, cur.username);
    return ok({ updated: true });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除账号 */
async function actionAdminDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const cur = (await db.collection(ADMIN_ACCOUNTS).doc(event._id).get()).data;
    if (!cur) return fail("账号不存在");
    if (cur.username === String(event.user)) return fail("不能删除当前登录账号");
    if (cur.role === SUPER_ROLE) {
      const cnt = await db.collection(ADMIN_ACCOUNTS).where({ role: SUPER_ROLE }).count();
      if (cnt.total <= 1) return fail("至少保留一个超级管理员");
    }
    await db.collection(ADMIN_ACCOUNTS).doc(event._id).remove();
    await writeLog(event, "admin_delete", event._id, cur.username);
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 角色列表（含权限点） */
async function actionRoleList() {
  try {
    let r;
    try {
      r = await db.collection(ADMIN_ROLES).orderBy("sort", "desc").limit(100).get();
    } catch (e) {
      r = await db.collection(ADMIN_ROLES).limit(100).get();
    }
    return ok({ list: r.data || [] });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 保存角色权限（内置角色仅允许改 permissions） */
async function actionRoleSave(event) {
  const role = String(event.role || "").trim();
  if (!role) return fail("缺少 role");
  const permissions = Array.isArray(event.permissions)
    ? event.permissions.filter((p) => typeof p === "string")
    : [];
  try {
    const exist = await db.collection(ADMIN_ROLES).where({ role }).limit(1).get();
    if (exist.data && exist.data.length) {
      // 不允许修改/删除超级管理员的权限（硬编码全量放行，改表无效但避免误导）
      if (role === SUPER_ROLE) return fail("超级管理员权限不可修改");
      await db.collection(ADMIN_ROLES).doc(exist.data[0]._id).update({
        data: { permissions, updated_at: Date.now() },
      });
      await writeLog(event, "role_save", exist.data[0]._id, role);
      return ok({ updated: true });
    }
    // 新增自定义角色
    const now = Date.now();
    const res = await db.collection(ADMIN_ROLES).add({
      data: {
        role,
        name: String(event.name || role),
        desc: String(event.desc || ""),
        permissions,
        builtin: false,
        sort: Number(event.sort) || 10,
        created_at: now,
        updated_at: now,
      },
    });
    await writeLog(event, "role_save", res._id, role);
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
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

// ---------- 审核结果 → 订阅消息（微信服务通知）----------
// 审核结果通知模板（与 sendSubscribeMsg 中 TMPL_CFG 的 key 保持一致）
const SUB_TMPL_AUDIT = "iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag";

/**
 * 审核通过/退回后，给发帖人推一条微信订阅消息。
 * 设计要点（保证不影响审核主流程）：
 *   ① 全程 try/catch，任何异常只打日志，绝不向上抛（审核结果已入库，不能被推送失败回滚）
 *   ② 用户未授权/次数用尽（43101）属正常业务结果，仅 warn 不报错
 *   ③ 需要发起人自己授权过「审核结果通知」模板（小程序端发布/查看我的发布时请求）
 * @param {string} toOpenid  接收人 openid
 * @param {boolean} passed   true=通过 / false=退回
 * @param {object} post      帖子快照（取内容做通知正文）
 * @param {object} event     原始事件（取 note 备注）
 */
async function pushReviewSubscribe(toOpenid, passed, post, event) {
  if (!toOpenid) return;
  try {
    // 取通知正文：优先原文摘要，其次"地区+角色"，最后兜底
    const raw = String((post && post.raw_text) || "").trim();
    const loc = [post && post.province, post && post.city].filter(Boolean).join("");
    const content = (raw || `${loc}${(post && post.role) || ""}信息`).slice(0, 20);
    const note = passed
      ? (event.note ? `审核备注：${event.note}` : "已公开展示，感谢发布")
      : (event.note ? `原因：${event.note}` : "请修改后重新提交");

    const res = await cloud.callFunction({
      name: "sendSubscribeMsg",
      data: {
        templateId: SUB_TMPL_AUDIT,
        toOpenid,
        result: passed ? "通过" : "驳回",
        content,
        remark: note.slice(0, 30),
        // 点击通知 → 详情页（退回的帖子可能不公开展示，仍跳详情，由详情页兜底提示）
        page: post && post._id ? `pages/detail/detail?id=${post._id}` : "pages/demo/demo",
      },
    });
    const r = (res && res.result) || {};
    if (r.success) {
      console.log("[adminAuth] 审核订阅消息已发送:", passed ? "通过" : "退回");
    } else if (r.errCode === 43101) {
      // 用户未订阅 → 正常情况（一次性订阅需用户每次授权），忽略
      console.log("[adminAuth] 审核订阅消息跳过（用户未订阅）");
    } else {
      console.warn("[adminAuth] 审核订阅消息发送失败:", r.errCode, r.error);
    }
  } catch (e) {
    console.error("[adminAuth] pushReviewSubscribe 异常:", e && (e.errMsg || e.message));
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
      // 审核通过 → 订阅消息（微信服务通知，真实推送）
      // 与站内通知独立：任一步失败互不影响；用户未授权(43101)属正常，静默跳过
      await pushReviewSubscribe(toOpenid, true, post, event);
    }

    await writeLog(event, "post_audit", event._id, event.note || "");
    return ok({ notified: !!toOpenid });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 审核退回（拒绝）：不通过，保留 needs_review 状态但标记 reviewed */
async function actionReject(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    // 先取帖子，退回时给发帖人推站内通知
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
        approved: false, // 结果型别名：退回=false
        reviewed: true,
        reviewed_at: Date.now(),
        review_note: event.note || "退回",
        status: "rejected", // 标记已退回
      },
    });

    // 退回 → 站内通知发帖人
    const toOpenid = post && post._openid;
    if (toOpenid) {
      try {
        await db.collection("baozi_messages").add({
          data: {
            type: "review",
            to_openid: toOpenid,
            title: "帖子审核退回",
            content: `您发布的帖子未通过审核，已被退回。${event.note ? `原因：${event.note}` : ""}`,
            post_id: event._id,
            read_by: [],
            sender: "admin",
            created_at: Date.now(),
          },
        });
      }
      catch (e) {
        console.error("adminAuth 推送退回通知失败:", e && e.errMsg);
      }
      // 退回 → 订阅消息（真实推送）
      await pushReviewSubscribe(toOpenid, false, post, event);
    }

    await writeLog(event, "post_reject", event._id, event.note || "退回");
    return ok({ notified: !!toOpenid });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 下架：status=offline（前端查询时排除，不删除数据） */
async function actionOffline(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(COLLECTION).doc(event._id).update({
      data: { status: "offline", updated_at: Date.now() },
    });
    await writeLog(event, "post_offline", event._id, "");
    return ok({ offline: 1 });
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 上架：取消下架（status 恢复为空/正常） */
async function actionOnline(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(COLLECTION).doc(event._id).update({
      data: { status: _.remove(), updated_at: Date.now() },
    });
    await writeLog(event, "post_online", event._id, "");
    return ok({ online: 1 });
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

/**
 * 设置用户角色（小程序管理员授予/撤销）—— 入参：_id, role("user"|"admin")
 *
 * 用途：小程序端「是否管理员」统一判定为 ADMIN_OPENIDS 白名单 + baozi_users.role==='admin'，
 *      本 action 让后台能在界面上给某个用户加/撤 admin，而不必手动改库。
 * 安全约束：role 只允许 user / admin（merchant 是业务角色，不从这里改，避免误伤）。
 * 说明：本 action 走后台账密 + RBAC（user.manage 权限）鉴权，调用者身份是后台账号而非微信 openid，
 *      因此不做「撤销自己」的 openid 比对（两者体系不同）；操作全程写 admin_logs 留痕可回溯。
 */
async function actionUserRole(event) {
  if (!event._id) return fail("缺少 _id");
  const role = String(event.role || "").trim();
  if (role !== "user" && role !== "admin") {
    return fail("不支持的角色（仅允许 user / admin）");
  }
  try {
    const cur = (await db.collection(USERS).doc(event._id).get()).data;
    if (!cur) return fail("用户不存在", "NOT_FOUND");

    const openid = String(cur.openid_wxapp || "").trim();

    // 1) 更新 baozi_users.role
    await db.collection(USERS).doc(event._id).update({
      data: { role, updated_at: Date.now() },
    });

    // 2) 同步维护 admin_openids 白名单集合（替代环境变量，纯数据库操作、即时生效）
    //    授予 admin -> 加入白名单；撤销 admin -> 移出白名单。
    //    openid 为空时跳过（无法入白名单，仅靠 role 字段，与历史行为一致）。
    if (openid) {
      if (role === "admin") {
        // 已存在则不重复插入（幂等）
        try {
          const exist = await db
            .collection(ADMIN_OPENIDS)
            .where({ openid })
            .limit(1)
            .get();
          if (!exist.data || !exist.data.length) {
            await db.collection(ADMIN_OPENIDS).add({
              data: { openid, remark: "后台用户管理授予", created_at: Date.now() },
            });
          }
        } catch (e) {
          console.error("[adminAuth] 写入 admin_openids 失败:", e && e.errMsg);
        }
      } else {
        // 撤销：删除该 openid 的全部白名单记录
        try {
          await db.collection(ADMIN_OPENIDS).where({ openid }).remove();
        } catch (e) {
          console.error("[adminAuth] 删除 admin_openids 失败:", e && e.errMsg);
        }
      }
    }

    await writeLog(event, role === "admin" ? "user_grant_admin" : "user_revoke_admin", event._id, openid);
    return ok({ role });
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

// ---------- 支付管理（§2.10）----------
// 集合：baozi_pay_orders（订单）、baozi_pay_records（付款记录）、baozi_phone_views（查看日志）
// 订单 biz_type：phone=付费看电话 / member=会员 / refresh=擦亮 / top=置顶 / merchant=商家入驻
// 订单 status：pending 待支付 / paid 已支付 / fulfilled 已履约
const PAY_ORDERS = "baozi_pay_orders";
const PAY_RECORDS = "baozi_pay_records";
const PHONE_VIEWS = "baozi_phone_views";

const PAY_BIZ_LABELS = {
  phone: "付费看电话", member: "会员开通", refresh: "信息擦亮",
  top: "信息置顶", merchant: "商家入驻",
};
const PAY_STATUS_LABELS = {
  pending: "待支付", paid: "已支付", fulfilled: "已履约",
};

/** 订单列表：支持 status / biz_type / keyword(订单号/openid/post_id) / 时间范围 筛选 + 分页 */
async function actionPayOrders(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(PAY_ORDERS);
    const conds = [];
    if (event.status) conds.push({ status: event.status });
    if (event.biz_type) conds.push({ biz_type: event.biz_type });

    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([
        { out_trade_no: reg },
        { openid: reg },
        { post_id: reg },
        { title: reg },
      ]));
    }

    // 时间范围（created_at）
    const range = {};
    const from = Number(event.created_from);
    const to = Number(event.created_to);
    if (event.created_from && !isNaN(from)) range.created_at = Object.assign(range.created_at || {}, { $gte: from });
    if (event.created_to && !isNaN(to)) range.created_at = Object.assign(range.created_at || {}, { $lte: to });
    if (Object.keys(range).length) conds.push(range);

    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    const res = await query.orderBy("created_at", "desc").get();

    // 关联查询：客户信息（baozi_users） + 帖子详情（baozi_posts），供「查看详情」弹窗展示
    const orders = res.data || [];
    const openids = [];
    const postIds = [];
    orders.forEach((o) => {
      if (o.openid && openids.indexOf(o.openid) < 0) openids.push(o.openid);
      if (o.post_id && postIds.indexOf(o.post_id) < 0) postIds.push(o.post_id);
    });

    // 客户信息（openid → 用户昵称/手机号/会员状态）
    const userMap = {};
    if (openids.length) {
      for (let i = 0; i < openids.length; i += 20) {
        const batch = openids.slice(i, i + 20);
        try {
          const uRes = await db.collection(USERS)
            .where({ openid_wxapp: _.in(batch) })
            .limit(100)
            .get();
          (uRes.data || []).forEach((u) => { userMap[u.openid_wxapp] = u; });
        } catch (e) {
          // 用户表异常不阻断订单列表
        }
      }
    }

    // 帖子详情（post_id → 完整帖子，供弹窗展示原始信息）
    const postMap = {};
    if (postIds.length) {
      for (let i = 0; i < postIds.length; i += 20) {
        const batch = postIds.slice(i, i + 20);
        try {
          const pRes = await db.collection(COLLECTION)
            .where({ _id: _.in(batch) })
            .limit(100)
            .get();
          (pRes.data || []).forEach((p) => { postMap[p._id] = p; });
        } catch (e) {
          // 帖子已删则留空
        }
      }
    }

    // 金额单位分 → 元 + 关联客户/帖子信息
    const list = orders.map((o) => {
      const u = userMap[o.openid] || null;
      const p = postMap[o.post_id] || null;
      return Object.assign({}, o, {
        biz_label: PAY_BIZ_LABELS[o.biz_type] || o.biz_type || "-",
        status_label: PAY_STATUS_LABELS[o.status] || o.status || "-",
        amount_yuan: o.amount != null ? (Number(o.amount) / 100) : 0,
        // 客户信息
        user: u ? {
          _id: u._id,
          openid: u.openid_wxapp || o.openid,
          username: u.username || u.nickname || "",
          phone: u.phone || "",
          phone_masked: u.phone_masked || "",
          membership: u.membership || "normal",
          membership_expire_at: u.membership_expire_at || 0,
          isVip: u.membership === "vip" && Number(u.membership_expire_at) > Date.now(),
        } : null,
        // 帖子详情
        post: p ? {
          _id: p._id,
          data_type: p.data_type || "",
          raw_text: p.raw_text || "",
          content: p.content || "",
          role: p.role || "",
          role_id: p.role_id || 0,
          salary: p.salary,
          salary_expect: p.salary_expect,
          price: p.price,
          monthly_rent: p.monthly_rent,
          area_sqm: p.area_sqm,
          province: p.province || "",
          city: p.city || "",
          district: p.district || "",
          address: p.address || "",
          phone: p.phone || "",
          phone_masked: p.phone_masked || "",
          contact: p.contact || "",
          username: p.username || "",
          tags: p.tags || [],
          published_at: p.published_at || 0,
          status: p.status || "",
          approved: p.approved,
          needs_review: p.needs_review,
        } : null,
      });
    });
    return ok({ list, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 付款记录列表：支持 keyword(openid/post_id) / 时间范围 筛选 + 分页 */
async function actionPayRecords(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(PAY_RECORDS);
    const conds = [];

    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([
        { openid: reg },
        { post_id: reg },
        { post_title: reg },
        { out_trade_no: reg },
      ]));
    }

    const range = {};
    const from = Number(event.created_from);
    const to = Number(event.created_to);
    if (event.created_from && !isNaN(from)) range.created_at = Object.assign(range.created_at || {}, { $gte: from });
    if (event.created_to && !isNaN(to)) range.created_at = Object.assign(range.created_at || {}, { $lte: to });
    if (Object.keys(range).length) conds.push(range);

    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    const res = await query.orderBy("created_at", "desc").get();

    // 关联查询：客户 + 帖子详情（与订单一致，供详情弹窗展示）
    const records = res.data || [];
    const openids = [];
    const postIds = [];
    records.forEach((r) => {
      if (r.openid && openids.indexOf(r.openid) < 0) openids.push(r.openid);
      if (r.post_id && postIds.indexOf(r.post_id) < 0) postIds.push(r.post_id);
    });

    const userMap = {};
    if (openids.length) {
      for (let i = 0; i < openids.length; i += 20) {
        const batch = openids.slice(i, i + 20);
        try {
          const uRes = await db.collection(USERS).where({ openid_wxapp: _.in(batch) }).limit(100).get();
          (uRes.data || []).forEach((u) => { userMap[u.openid_wxapp] = u; });
        } catch (e) {}
      }
    }

    const postMap = {};
    if (postIds.length) {
      for (let i = 0; i < postIds.length; i += 20) {
        const batch = postIds.slice(i, i + 20);
        try {
          const pRes = await db.collection(COLLECTION).where({ _id: _.in(batch) }).limit(100).get();
          (pRes.data || []).forEach((p) => { postMap[p._id] = p; });
        } catch (e) {}
      }
    }

    const list = records.map((r) => {
      const u = userMap[r.openid] || null;
      const p = postMap[r.post_id] || null;
      return Object.assign({}, r, {
        amount_yuan: r.total_fee != null ? (Number(r.total_fee) / 100) : 0,
        type_label: PAY_BIZ_LABELS[r.biz_type] || "",
        user: u ? {
          _id: u._id,
          openid: u.openid_wxapp || r.openid,
          username: u.username || u.nickname || "",
          phone: u.phone || "",
          phone_masked: u.phone_masked || "",
          membership: u.membership || "normal",
          isVip: u.membership === "vip" && Number(u.membership_expire_at) > Date.now(),
        } : null,
        post: p ? {
          _id: p._id,
          data_type: p.data_type || "",
          raw_text: p.raw_text || "",
          content: p.content || "",
          role: p.role || "",
          salary: p.salary,
          price: p.price,
          province: p.province || "",
          city: p.city || "",
          district: p.district || "",
          address: p.address || "",
          phone: p.phone || "",
          phone_masked: p.phone_masked || "",
          contact: p.contact || "",
          username: p.username || "",
          tags: p.tags || [],
          published_at: p.published_at || 0,
        } : null,
      });
    });
    return ok({ list, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 支付统计：订单总数 / 各状态数 / 各业务类型数 / 已履约金额合计（分） */
async function actionPayStats(event) {
  const out = {};
  const orders = db.collection(PAY_ORDERS);
  const records = db.collection(PAY_RECORDS);

  try { out.orders_total = (await orders.count()).total; } catch (e) { out.orders_total = 0; }
  try { out.records_total = (await records.count()).total; } catch (e) { out.records_total = 0; }

  // 各状态订单数
  out.orders_by_status = {};
  for (const s of ["pending", "paid", "fulfilled"]) {
    try { out.orders_by_status[s] = (await orders.where({ status: s }).count()).total; }
    catch (e) { out.orders_by_status[s] = 0; }
  }

  // 各业务类型订单数
  out.orders_by_biz = {};
  for (const b of ["phone", "member", "refresh", "top", "merchant"]) {
    try { out.orders_by_biz[b] = (await orders.where({ biz_type: b }).count()).total; }
    catch (e) { out.orders_by_biz[b] = 0; }
  }

  // 已履约订单金额合计（分）—— 聚合失败则置 0
  try {
    const agg = db.command.aggregate;
    const r = await orders.aggregate()
      .match({ status: "fulfilled" })
      .group({ _id: null, total: agg.sum("$amount") })
      .end();
    out.fulfilled_amount = (r.list && r.list[0] && r.list[0].total) || 0;
  } catch (e) {
    out.fulfilled_amount = 0;
  }

  // 今日新增订单 / 付款记录
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  try { out.orders_today = (await orders.where({ created_at: _.gte(dayStart.getTime()) }).count()).total; }
  catch (e) { out.orders_today = 0; }
  try { out.records_today = (await records.where({ created_at: _.gte(dayStart.getTime()) }).count()).total; }
  catch (e) { out.records_today = 0; }

  return ok(out);
}

// ---------- 行为埋点统计（baozi_events）----------
// 后台「埋点分析」看板专用：聚合 baozi_events 回答四个问题——
//   ① 看详情最多板块（post_detail_view 按 params.data_type）
//   ② 付费最多板块（pay_success 按 params.biz_type，含金额）
//   ③ 广告点击（ad_click 按 params.slot）
//   ④ 用户停留终点（page_leave 按 page）
// 聚合失败逐项降级为空，不拖垮整接口。
async function actionEventStats(event) {
  const out = {};
  const ev = db.collection("baozi_events");
  const agg = db.command.aggregate;

  // 时间范围：默认近 30 天
  const now = Date.now();
  const days = Math.max(1, Math.min(365, parseInt(event.days, 10) || 30));
  const since = now - days * 86400000;

  async function groupByEvent(eventName, groupField, sumField) {
    const groupExpr = sumField
      ? { _id: `$${groupField}`, count: agg.sum(1), amount: agg.sum(`$${sumField}`) }
      : { _id: `$${groupField}`, count: agg.sum(1) };
    const r = await ev
      .aggregate()
      .match({ event: eventName, ts: _.gte(since) })
      .group(groupExpr)
      .sort({ count: -1 })
      .limit(20)
      .end();
    return (r.list || []).map((x) => ({
      key: x._id || "未知",
      count: x.count || 0,
      amount: x.amount || 0,
    }));
  }

  // ① 看详情最多板块
  try { out.detail_by_type = await groupByEvent("post_detail_view", "params.data_type"); }
  catch (e) { out.detail_by_type = []; }

  // ② 付费最多板块（含金额）
  try { out.pay_by_biz = await groupByEvent("pay_success", "params.biz_type", "params.amount"); }
  catch (e) { out.pay_by_biz = []; }

  // ③ 广告点击
  try { out.ad_click_by_slot = await groupByEvent("ad_click", "params.slot"); }
  catch (e) { out.ad_click_by_slot = []; }

  // ④ 用户停留终点
  try { out.leave_by_page = await groupByEvent("page_leave", "page"); }
  catch (e) { out.leave_by_page = []; }

  // 汇总指标（近 N 天总量）
  const totals = {
    detail_total: "post_detail_view",
    pay_total: "pay_success",
    ad_click_total: "ad_click",
    page_view_total: "page_view",
  };
  for (const [k, eventName] of Object.entries(totals)) {
    try {
      out[k] = (await ev.where({ event: eventName, ts: _.gte(since) }).count()).total;
    } catch (e) {
      out[k] = 0;
    }
  }

  out.days = days;
  return ok(out);
}

// ---------- 用户行为流水（按 openid 查单个用户全部事件）----------
// 后台「用户管理」里点「行为链路」查看单个用户的操作记录：
// 按 _openid 精准匹配 baozi_events，按 ts 倒序分页返回。
// 不再做全局会话聚合（原 event_paths/event_sessions 已废弃删除）。
async function actionUserEvents(event) {
  const openid = String(event.openid || "").trim();
  if (!openid) return fail("缺少 openid");

  const ev = db.collection("baozi_events");
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 50));

  // 该用户事件总数
  let total = 0;
  try {
    total = (await ev.where({ _openid: openid }).count()).total;
  } catch (e) {
    console.error("[adminAuth] 统计用户事件数失败:", e && e.errMsg);
  }

  // 按 ts 倒序拉一页
  let list = [];
  try {
    const r = await ev
      .where({ _openid: openid })
      .orderBy("ts", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    list = r.data || [];
  } catch (e) {
    console.error("[adminAuth] 拉取用户事件失败:", e && e.errMsg);
  }

  return ok({ list, total, page, pageSize });
}

// ---------- 广告运营位管理（§2.9）----------
// 集合 advertisements，字段见文档 §2.9：
//   slot, type(banner/feed/popup), title, image, icon, emoji, sub, bgFrom, bgTo,
//   link, linkType(page/post/url/none), target, sort, status(online/offline),
//   start_at, end_at, pages[], created_at

/** 广告字段白名单（写库前清洗） */
const AD_FIELDS = [
  "slot", "type", "title", "image", "images", "icon", "emoji", "sub",
  "bgFrom", "bgTo", "link", "linkType", "target", "sort",
  "status", "start_at", "end_at", "pages", "page", "position",
  // 弹窗频控字段（仅 type=popup 生效）
  "freq", "freq_days", "freq_max",
  // 热门推荐卡片组字段（模块 4b：layout 区分 headline/mini，theme 区分 vip/group）
  "layout", "theme",
  "badge_text", "line1", "strong", "price", "cta_text", "headline_image",
  "icon_name", "bottom_text",
];
const AD_NUMBER_FIELDS = ["sort", "start_at", "end_at", "freq_days", "freq_max", "price"];
const AD_ARRAY_FIELDS = ["pages", "images"];

function sanitizeAd(input = {}) {
  const out = {};
  for (const k of AD_FIELDS) {
    if (input[k] === undefined || input[k] === null) continue;
    let v = input[k];
    if (AD_NUMBER_FIELDS.includes(k)) {
      if (v === "" || v === null) continue;
      v = Number(v);
      if (isNaN(v)) continue;
    }
    if (AD_ARRAY_FIELDS.includes(k)) {
      v = Array.isArray(v) ? v : (v === "" ? [] : String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean));
    }
    out[k] = v;
  }
  return out;
}

/** 广告列表：支持 slot/status 筛选 + 分页 */
async function actionAdList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(ADS);
    const conds = [];
    if (event.slot) conds.push({ slot: event.slot });
    if (event.status) conds.push({ status: event.status });
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    const res = await query.orderBy("sort", "desc").orderBy("created_at", "desc").get();
    return ok({ list: res.data, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新增广告 */
async function actionAdCreate(event) {
  const data = sanitizeAd(event.data || {});
  if (!data.slot) return fail("缺少广告位 slot");
  if (!data.type) return fail("缺少广告类型 type");
  try {
    const res = await db.collection(ADS).add({
      data: Object.assign({ created_at: Date.now() }, data),
    });
    await writeLog(event, "ad_create", res._id, data.slot || "");
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑广告 */
async function actionAdUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeAd(event.data || {});
  delete data._id;
  try {
    const res = await db.collection(ADS).doc(event._id).update({ data });
    await writeLog(event, "ad_update", event._id, data.slot || "");
    return ok({ updated: res.stats && res.stats.updated });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除广告（物理删除） */
async function actionAdDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(ADS).doc(event._id).remove();
    await writeLog(event, "ad_delete", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 上下线（改 status） */
async function actionAdToggle(event) {
  if (!event._id) return fail("缺少 _id");
  const status = event.status === "online" ? "online" : "offline";
  try {
    await db.collection(ADS).doc(event._id).update({ data: { status } });
    await writeLog(event, status === "online" ? "ad_online" : "ad_offline", event._id, "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ==================== 广告位管理（方案 C：ad_slots 数据驱动） ====================
// 广告位定义字段白名单
const AD_SLOT_FIELDS = [
  "slot", "page", "position", "type", "title", "sort", "status",
];
const AD_SLOT_NUMBER_FIELDS = ["sort"];

function sanitizeAdSlot(input = {}) {
  const out = {};
  for (const k of AD_SLOT_FIELDS) {
    if (input[k] === undefined || input[k] === null) continue;
    let v = input[k];
    if (AD_SLOT_NUMBER_FIELDS.includes(k)) {
      if (v === "" || v === null) continue;
      v = Number(v);
      if (isNaN(v)) continue;
    }
    out[k] = v;
  }
  return out;
}

/** 广告位列表：支持 page/status 筛选 */
async function actionAdSlotList(event) {
  try {
    const coll = db.collection(AD_SLOTS);
    const conds = [];
    if (event.page) conds.push({ page: event.page });
    if (event.status) conds.push({ status: event.status });
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;
    const res = hasWhere
      ? await coll.where(where).orderBy("sort", "desc").orderBy("created_at", "desc").limit(200).get()
      : await coll.orderBy("sort", "desc").orderBy("created_at", "desc").limit(200).get();
    return ok({ list: res.data });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新增广告位 */
async function actionAdSlotCreate(event) {
  const data = sanitizeAdSlot(event.data || {});
  if (!data.slot) return fail("缺少广告位标识 slot");
  if (!data.page) return fail("缺少所属页面 page");
  if (!data.position) return fail("缺少位置 position");
  try {
    // 同 slot 已存在则拒绝，避免重复
    const dup = await db.collection(AD_SLOTS).where({ slot: data.slot }).count();
    if (dup.total > 0) return fail("广告位标识已存在");
    const res = await db.collection(AD_SLOTS).add({
      data: Object.assign({ created_at: Date.now(), status: "online" }, data),
    });
    await writeLog(event, "ad_slot_create", res._id, `${data.page}/${data.position}`);
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑广告位 */
async function actionAdSlotUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeAdSlot(event.data || {});
  delete data._id;
  delete data.slot; // slot 是唯一标识，不允许改
  try {
    await db.collection(AD_SLOTS).doc(event._id).update({ data });
    await writeLog(event, "ad_slot_update", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除广告位（物理删除） */
async function actionAdSlotDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(AD_SLOTS).doc(event._id).remove();
    await writeLog(event, "ad_slot_delete", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 广告位上下线 */
async function actionAdSlotToggle(event) {
  if (!event._id) return fail("缺少 _id");
  const status = event.status === "online" ? "online" : "offline";
  try {
    await db.collection(AD_SLOTS).doc(event._id).update({ data: { status } });
    await writeLog(event, status === "online" ? "ad_slot_online" : "ad_slot_offline", event._id, "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ==================== 包友群管理（baozi_groups） ====================
// C 端口径（groupService）：{ _id, name, city, cover, qr_code, intro, member_count, sort, status, created_at }
// 管理端补齐：增 / 删 / 改（含封面、群二维码）、启停、排序。

const GROUP_FIELDS = ["name", "city", "cover", "qr_code", "intro", "member_count", "sort", "status"];
const GROUP_NUMBER_FIELDS = ["member_count", "sort"];

function sanitizeGroup(input = {}) {
  const out = {};
  for (const k of GROUP_FIELDS) {
    if (input[k] === undefined || input[k] === null) continue;
    let v = input[k];
    if (GROUP_NUMBER_FIELDS.includes(k)) {
      if (v === "" || v === null) continue;
      v = Number(v);
      if (isNaN(v)) continue;
    }
    out[k] = v;
  }
  return out;
}

/** 群列表：支持 keyword（群名/城市）、status 筛选 + 分页 */
async function actionGroupList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(GROUPS);
    const conds = [];
    if (event.status) conds.push({ status: event.status });
    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([{ name: reg }, { city: reg }, { intro: reg }]));
    }
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    let res;
    try {
      res = await query.orderBy("sort", "desc").orderBy("created_at", "desc").get();
    } catch (e) {
      res = await query.get();
    }
    return ok({ list: res.data || [], total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新增群 */
async function actionGroupCreate(event) {
  const data = sanitizeGroup(event.data || {});
  if (!data.name) return fail("缺少群名称");
  try {
    const res = await db.collection(GROUPS).add({
      data: Object.assign({ created_at: Date.now(), updated_at: Date.now(), status: "active" }, data),
    });
    await writeLog(event, "group_create", res._id, data.name || "");
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑群 */
async function actionGroupUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeGroup(event.data || {});
  delete data._id;
  data.updated_at = Date.now();
  try {
    const res = await db.collection(GROUPS).doc(event._id).update({ data });
    await writeLog(event, "group_update", event._id, data.name || "");
    return ok({ updated: res.stats && res.stats.updated });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除群（物理删除） */
async function actionGroupDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(GROUPS).doc(event._id).remove();
    await writeLog(event, "group_delete", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 群启停：status=active / disabled */
async function actionGroupToggle(event) {
  if (!event._id) return fail("缺少 _id");
  const status = event.status === "disabled" ? "disabled" : "active";
  try {
    await db.collection(GROUPS).doc(event._id).update({ data: { status, updated_at: Date.now() } });
    await writeLog(event, status === "active" ? "group_enable" : "group_disable", event._id, "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ==================== 包友圈商家管理（baozi_merchants） ====================
// C 端口径（merchantApply）：{ openid, name, category, address, latitude, longitude, phone,
//   business_hours, intro, avatar, photos[], wechat_qr, license_img, invite_code, plan,
//   status(pending/approved/rejected), reject_reason, created_at, updated_at }
// 管理端补齐：列表 / 详情 / 新建 / 编辑 / 审核(通过|驳回) / 删除。

const MERCHANT_CATEGORIES = [
  "供应商", "技术培训", "连锁品牌", "面粉辅料", "馅料面点", "饮品/其他", "厨具设备", "早餐培训",
];
const MERCHANT_FIELDS = [
  "name", "category", "address", "latitude", "longitude", "phone", "business_hours",
  "intro", "avatar", "photos", "wechat_qr", "license_img", "invite_code", "plan",
  "status", "reject_reason", "sort", "recommend",
];
const MERCHANT_NUMBER_FIELDS = ["latitude", "longitude", "sort"];
const MERCHANT_ARRAY_FIELDS = ["photos"];

function sanitizeMerchant(input = {}) {
  const out = {};
  for (const k of MERCHANT_FIELDS) {
    if (input[k] === undefined || input[k] === null) continue;
    let v = input[k];
    if (MERCHANT_ARRAY_FIELDS.includes(k)) {
      v = Array.isArray(v) ? v : (v === "" ? [] : String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean));
    } else if (MERCHANT_NUMBER_FIELDS.includes(k)) {
      if (v === "" || v === null) continue;
      v = Number(v);
      if (isNaN(v)) continue;
    } else if (k === "recommend") {
      v = v === true || v === "true" || v === 1 || v === "1";
    }
    out[k] = v;
  }
  return out;
}

/** 商家列表：支持 keyword / status / category 筛选 + 分页 */
async function actionMerchantList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(MERCHANTS);
    const conds = [];
    if (event.status) conds.push({ status: event.status });
    if (event.category) conds.push({ category: event.category });
    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([{ name: reg }, { address: reg }, { phone: reg }, { intro: reg }]));
    }
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    let res;
    try {
      res = await query.orderBy("created_at", "desc").get();
    } catch (e) {
      res = await query.get();
    }
    return ok({ list: res.data || [], total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 商家详情（含待审/驳回，供后台查看） */
async function actionMerchantGet(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const r = await db.collection(MERCHANTS).doc(event._id).get();
    return ok({ item: r.data });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新建商家（后台代录） */
async function actionMerchantCreate(event) {
  const data = sanitizeMerchant(event.data || {});
  if (!data.name) return fail("缺少店铺名称");
  if (data.category && MERCHANT_CATEGORIES.indexOf(data.category) < 0) return fail("分类不合法");
  try {
    const now = Date.now();
    const res = await db.collection(MERCHANTS).add({
      data: Object.assign({ status: "approved", reject_reason: "", created_at: now, updated_at: now }, data),
    });
    await writeLog(event, "merchant_create", res._id, data.name || "");
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑商家 */
async function actionMerchantUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = sanitizeMerchant(event.data || {});
  delete data._id;
  if (data.category && MERCHANT_CATEGORIES.indexOf(data.category) < 0) return fail("分类不合法");
  data.updated_at = Date.now();
  try {
    const res = await db.collection(MERCHANTS).doc(event._id).update({ data });
    await writeLog(event, "merchant_update", event._id, data.name || "");
    return ok({ updated: res.stats && res.stats.updated });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 审核商家：op=approve / reject（reject 可带 reason） */
async function actionMerchantAudit(event) {
  if (!event._id) return fail("缺少 _id");
  const op = event.op === "reject" ? "reject" : "approve";
  const status = op === "reject" ? "rejected" : "approved";
  try {
    await db.collection(MERCHANTS).doc(event._id).update({
      data: {
        status,
        reject_reason: op === "reject" ? String(event.reason || "") : "",
        reviewed_at: Date.now(),
        updated_at: Date.now(),
      },
    });
    await writeLog(event, op === "reject" ? "merchant_reject" : "merchant_approve", event._id, event.reason || "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除商家（物理删除） */
async function actionMerchantDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(MERCHANTS).doc(event._id).remove();
    await writeLog(event, "merchant_delete", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 全局配置开关（baozi_settings，key/value）----------
// 用于后台控制小程序端某些区块的显示/隐藏（如「包友圈展示」），
// 由 merchantApply 等 C 端云函数读取，前端零改动。

/** 读单个配置项（未配置返回 null） */
async function actionSettingGet(event) {
  const key = String(event.key || "").trim();
  if (!key) return fail("缺少 key");
  try {
    const r = await db.collection(SETTINGS).where({ key }).limit(1).get();
    const s = r.data && r.data[0];
    return ok({ key, value: s ? s.value : null });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 写单个配置项（upsert：已存在则更新，否则新建） */
async function actionSettingSet(event) {
  const key = String(event.key || "").trim();
  if (!key) return fail("缺少 key");
  // value 支持布尔/数字/字符串，原样存
  if (event.value === undefined || event.value === null) return fail("缺少 value");
  const now = Date.now();
  try {
    const r = await db.collection(SETTINGS).where({ key }).limit(1).get();
    if (r.data && r.data.length) {
      await db.collection(SETTINGS).doc(r.data[0]._id).update({
        data: { value: event.value, updated_at: now },
      });
    } else {
      await db.collection(SETTINGS).add({
        data: { key, value: event.value, updated_at: now },
      });
    }
    await writeLog(event, "setting_set", key, String(event.value));
    return ok({ key, value: event.value });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 举报 / 意见反馈管理（baozi_feedback）----------
// C 端提交走独立云函数 feedback(action=submit)；管理侧查询/处理在此统一入口，复用 RBAC。
const FEEDBACK = "baozi_feedback";

/** 反馈列表（分页 + kind/status/关键词筛选） */
async function actionFeedbackList(event) {
  try {
    const page = Math.max(parseInt(event.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 100);
    const and = [];
    const kind = String(event.kind || "").trim();
    if (kind === "report" || kind === "feedback") and.push({ kind });
    const status = String(event.status || "").trim();
    if (status) and.push({ status });
    const kw = String(event.keyword || "").trim();
    if (kw) {
      and.push(_.or([
        { content: db.RegExp({ regexp: kw, options: "i" }) },
        { reason: db.RegExp({ regexp: kw, options: "i" }) },
        { contact: db.RegExp({ regexp: kw, options: "i" }) },
      ]));
    }
    const query = and.length ? _.and(and) : {};
    const coll = db.collection(FEEDBACK);
    const countRes = await coll.where(query).count();
    const total = countRes.total;
    const res = await coll
      .where(query)
      .orderBy("created_at", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
    return ok({ list: res.data || [], total, page, pageSize, hasMore: page * pageSize < total });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 标记反馈处理结果：op=handled 已处理 / ignored 忽略 */
async function actionFeedbackHandle(event) {
  if (!event._id) return fail("缺少 _id");
  const op = event.op === "ignored" ? "ignored" : "handled";
  try {
    await db.collection(FEEDBACK).doc(event._id).update({
      data: {
        status: op,
        handle_note: String(event.note || "").slice(0, 200),
        // 记录处理人：后台账密账号名；小程序 openid 管理员（无 user）记为 mp_admin
        handled_by: String(event.user || event.__role || "admin"),
        handled_at: Date.now(),
      },
    });
    await writeLog(event, `feedback_${op}`, event._id, event.note || "");
    return ok({ status: op });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 待处理反馈数量（后台红点） */
async function actionFeedbackCount() {
  try {
    const res = await db.collection(FEEDBACK).where({ status: "pending" }).count();
    return ok({ pending: res.total });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 平台公告管理（baozi_messages 中 type=global）----------
// C 端读取走 notifyMsg（notice_latest / notice_list_c）；本组 action 是管理侧增删改查。
// 公告与站内通知共用集合：后台发一条公告，「消息」页与「公告」页同时可见、未读红点自然生效。

/** 公告字段清洗（只允许这几个字段入库，防脏字段） */
function cleanNotice(input = {}) {
  const out = {};
  if (input.title !== undefined) out.title = String(input.title || "").trim().slice(0, 60);
  if (input.content !== undefined) out.content = String(input.content || "").trim().slice(0, 2000);
  if (input.sort !== undefined) {
    const n = Number(input.sort);
    if (!isNaN(n)) out.sort = n;
  }
  if (input.status !== undefined) {
    out.status = input.status === "offline" ? "offline" : "online";
  }
  return out;
}

/** 公告管理列表：支持关键词 / 状态筛选 + 分页（含已下线） */
async function actionNoticeList(event) {
  try {
    const page = Math.max(parseInt(event.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 100);
    const coll = db.collection(MESSAGES);

    const conds = [{ type: "global" }];
    const status = String(event.status || "").trim();
    if (status === "online") conds.push({ status: _.neq("offline") });
    else if (status === "offline") conds.push({ status: "offline" });

    const kw = String(event.keyword || "").trim();
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([{ title: reg }, { content: reg }]));
    }
    const where = conds.length === 1 ? conds[0] : _.and(conds);

    const total = (await coll.where(where).count()).total;
    let res;
    try {
      res = await coll
        .where(where)
        .orderBy("sort", "desc")
        .orderBy("created_at", "desc")
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
    } catch (e) {
      res = await coll
        .where(where)
        .orderBy("created_at", "desc")
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
    }

    const list = (res.data || []).map((m) => ({
      _id: m._id,
      title: m.title || "",
      content: m.content || "",
      // 兼容旧公告：无 status 字段视为已上线
      status: m.status === "offline" ? "offline" : "online",
      sort: Number(m.sort) || 0,
      created_at: m.created_at || 0,
      updated_at: m.updated_at || 0,
    }));
    return ok({ list, total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 新建公告（type 固定 global，read_by 空数组） */
async function actionNoticeCreate(event) {
  const data = cleanNotice(event.data || {});
  if (!data.title && !data.content) return fail("公告需要标题或内容");
  try {
    const now = Date.now();
    const res = await db.collection(MESSAGES).add({
      data: Object.assign(
        {
          type: "global",
          to_openid: "",
          post_id: "",
          read_by: [],
          sender: String(event.user || "admin"),
          status: "online",
          sort: 0,
          created_at: now,
          updated_at: now,
        },
        data,
      ),
    });
    await writeLog(event, "notice_create", res._id, data.title || "");
    return ok({ _id: res._id });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 编辑公告 */
async function actionNoticeUpdate(event) {
  if (!event._id) return fail("缺少 _id");
  const data = cleanNotice(event.data || {});
  if (!Object.keys(data).length) return fail("没有可更新的字段");
  try {
    data.updated_at = Date.now();
    await db.collection(MESSAGES).doc(event._id).update({ data });
    await writeLog(event, "notice_update", event._id, data.title || "");
    return ok({ updated: true });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除公告（物理删除） */
async function actionNoticeDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    await db.collection(MESSAGES).doc(event._id).remove();
    await writeLog(event, "notice_delete", event._id, "");
    return ok();
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 公告上线 / 下线（软控制，不删数据） */
async function actionNoticeToggle(event) {
  if (!event._id) return fail("缺少 _id");
  const status = event.status === "offline" ? "offline" : "online";
  try {
    await db.collection(MESSAGES).doc(event._id).update({
      data: { status, updated_at: Date.now() },
    });
    await writeLog(event, status === "offline" ? "notice_offline" : "notice_online", event._id, "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

// ---------- 身份认证管理（baozi_identities，店主/师傅） ----------
// 商家身份走包友圈商家入驻（baozi_merchants），不在此管理。
// 每条记录对应一个身份的一次申请：{ openid, identity: 'owner'|'master', real_name, id_card, phone, address, license_img, photos[], status, ... }

const IDENTITY_TYPES = ["owner", "master"];
const IDENTITY_LABEL = { owner: "店主", master: "师傅" };

/** 身份认证列表：分页 + 状态/身份类型/关键词筛选 */
async function actionIdentityList(event) {
  try {
    const page = Math.max(1, parseInt(event.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize, 10) || 20));
    const coll = db.collection(IDENTITIES);
    const conds = [];
    if (event.status) conds.push({ status: event.status });
    const identity = String(event.identity || "").trim();
    if (identity && IDENTITY_TYPES.includes(identity)) {
      conds.push({ identity });
    }
    const kw = event.keyword ? String(event.keyword).trim() : "";
    if (kw) {
      const reg = db.RegExp({ regexp: escapeRegExp(kw), options: "i" });
      conds.push(_.or([{ real_name: reg }, { phone: reg }, { id_card: reg }, { address: reg }]));
    }
    const where = conds.length ? (conds.length === 1 ? conds[0] : _.and(conds)) : {};
    const hasWhere = conds.length > 0;

    const total = hasWhere ? (await coll.where(where).count()).total : (await coll.count()).total;
    const query = hasWhere
      ? coll.where(where).skip((page - 1) * pageSize).limit(pageSize)
      : coll.skip((page - 1) * pageSize).limit(pageSize);
    let res;
    try {
      res = await query.orderBy("created_at", "desc").get();
    } catch (e) {
      res = await query.get();
    }
    return ok({ list: res.data || [], total, page, pageSize });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 身份认证详情 */
async function actionIdentityGet(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    const r = await db.collection(IDENTITIES).doc(event._id).get();
    return ok({ item: r.data });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 审核身份认证：op=approve / reject（reject 可带 reason） */
async function actionIdentityAudit(event) {
  if (!event._id) return fail("缺少 _id");
  const op = event.op === "reject" ? "reject" : "approve";
  const status = op === "reject" ? "rejected" : "approved";

  try {
    // 1) 读申请记录
    const r = await db.collection(IDENTITIES).doc(event._id).get();
    const apply = r.data;
    if (!apply) return fail("申请不存在", "NOT_FOUND");

    // 2) 更新申请状态
    await db.collection(IDENTITIES).doc(event._id).update({
      data: {
        status,
        reject_reason: op === "reject" ? String(event.reason || "") : "",
        reviewed_by: String(event.user || event.__role || "admin"),
        reviewed_at: Date.now(),
        updated_at: Date.now(),
      },
    });

    // 3) 回写 baozi_users（审核通过时把该身份并入用户 identities）
    if (op === "approve") {
      const identity = apply.identity;
      try {
        const ur = await db.collection(USERS).where({ openid_wxapp: apply.openid }).limit(1).get();
        const user = ur.data && ur.data[0];
        if (user) {
          const existing = Array.isArray(user.identities) ? user.identities : [];
          const merged = [...new Set([...existing, identity])];
          await db.collection(USERS).doc(user._id).update({
            data: { identities: merged, updated_at: Date.now() },
          });
        }
      } catch (e) {
        console.error("[adminAuth] 回写用户认证身份失败:", e && e.errMsg);
      }
    }

    await writeLog(event, op === "reject" ? "identity_reject" : "identity_approve", event._id, event.reason || "");
    return ok({ status });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}

/** 删除身份认证申请（物理删除），同时从用户 identities 移除对应身份 */
async function actionIdentityDelete(event) {
  if (!event._id) return fail("缺少 _id");
  try {
    // 先读申请，拿到 openid 和 identity
    const r = await db.collection(IDENTITIES).doc(event._id).get();
    const apply = r.data;
    if (!apply) return fail("申请不存在", "NOT_FOUND");

    // 删除申请记录
    await db.collection(IDENTITIES).doc(event._id).remove();

    // 从用户 identities 移除对应身份
    const identity = apply.identity;
    if (identity) {
      try {
        const ur = await db.collection(USERS).where({ openid_wxapp: apply.openid }).limit(1).get();
        const user = ur.data && ur.data[0];
        if (user && Array.isArray(user.identities)) {
          const filtered = user.identities.filter((id) => id !== identity);
          await db.collection(USERS).doc(user._id).update({
            data: { identities: filtered, updated_at: Date.now() },
          });
        }
      } catch (e) {
        console.error("[adminAuth] 移除用户认证身份失败:", e && e.errMsg);
      }
    }

    await writeLog(event, "identity_delete", event._id, "");
    return ok();
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

  // 管理员身份校验：免口令（普通用户也需调用以判断自己是否为管理员，决定 AI 入口显隐）
  // 用服务端 OPENID 比对白名单，用户无法伪造，只返回 true/false 不泄露数据
  if (action === "check_admin") {
    return actionCheckAdmin();
  }

  // ==================== 鉴权：双通道（账密 RBAC / 小程序 openid） ====================
  // ① 账密通道：后台 Web 调用（带 user/pass）→ 查 admin_accounts → 验哈希 → 查角色权限（RBAC）
  // ② openid 通道：小程序调用（无账密，但有服务端 OPENID）
  //    - 命中 ADMIN_OPENIDS 白名单 或 baozi_users.role === 'admin' → 视为管理员，全量放行（A1）
  //    - 说明：OPENID 由服务端 getWXContext 取，用户无法伪造；后台 Web 经网关调用时 OPENID 为空，不会误放行
  let ctx = null;
  try {
    ctx = await authorize(event);
  } catch (e) {
    return fail("鉴权失败：" + String(e && e.message ? e.message : e));
  }

  if (!ctx) {
    // 账密未通过 → 尝试 openid 管理员通道（A1：命中即为超管级，放行全部管理 action）
    const { OPENID } = cloud.getWXContext();
    const byOpenid = await isAdminOpenid(OPENID || "");
    if (!byOpenid) {
      return fail("未授权：请先登录", "AUTH_FAILED");
    }
    // 以"小程序管理员"身份放行；角色记为 mp_admin 便于操作日志区分来源
    event.__role = "mp_admin";
  } else {
    if (ctx.forbidden) {
      return fail("无权限执行该操作：" + (ctx.need || action), "FORBIDDEN");
    }
    // 供 writeLog 记录操作人角色
    event.__role = ctx.role || "";
  }

  try {
    switch (action) {
      case "admin_list": return await actionAdminList(event);
      case "admin_create": return await actionAdminCreate(event);
      case "admin_update": return await actionAdminUpdate(event);
      case "admin_delete": return await actionAdminDelete(event);
      case "role_list": return await actionRoleList(event);
      case "role_save": return await actionRoleSave(event);
      case "list": return await actionList(event);
      case "get": return await actionGet(event);
      case "post_phone": return await actionPostPhone(event);
      case "create": return await actionCreate(event);
      case "update": return await actionUpdate(event);
      case "delete": return await actionDelete(event);
      case "audit": return await actionAudit(event);
      case "reject": return await actionReject(event);
      case "offline": return await actionOffline(event);
      case "online": return await actionOnline(event);
      case "list_tops": return await actionListTops(event);
      case "top": return await actionTop(event);
      case "users": return await actionUsers(event);
      case "member": return await actionMember(event);
      case "file_url": return await actionFileUrl(event);
      case "stats": return await actionStats(event);
      case "event_stats": return await actionEventStats(event);
      case "user_events": return await actionUserEvents(event);
      case "user_ban": return await actionUserBan(event);
      case "logs": return await actionLogs(event);
      case "ad_list": return await actionAdList(event);
      case "ad_create": return await actionAdCreate(event);
      case "ad_update": return await actionAdUpdate(event);
      case "ad_delete": return await actionAdDelete(event);
      case "ad_toggle": return await actionAdToggle(event);
      case "ad_slot_list": return await actionAdSlotList(event);
      case "ad_slot_create": return await actionAdSlotCreate(event);
      case "ad_slot_update": return await actionAdSlotUpdate(event);
      case "ad_slot_delete": return await actionAdSlotDelete(event);
      case "ad_slot_toggle": return await actionAdSlotToggle(event);
      case "pay_orders": return await actionPayOrders(event);
      case "pay_records": return await actionPayRecords(event);
      case "pay_stats": return await actionPayStats(event);
      case "user_role": return await actionUserRole(event);
      // 包友群管理
      case "group_list": return await actionGroupList(event);
      case "group_create": return await actionGroupCreate(event);
      case "group_update": return await actionGroupUpdate(event);
      case "group_delete": return await actionGroupDelete(event);
      case "group_toggle": return await actionGroupToggle(event);
      // 包友圈商家管理
      case "merchant_list": return await actionMerchantList(event);
      case "merchant_get": return await actionMerchantGet(event);
      case "merchant_create": return await actionMerchantCreate(event);
      case "merchant_update": return await actionMerchantUpdate(event);
      case "merchant_audit": return await actionMerchantAudit(event);
      case "merchant_delete": return await actionMerchantDelete(event);
      // 全局配置开关（如「包友圈展示」）
      case "setting_get": return await actionSettingGet(event);
      case "setting_set": return await actionSettingSet(event);
      // 举报 / 意见反馈管理
      case "feedback_list": return await actionFeedbackList(event);
      case "feedback_handle": return await actionFeedbackHandle(event);
      case "feedback_count": return await actionFeedbackCount(event);
      // 平台公告管理
      case "notice_list": return await actionNoticeList(event);
      case "notice_create": return await actionNoticeCreate(event);
      case "notice_update": return await actionNoticeUpdate(event);
      case "notice_delete": return await actionNoticeDelete(event);
      case "notice_toggle": return await actionNoticeToggle(event);
      // 身份认证管理
      case "identity_list": return await actionIdentityList(event);
      case "identity_get": return await actionIdentityGet(event);
      case "identity_audit": return await actionIdentityAudit(event);
      case "identity_delete": return await actionIdentityDelete(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  }
  catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
};
