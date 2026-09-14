// cloudfunctions/notifyMsg/index.js
// 站内通知（平台消息）—— 仅负责 C 端读取
//
// 【动作一览】
//   list          分页拉当前用户可见通知（global 全局 + to_openid==自己 的 review/member），附「我是否已读」与未读数
//   read          把某条通知标记为当前用户已读（写 read_by）；也可全部已读(传 all=1)
//   notice_latest 取最新一条「已上线」公告，供「我的」页公告条展示（无则返回 notice: null）
//   notice_list_c 分页拉「已上线」公告列表，供公告列表页展示（只含 type=global 且未下线）
//   send          发一条非公告类通知（review/member 定向推送），保留原有免鉴权能力
//
// 【集合 baozi_messages】
//   { _id, type, to_openid(空=全局), title, content, post_id, read_by:[openid],
//     status('online'|'offline', 仅 global 公告用；缺省视为 online 兼容旧数据),
//     sort(仅公告：越大越靠前), sender, created_at, updated_at }
//
// 【设计说明】
//   · 公告复用本集合（type='global'），而非另建集合：后台发一条公告，
//     「消息」页与「公告」页同时可见、未读红点也自然生效，避免同一条公告维护两处。
//   · **本函数不再承担管理能力**：公告的增删改查（notice_list/create/update/delete/toggle）
//     统一放在 adminAuth，复用其已验证的 RBAC 双通道鉴权。
//     原因：本函数未配置 ADMIN_USER/ADMIN_PASS 环境变量（Environment.Variables 为空），
//     若在此自行校验账密会回落到默认口令 admin/admin，等于把管理入口暴露给任何人。
//     放在 adminAuth 可避免口令散落多处，也不需要为本函数补配环境变量。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const COLLECTION = "baozi_messages";

