// cloudfunctions/payCallback/index.js
// 微信支付回调（权威履约入口）：支付成功 → 按 out_trade_no 找到订单 → 履约 + 幂等
//
// ⚠️ 生效前提（控制台配置，非代码）：
//   需在「云开发控制台 → 集成中心 → 微信支付集成」把支付回调的资源类型设为云函数、
//   资源名设为 payCallback（对应集成云函数环境变量 notifyURLPayResourceType/Name）。
//   配好后，支付回调会打到本函数；未配置则本函数不会被调用（订单靠 verify 乐观履约）。
//
// 本函数由集成中心转发调用，调用方已是平台内部链路（微信侧已验签），
// 故此处不再重复验签，只做订单归属校验与幂等。
//
// 支持业务：
//   biz_type=phone  → 写 baozi_pay_records（付费查看电话）
//   biz_type=member → 开通/续期会员（写 baozi_users + 推站内通知）
//
// 幂等保证：
//   1) 订单维度：status 为 paid/fulfilled 时直接返回 duplicated，不重复履约。
//   2) 业务维度：phone 记录按 openid+post_id 查重；member 按订单只执行一次。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = "baozi_posts";
const USERS = "baozi_users";
const PAY_RECORDS = "baozi_pay_records";
const PAY_ORDERS = "baozi_pay_orders";

const PLAN_DAYS = { day: 1, month: 30, year: 365 };
const PLAN_NAMES = { day: "天卡", month: "月卡", year: "年卡" };

function ok(data = {}) { return { errcode: 0, errmsg: "ok", ...data }; }
function fail(errmsg) { return { errcode: -1, errmsg }; }

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 归一化事件：集成中心转发时可能包成 HTTP 事件（body 为 JSON 字符串），
// 也可能是直接对象 / 微信支付 v3 结构。统一摊平成可解析的对象。
function normalizeEvent(event) {
  let e = event || {};
  if (typeof e.body === 'string') {
    try {
      const parsed = JSON.parse(e.body);
      if (parsed && typeof parsed === 'object') {
        e = Object.assign({}, parsed, { __httpEvent: true });
      }
    } catch (err) {
      // body 不是 JSON，保留原事件
    }
  }
  return e;
}

// 从回调事件里提取商户订单号（兼容多种字段命名/嵌套）
function pickOutTradeNo(event) {
  const direct = ["out_trade_no", "outTradeNo", "out_trade_no_"];
  for (const k of direct) {
    if (event[k]) return String(event[k]).trim();
  }
  // 微信支付 v3 常见结构：resource 解密后 / event.data 里
  const candidates = [event.resource, event.data, event.order, event.body];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    if (c.out_trade_no) return String(c.out_trade_no).trim();
    if (c.outTradeNo) return String(c.outTradeNo).trim();
  }
  return "";
}

// 判断回调是否为「支付成功」（兼容多种字段命名）
function isPaid(event) {
  const vals = [
    event.resultCode, event.result_code, event.trade_state,
    event.tradeState, event.returnCode, event.return_code,
    event.status, event.state,
  ];
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).toUpperCase();
    if (s === "SUCCESS" || s === "PAID" || s === "0") return true;
  }
  // 嵌套结构（v3 解密后常见 attach/trade_state）
  const nested = [event.resource, event.data];
  for (const c of nested) {
    if (!c || typeof c !== "object") continue;
    const s = String(c.trade_state || c.tradeState || c.resultCode || "").toUpperCase();
    if (s === "SUCCESS") return true;
  }
  return false;
}

async function hasPhoneRecord(openid, postId) {
  const res = await db.collection(PAY_RECORDS)
    .where({ openid, post_id: postId })
    .limit(1)
    .get();
  return res.data && res.data.length > 0;
}

// 履约：付费查看电话
async function fulfillPhone(order) {
  const openid = order.openid;
  const postId = order.post_id;
  if (!postId) return;
  if (await hasPhoneRecord(openid, postId)) return; // 幂等

  let postTitle = "";
  let postType = "";
  try {
    const p = (await db.collection(COLLECTION).doc(postId).get()).data || {};
    postTitle = String(p.raw_text || "").trim().split("\n")[0] || "";
    postType = p.data_type || "";
  } catch (e) {
    // 帖子已删则留空
  }

  await db.collection(PAY_RECORDS).add({
    data: {
      openid,
      post_id: postId,
      post_title: postTitle,
      post_type: postType,
      out_trade_no: order.out_trade_no,
      total_fee: order.amount || 1,
      created_at: Date.now(),
    },
  });
}

// 履约：擦亮（刷新）→ published_at 置为当前时间
async function fulfillRefresh(order) {
  const postId = order.post_id;
  if (!postId) return;
  const now = Date.now();
  await db.collection(COLLECTION).doc(postId).update({
    data: { published_at: now, updated_at: now },
  });
}

