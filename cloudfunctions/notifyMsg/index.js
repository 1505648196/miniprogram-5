// cloudfunctions/notifyMsg/index.js
// 站内通知（平台消息）：
//   - list：分页拉当前用户可见通知（global 全局 + to_openid==自己 的 review/member），附"我是否已读"与未读数
//   - read：把某条通知标记为当前用户已读（写 read_by）；也可全部已读(传 all=1)
//   - send：发一条通知（type: global/review/member；to_openid 空=全局，非空=发给该用户）—— 供后台/测试/后续自动推送用
//
// 集合 baozi_messages：
//   { _id, type, to_openid(空=全局), title, content, post_id, read_by:[openid], created_at }
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const COLLECTION = "baozi_messages";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  const action = event.action || "list";

  try {
    // send(发通知)属管理/后台操作，不要求登录身份；list/read 需要区分用户
    if (action === "send") {
      return await actionSend(openid, event);
    }
    if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");
    switch (action) {
      case "list": return await actionList(openid, event);
      case "read": return await actionRead(openid, event);
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

// 分页遍历当前用户全部可见通知（避免 get 默认 100 上限）
async function fetchVisible(openid, pageSize = 100) {
  const coll = db.collection(COLLECTION);
  const query = visibleCond(openid);
  const countRes = await coll.where(query).count();
  const total = countRes.total;
  const out = [];
  for (let skip = 0; skip < total; skip += pageSize) {
    const res = await coll
      .where(query)
      .orderBy("created_at", "desc")
      .skip(skip)
      .limit(pageSize)
      .get();
    out.push(...(res.data || []));
  }
  return { list: out, total };
}

// 分页拉可见通知：global(to_openid 为空) 或 to_openid==自己，按 created_at 倒序
// 每条附 isRead = openid ∈ read_by
async function actionList(openid, event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 30);
  const coll = db.collection(COLLECTION);
  const query = visibleCond(openid);

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

  // 未读数 = 可见且未读（全量遍历）
  const all = await fetchVisible(openid);
  let unread = 0;
  (all.list || []).forEach((m) => {
    const readBy = Array.isArray(m.read_by) ? m.read_by : [];
    if (readBy.indexOf(openid) < 0) unread += 1;
  });

  return ok({ list, total, page, pageSize, unread, hasMore: page * pageSize < total });
}

// 标记已读：传 id 标单条；传 all=1 标全部可见
async function actionRead(openid, event) {
  const coll = db.collection(COLLECTION);

  if (event.all) {
    const all = await fetchVisible(openid);
    let marked = 0;
    for (let i = 0; i < all.list.length; i += 1) {
      const m = all.list[i];
      const readBy = Array.isArray(m.read_by) ? m.read_by : [];
      if (readBy.indexOf(openid) < 0) {
        readBy.push(openid);
        await coll.doc(m._id).update({ data: { read_by: readBy, updated_at: Date.now() } });
        marked += 1;
      }
    }
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

// 发通知（平台/后台）：type 必填，title/content 至少一个
async function actionSend(openid, event) {
  const type = String(event.type || "global").trim();
  if (["global", "review", "member"].indexOf(type) < 0) {
    return fail("通知类型须为 global/review/member");
  }
  const title = String(event.title || "").trim();
  const content = String(event.content || "").trim();
  if (!title && !content) return fail("通知缺少 title/content");

  const doc = {
    type,
    // global 全局(to_openid 空)；review/member 需指定接收人，否则仅作全局兜底
    to_openid: type === "global" ? "" : String(event.to_openid || "").trim(),
    title,
    content,
    post_id: event.post_id ? String(event.post_id).trim() : "",
    read_by: [],
    sender: openid, // 记录谁/后台发的
    created_at: Date.now(),
  };
  const res = await db.collection(COLLECTION).add({ data: doc });
  return ok({ _id: res._id, type, to_openid: doc.to_openid });
}
