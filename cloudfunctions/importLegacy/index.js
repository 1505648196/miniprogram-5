// cloudfunctions/importLegacy/index.js
// 老数据导入云函数：读 data.js(清洗后的老数据数组) → 分批写入 baozi_posts
//
// 入参：
//   { action: "run", start?: 0, size?: 100 }   // 从 start 起导入 size 条（分批调用）
//   { action: "count" }                        // 返回总条数（预览）
//
// 返回：
//   { success: true, imported, total, next_start }
//   | { success: false, error }
//
// 注意：
//   - 数据来自 data.js（module.exports = [...]，由 tools/import-legacy-posts 清洗生成）
//   - 写入前按 phone_normalized + published_at 查重，已存在则跳过（幂等，可重复跑）
//   - 分批：云函数单次超时限制，建议每次 size<=200
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = "baozi_posts";

// 清洗后的老数据数组
let LEGACY_DATA = [];
try {
  LEGACY_DATA = require("./data.js");
} catch (e) {
  console.error("[importLegacy] 加载 data.js 失败:", e && e.message);
}

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event = {}) => {
  const action = event.action || "run";
  const total = LEGACY_DATA.length;

  if (action === "count") {
    return ok({ total });
  }

  // 清空所有 source=import_legacy 的帖子（重跑迁移前先清掉旧数据）
  if (action === "clear") {
    let cleared = 0;
    // 循环删除，云数据库单次 where().remove() 上限约 1000 条
    while (true) {
      const res = await db.collection(COLLECTION)
        .where({ source: "import_legacy" })
        .limit(1000)
        .get();
      if (!res.data || !res.data.length) break;
      const ids = res.data.map((d) => d._id);
      const del = await db.collection(COLLECTION).where({ _id: _.in(ids) }).remove();
      cleared += del.stats ? del.stats.removed : ids.length;
      if (ids.length < 1000) break;
    }
    return ok({ cleared });
  }

  if (action === "run") {
    const start = Math.max(0, parseInt(event.start, 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(event.size, 10) || 100));
    const batch = LEGACY_DATA.slice(start, start + size);

    let imported = 0;
    let skipped = 0;
    for (const doc of batch) {
      try {
        // 查重：同 phone_normalized + published_at 已存在则跳过
        const exist = await db.collection(COLLECTION)
          .where({ phone_normalized: doc.phone_normalized, published_at: doc.published_at })
          .limit(1)
          .get();
        if (exist.data && exist.data.length) {
          skipped += 1;
          continue;
        }
        // 结果型别名：approved = !needs_review（true=已通过），保证老数据导入后也能被 approved 过滤命中
        const withApproved = Object.assign({}, doc, {
          approved: doc.needs_review === true ? false : true,
        });
        await db.collection(COLLECTION).add({ data: withApproved });
        imported += 1;
      } catch (e) {
        console.error("[importLegacy] 写入失败:", doc.phone_normalized, e && e.message);
      }
    }

    const next_start = start + size;
    return ok({
      total,
      imported,
      skipped,
      start,
      size,
      next_start: next_start < total ? next_start : -1, // -1 表示全部完成
    });
  }

  return fail("未知操作: " + action, "UNKNOWN_ACTION");
};
