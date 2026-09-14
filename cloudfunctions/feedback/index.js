// cloudfunctions/feedback/index.js
// 举报 / 意见反馈（用户提交 + 后台查看处理）
//
// 集合 baozi_feedback：
//   {
//     _id, _openid,          // 提交人（服务端 getWXContext 取，用户不可伪造）
//     kind: "report" | "feedback",   // 举报(Inappropriate内容) / 意见反馈
//     reason,                 // 举报理由 / 反馈分类（如 虚假信息、骚扰、垃圾广告…）
//     content,                // 补充说明
//     post_id,                // 举报对象帖子 id（意见反馈为空）
//     post_type,              // 被举报帖子的 data_type（便于后台展示，快照）
//     contact,                // 可选联系方式
//     images,                 // 可选截图 fileID 数组
//     status: "pending" | "handled" | "ignored",  // 处理状态
//     handle_note,            // 后台处理备注
//     handled_by, handled_at, // 后台处理人/时间
//     created_at,
//   }
//
// action：
//   submit  用户提交举报/反馈（唯一 action，面向普通用户；身份取服务端 OPENID）
//
// ⚠️ 设计边界（重要）：本函数**只负责 C 端提交**，不含任何管理侧查询/处理。
//   后台的列表/处理/计数一律走 adminAuth 的 feedback_list / feedback_handle / feedback_count
//   —— 复用 adminAuth 已验证的双通道鉴权（账密 RBAC / openid 管理员），
//   避免在本函数重复一套账密校验（会造成口令分散、且漏配环境变量时回落弱口令的风险）。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = "baozi_feedback";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 反馈分类白名单（与小程序端选项保持一致）
const REPORT_REASONS = [
  "虚假信息",
  "电话骚扰",
  "垃圾广告",
  "涉嫌诈骗",
  "内容违规",
  "已成交/失效",
  "其他",
];
const FEEDBACK_REASONS = [
  "功能建议",
  "使用问题",
  "举报投诉",
  "内容错误",
  "其他",
];

function cut(s, n) {
  return String(s || "").trim().slice(0, n);
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  const action = event.action || "submit";

  try {
    switch (action) {
      case "submit": return await actionSubmit(openid, event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[feedback]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// ---------------- 用户提交 ----------------
async function actionSubmit(openid, event) {
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const kind = event.kind === "report" ? "report" : "feedback";
  const reasonRaw = String(event.reason || "").trim();
  const content = cut(event.content, 500);
  const postId = String(event.post_id || "").trim();

  // 举报：必须有对象 + 理由；反馈：必须有内容或理由
  if (kind === "report") {
    if (!postId) return fail("举报缺少目标信息");
    if (!reasonRaw) return fail("请选择举报理由");
    if (REPORT_REASONS.indexOf(reasonRaw) < 0) return fail("举报理由不合法");
  } else {
    if (!content && !reasonRaw) return fail("请填写反馈内容");
    if (reasonRaw && FEEDBACK_REASONS.indexOf(reasonRaw) < 0) return fail("反馈分类不合法");
  }

  // 防刷：同一用户同一天对同一帖子只能举报一次（同一 target 重复提交直接拦）
  if (kind === "report") {
    const dup = await db
      .collection(COLLECTION)
      .where({ _openid: openid, kind: "report", post_id: postId, status: _.neq("ignored") })
      .limit(1)
      .get();
    if (dup.data && dup.data.length) {
      return fail("你已举报过该信息，我们正在处理中", "DUPLICATE");
    }
  }

  const doc = {
    _openid: openid,
    kind,
    reason: cut(reasonRaw, 20),
    content,
    post_id: postId,
    post_type: cut(event.post_type, 20),
    contact: cut(event.contact, 40),
    images: Array.isArray(event.images) ? event.images.slice(0, 3).map((v) => String(v)) : [],
    status: "pending",
    handle_note: "",
    handled_by: "",
    handled_at: 0,
    created_at: Date.now(),
  };

  const res = await db.collection(COLLECTION).add({ data: doc });
  return ok({ _id: res._id, kind });
}
