// cloudfunctions/feedPosts/index.js
// 板块信息流：按 data_type 分页拉取帖子，只查库、不做 AI 分析，秒开列表
//
// 入参：
//   { dataType: "recruit", dataTypes: ["recruit","jobseek"], city, city_code, role, role_id, salary, page, pageSize }
//   - dataType 可选，默认 recruit（单类型，其他板块可复用）
//   - dataTypes 可选数组，多类型混排（如 ['recruit','jobseek']，招聘求职频道页用）；传了优先于 dataType
//   - city / city_code：按城市名字段 / 市级行政区划 code 过滤
//   - role / role_id：按师傅类型中文名 / 稳定角色 ID 过滤
//   - salary：按 salary(元/月) 下限过滤（salary >= salary）。招聘帖是"给价"，求职帖是"期望薪资"，均存 salary
//   - 任意筛选条件同时传时取交集(AND)。要求：被筛的帖子自身须含对应字段
//     （招聘 recruit 与规范化的求职 jobseek 均含 role_id/city_code/salary，故可统一 AND；无字段的脏帖自然不命中）
// 返回：
//   { success: true, list: [...], total, page, pageSize, hasMore }
//   - 字段白名单下发：不含完整 phone / _openid（完整号仅发布本人经 managePost.get 可见）
//   - 每条附 isMine（_openid === 调用者 openid），用于前端"编辑/删除"按钮
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 展示所需字段白名单
// 含招聘(recruit)通用字段 + 求职(jobseek)专属字段 + 图片/地址/信用等，
// 列表页与详情页(点卡片复用缓存)都用同一份完整数据，避免详情二次查库。
const LIST_KEYS = [
  "_id", "data_type", "role", "role_id", "province", "city", "district",
  "province_code", "city_code", "district_code",
  "salary", "contact", "phone_masked", "username", "credit",
  "raw_text", "tags", "published_at", "needs_review", "sec_status", "sec_label",
  // 求职(jobseek)专属字段
  "salary_expect", "salary_note", "availability", "want_terms", "service_area",
  // 地址定位 / 图片
  "address", "latitude", "longitude", "image",
  // 更新/创建时间（详情页展示）
  "created_at", "updated_at",
];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  // 支持多类型查询：dataTypes 为数组时按数组查（_.in）；否则回退单 dataType
  // 典型用法：招聘求职频道页传 ['recruit','jobseek'] 混排展示
  const dataTypes = Array.isArray(event.dataTypes) && event.dataTypes.length ? event.dataTypes : null;
  const dataType = event.dataType || "recruit";
  const city = String(event.city || "").trim();
  const cityCode = String(event.city_code || "").trim();
  const role = String(event.role || "").trim();
  // 师傅类型稳定角色 ID（推荐用这个，比中文名稳定）；数字校验，非法/缺省返回 0
  const roleId = Number(event.role_id) > 0 ? Number(event.role_id) : 0;
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 20);
  // 薪资下限（元/月）：仅当传入时才按数据库过滤（salary >= 筛选值）
  const salary = Number(event.salary) > 0 ? Number(event.salary) : 0;

  // 筛选条件（师傅类型 role_id/role、区域 city/city_code、薪资 salary）
  // 招聘帖(recruit)与求职帖(jobseek)现在都具备 role_id/city_code/salary 字段，
  // 可直接对所有选中类型统一 AND 过滤，无需再对 jobseek 做 OR 豁免。
  // 注意：薪资过滤 salary >= 下限 —— 招聘按"给价"、求职按"期望薪资"，同用 salary 字段。
  const query = {
    needs_review: _.neq(true),
  };
  // 多类型用 in，单类型直接用 data_type（性能等价且兼容旧调用）
  if (dataTypes && dataTypes.length) {
    query.data_type = _.in(dataTypes);
  } else {
    query.data_type = dataType;
  }
  if (city) query.city = city;
  if (cityCode) query.city_code = cityCode;
  if (role) query.role = role;
  if (roleId > 0) query.role_id = roleId;
  if (salary > 0) query.salary = _.gte(salary); // 帖子薪资 >= 筛选下限

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

    const list = (res.data || []).map((p) => {
      const o = {};
      for (const k of LIST_KEYS) if (p[k] !== undefined) o[k] = p[k];
      o.isMine = !!openid && p._openid === openid;
      return o;
    });

    return {
      success: true,
      list,
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
