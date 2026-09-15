// cloudfunctions/memberService/index.js
// 会员状态查询（C 端）
//
// - status：查当前用户会员状态（isVip / 到期时间 / 到期文案）
//
// ⚠️ 会员「开通/取消」已迁移到统一支付中心与后台：
//   - C 端开通：payForPhone（create 服务端建单 → 微信支付 → verify 校验订单后履约）
//   - 后台人工：adminAuth.member（activate/cancel）
//   本文件的 activate / cancel 已废弃，仅返回明确提示，
//   避免任何人直接调用云函数白开通或恶意取消会员。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
  // 兜底建号：字段与 getOrCreateUser.createUser 对齐（此前缺失 uid/unionid/status/
  // credit_score 等关键字段，会导致后续按这些字段判断时行为异常）
  const now = Date.now();
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
    identities: [],
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

// ⚠️ 已废弃：原「模拟支付直接开通」存在严重漏洞——任何人可直接调用本接口白得会员。
// 会员开通统一走支付中心 payForPhone（create → 微信支付 → verify 履约），
// 由服务端校验订单（订单号服务端生成 + 权威定价 + 幂等）后才开通。
// 后台人工开通请用 adminAuth.member。此处保留仅为兼容旧调用并给出明确提示。
async function actionActivate() {
  return fail("请通过支付流程开通会员", "USE_PAY_FLOW");
}

// 取消会员：已废弃（原为调试用，可被任意调用取消自己的会员）。
// 会员变更统一走支付中心 payForPhone 与后台 adminAuth.member。
async function actionCancel() {
  return fail("请通过后台管理会员", "USE_ADMIN");
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
