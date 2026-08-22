// cloudfunctions/feedPosts/index.js
// 招工板块信息流：按 data_type=recruit 分页拉取招聘帖子
// 只查库、不做 AI 分析，秒开列表
//
// 入参：
//   { dataType: "recruit", city: "上海" | "", page: 1, pageSize: 10 }
//   - dataType 可选，默认 recruit（后续其他板块可复用）
//   - city 可选，空 = 全部城市
// 返回：
//   { success: true, list: [...], total, page, pageSize, hasMore }
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const dataType = event.dataType || "recruit";
  const city = String(event.city || "").trim();
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 20);

  const query = {
    data_type: dataType,
    needs_review: _.neq(true),
  };
  if (city) query.city = city;

  try {
    const countRes = await db.collection("baozi_posts").where(query).count();
    const total = countRes.total;

    const res = await db
      .collection("baozi_posts")
      .where(query)
      .orderBy("published_at", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get();

    return {
      success: true,
      list: res.data || [],
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  } catch (e) {
    console.error("feedPosts 查询失败:", e);
    return {
      success: false,
      error: (e.errMsg || e.message || e) + "（检查 baozi_posts 集合是否存在）",
    };
  }
};
