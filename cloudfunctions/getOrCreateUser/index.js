// cloudfunctions/getOrCreateUser/index.js
// 用户登录基座（无感）：
//   1) 按 openid 在 baozi_users 查找用户；不存在则自动建号（默认信用分100）。
//   2) 入参带 phoneCode 时，解密微信授权手机号并回写绑定（phone / phone_masked / phone_verified）。
//
// 入参：
//   {
//     phoneCode: "..."    // 可选。button open-type="getPhoneNumber" 返回的 code，用于绑定手机号
//   }
// 返回：
//   { success: true, isNew: bool, user: {...}, phone_bound: bool }
//   | { success: false, error: "..." }
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 脱敏：保留前 3 后 4，中间 4 位 ****（187****9563）
function maskPhone(p) {
  const s = String(p || "").trim();
  if (!/^1\d{10}$/.test(s)) return "";
  return s.slice(0, 3) + "****" + s.slice(7);
}

// 新建默认用户文档（含全部预留字段 + 默认值）
async function createUser(OPENID, extra) {
  const users = db.collection("baozi_users");
  const count = await users.count();
  const now = Date.now();
  const doc = Object.assign(
    {
      // ===== 身份主键区（多端预留）=====
      openid_wxapp: OPENID,
      openid_mp: "",
      openid_web: "",
      unionid: "",
      uid: count.total + 1, // 展示序列号（非主键）
      wx_id: "",
      identities: [],
      // ===== 画像区 =====
      username: "",
      avatar: "",
      gender: 0, // 1男 2女 0未知
      // ===== 账号状态区 =====
      role: "user", // user普通 / merchant发帖商户 / admin运营
      status: "active", // active正常 / banned封禁 / pending待审
      register_source: "wxapp", // wxapp / mp / web / kefu
      // ===== 认证与联系方式区 =====
      phone: "",
      phone_masked: "",
      phone_verified: false,
      email: "",
      // ===== 会员区 =====
      membership: "normal",
      membership_expire_at: 0,
      // ===== 信用区 =====
      credit_score: 100, // 默认初始分 100，只存数字
      credit_count: 0,
      // ===== 运营区 =====
      remark: "",
      created_at: now,
      updated_at: now,
    },
    extra || {}
  );
  const res = await users.add({ data: doc });
  return Object.assign({ _id: res._id }, doc);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: "未获取到用户身份" };

  const users = db.collection("baozi_users");
  // 1) 查已有用户
  let exist = [];
  try {
    exist = (await users.where({ openid_wxapp: OPENID }).limit(1).get()).data;
  } catch (e) {
    console.error("[getOrCreateUser] 查询用户失败:", e);
    // 集合不存在等异常 → 尝试建号时抛错，让前端知道
  }

  let user;
  let isNew = false;
  if (exist.length) {
    user = exist[0];
  } else {
    user = await createUser(OPENID);
    isNew = true;
  }

  // 2) 带 phoneCode → 绑定手机号
  let phone_bound = false;
  if (event.phoneCode) {
    try {
      const pr = await cloud.openapi.phonenumber.getPhoneNumber({ code: event.phoneCode });
      const phone = pr && pr.phoneInfo && pr.phoneInfo.phoneNumber;
      if (/^1\d{10}$/.test(phone)) {
        const mask = maskPhone(phone);
        const patch = {
          phone,
          phone_masked: mask,
          phone_verified: true,
          updated_at: Date.now(),
        };
        if (user._id) {
          await users.doc(user._id).update({ data: patch });
          user = Object.assign(user, patch);
        } else {
          user = await createUser(OPENID, patch);
          isNew = true;
        }
        phone_bound = true;
      }
    } catch (e) {
      console.error("[getOrCreateUser] 手机号绑定失败:", e.errMsg || e);
      return { success: false, error: "手机号绑定失败：" + (e.errMsg || e.message || e) };
    }
  }

  return {
    success: true,
    isNew,
    phone_bound,
    user: {
      _id: user._id,
      uid: user.uid,
      username: user.username || "",
      avatar: user.avatar || "",
      phone_masked: user.phone_masked || "",
      phone_verified: !!user.phone_verified,
      credit_score: Number(user.credit_score) || 100,
      membership: user.membership || "normal",
    },
  };
};
