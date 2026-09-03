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

// 转义正则保留字，防止用户输入中的特殊字符破坏正则
function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  // 转让/求店(transfer/want_shop)专属字段
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment",
  "terms", "rent_max", "area_min",
  // 二手设备(equip_sell/equip_buy)专属字段
  "cond",
  // 顺风车(carpool_car/carpool_person)专属字段
  "from_place", "to_place", "depart_time", "depart_deadline", "seats",
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
  // 主价格下限（元，转让费/预算）：转让求店频道页用，作用于 transfer(转让费)/want_shop(预算) 共有的 price 字段
  const price = Number(event.price) > 0 ? Number(event.price) : 0;
  // 新旧成数下限（0-10）：二手设备频道页用，作用于 equip_sell(当前成色)/equip_buy(期望成色) 共有的 cond 字段
  const cond = Number(event.cond) > 0 ? Math.min(Number(event.cond), 10) : 0;
  // 全局模糊关键词：对所有分类帖子做文本模糊匹配（全库搜索）
  const keyword = String(event.keyword || "").trim();

  // 筛选条件（师傅类型 role_id/role、区域 city/city_code、薪资 salary）
  // 招聘帖(recruit)与求职帖(jobseek)现在都具备 role_id/city_code/salary 字段，
  // 可直接对所有选中类型统一 AND 过滤，无需再对 jobseek 做 OR 豁免。
  // 注意：薪资过滤 salary >= 下限 —— 招聘按"给价"、求职按"期望薪资"，同用 salary 字段。
  const conds = [
    { needs_review: _.neq(true) }, // 只展示已过审
  ];
  // 多类型用 in，单类型直接用 data_type；两者都不传 = 全部分类(供全局搜索)
  if (dataTypes && dataTypes.length) {
    conds.push({ data_type: _.in(dataTypes) });
  } else if (event.dataType) {
    conds.push({ data_type: dataType });
  }
  if (city) conds.push({ city });
  if (cityCode) conds.push({ city_code: cityCode });
  if (role) conds.push({ role });
  if (roleId > 0) conds.push({ role_id: roleId });
  if (salary > 0) conds.push({ salary: _.gte(salary) }); // 帖子薪资 >= 筛选下限
  if (price > 0) conds.push({ price: _.gte(price) }); // 转让/求店主价格(转让费/预算) >= 筛选下限
  if (cond > 0) conds.push({ cond: _.gte(cond) }); // 二手设备成色 >= 下限

  // 关键词：对"原文/角色/省市区/地址/联系人/备注/可服务地区"做正则模糊(OR)
  // 对已选中的类型(data_type 条件)内再叠加过滤 → 全局搜索(不传 data_type) = 全库模糊搜
  if (keyword) {
    const rx = db.RegExp({ regexp: escapeReg(keyword), options: "i" });
    const textFields = ["raw_text", "role", "province", "city", "district", "address", "contact", "salary_note", "service_area"];
    const ors = textFields.map((f) => ({ [f]: rx }));
    conds.push(_.or(ors));
  }

  // 过滤后的完整查询
  const query = conds.length === 1 ? conds[0] : _.and(conds);

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
