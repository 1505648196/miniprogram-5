// cloudfunctions/migrateCreditScore/index.js
// 一次性数据迁移：给存量帖子回填 credit_score（信用分）。
// 幂等：已有 credit_score（数值）的帖子跳过。
//
// 调用：invoke { batches: N } 或 { offset: X }。可重复执行。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTION = "baozi_posts";
const USERS = "baozi_users";
const BATCH = 100;

exports.main = async (event = {}) => {
  const maxBatches = parseInt(event.batches, 10) || 100; // 单次最多批次数
  const offset = parseInt(event.offset, 10) || 0;

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;

  for (let b = 0; b < maxBatches; b++) {
    const res = await db.collection(COLLECTION)
      .skip(offset + processed)
      .limit(BATCH)
      .get();
    const rows = res.data || [];
    if (!rows.length) break;

    const needFix = rows.filter((p) => {
      const v = p.credit_score;
      return v === undefined || v === null || Number.isNaN(Number(v));
    });

    if (needFix.length) {
      // 批量查发布者信用分
      const openids = [...new Set(needFix.map((p) => p._openid).filter(Boolean))];
      const creditMap = {};
      if (openids.length) {
        for (let i = 0; i < openids.length; i += 20) {
          const batch = openids.slice(i, i + 20);
          try {
            const uRes = await db.collection(USERS)
              .where({ openid_wxapp: db.command.in(batch) })
              .get();
            (uRes.data || []).forEach((u) => {
              if (u.openid_wxapp != null && u.credit_score != null) {
                creditMap[u.openid_wxapp] = Number(u.credit_score);
              }
            });
          } catch (e) {
            console.error("[migrateCreditScore] 查用户失败:", e && e.errMsg);
          }
        }
      }

      for (const p of needFix) {
        const score = creditMap[p._openid] != null ? creditMap[p._openid] : 100;
        try {
          await db.collection(COLLECTION).doc(p._id).update({
            data: { credit_score: score },
          });
          updated++;
        } catch (e) {
          console.error("[migrateCreditScore] 更新失败:", p._id, e && e.errMsg);
          errors++;
        }
      }
    }
    skipped += rows.length - needFix.length;
    processed += rows.length;
  }

  return {
    success: true,
    processed,
    updated,
    skipped,
    errors,
    next_offset: offset + processed,
  };
};
