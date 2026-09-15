// cloudfunctions/userIdentity/index.js
// 身份认证（C 端）：店主/师傅认证申请（商家走包友圈商家入驻，不在此处理）
//
// 数据模型（baozi_identities，每条记录对应一个身份的一次申请）：
//   { openid, identity: 'owner'|'master', real_name, id_card, phone, address,
//     license_img, photos[], status: 'pending'|'approved'|'rejected',
//     reject_reason, reviewed_by, reviewed_at, created_at, updated_at }
//
// action 路由：
//   submit  提交认证申请（按 identity 类型，幂等覆盖该类型的 pending）
//   status  查我的认证状态（返回各身份状态 + 最近申请列表）
//   cancel  撤销待审核申请（按 identity 类型）
const cloud = require("wx-server-sdk");
const { checkText } = require("./secCheck.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const IDENTITIES = "baozi_identities";
const USERS = "baozi_users";

// 身份类型枚举（仅独立认证部分，商家走 merchantApply）
const IDENTITY_TYPES = ["owner", "master"];
const IDENTITY_LABEL = {
  owner: "店主",
  master: "师傅",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 校验提交参数（按身份类型校验必填）
function validateSubmit(payload, identity) {
  if (!payload) return "参数为空";

  // 通用字段
  const phone = String(payload.phone || "").trim();
  if (!phone || !/^1\d{10}$/.test(phone)) return "请输入 11 位手机号";

  const idCard = String(payload.id_card || "").trim();
  if (!idCard || !/(^\d{15}$)|(^\d{18}$)|(^\d{17}(\d|X|x)$)/.test(idCard)) return "身份证号格式不正确";

  const address = String(payload.address || "").trim();
  if (!address) return "请填写地址";

  // 姓名（店主/师傅都必填，与身份证配套便于人工审核核对）
  const realName = String(payload.real_name || "").trim();
  if (!realName) return "请填写姓名";
  if (realName.length > 20) return "姓名不能超过 20 个字";

  // 按身份类型校验
  if (identity === "owner") {
    if (!payload.license_img) return "请上传营业执照";
    if (!/^cloud:\/\//.test(payload.license_img) && !/^https?:\/\//.test(payload.license_img)) {
      return "营业执照图片地址不合法";
    }
  }

  // 其他证明材料
  const photos = payload.photos;
  if (photos && (!Array.isArray(photos) || photos.length > 6)) return "证明材料最多 6 张";
  if (photos) {
    for (const p of photos) {
      if (typeof p !== "string" || !p.trim()) return "图片标识不合法";
      if (!/^cloud:\/\//.test(p) && !/^https?:\/\//.test(p)) return "图片地址不合法";
    }
  }

  return null;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "status";
  try {
    switch (action) {
      case "submit": return await actionSubmit(openid, event);
      case "status": return await actionStatus(openid, event);
      case "cancel": return await actionCancel(openid, event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[userIdentity]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// ============ submit：提交认证申请 ============
async function actionSubmit(openid, event) {
  const payload = event.payload || {};
  const identity = String(payload.identity || "").trim();

  if (!IDENTITY_TYPES.includes(identity)) {
    return fail("不支持的身份类型：" + identity, "BAD_IDENTITY");
  }

  const errMsg = validateSubmit(payload, identity);
  if (errMsg) return fail(errMsg, "BAD_PARAM");

  // 内容安全：对姓名 + 地址做文本审核
  const secText = [payload.real_name, payload.address].filter(Boolean).join("\n");
  const sec = await checkText(secText, openid);
  if (sec.suggest === "reject" || sec.suggest === "risky") {
    return fail("提交内容含违规信息，请修改后重试", "CONTENT_REJECTED");
  }

  const now = Date.now();

  // 1) 若该身份已有 approved 记录，先将其标记为 rejected（重新提交后原认证失效，等审核）
  try {
    await db.collection(IDENTITIES)
      .where({ openid, identity, status: "approved" })
      .update({
        data: {
          status: "rejected",
          reject_reason: "用户重新提交资料，原认证待重新审核",
          updated_at: now,
        },
      });
  } catch (e) {
    console.error("[userIdentity] 标记原 approved 记录失败:", e && e.errMsg);
  }

  // 2) 同时从 baozi_users.identities 移除该身份（等审核通过后再加回）
  try {
    const ur = await db.collection(USERS).where({ openid_wxapp: openid }).limit(1).get();
    const user = ur.data && ur.data[0];
    if (user && Array.isArray(user.identities)) {
      const filtered = user.identities.filter((id) => id !== identity);
      await db.collection(USERS).doc(user._id).update({
        data: { identities: filtered, updated_at: now },
      });
    }
  } catch (e) {
    console.error("[userIdentity] 移除用户已认证身份失败:", e && e.errMsg);
  }

  // 3) 同 openid + identity 已有 pending 记录的，覆盖（幂等）
  const exist = await db.collection(IDENTITIES)
    .where({ openid, identity, status: "pending" })
    .limit(1)
    .get();

  const doc = {
    openid,
    identity,
    real_name: String(payload.real_name || "").trim(),
    id_card: String(payload.id_card || "").trim(),
    phone: String(payload.phone || "").trim(),
    address: String(payload.address || "").trim(),
    license_img: String(payload.license_img || "").trim(),
    photos: (Array.isArray(payload.photos) ? payload.photos : []).slice(0, 6),
    status: "pending",
    reject_reason: "",
    reviewed_by: "",
    reviewed_at: 0,
    created_at: now,
    updated_at: now,
  };

  let _id;
  if (exist.data && exist.data.length) {
    _id = exist.data[0]._id;
    await db.collection(IDENTITIES).doc(_id).update({
      data: { ...doc, updated_at: now },
    });
  } else {
    const add = await db.collection(IDENTITIES).add({ data: doc });
    _id = add._id;
  }

  return ok({ _id, status: "pending", message: "提交成功，审核中" });
}

// ============ status：查我的认证状态 ============
async function actionStatus(openid, event) {
  // 1) 查 baozi_users 的 identities（已认证生效身份）
  let verifiedIdentities = [];
  try {
    const r = await db.collection(USERS).where({ openid_wxapp: openid }).limit(1).get();
    const user = r.data && r.data[0];
    if (user) {
      verifiedIdentities = Array.isArray(user.identities) ? user.identities : [];
    }
  } catch (e) {
    console.error("[userIdentity] 查询用户认证状态失败:", e && e.errMsg);
  }

  // 2) 查该用户所有申请记录（按 created_at 倒序）
  let lastApplies = [];
  try {
    const r = await db.collection(IDENTITIES)
      .where({ openid })
      .orderBy("created_at", "desc")
      .limit(10)
      .get();
    lastApplies = r.data || [];
  } catch (e) {
    console.error("[userIdentity] 查询认证申请记录失败:", e && e.errMsg);
  }

  // 3) 分离各身份状态
  const ownerStatus = verifiedIdentities.includes("owner") ? "approved" : "none";
  const masterStatus = verifiedIdentities.includes("master") ? "approved" : "none";

  return ok({
    identities: verifiedIdentities,
    owner_status: ownerStatus,
    master_status: masterStatus,
    lastApplies, // 最近申请列表（含 identity 字段）
  });
}

// ============ cancel：撤销待审核申请 ============
async function actionCancel(openid, event) {
  const identity = String(event.identity || "").trim();
  if (!IDENTITY_TYPES.includes(identity)) {
    return fail("不支持的身份类型：" + identity, "BAD_IDENTITY");
  }

  try {
    const r = await db.collection(IDENTITIES)
      .where({ openid, identity, status: "pending" })
      .limit(1)
      .get();
    const apply = (r.data && r.data[0]) || null;
    if (!apply) return fail("没有待审核的申请", "NOT_FOUND");

    await db.collection(IDENTITIES).doc(apply._id).remove();
    return ok({ message: "已撤销申请" });
  } catch (e) {
    return fail(String(e && e.message ? e.message : e));
  }
}
