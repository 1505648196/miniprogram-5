// cloudfunctions/payCallback/index.js
// 微信支付回调：支付成功时写入付费记录（openid + post_id），
// 供 payForPhone 的 reveal 校验「该用户是否已为此帖子付费」。
//
// 由 payForPhone 下单时 functionName 指定本函数；微信支付成功后云开发会回调本函数。
// event 包含微信支付回调字段，如 returnCode / resultCode / outTradeNo / openid 等。
//
// ⚠️ 关联方式：需要在 payForPhone 下单时把帖子 post_id 编码进 outTradeNo 之外，
//    或通过「附加数据 attach」传递。云调用的 unifiedOrder 支持 attach 字段，
//    回调里可从 event.attach 读取。若无 attach，则只能按 openid 记录（不精确到帖子）。
//    为稳妥，这里优先读 event.attach；若无，则退化为按 openid 记录一张「通用查看券」。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PAY_RECORDS = "baozi_pay_records";
const PAY_ORDERS = "baozi_pay_orders"; // 订单号 ↔ 帖子 映射

function ok(data = {}) { return { errcode: 0, errmsg: "ok", ...data }; }
function fail(errmsg) { return { errcode: -1, errmsg }; }

exports.main = async (event) => {
  console.log("[payCallback] 收到支付回调:", JSON.stringify(event));

  const returnCode = event.returnCode;
  const resultCode = event.resultCode;

  // 支付成功判定
  const success =
    resultCode === "SUCCESS" ||
    returnCode === "SUCCESS" ||
    event.trade_state === "SUCCESS";

  if (!success) {
    console.log("[payCallback] 支付未成功，忽略:", returnCode, resultCode);
    return fail("not success");
  }

  const openid = event.openid || event.sub_openid || "";
  const outTradeNo = event.out_trade_no || event.outTradeNo || "";

  if (!openid) {
    console.log("[payCallback] 缺少 openid，无法记录");
    return fail("missing openid");
  }

  // 1) 用订单号反查 post_id（精确关联到具体帖子，避免一次付费看全部）
  let postId = event.attach || event.post_id || "";
  if (!postId && outTradeNo) {
    try {
      const orderRes = await db.collection(PAY_ORDERS)
        .where({ out_trade_no: outTradeNo })
        .limit(1)
        .get();
      if (orderRes.data && orderRes.data.length) {
        postId = orderRes.data[0].post_id || "";
        // openid 以映射表为准（更可靠）
        if (!openid && orderRes.data[0].openid) {
          // openid 已在上面从 event 取，这里仅兜底
        }
      }
    } catch (e) {
      console.error("[payCallback] 反查订单映射失败:", e && e.errMsg);
    }
  }

  // 仍拿不到 post_id，则只能按 openid 记一条通用记录（退化兜底）
  if (!postId) {
    console.log("[payCallback] 未找到 post_id，退化按 openid 记录");
    postId = `openid:${openid}`;
  }

  try {
    // 幂等：同一 openid + post_id 只记一条
    const exist = await db.collection(PAY_RECORDS)
      .where({ openid, post_id: String(postId) })
      .limit(1)
      .get();

    if (exist.data && exist.data.length) {
      return ok({ duplicated: true });
    }

    await db.collection(PAY_RECORDS).add({
      data: {
        openid,
        post_id: String(postId),
        transaction_id: event.transaction_id || event.transactionId || "",
        out_trade_no: outTradeNo,
        total_fee: event.total_fee || event.totalFee || 1,
        created_at: Date.now(),
      },
    });

    return ok({ recorded: 1 });
  } catch (e) {
    console.error("[payCallback] 写付费记录失败:", e && e.errMsg);
    return fail(String(e && e.message ? e.message : e));
  }
};
