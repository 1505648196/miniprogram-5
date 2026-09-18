// cloudfunctions/payForPhone/index.js
// 包子一哥 · 统一支付中心（付费看电话 + 会员开通）
//
// 下单/支付由集成中心的「微信支付」HTTP 云函数承担；本云函数负责：
//   1) create   ：服务端生成 out_trade_no + 服务端定价 + 落待支付订单（防伪造订单号/防改价）
//   2) verify   ：支付后校验订单（归属/金额/幂等）→ 履约（写付费记录 / 开通会员）
//   3) reveal   ：校验是否已付费 → 返回完整手机号（保持原语义）
//   4) list     ：我的付款记录（保持原语义）
//   5) markPaid ：兼容旧前端（直接写付费记录），新流程请用 create+verify
//
// ⚠️ 安全说明（必读）：
//   - out_trade_no 一律由本函数（服务端）生成，前端不可伪造订单。
//   - 金额一律由服务端按业务定价，前端传的金额不作为依据，杜绝改价。
//   - 履约按 out_trade_no 幂等：同一订单重复 verify 不会重复开通/重复记录。
//   - 严格模式：配置环境变量 PAY_STRICT_VERIFY=1 后，必须等支付回调把订单置为
//     paid 才允许履约（需先在集成中心把支付回调 ResourceName 配成 payCallback）。
//     未开启时采用「乐观履约 + 订单留痕」，保证用户付款后立即可用，订单表可对账。
//
// 完整手机号(phone)不下发到列表/详情，只在校验付费后按帖子返回，避免泄露。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = "baozi_posts";
const USERS = "baozi_users";
const PAY_RECORDS = "baozi_pay_records";
const PAY_ORDERS = "baozi_pay_orders"; // 订单表：out_trade_no 唯一
const PHONE_VIEWS = "baozi_phone_views"; // 电话查看日志（频控 + 泄露溯源）
const PUBLISH_QUOTA = "baozi_publish_quota"; // 发布凭证（先付款后入库：付费成功写一条 unused 凭证，入库时消费）

// 付费查看电话：2 元 = 200 分
const PHONE_FEE = 200;

// 发布信息：默认 2 元 = 200 分（会员免费发布，非会员付费）
const PUBLISH_FEE = 200;

// 擦亮（刷新，帖子重新排前）：5 毛 = 50 分
const REFRESH_FEE = 50;
// 置顶（首页置顶展示）：按天数阶梯定价（分），1天50元 / 3天150元 / 7天350元
const TOP_FEES = { 1: 5000, 3: 15000, 7: 35000 };
const TOP_DEFAULT_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000; // 1 天(毫秒)

// 商家入驻高级版定价（单位：分）——2999 元 = 299900 分
const MERCHANT_PRO_FEE = 299900;
const MERCHANT_PRO_NAME = "商家入驻高级版";

// 单日查看电话上限（防批量抓取；会员与非会员同样受限）
const DAY_VIEW_LIMIT = 20;

// 会员套餐定价（单位：分）——服务端权威定价，前端传价无效
// 正式定价：天卡 9.9 元 / 月卡 50 元 / 年卡 299 元
const PLAN_FEES = { day: 990, month: 5000, year: 29900 };
const PLAN_DAYS = { day: 1, month: 30, year: 365 };
const PLAN_NAMES = { day: "天卡", month: "月卡", year: "年卡" };

// 严格模式开关：需配合支付回调（集成中心把回调指向 payCallback）使用
const STRICT_VERIFY = process.env.PAY_STRICT_VERIFY === "1";

