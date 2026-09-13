// cloudfunctions/groupService/index.js
// 包友群（轻量加群）：
//   - listGroups：群列表（按城市/推荐）
//   - groupDetail：单个群详情（返回群二维码，供长按识别加群）
//
// 集合 baozi_groups：
//   { _id, name, city, cover, qr_code, intro, member_count, sort, status, created_at }

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLL = "baozi_groups";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";

  const action = event.action || "listGroups";
  try {
    switch (action) {
      case "listGroups": return await actionListGroups(event);
      case "groupDetail": return await actionGroupDetail(event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[groupService]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 群列表：只返回启用状态的群，按 sort 升序（越大越靠前）、再按创建时间倒序
async function actionListGroups(event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 50);

  const cond = { status: "active" };

  // 按城市筛选（可选）
  const city = String(event.city || "").trim();
  if (city) {
    cond.city = db.RegExp({ regexp: escapeReg(city.replace(/市$/, "")), options: "i" });
  }

  const res = await db.collection(COLL)
    .where(cond)
    .orderBy("sort", "desc")
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  // 列表不下发完整 qr_code 字段（二维码只进详情时展示），避免列表过重
  const list = (res.data || []).map((g) => ({
    _id: g._id,
    name: g.name,
    city: g.city,
    cover: g.cover || "",
    intro: g.intro || "",
    member_count: g.member_count || 0,
  }));
  return ok({ list, page, pageSize });
}

// 群详情：返回完整信息含二维码
async function actionGroupDetail(event) {
  const id = String(event._id || "").trim();
  if (!id) return fail("缺少群标识", "MISSING_ID");
  let g;
  try {
    g = (await db.collection(COLL).doc(id).get()).data;
  } catch (e) {
    g = null;
  }
  if (!g) return fail("群不存在", "NOT_FOUND");
  if (g.status !== "active") return fail("该群已关闭", "CLOSED");
  return ok({ item: g });
}

// 转义正则特殊字符
function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
