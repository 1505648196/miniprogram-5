// cloudfunctions/payForPhone/index.js
// 「查看完整电话」付费业务逻辑（下单/支付由集成中心的 pay-common HTTP 云函数承担）。
//
// - reveal：校验该用户是否已为此帖子付费；已付费则返回完整手机号，未付费返回 NOT_PAID
// - markPaid：前端在 wx.requestPayment 支付成功后调用，写入付费记录（openid + post_id）
//
// 下单链路（前端）：
//   wx.cloud.callHTTPFunction(集成云函数, path=/wx-pay/wxpay_order) → 拿 payment 参数
//   → wx.requestPayment 支付 → 成功后调本云函数 markPaid → 再 reveal 取完整号。
//
// 完整手机号(phone)不下发到列表/详情，只在本云函数校验付费后按 _id 返回，避免泄露。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = "baozi_posts";
const PAY_RECORDS = "baozi_pay_records";

// 付款记录列表展示用的类型中文名（与 managePost 的 DATA_TYPE_NAMES 对齐）
const TYPE_NAMES = {
  recruit: "招工", jobseek: "求职", transfer: "转让", want_shop: "求店",
  equip_sell: "设备出售", equip_buy: "设备求购", carpool_car: "车找人",
  carpool_person: "人找车", other: "信息",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 是否已为该帖子付费
async function hasPaid(openid, postId) {
  const res = await db.collection(PAY_RECORDS)
    .where({ openid, post_id: postId })
    .limit(1)
    .get();
  return res.data && res.data.length > 0;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "reveal";
  try {
    switch (action) {
      case "reveal": return await actionReveal(openid, event);
      case "markPaid": return await actionMarkPaid(openid, event);
      case "list": return await actionList(openid);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[payForPhone]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 校验付费后返回完整手机号
async function actionReveal(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少帖子标识", "MISSING_POST");

  if (!(await hasPaid(openid, postId))) {
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

  return ok({ phone, phone_masked: post.phone_masked || "" });
}

// 支付成功后写入付费记录（幂等）
async function actionMarkPaid(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少帖子标识", "MISSING_POST");

  // 幂等：已存在则直接返回
  if (await hasPaid(openid, postId)) {
    return ok({ already: true });
  }

  try {
    // 关联帖子快照（标题/类型）：帖子后续被删/下架时，付款记录列表仍能显示买了什么
    let snapshot = { post_title: "", post_type: "" };
    try {
      const pRes = await db.collection(COLLECTION).doc(postId).get();
      const p = pRes.data || {};
      snapshot.post_title = String(p.raw_text || "").trim().split("\n")[0] || "";
      snapshot.post_type = p.data_type || "";
    } catch (e) {
      // 帖子已删则留空，列表端走 post_id 反查失败后还能用 post_title 兜底
    }

    await db.collection(PAY_RECORDS).add({
      data: {
        openid,
        post_id: postId,
        post_title: snapshot.post_title,
        post_type: snapshot.post_type,
        transaction_id: String(event.transaction_id || ""),
        out_trade_no: String(event.out_trade_no || ""),
        total_fee: Number(event.total_fee) || 1,
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
    const pRes = await db.collection(COLLECTION)
      .where({ _id: db.command.in(postIds) })
      .get();
    (pRes.data || []).forEach((p) => { postMap[p._id] = p; });
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
      total_fee: Number(r.total_fee) || 1, // 单位：分
      out_trade_no: r.out_trade_no || "",
      created_at: r.created_at || 0,
    };
  });
  return ok({ list });
}