// 付款记录列表展示用的类型中文名（与 managePost 的 DATA_TYPE_NAMES 对齐）
const TYPE_NAMES = {
  recruit: "招工", jobseek: "求职", transfer: "转让", want_shop: "求店",
  equip_sell: "设备出售", equip_buy: "设备求购", carpool_car: "车找人",
  carpool_person: "人找车", other: "信息",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 生成商户订单号：BZ + 时间戳 + 随机（服务端生成，防伪造）
function genOutTradeNo() {
  return `BZ${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

// 是否已为该帖子付费（供 reveal 校验 + phone 履约幂等）
async function hasPaid(openid, postId) {
  const res = await db.collection(PAY_RECORDS)
    .where({ openid, post_id: postId })
    .limit(1)
    .get();
  return res.data && res.data.length > 0;
}

// 是否为有效会员（membership=vip 且未过期）→ 会员可免费查看/拨打电话
async function isVip(openid) {
  try {
    const r = await db.collection(USERS).where({ openid_wxapp: openid }).limit(1).get();
    const u = r.data && r.data[0];
    if (!u) return false;
    return u.membership === "vip" && Number(u.membership_expire_at) > Date.now();
  } catch (e) {
    console.error("[payForPhone] 会员状态查询失败:", e && e.errMsg);
    return false;
  }
}

// 今日 0 点时间戳（频控按自然日计算）
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 今日已查看过电话的帖子数（同一帖子当天重复查看不重复计数）
async function todayViewCount(openid) {
  try {
    const r = await db.collection(PHONE_VIEWS)
      .where({ openid, created_at: _.gte(todayStart()) })
      .count();
    return r.total || 0;
  } catch (e) {
    // 日志集合异常时放行，不阻断主流程
    console.error("[payForPhone] 查看日志查询失败:", e && e.errMsg);
    return 0;
  }
}

// 记录一次电话查看（溯源：谁在何时看了哪个帖子的电话）
async function logPhoneView(openid, postId, via) {
  try {
    await db.collection(PHONE_VIEWS).add({
      data: { openid, post_id: postId, via, created_at: Date.now() },
    });
  } catch (e) {
    console.error("[payForPhone] 写查看日志失败:", e && e.errMsg);
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "reveal";
  try {
    switch (action) {
      case "create": return await actionCreate(openid, event);
      case "verify": return await actionVerify(openid, event);
      case "reveal": return await actionReveal(openid, event);
      case "markPaid": return await actionMarkPaid(openid, event);
      case "check": return await actionCheck(openid, event);
      case "list": return await actionList(openid);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[payForPhone]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// ==================== create：服务端建单（防伪造 + 防改价）====================
async function actionCreate(openid, event) {
  const bizType = String(event.biz_type || "phone").trim();
  const now = Date.now();
  const doc = {
    out_trade_no: genOutTradeNo(),
    openid,
    biz_type: bizType,
    amount: 0,          // 单位：分
    title: "",
    status: "pending",  // pending 待支付 / paid 已支付(回调置位) / fulfilled 已履约
    post_id: "",
    plan: "",
    merchant_id: "",
    top_days: 0,        // 置顶天数（1/3/7，仅 biz_type=top 有效）
    created_at: now,
    updated_at: now,
  };

  if (bizType === "phone") {
    // 付费查看电话：固定 1 分钱，需校验帖子存在
    const postId = String(event.post_id || "").trim();
    if (!postId) return fail("缺少帖子标识", "MISSING_POST");
    let post = null;
    try {
      post = (await db.collection(COLLECTION).doc(postId).get()).data;
    } catch (e) {
      post = null;
    }
    if (!post) return fail("帖子不存在或已被删除", "NOT_FOUND");
    // 已付费则不必再下单，直接告诉前端可查看（幂等，避免重复扣费）
    if (await hasPaid(openid, postId)) {
      return ok({ already_paid: true, post_id: postId, out_trade_no: "", amount: 0 });
    }
    doc.amount = PHONE_FEE;
    doc.title = "查看联系电话";
    doc.post_id = postId;
  } else if (bizType === "member") {
    // 会员开通：按套餐定价（服务端权威）
    const plan = String(event.plan || "month").trim();
    const fee = PLAN_FEES[plan];
    if (!fee) return fail("不支持的会员套餐: " + plan, "BAD_PLAN");
    doc.amount = fee;
    doc.title = `开通会员(${PLAN_NAMES[plan] || plan})`;
    doc.plan = plan;
  } else if (bizType === "refresh") {
    // 擦亮（刷新）：帖子重新排前，需校验帖子存在且属于本人
    const postId = String(event.post_id || "").trim();
    if (!postId) return fail("缺少帖子标识", "MISSING_POST");
    let post = null;
    try {
      post = (await db.collection(COLLECTION).doc(postId).get()).data;
    } catch (e) {
      post = null;
    }
    if (!post) return fail("帖子不存在或已被删除", "NOT_FOUND");
    if (post._openid !== openid) return fail("无权操作该帖子", "FORBIDDEN");
    doc.amount = REFRESH_FEE;
    doc.title = "信息擦亮";
    doc.post_id = postId;
  } else if (bizType === "top") {
    // 置顶：写入 baozi_post_tops，需校验帖子存在且属于本人
    const postId = String(event.post_id || "").trim();
    if (!postId) return fail("缺少帖子标识", "MISSING_POST");
    let post = null;
    try {
      post = (await db.collection(COLLECTION).doc(postId).get()).data;
    } catch (e) {
      post = null;
    }
    if (!post) return fail("帖子不存在或已被删除", "NOT_FOUND");
    if (post._openid !== openid) return fail("无权操作该帖子", "FORBIDDEN");
    // 置顶天数：1/3/7，非法值回落 1 天
    const days = [1, 3, 7].indexOf(Number(event.days)) >= 0 ? Number(event.days) : TOP_DEFAULT_DAYS;
    const fee = TOP_FEES[days];
    if (!fee) return fail("不支持的置顶时长", "BAD_DAYS");
    doc.amount = fee;
    doc.title = `信息置顶 ${days} 天`;
    doc.post_id = postId;
    doc.top_days = days;
  } else if (bizType === "publish") {
    // 发布信息：固定 2 元。
    // ⚠️ 先付款后入库：下单时不依赖帖子（帖子尚不存在），只记「买了一次发布额度」。
    //    付款成功 verify 履约时写一条 baozi_publish_quota 凭证，入库时由 publishPost 消费。
    doc.amount = PUBLISH_FEE;
    doc.title = "发布信息";
    doc.post_id = ""; // 无 post_id（发布凭证制，不绑定具体帖子）
  } else if (bizType === "merchant") {
    // 商家入驻高级版：固定 2999 元，订单携带 merchant_id（下单前已创建入驻申请）
    const merchantId = String(event.merchant_id || "").trim();
    if (!merchantId) return fail("缺少入驻申请标识", "MISSING_MERCHANT");
    doc.amount = MERCHANT_PRO_FEE;
    doc.title = MERCHANT_PRO_NAME;
    doc.merchant_id = merchantId;
  } else {
    return fail("不支持的业务类型: " + bizType, "BAD_BIZ_TYPE");
  }

  try {
    const res = await db.collection(PAY_ORDERS).add({ data: doc });
    return ok({
      out_trade_no: doc.out_trade_no,
      amount: doc.amount,      // 分，供 wxpay_order 的 amount.total 使用
      title: doc.title,
      biz_type: doc.biz_type,
      _id: res._id,
    });
  } catch (e) {
    return fail("创建订单失败: " + (e && e.message ? e.message : e));
  }
}

// ==================== verify：支付后校验 + 履约（幂等）====================
async function actionVerify(openid, event) {
  const outTradeNo = String(event.out_trade_no || "").trim();
  if (!outTradeNo) return fail("缺少订单号", "MISSING_ORDER");

  // 1) 查订单（服务端订单号，前端伪造不出来）
  const ordRes = await db.collection(PAY_ORDERS)
    .where({ out_trade_no: outTradeNo })
    .limit(1)
    .get();
  const order = ordRes.data && ordRes.data[0];
  if (!order) return fail("订单不存在", "ORDER_NOT_FOUND");
  // 归属校验：只能核销自己的订单
  if (order.openid !== openid) return fail("无权操作该订单", "FORBIDDEN");

  // 2) 已履约 → 幂等直接返回成功（重复 verify 不重复开通/不重复记录）
  if (order.status === "fulfilled") {
    return ok({ fulfilled: true, already: true, biz_type: order.biz_type, out_trade_no: outTradeNo });
  }

  // 3) 严格模式：必须等支付回调置为 paid（回调把 status 改成 paid 或 fulfilled）
  if (STRICT_VERIFY && order.status !== "paid") {
    return fail("订单尚未确认支付，请稍候重试", "NOT_PAID");
  }

  // 4) 履约（按业务类型分别处理，内部各自幂等）
  try {
    if (order.biz_type === "phone") {
      await fulfillPhone(openid, order);
    } else if (order.biz_type === "member") {
      await fulfillMember(openid, order);
    } else if (order.biz_type === "merchant") {
      await fulfillMerchant(openid, order);
    } else if (order.biz_type === "refresh") {
      await fulfillRefresh(openid, order);
    } else if (order.biz_type === "top") {
      await fulfillTop(openid, order);
    } else if (order.biz_type === "publish") {
      await fulfillPublish(openid, order);
    } else {
      return fail("订单业务类型异常: " + order.biz_type, "BAD_BIZ_TYPE");
    }
  } catch (e) {
    console.error("[payForPhone] 履约失败:", e);
    return fail("处理失败: " + (e && e.message ? e.message : e));
  }

  // 5) 标记订单已履约
  try {
    await db.collection(PAY_ORDERS).doc(order._id).update({
      data: { status: "fulfilled", fulfilled_at: Date.now(), updated_at: Date.now() },
    });
  } catch (e) {
    console.error("[payForPhone] 更新订单状态失败:", e && e.errMsg);
  }

  // 6) 付费成功埋点（服务端权威，防前端伪造/丢失，覆盖 phone/member/refresh/top/merchant 全业务）
  await trackPaySuccess(openid, order);

  return ok({ fulfilled: true, already: false, biz_type: order.biz_type, out_trade_no: outTradeNo });
}

// 履约：付费查看电话 → 写付费记录（幂等）
async function fulfillPhone(openid, order) {
  const postId = order.post_id;
  if (!postId) throw new Error("订单缺少 post_id");
  if (await hasPaid(openid, postId)) return; // 已记录，幂等跳过

  // 关联帖子快照（标题/类型）：帖子被删时列表仍能显示买了什么
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
      total_fee: order.amount || PHONE_FEE, // 单位：分
      created_at: Date.now(),
    },
  });
}

// 开通会员成功通知模板（与 sendSubscribeMsg 的 TMPL_CFG key 保持一致）
const SUB_TMPL_MEMBER = "xea4n_3f_PAnULJ5kLZw1O5NMGM4J0f90pPU4pJIy40";

/**
 * 会员开通成功后，给用户推一条微信订阅消息（服务通知）。
 * 与站内通知独立：任一步失败互不影响；用户未授权(43101)属正常，静默跳过。
 * 全程 try/catch：任何异常只打日志，绝不向上抛，确保不影响会员开通主流程。
 * @param {string} openid 接收人 openid
 * @param {string} planName 套餐名（天卡/月卡/年卡）
 * @param {number} amountFen 支付金额（分）
 * @param {number} newExpire 到期时间戳（毫秒）
 */
async function pushMemberSubscribe(openid, planName, amountFen, newExpire) {
  if (!openid) return;
  try {
    const res = await cloud.callFunction({
      name: "sendSubscribeMsg",
      data: {
        templateId: SUB_TMPL_MEMBER,
        toOpenid: openid,
        content: planName || "会员",
        amount: String((Number(amountFen) || 0) / 100), // 分 → 元字符串
        time: newExpire ? fmtDate(newExpire) : "",
        remark: "感谢开通会员",
        page: "pages/vip/vip",
      },
    });
    const r = (res && res.result) || {};
    if (r.success) {
      console.log("[payForPhone] 会员订阅消息已发送:", planName);
    } else if (r.errCode === 43101) {
      console.log("[payForPhone] 会员订阅消息跳过（用户未订阅）:", planName);
    } else {
      console.warn("[payForPhone] 会员订阅消息发送失败:", r.errCode, r.error);
    }
  } catch (e) {
    console.error("[payForPhone] pushMemberSubscribe 异常:", e && (e.errMsg || e.message));
  }
}

// 履约：会员开通/续期 → 写 baozi_users + 推站内通知（幂等由 order.status 保证）
async function fulfillMember(openid, order) {
  const plan = order.plan || "month";
  const days = PLAN_DAYS[plan] || PLAN_DAYS.month;
  const planName = PLAN_NAMES[plan] || "月卡";
  const now = Date.now();

  const users = db.collection(USERS);
  const exist = (await users.where({ openid_wxapp: openid }).limit(1).get()).data;
  let user = exist && exist[0];

  if (!user) {
    // 兜底建号（与 getOrCreateUser 的关键字段保持一致，避免残缺用户）
    const doc = {
      openid_wxapp: openid,
      openid_mp: "",
      openid_web: "",
      openid_app: "",
      unionid: "",
      username: "",
      avatar: "",
      gender: 0,
      role: "user",
      status: "active",
      register_source: "wxapp",
      phone: "",
      phone_masked: "",
      phone_verified: false,
      email: "",
      membership: "normal",
      membership_expire_at: 0,
      credit_score: 100,
      credit_count: 0,
      remark: "",
      created_at: now,
      updated_at: now,
    };
    const add = await users.add({ data: doc });
    user = Object.assign({ _id: add._id }, doc);
  }

  // 续期：未到期则在原到期时间上顺延，否则从现在起算
  const base = user.membership === "vip" && Number(user.membership_expire_at) > now
    ? Number(user.membership_expire_at)
    : now;
  const newExpire = base + days * 86400000;

  await users.doc(user._id).update({
    data: { membership: "vip", membership_expire_at: newExpire, updated_at: now },
  });

  // 推一条 member 站内通知
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
    console.error("payForPhone 推送 member 通知失败:", e && e.errMsg);
  }

  // 会员开通成功 → 推微信订阅消息（服务通知）。用户未授权(43101)静默跳过，不影响开通。
  await pushMemberSubscribe(openid, planName, order.amount, newExpire);
}

// 履约：商家入驻高级版 → 把入驻申请置为「已支付高级版」状态（幂等由 order.status 保证）
async function fulfillMerchant(openid, order) {
  const merchantId = order.merchant_id;
  if (!merchantId) throw new Error("订单缺少 merchant_id");
  const now = Date.now();

  // 更新入驻申请：plan=pro、paid=true、pay_out_trade_no 留痕
  try {
    await db.collection("baozi_merchants").doc(merchantId).update({
      data: {
        plan: "pro",
        paid: true,
        paid_at: now,
        pay_out_trade_no: order.out_trade_no,
        updated_at: now,
      },
    });
  } catch (e) {
    console.error("[payForPhone] 更新入驻申请付费状态失败:", e && e.errMsg);
    throw e;
  }
}

// 履约：擦亮（刷新）→ 把帖子 published_at 更新为当前时间，重新排前（幂等由 order.status 保证）
async function fulfillRefresh(openid, order) {
  const postId = order.post_id;
  if (!postId) throw new Error("订单缺少 post_id");
  const now = Date.now();
  await db.collection(COLLECTION).doc(postId).update({
    data: { published_at: now, updated_at: now },
  });
}

// 履约：置顶 → 写入 baozi_post_tops（幂等由 order.status 保证）
// 记录结构：post_id + data_type + level + expire_at（按订单 top_days 计算）
async function fulfillTop(openid, order) {
  const postId = order.post_id;
  if (!postId) throw new Error("订单缺少 post_id");
  const now = Date.now();

  // 取帖子 data_type（置顶集合回查时按 data_type 命中）
  let dataType = "";
  try {
    const p = (await db.collection(COLLECTION).doc(postId).get()).data || {};
    dataType = p.data_type || "";
  } catch (e) {
    throw new Error("帖子不存在或已被删除");
  }

  // 置顶天数：订单里存的 top_days（1/3/7），非法回落 1 天
  const days = [1, 3, 7].indexOf(Number(order.top_days)) >= 0 ? Number(order.top_days) : TOP_DEFAULT_DAYS;
  const expireAt = now + days * DAY_MS;
  await db.collection("baozi_post_tops").add({
    data: {
      post_id: postId,
      data_type: dataType,
      level: 1,
      days,
      expire_at: expireAt,
      openid,
      out_trade_no: order.out_trade_no,
      created_at: now,
    },
  });
}

// 履约：发布信息 → 写一条「发布凭证」到 baozi_publish_quota（先付款后入库）。
// 幂等：同一 out_trade_no 只写一条（重复 verify 不重复发凭证，防止一人多付一次却发多次额度）。
// 凭证被 publishPost 消费后 status 由 unused → used，绑定 used_post_id。
async function fulfillPublish(openid, order) {
  const now = Date.now();
  const outTradeNo = order.out_trade_no;

  // 幂等：该订单是否已发过凭证
  const exist = await db
    .collection(PUBLISH_QUOTA)
    .where({ out_trade_no: outTradeNo })
    .limit(1)
    .get();
  if (exist.data && exist.data.length) return; // 已发过，跳过

  await db.collection(PUBLISH_QUOTA).add({
    data: {
      openid,
      out_trade_no: outTradeNo,
      status: "unused",   // unused 可用 / used 已消费
      used_post_id: "",   // 消费后回填帖子 id
      created_at: now,
    },
  });
}

// 付费成功埋点：覆盖 phone / member / refresh / top / merchant 全业务类型。
// 服务端权威：用户付了钱订单一定在服务端履约，埋点跟着履约走，前端杀不杀进程都无所谓。
// 写入 baozi_events，供后台统计「付费最多是哪个板块」（按 params.biz_type 聚合）。
async function trackPaySuccess(openid, order) {
  try {
    await db.collection("baozi_events").add({
      data: {
        event: "pay_success",
        ts: Date.now(),
        session_id: "",           // 服务端拿不到前端 session，留空由看板按 openid 聚合
        page: "",
        params: {
          biz_type: order.biz_type,   // 付费板块：phone/member/top/refresh/merchant/publish
          amount: Number(order.amount) || 0, // 单位：分
          post_id: order.post_id || "",
          plan: order.plan || "",
          top_days: order.top_days || 0,
          out_trade_no: order.out_trade_no,
        },
        _openid: openid,
        created_at: Date.now(),
      },
    });
  } catch (e) {
    console.error("[payForPhone] 埋点失败(不影响主流程):", e && e.errMsg);
  }
}

// ==================== reveal：会员免费 / 已付费 → 返回完整手机号 ====================
// 1) 放行条件：该帖已付费 **或** 当前是有效会员（会员免费）
// 2) 频控：单日查看「不同帖子」数达上限即拦截，防批量抓取
// 3) 溯源：每次新查看写 baozi_phone_views（谁在何时看了哪条信息的电话）
async function actionReveal(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少帖子标识", "MISSING_POST");

  const paid = await hasPaid(openid, postId);
  const vip = await isVip(openid);
  if (!paid && !vip) {
    return fail("尚未付费，请先支付后查看", "NOT_PAID");
  }

  let post;
  try {
    const res = await db.collection(COLLECTION).doc(postId).get();
    post = res.data;
  } catch (e) {
    return fail("帖子不存在或已被删除", "NOT_FOUND");
  }
  if (!post) return fail("帖子不存在或已被删除", "NOT_FOUND");

  const phone = String(post.phone || "").trim();
  if (!phone) return fail("该帖子未登记手机号", "NO_PHONE");

  // 频控：同一帖子当天已看过则不再计数，直接放行（避免重复点击被误伤）
  const dayStart = todayStart();
  let seen = false;
  try {
    const ex = await db.collection(PHONE_VIEWS)
      .where({ openid, post_id: postId, created_at: _.gte(dayStart) })
      .limit(1)
      .get();
    seen = !!(ex.data && ex.data.length);
  } catch (e) {
    seen = false;
  }

  if (!seen) {
    const cnt = await todayViewCount(openid);
    if (cnt >= DAY_VIEW_LIMIT) {
      return fail("今日查看次数已达上限，请明日再试", "LIMIT_EXCEEDED");
    }
    await logPhoneView(openid, postId, vip ? "vip" : "paid");
  }

  return ok({ phone, phone_masked: post.phone_masked || "", is_vip: vip });
}

// 轻量查询「是否已付费 / 是否会员」：供详情页进入时判断按钮文案（免费拨打 vs 付费查看）
// 不取完整号、不计频控、不记日志，只返回权限状态
async function actionCheck(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少帖子标识", "MISSING_POST");

  const paid = await hasPaid(openid, postId);
  const vip = await isVip(openid);
  return ok({ paid, is_vip: vip });
}

// 兼容旧前端：直接写付费记录（新流程请用 create + verify）
async function actionMarkPaid(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少帖子标识", "MISSING_POST");

  // 幂等：已存在则直接返回
  if (await hasPaid(openid, postId)) {
    return ok({ already: true });
  }

  try {
    // 关联帖子快照（标题/类型）
    let snapshot = { post_title: "", post_type: "" };
    try {
      const pRes = await db.collection(COLLECTION).doc(postId).get();
      const p = pRes.data || {};
      snapshot.post_title = String(p.raw_text || "").trim().split("\n")[0] || "";
      snapshot.post_type = p.data_type || "";
    } catch (e) {
      // 帖子已删则留空
    }

    await db.collection(PAY_RECORDS).add({
      data: {
        openid,
        post_id: postId,
        post_title: snapshot.post_title,
        post_type: snapshot.post_type,
        transaction_id: String(event.transaction_id || ""),
        out_trade_no: String(event.out_trade_no || ""),
        total_fee: Number(event.total_fee) || PHONE_FEE,
        created_at: Date.now(),
      },
    });
    return ok({ recorded: true });
  } catch (e) {
    return fail("记录付费状态失败: " + (e && e.message ? e.message : e));
  }
}

// 我的付款记录列表：本人全部付费记录，并关联帖子标题/类型/地区供列表展示
async function actionList(openid) {
  const res = await db.collection(PAY_RECORDS)
    .where({ openid })
    .orderBy("created_at", "desc")
    .limit(100)
    .get();
  const records = res.data || [];

  // 一次性取回关联帖子（帖子被删则查不到，用写入时冗余的 post_title 兜底）
  const postIds = [];
  records.forEach((r) => { if (r.post_id) postIds.push(r.post_id); });
  const postMap = {};
  if (postIds.length) {
    // 分批查询，避免 in 数量超限
    for (let i = 0; i < postIds.length; i += 20) {
      const batch = postIds.slice(i, i + 20);
      const pRes = await db.collection(COLLECTION)
        .where({ _id: db.command.in(batch) })
        .get();
      (pRes.data || []).forEach((p) => { postMap[p._id] = p; });
    }
  }

  const list = records.map((r) => {
    const p = postMap[r.post_id] || {};
    const title = String(p.raw_text || "").trim().split("\n")[0] || r.post_title || "";
    const region = [p.province, p.city, p.district].filter(Boolean).join("");
    return {
      post_id: r.post_id,
      title: title || "信息已删除或下架",
      typeName: TYPE_NAMES[p.data_type || r.post_type] || "信息",
      region,
      total_fee: Number(r.total_fee) || PHONE_FEE, // 单位：分
      out_trade_no: r.out_trade_no || "",
      created_at: r.created_at || 0,
    };
  });
  return ok({ list });
}
