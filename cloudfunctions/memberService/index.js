// cloudfunctions/memberService/index.js
// 会员开通（当前为"模拟支付"阶段：activate 直接当支付成功处理，将来接真实 wx.requestPayment 时
// 只需把"前端拉起支付成功后调用 activate"改成"微信支付回调里调用"，逻辑不变）
//
// - activate：把当前用户开通为会员（写 baozi_users.membership/membership_expire_at）+ 推 member 站内通知
//   plan: month(30天)/quarter(90天)/year(365天)；可在现有到期上顺延，过期则从现在起算
// - status：查当前用户会员状态
// - cancel(可选调试)：手动取消会员（仅供测试）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PLAN_DAYS = {
  month: 30,
  quarter: 90,
  year: 365,
};
const PLAN_NAMES = {
  month: "月卡",
  quarter: "季卡",
  year: "年卡",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "status";
  try {
    switch (action) {
      case "status": return await actionStatus(openid);
      case "activate": return await actionActivate(openid, event);
      case "cancel": return await actionCancel(openid);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[memberService]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

async function getOrCreateUser(openid) {
  const users = db.collection("baozi_users");
  const exist = (await users.where({ openid_wxapp: openid }).limit(1).get()).data;
  if (exist.length) return { user: exist[0], isNew: false };
  // 与 getOrCreateUser 建号一致地补一个（缺省字段兜底）
  const now = Date.now();
  const doc = {
    openid_wxapp: openid,
    username: "",
    avatar: "",
    membership: "normal",
    membership_expire_at: 0,
    created_at: now,
    updated_at: now,
  };
  const res = await users.add({ data: doc });
  return { user: Object.assign({ _id: res._id }, doc), isNew: true };
}

// 会员状态：isVip = membership==='vip' && expire > now
async function actionStatus(openid) {
  const { user } = await getOrCreateUser(openid);
  const expire = Number(user.membership_expire_at) || 0;
  const isVip = user.membership === "vip" && expire > Date.now();
  return ok({
    isVip,
    membership: isVip ? "vip" : "normal",
    expire_at: expire,
    expireText: expire ? fmtDate(expire) : "",
  });
}

// 模拟开通：把当前用户升级为 vip，会员期顺延；写会员信息并推 member 站内通知
async function actionActivate(openid, event) {
  const plan = String(event.plan || "month").trim();
  const days = PLAN_DAYS[plan] || PLAN_DAYS.month;
  const planName = PLAN_NAMES[plan] || "月卡";

  const { user } = await getOrCreateUser(openid);
  const now = Date.now();
  // 若当前仍是会员且未到期 → 顺延；否则从现在起算
  const base = user.membership === "vip" && Number(user.membership_expire_at) > now
    ? Number(user.membership_expire_at)
    : now;
  const newExpire = base + days * 86400000;

  const users = db.collection("baozi_users");
  if (user._id) {
    await users.doc(user._id).update({ data: { membership: "vip", membership_expire_at: newExpire, updated_at: now } });
  } else {
    await users.add({ data: { openid_wxapp: openid, membership: "vip", membership_expire_at: newExpire, updated_at: now } });
  }

  // 推一条 member 站内通知
  const typeName = "会员";
  try {
    await db.collection("baozi_messages").add({
      data: {
        type: "member",
        to_openid: openid,
        title: "会员开通成功",
        content: `恭喜您开通「${planName}」，会员有效期至 ${fmtDate(newExpire)}，发布信息将获得更多曝光与专属标识。`,
        post_id: "",
        read_by: [],
        sender: "system",
        created_at: now,
      },
    });
  } catch (e) {
    console.error("memberService 推送 member 通知失败:", e && e.errMsg);
  }

  return ok({ isVip: true, plan, planName, expire_at: newExpire, expireText: fmtDate(newExpire) });
}

// 取消会员（仅调试用）
async function actionCancel(openid) {
  const users = db.collection("baozi_users");
  const { user } = await getOrCreateUser(openid);
  if (user._id) {
    await users.doc(user._id).update({ data: { membership: "normal", membership_expire_at: 0, updated_at: Date.now() } });
  }
  return ok({ isVip: false });
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
