// cloudfunctions/recruitAI/drafts.js
// 招工发布草稿集合（recruit_drafts）读写工具
//  - openid 隔离：每人最多维护 1 条未过期草稿（按 updated_at 取最新）
//  - 7 天过期：expires_at 超时视为无草稿
//  - 草稿只存完整 phone，不存 phone_masked（掩码在 publishPost 落库时生成）
//  - 字段用下划线风格，与 baozi_posts 一致
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DRAFT_COLLECTION = "recruit_drafts";
const DRAFT_TTL_DAYS = 7;
const MAX_SALARY = 100000; // 工资解析上限，超出视为噪点置空

// 取当前用户最新未过期草稿
async function getDraft(openid) {
  if (!openid) return null;
  try {
    const res = await db
      .collection(DRAFT_COLLECTION)
      .where({ _openid: openid, expires_at: _.gt(Date.now()) })
      .orderBy("updated_at", "desc")
      .limit(1)
      .get();
    return (res.data || [])[0] || null;
  } catch (e) {
    console.error("[recruitAI] getDraft 失败:", e.errMsg || e.message);
    return null;
  }
}

// 按 _id 取草稿（校验 openid 归属 + 未过期，防止越权）
async function getDraftById(openid, draftId) {
  if (!openid || !draftId) return null;
  try {
    const res = await db.collection(DRAFT_COLLECTION).doc(draftId).get();
    const d = res.data;
    if (!d || d._openid !== openid) return null;
    if (d.expires_at && d.expires_at < Date.now()) return null;
    return d;
  } catch (e) {
    return null;
  }
}

// 保存/合并草稿：data 含 _id 则 update，否则 add；自动刷新 expires_at/updated_at
async function saveDraft(openid, data) {
  const now = Date.now();
  const record = Object.assign({}, data, {
    _openid: openid,
    updated_at: now,
    expires_at: now + DRAFT_TTL_DAYS * 86400000,
  });
  const id = record._id;
  delete record._id;
  if (id) {
    await db.collection(DRAFT_COLLECTION).doc(id).update({ data: record });
    return id;
  }
  const res = await db.collection(DRAFT_COLLECTION).add({ data: record });
  return res._id;
}

// 删除草稿（先校验归属）
async function deleteDraftById(openid, draftId) {
  if (!draftId) return false;
  const d = await getDraftById(openid, draftId);
  if (!d) return false;
  try {
    await db.collection(DRAFT_COLLECTION).doc(draftId).remove();
    return true;
  } catch (e) {
    console.error("[recruitAI] deleteDraft 失败:", e.errMsg || e.message);
    return false;
  }
}

// 清理当前用户全部过期草稿（可在每次取草稿前兜底，暂未启用）
async function cleanExpired(openid) {
  try {
    await db
      .collection(DRAFT_COLLECTION)
      .where({ _openid: openid, expires_at: _.lte(Date.now()) })
      .remove();
  } catch (e) {
    // 忽略清理失败
  }
}

module.exports = {
  getDraft,
  getDraftById,
  saveDraft,
  deleteDraftById,
  cleanExpired,
  MAX_SALARY,
  DRAFT_TTL_DAYS,
};
