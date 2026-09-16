// cloudfunctions/trackEvent/index.js
// 行为埋点落库：一次写入一批事件（前端满 20 条合并上传 / 即时单条）
// 集合：baozi_events
//   _id / event / ts / session_id / page / params / _openid / created_at
// 安全：_openid 由服务端 context 注入，前端不可伪造。

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = "baozi_events";
const MAX_BATCH = 20; // 单次最多处理 20 条，防单请求灌爆

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";

  const events = Array.isArray(event.events) ? event.events.slice(0, MAX_BATCH) : [];
  if (!events.length) return ok({ count: 0 });

  const now = Date.now();
  let okCount = 0;

  const tasks = events.map((e) => {
    // 字段类型统一（避免脏数据：amount 用数字、业务字段用小写字符串）
    const params = e.params && typeof e.params === "object" ? e.params : {};
    if (params.amount !== undefined) params.amount = Number(params.amount) || 0;

    const doc = {
      event: String(e.event || "").slice(0, 64),
      ts: Number(e.ts) || now,
      session_id: String(e.session_id || "").slice(0, 64),
      page: String(e.page || "").slice(0, 128),
      params,
      _openid: openid,          // 服务端注入，前端不可伪造
      created_at: now,
    };
    return db.collection(COLLECTION).add({ data: doc })
      .then(() => { okCount++; })
      .catch((err) => console.error("[trackEvent] 单条写入失败:", err && err.errMsg));
  });

  await Promise.all(tasks);
  return ok({ count: okCount });
};