// 公告列表每页上限（C 端）
const NOTICE_PAGE_MAX = 50;

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  const action = event.action || "list";

  try {
    // send(发通知)属管理/后台操作，不要求登录身份；其余 action 需要区分用户
    if (action === "send") {
      return await actionSend(openid, event);
    }
    if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");
    switch (action) {
      case "list": return await actionList(openid, event);
      case "read": return await actionRead(openid, event);
      case "notice_latest": return await actionNoticeLatest();
      case "notice_list_c": return await actionNoticeListC(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[notifyMsg]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 可见条件：global(to_openid 空/不存在) 或 to_openid==自己
function visibleCond(openid) {
  return _.or([
    { to_openid: "" },
    { to_openid: _.exists(false) },
    { to_openid: openid },
  ]);
}

// 「公告已上线」条件：type=global 且 status 不为 offline
//   —— 兼容旧数据：历史公告没有 status 字段，视为已上线（不因新增字段导致老公告消失）
function noticeOnlineCond() {
  return _.and([
    { type: "global" },
    _.or([{ status: "online" }, { status: _.exists(false) }]),
  ]);
}

// 分页拉可见通知：global(to_openid 为空) 或 to_openid==自己，按 created_at 倒序
// 每条附 isRead = openid ∈ read_by
async function actionList(openid, event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 30);
  const coll = db.collection(COLLECTION);

  // 已下线的公告不再出现在消息列表（review/member 不受影响）
  const query = _.and([
    visibleCond(openid),
    _.or([{ type: _.neq("global") }, { status: _.neq("offline") }]),
  ]);

  const countRes = await coll.where(query).count();
  const total = countRes.total;
  const res = await coll
    .where(query)
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const list = (res.data || []).map((m) => {
    const readBy = Array.isArray(m.read_by) ? m.read_by : [];
    return {
      _id: m._id,
      type: m.type || "global",
      title: m.title || "",
      content: m.content || "",
      post_id: m.post_id || "",
      created_at: m.created_at || 0,
      isRead: readBy.indexOf(openid) >= 0,
    };
  });

  // 未读数 = 可见总数(total) − 已读条数。只用一次 count，不遍历全表。
  // 用 _.all 判断 read_by 数组含 openid：对 read_by 字段缺失的旧数据不会误判为已读，
  // 缺失即「未读」→ 自然落入 total−read 的差值，语义与原实现一致。
  const readRes = await coll.where(_.and([query, { read_by: _.all([openid]) }])).count();
  const unread = Math.max(total - readRes.total, 0);

  return ok({ list, total, page, pageSize, unread, hasMore: page * pageSize < total });
}

// 标记已读：传 id 标单条；传 all=1 标全部可见
async function actionRead(openid, event) {
  const coll = db.collection(COLLECTION);

  if (event.all) {
    // 批量标记已读，替代原「逐条串行 doc.update」→ N 条未读 = N 次写库放大。
    // 分两段批量，避免对"字段缺失"用 _.push 的潜在不确定性：
    //   段①  read_by 字段存在(数组)且未含我 → 用 _.push 追加（字段必存在，push 安全，且不覆盖其他已读用户）
    //   段②  read_by 字段缺失的历史脏数据 → 用整体赋值 read_by:[openid]（本无字段，直接建，不会丢他人已读）
    // 正常消息由 actionSend 创建时恒写 read_by:[]，故段①覆盖绝大多数、段②几乎不触发。
    let marked = 0;

    const pushRes = await coll
      // 段① 仅命中 read_by 字段存在 且 未含我 的数组（_.exists(true) 排除缺失字段，
      // 避免对缺失字段执行 _.push 的潜在不确定性；缺失字段留给段②整体赋值）
      .where(_.and([visibleCond(openid), { read_by: _.exists(true) }, { read_by: _.nin([openid]) }]))
      .update({ data: { read_by: _.push([openid]), updated_at: Date.now() } });
    marked += pushRes.stats ? pushRes.stats.updated : (pushRes.updated || 0);

    const missingRes = await coll
      .where(_.and([visibleCond(openid), { read_by: _.exists(false) }]))
      .update({ data: { read_by: [openid], updated_at: Date.now() } });
    marked += missingRes.stats ? missingRes.stats.updated : (missingRes.updated || 0);

    return ok({ marked });
  }

  if (!event._id) return fail("缺少 _id");
  const m = (await coll.doc(event._id).get()).data;
  if (!m) return fail("通知不存在", "NOT_FOUND");
  // 校验是否可见：global 或发给该用户
  const isVisible = !m.to_openid || m.to_openid === openid;
  if (!isVisible) return fail("无权操作该通知", "FORBIDDEN");
  const readBy = Array.isArray(m.read_by) ? m.read_by : [];
  if (readBy.indexOf(openid) < 0) {
    readBy.push(openid);
    await coll.doc(event._id).update({ data: { read_by: readBy, updated_at: Date.now() } });
  }
  return ok({ marked: 1 });
}

// ---------------- C 端：公告读取 ----------------

/**
 * 取最新一条已上线公告（供「我的」页公告条展示）
 * 无公告时返回 notice: null —— 由前端决定展示"暂无公告"。
 * 优先按 sort 倒序（运营可置顶重点公告），其次 created_at。
 */
async function actionNoticeLatest() {
  const coll = db.collection(COLLECTION);
  let res;
  try {
    res = await coll
      .where(noticeOnlineCond())
      .orderBy("sort", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .get();
  } catch (e) {
    // sort 字段无索引时降级为仅按时间排序
    res = await coll.where(noticeOnlineCond()).orderBy("created_at", "desc").limit(1).get();
  }
  const m = (res.data || [])[0] || null;
  return ok({
    notice: m
      ? { _id: m._id, title: m.title || "", content: m.content || "", created_at: m.created_at || 0 }
      : null,
  });
}

/**
 * 分页拉已上线公告列表（供公告列表页）
 * 入参：page, pageSize（≤50）
 */
async function actionNoticeListC(event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), NOTICE_PAGE_MAX);
  const coll = db.collection(COLLECTION);
  const cond = noticeOnlineCond();

  const total = (await coll.where(cond).count()).total;
  let res;
  try {
    res = await coll
      .where(cond)
      .orderBy("sort", "desc")
      .orderBy("created_at", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
  } catch (e) {
    res = await coll
      .where(cond)
      .orderBy("created_at", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();
  }

  const list = (res.data || []).map((m) => ({
    _id: m._id,
    title: m.title || "",
    content: m.content || "",
    created_at: m.created_at || 0,
  }));
  return ok({ list, total, page, pageSize, hasMore: page * pageSize < total });
}

// ---------------- 发通知（非公告类） ----------------

/**
 * 发通知（平台/后台）：type 必填，title/content 至少一个
 *
 * ⚠️ 保留原有的免鉴权行为（供后台通知页推送 review/member 定向消息）。
 *    但 **global 类型不再放行**：公告统一走 adminAuth 的 notice_create 管理，
 *    避免绕过公告管理（列表/下线/排序）直接塞一条 global 进来。
 * @param {string} openid 调用者 openid（记录 sender 用）
 * @param {object} event  含 type/title/content/to_openid/post_id
 */
async function actionSend(openid, event) {
  const type = String(event.type || "").trim();
  if (["review", "member"].indexOf(type) < 0) {
    return fail(
      type === "global"
        ? "公告请使用「公告管理」新建（adminAuth.notice_create）"
        : "此处仅支持发送 review/member 类型通知",
    );
  }
  const toOpenid = String(event.to_openid || "").trim();
  if (!toOpenid) return fail("review/member 通知需要指定接收人 to_openid");

  const title = String(event.title || "").trim();
  const content = String(event.content || "").trim();
  if (!title && !content) return fail("通知缺少 title/content");

  const doc = {
    type,
    to_openid: toOpenid,
    title,
    content,
    post_id: event.post_id ? String(event.post_id).trim() : "",
    read_by: [],
    sender: openid,
    created_at: Date.now(),
  };
  const res = await db.collection(COLLECTION).add({ data: doc });
  return ok({ _id: res._id, type, to_openid: doc.to_openid });
}
