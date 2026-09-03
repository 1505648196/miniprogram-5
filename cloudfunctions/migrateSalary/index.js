// cloudfunctions/migrateSalary/index.js
// 一次性数据迁移：把旧版招工帖子的薪资三字段（salary_low/salary_high/salary_note）
// 合并成单一 salary(元/月)，并补齐 userid（从 _openid 拷贝）。
//
// 转换规则：
//   - 有 salary_low  → salary = salary_low（取下限，保守）
//   - 无下限但有 salary_high → salary = salary_high
//   - 其余（含 salary_note=面议 / 都为空）→ salary = 0
//   - userid 为空 → userid = _openid
//
// 调用：debug 工具 / 云开发控制台手动触发一次。幂等：已迁移的记录跳过。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = "baozi_posts";

exports.main = async () => {
  const MAX = 1000; // 单次最多处理条数
  const res = await db.collection(COLLECTION)
    .where({ data_type: "recruit" })
    .limit(MAX)
    .get();
  const rows = res.data || [];

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const p of rows) {
    // 已迁移（存在 salary 且数值化）→ 跳过
    if (typeof p.salary === "number") {
      skipped++;
      continue;
    }

    const patch = {};
    const lo = Number(p.salary_low) || 0;
    const hi = Number(p.salary_high) || 0;
    // 有下限取下限；否则取上限；否则 0（面议）
    patch.salary = lo > 0 ? lo : hi > 0 ? hi : 0;

    // 补齐 userid（唯一用户标识，小程序内即 openid）
    if (!p.userid) patch.userid = p._openid || "";

    // 清理旧字段
    patch.salary_low = db.command.remove();
    patch.salary_high = db.command.remove();
    patch.salary_note = db.command.remove();

    try {
      await db.collection(COLLECTION).doc(p._id).update({ data: patch });
      updated++;
    } catch (e) {
      console.error("[migrateSalary] 更新失败:", p._id, e);
      errors++;
    }
  }

  return {
    success: true,
    total: rows.length,
    updated,
    skipped,
    errors,
  };
};