// 履约：置顶 → 写入 baozi_post_tops（有效期 1 天）
async function fulfillTop(order) {
  const postId = order.post_id;
  if (!postId) return;
  const now = Date.now();
  let dataType = "";
  try {
    const p = (await db.collection(COLLECTION).doc(postId).get()).data || {};
    dataType = p.data_type || "";
  } catch (e) {
    return; // 帖子已删则不置顶
  }
  await db.collection("baozi_post_tops").add({
    data: {
      post_id: postId,
      data_type: dataType,
      level: 1,
      expire_at: now + 1 * 24 * 60 * 60 * 1000,
      openid: order.openid,
      out_trade_no: order.out_trade_no,
      created_at: now,
    },
  });
}

// 履约：会员开通/续期
async function fulfillMember(order) {
  const openid = order.openid;
  const plan = order.plan || "month";
  const days = PLAN_DAYS[plan] || PLAN_DAYS.month;
  const planName = PLAN_NAMES[plan] || "月卡";
  const now = Date.now();

  const users = db.collection(USERS);
  const exist = (await users.where({ openid_wxapp: openid }).limit(1).get()).data;
  let user = exist && exist[0];
  if (!user) {
    // 兜底建号（关键字段与 getOrCreateUser 对齐）
    const doc = {
      openid_wxapp: openid,
      openid_mp: "", openid_web: "", openid_app: "", unionid: "",
      username: "", avatar: "", gender: 0,
      role: "user", status: "active", register_source: "wxapp",
      phone: "", phone_masked: "", phone_verified: false, email: "",
      membership: "normal", membership_expire_at: 0,
      credit_score: 100, credit_count: 0,
      remark: "", created_at: now, updated_at: now,
    };
    const add = await users.add({ data: doc });
    user = Object.assign({ _id: add._id }, doc);
  }

  const base = user.membership === "vip" && Number(user.membership_expire_at) > now
    ? Number(user.membership_expire_at)
    : now;
  const newExpire = base + days * 86400000;

  await users.doc(user._id).update({
    data: { membership: "vip", membership_expire_at: newExpire, updated_at: now },
  });

  try {
    await db.collection("baozi_messages").add({
      data: {
        type: "member",
        to_openid: openid,
        title: "会员开通成功",
        content: `恭喜您开通「${planName}」，会员有效期至 ${fmtDate(newExpire)}。`,
        post_id: "",
        read_by: [],
        sender: "system",
        created_at: now,
      },
    });
  } catch (e) {
    console.error("[payCallback] 推送 member 通知失败:", e && e.errMsg);
  }
}

exports.main = async (event) => {
  console.log("[payCallback] 收到支付回调(原始):", JSON.stringify(event));
  const e = normalizeEvent(event);

  if (!isPaid(e)) {
    console.log("[payCallback] 非支付成功回调，忽略");
    return fail("not success");
  }

  const outTradeNo = pickOutTradeNo(e);
  if (!outTradeNo) {
    // 打全归一化后的事件，便于排查集成中心转发的真实字段结构
    console.log("[payCallback] 回调缺少 out_trade_no，归一化事件:", JSON.stringify(e));
    return fail("missing out_trade_no");
  }

  // 1) 查订单
  let order = null;
  try {
    const ordRes = await db.collection(PAY_ORDERS)
      .where({ out_trade_no: outTradeNo })
      .limit(1)
      .get();
    order = ordRes.data && ordRes.data[0];
  } catch (e) {
    console.error("[payCallback] 查询订单失败:", e && e.errMsg);
    return fail("query order failed");
  }

  if (!order) {
    console.log("[payCallback] 未找到订单:", outTradeNo);
    return fail("order not found");
  }

  // 2) 幂等：已支付/已履约直接返回
  if (order.status === "paid" || order.status === "fulfilled") {
    return ok({ duplicated: true, out_trade_no: outTradeNo });
  }

  // 3) 标记已支付
  try {
    await db.collection(PAY_ORDERS).doc(order._id).update({
      data: { status: "paid", paid_at: Date.now(), updated_at: Date.now() },
    });
  } catch (e) {
    console.error("[payCallback] 更新订单状态失败:", e && e.errMsg);
  }

  // 4) 履约（按业务类型）
  try {
    if (order.biz_type === "member") {
      await fulfillMember(order);
    } else if (order.biz_type === "refresh") {
      await fulfillRefresh(order);
    } else if (order.biz_type === "top") {
      await fulfillTop(order);
    } else {
      await fulfillPhone(order);
    }
  } catch (e) {
    console.error("[payCallback] 履约失败:", e && (e.errMsg || e.message));
    return fail(String(e && e.message ? e.message : e));
  }

  // 5) 标记已履约
  try {
    await db.collection(PAY_ORDERS).doc(order._id).update({
      data: { status: "fulfilled", fulfilled_at: Date.now(), updated_at: Date.now() },
    });
  } catch (e) {
    console.error("[payCallback] 更新履约状态失败:", e && e.errMsg);
  }

  return ok({ recorded: 1, out_trade_no: outTradeNo, biz_type: order.biz_type });
};
