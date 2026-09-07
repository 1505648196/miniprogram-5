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
const { checkText } = require("./secCheck.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 头像地址白名单：只允许云开发的 cloud:// fileID 或 https 网络图
function validAvatar(v) {
  const s = String(v || "").trim();
  if (!s) return true; // 空表示「不设置头像」
  return /^cloud:\/\//.test(s) || /^https?:\/\//.test(s);
}

// 更新个人资料（昵称 / 头像）
// 昵称变更会同步本人已发布帖子的 username，避免改名后老帖仍显示旧昵称。
async function updateProfile(OPENID, event) {
  const users = db.collection("baozi_users");
  let exist = [];
  try {
    exist = (await users.where({ openid_wxapp: OPENID }).limit(1).get()).data;
  } catch (e) {
    console.error("[getOrCreateUser] updateProfile 查询用户失败:", e && (e.errMsg || e));
    return { success: false, error: "查询用户失败" };
  }
  const user = exist[0];
  if (!user) return { success: false, error: "用户不存在" };

  const patch = { updated_at: Date.now() };

  // ---- 昵称 ----
  if (event.username !== undefined) {
    const name = String(event.username || "").trim().replace(/\s+/g, " ");
    if (name.length > 20) return { success: false, error: "昵称不能超过 20 个字" };
    if (name) {
      const sec = await checkText(name, OPENID);
      if (sec.suggest === "reject") return { success: false, error: "昵称含违规内容，请修改" };
      if (sec.suggest === "risky") return { success: false, error: "昵称疑似违规，请换个昵称" };
      // pending（安全接口异常）按放行处理，不误杀
    }
    patch.username = name;
  }

  // ---- 头像 ----
  if (event.avatar !== undefined) {
    const av = String(event.avatar || "").trim();
    if (!validAvatar(av)) return { success: false, error: "头像地址不合法" };
    patch.avatar = av;
  }

  try {
    await users.doc(user._id).update({ data: patch });
  } catch (e) {
    console.error("[getOrCreateUser] updateProfile 写入失败:", e && (e.errMsg || e));
    return { success: false, error: "保存失败，请重试" };
  }

  // ---- 昵称变更 → 同步本人帖子上的 username ----
  let synced = 0;
  const nameChanged =
    patch.username !== undefined && patch.username !== (user.username || "");
  if (nameChanged && patch.username) {
    try {
      const res = await db
        .collection("baozi_posts")
        .where({ _openid: OPENID })
        .update({ data: { username: patch.username } });
      synced = res && res.stats ? res.stats.updated : 0;
    } catch (e) {
      // 同步失败不影响资料保存成功
      console.error("[getOrCreateUser] 同步帖子 username 失败:", e && (e.errMsg || e));
    }
  }

  return {
    success: true,
    synced,
    user: {
      _id: user._id,
      uid: user.uid,
      username: patch.username !== undefined ? patch.username : user.username || "",
      avatar: patch.avatar !== undefined ? patch.avatar : user.avatar || "",
      phone_masked: user.phone_masked || "",
      phone_verified: !!user.phone_verified,
      credit_score: Number(user.credit_score) || 100,
      membership: user.membership || "normal",
    },
  };
}

// ==================== uid 原子自增（§5.4）====================
// 原实现 uid = count.total + 1，并发建号会取到重复号。
// 改为独立计数器集合 + 乐观锁（seq 未变才写入，冲突则重读重试）。
const COUNTERS = "baozi_counters";
const UID_KEY = "user_uid";

async function nextUid() {
  const coll = db.collection(COUNTERS);
  let doc = null;
  try {
    const r = await coll.where({ name: UID_KEY }).limit(1).get();
    if (r.data && r.data.length) doc = r.data[0];
  } catch (e) {
    doc = null; // 集合未建时走下面的初始化
  }
  if (!doc) {
    try {
      const add = await coll.add({
        data: { name: UID_KEY, seq: 0, created_at: Date.now() },
      });
      doc = { _id: add._id, seq: 0 };
    } catch (e) {
      console.error("[getOrCreateUser] 计数器初始化失败:", e);
      return Date.now(); // 兜底：至少不重复
    }
  }

  for (let i = 0; i < 5; i++) {
    const cur = Number(doc.seq) || 0;
    const next = cur + 1;
    try {
      // 乐观锁：只有 seq 仍等于 cur 才写入成功
      const up = await coll
        .where({ name: UID_KEY, seq: cur })
        .update({ data: { seq: next, updated_at: Date.now() } });
      if (up && up.stats && up.stats.updated === 1) return next;
    } catch (e) {
      console.error("[getOrCreateUser] uid 自增失败:", e);
    }
    // 被并发抢先 → 重读再试
    try {
      const again = await coll.where({ name: UID_KEY }).limit(1).get();
      if (again.data && again.data.length) doc = again.data[0];
    } catch (e) {
      break;
    }
  }
  return Date.now(); // 兜底
}
// ==================== uid 原子自增结束 ====================

// 脱敏：保留前 3 后 4，中间 4 位 ****（187****9563）
function maskPhone(p) {
  const s = String(p || "").trim();
  if (!/^1\d{10}$/.test(s)) return "";
  return s.slice(0, 3) + "****" + s.slice(7);
}

// 新建默认用户文档（含全部预留字段 + 默认值）
async function createUser(OPENID, extra) {
  const users = db.collection("baozi_users");
  const uid = await nextUid(); // §5.4：原子自增，替代原 count.total + 1（并发会重复）
  const now = Date.now();
  const doc = Object.assign(
    {
      // ===== 身份主键区（多端预留）=====
      openid_wxapp: OPENID,
      openid_mp: "",
      openid_web: "",
      openid_app: "", // §5.2：App(iOS/安卓/鸿蒙) openid，原字段缺失，此处补齐
      unionid: "",
      uid,
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
  // UNIONID 仅在小程序绑定到微信开放平台后才会有值（§5.6 前提）
  const { OPENID, UNIONID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: "未获取到用户身份" };

  // 更新个人资料（昵称 / 头像）：独立于下面的登录流程，直接返回
  if (event.action === "updateProfile") {
    return await updateProfile(OPENID, event);
  }

  const users = db.collection("baozi_users");

  // ===== §5.3 多端身份：优先用 unionid 打通，拿不到再退回 openid =====
  let user = null;
  let isNew = false;

  if (UNIONID) {
    try {
      const r = await users.where({ unionid: UNIONID }).limit(1).get();
      if (r.data && r.data.length) {
        user = r.data[0];
        // 回填当前端 openid → 多端绑定同一账号
        const patch = {};
        if (!user.openid_wxapp) patch.openid_wxapp = OPENID;
        if (Object.keys(patch).length) {
          patch.updated_at = Date.now();
          await users.doc(user._id).update({ data: patch });
          user = Object.assign(user, patch);
        }
      }
    } catch (e) {
      console.error("[getOrCreateUser] unionid 查询失败:", e);
    }
  }

  if (!user) {
    // 1) 查已有用户
    let exist = [];
    try {
      exist = (await users.where({ openid_wxapp: OPENID }).limit(1).get()).data;
    } catch (e) {
      console.error("[getOrCreateUser] 查询用户失败:", e);
      // 集合不存在等异常 → 尝试建号时抛错，让前端知道
    }

    if (exist.length) {
      user = exist[0];
      // §5.5 老用户 unionid 为空 → 登录时回填
      if (UNIONID && !user.unionid) {
        try {
          await users.doc(user._id).update({
            data: { unionid: UNIONID, updated_at: Date.now() },
          });
          user.unionid = UNIONID;
        } catch (e) {
          console.error("[getOrCreateUser] 回填 unionid 失败:", e);
        }
      }
    } else {
      user = await createUser(OPENID, UNIONID ? { unionid: UNIONID } : {});
      isNew = true;
    }
  }

  // ===== §2.4 封禁校验：封禁用户直接拒绝登录 =====
  if (user && user.status === "banned") {
    return { success: false, error: "账号已被封禁，如有疑问请联系客服", banned: true };
  }

  // 2) 带 phoneCode → 绑定手机号
  let phone_bound = false;
  let matched_posts = 0; // 本次绑定后匹配到的老帖数
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

        // 3) 绑定成功后，一次性匹配老数据归属：
        //    老帖(import_legacy)且未被认领(claimed=false)且 phone_normalized 命中当前号码
        //    → 批量归到当前用户。匹配后 claimed=true，天然幂等（下次不会再被匹配）。
        try {
          const matchRes = await db
            .collection("baozi_posts")
            .where({
              phone_normalized: phone,
              claimed: false,
              source: "import_legacy",
            })
            .update({
              data: {
                _openid: OPENID,
                userid: OPENID,
                claimed: true,
                claimed_at: Date.now(),
              },
            });
          matched_posts = matchRes.stats ? matchRes.stats.updated : 0;
        } catch (e2) {
          // 匹配失败不影响绑定主流程（老数据集合可能还没导入）
          console.error("[getOrCreateUser] 老帖匹配失败:", e2 && e2.errMsg);
        }
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
    matched_posts,
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
