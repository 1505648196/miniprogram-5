// cloudfunctions/feedPosts/index.js
// 板块信息流：按 data_type 分页拉取帖子，只查库、不做 AI 分析，秒开列表
//
// 入参：
//   { dataType: "recruit", dataTypes: ["recruit","jobseek"], types:[...], city, city_code, role, role_id, salary, page, pageSize }
//   - dataType 可选，默认 recruit（单类型，其他板块可复用）
//   - dataTypes 可选数组，多类型混排（如 ['recruit','jobseek']，招聘求职频道页用）；传了优先于 dataType，用 _.in 一次查
//   - types 可选数组（批量模式，首页/附近混排全板块用）：一次云函数调用内部按 types 逐个类型各取第 page 页并合并返回，
//     等价于前端之前"对每个类型各调一次本函数再拼接"的结果，但只算一次云函数调用。传了优先于 dataType/dataTypes。
//   - city / city_code：按城市名字段 / 市级行政区划 code 过滤
//   - role / role_id：按师傅类型中文名 / 稳定角色 ID 过滤
//   - salary：按 salary(元/月) 下限过滤（salary >= salary）。招聘帖是"给价"，求职帖是"期望薪资"，均存 salary
//   - 任意筛选条件同时传时取交集(AND)。要求：被筛的帖子自身须含对应字段
//     （招聘 recruit 与规范化的求职 jobseek 均含 role_id/city_code/salary，故可统一 AND；无字段的脏帖自然不命中）
// 返回：
//   { success: true, list: [...], page, pageSize, hasMore, total }
//   - 用 limit(pageSize+1) 判 hasMore，不再单独 count（省一次全表扫描读）
//   - total 为兼容占位：hasMore 时 -1，末页才给确切值（前端均已不消费，勿依赖其精确性）
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
  "raw_text", "tags", "published_at", "needs_review", "approved", "sec_status", "sec_label",
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
  // 浏览点击量
  "views",
];

// 按给定完整 query 条件取一页（limit+1 判 hasMore），白名单 + isMine
// query 已含 needs_review/data_type 等全部筛选；page/pageSize 决定翻页位置
async function fetchPageByCond(query, page, pageSize, openid) {
  const fetchN = pageSize + 1; // 多取 1 条仅用于判断是否有下一页
  const res = await db
    .collection("baozi_posts")
    .where(query)
    .orderBy("published_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(fetchN)
    .get();

  const raw = res.data || [];
  const hasMore = raw.length > pageSize;
  const pageData = raw.slice(0, pageSize); // 展示用前 pageSize 条

  const list = pageData.map((p) => {
    const o = {};
    for (const k of LIST_KEYS) if (p[k] !== undefined) o[k] = p[k];
    o.isMine = !!openid && p._openid === openid;
    return o;
  });
  return { list, hasMore };
}

// 把条件数组合并成 query：单条件直接返回，多条件用 _.and
function mergeConds(conds) {
  return conds.length === 1 ? conds[0] : _.and(conds);
}

// 查询指定类型集合的置顶帖（独立集合 baozi_post_tops → 回查帖子完整内容）
// 仅在 page===1 时调用（置顶只出现在第一页顶部）。置顶帖仍须已过审。
// cityCode：可选，传入时置顶帖也须命中该市级 code（附近页同城才置顶），
//          在回查帖子时按 city_code 过滤（帖子表含 city_code，置顶集合无需冗余）。
// 返回：置顶帖完整对象数组（白名单 + isMine + isTop，与普通帖一致，额外 isTop 标记）
async function fetchTops(types, openid, cityCode) {
  try {
    const now = Date.now();
    const topRes = await db
      .collection("baozi_post_tops")
      .where(_.and([
        { data_type: _.in(types) },
        _.or([{ expire_at: 0 }, { expire_at: _.gt(now) }]), // 0=永不过期
      ]))
      .orderBy("level", "desc")
      .limit(50)
      .get();

    const topIds = (topRes.data || []).map((t) => t.post_id).filter(Boolean);
    if (!topIds.length) return [];

    // 回查帖子完整内容：已过审 + 可选同城过滤
    const postConds = [{ _id: _.in(topIds) }, { approved: _.eq(true) }];
    if (cityCode) postConds.push({ city_code: cityCode });
    const postRes = await db
      .collection("baozi_posts")
      .where(_.and(postConds))
      .get();

    const list = (postRes.data || []).map((p) => {
      const o = {};
      for (const k of LIST_KEYS) if (p[k] !== undefined) o[k] = p[k];
      o.isMine = !!openid && p._openid === openid;
      o.isTop = true; // 置顶标记，供前端排序 + 视觉标识
      return o;
    });
    return list;
  } catch (e) {
    // 置顶集合可能尚未创建；失败静默，不影响普通列表
    console.error("[feedPosts] 置顶查询失败(忽略):", e && e.errMsg);
    return [];
  }
}

// 构造"基础筛选"（不含 data_type 的那部分），供单类型/多类型/批量共用
// conds 已在调用前就绪；这里仅做导出，避免重复
// 见 main 内 conds 数组构建

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 20);

  // 通用筛选参数（对所有类型一致的过滤项）
  const city = String(event.city || "").trim();
  const cityCode = String(event.city_code || "").trim();
  const role = String(event.role || "").trim();
  // 师傅类型稳定角色 ID（数字校验，非法/缺省返回 0）
  const roleId = Number(event.role_id) > 0 ? Number(event.role_id) : 0;
  const salary = Number(event.salary) > 0 ? Number(event.salary) : 0; // 薪资下限(元/月)
  const price = Number(event.price) > 0 ? Number(event.price) : 0; // 转让/求店主价格下限(元)
  const cond = Number(event.cond) > 0 ? Math.min(Number(event.cond), 10) : 0; // 设备成色下限
  const keyword = String(event.keyword || "").trim(); // 全库模糊关键词

  // 基础筛选：已过审 + 通用过滤项（不含 data_type）
  // 审核权威字段已切换为 approved（true=已通过）。approved 与 needs_review 恒等(!needs_review)，
  // 存量数据已回填 approved，故直接用 approved 过滤即可。
  const baseConds = [
    { approved: _.eq(true) }, // 只展示已通过
  ];
  if (city) baseConds.push({ city });
  if (cityCode) baseConds.push({ city_code: cityCode });
  if (role) baseConds.push({ role });
  if (roleId > 0) baseConds.push({ role_id: roleId });
  if (salary > 0) baseConds.push({ salary: _.gte(salary) }); // 帖子薪资 >= 筛选下限
  if (price > 0) baseConds.push({ price: _.gte(price) }); // 转让/求店主价格(转让费/预算) >= 筛选下限
  if (cond > 0) baseConds.push({ cond: _.gte(cond) }); // 二手设备成色 >= 下限

  // 关键词：对文本字段正则模糊(OR)。keyword 与 data_type 叠加过滤
  if (keyword) {
    const rx = db.RegExp({ regexp: escapeReg(keyword), options: "i" });
    const textFields = ["raw_text", "role", "province", "city", "district", "address", "contact", "salary_note", "service_area"];
    const ors = textFields.map((f) => ({ [f]: rx }));
    baseConds.push(_.or(ors));
  }

  try {
    // ---------------- 批量模式：types 数组 ----------------
    // 一次云函数调用，内部按每个 type 各取当前页并合并（等价原前端多次并发）
    const types = Array.isArray(event.types) && event.types.length ? event.types : null;
    if (types) {
      const perRes = await Promise.all(
        types.map(async (tp) => {
          const q = mergeConds(baseConds.concat([{ data_type: tp }]));
          return fetchPageByCond(q, page, pageSize, openid);
        })
      );
      let list = perRes.reduce((acc, r) => acc.concat(r.list), []);
      const hasMore = perRes.some((r) => r.hasMore);
      // 第一页顶部合并置顶帖（去重：置顶帖从普通列表剔除）
      if (page === 1) {
        const tops = await fetchTops(types, openid, cityCode);
        if (tops.length) {
          const topIdSet = {};
          tops.forEach((t) => { topIdSet[t._id] = true; });
          list = list.filter((it) => !topIdSet[it._id]);
          list = tops.concat(list);
        }
      }
      return {
        success: true,
        list,
        page,
        pageSize,
        hasMore,
        total: hasMore ? -1 : (page - 1) * pageSize + list.length,
      };
    }

    // ---------------- 单类型 / 多类型混排 ----------------
    // dataTypes 优先于 dataType；都不传 = 全部分类(供全局搜索)
    const dataTypes = Array.isArray(event.dataTypes) && event.dataTypes.length ? event.dataTypes : null;
    if (dataTypes && dataTypes.length) {
      baseConds.push({ data_type: _.in(dataTypes) });
    } else if (event.dataType) {
      baseConds.push({ data_type: String(event.dataType) });
    }

    const query = mergeConds(baseConds);
    const { list: rawList, hasMore } = await fetchPageByCond(query, page, pageSize, openid);
    let list = rawList;
    // 第一页顶部合并置顶帖
    if (page === 1) {
      const topTypes = dataTypes && dataTypes.length ? dataTypes : [event.dataType || "recruit"];
      const tops = await fetchTops(topTypes, openid, cityCode);
      if (tops.length) {
        const topIdSet = {};
        tops.forEach((t) => { topIdSet[t._id] = true; });
        list = tops.concat(rawList.filter((it) => !topIdSet[it._id]));
      }
    }
    return {
      success: true,
      list,
      page,
      pageSize,
      hasMore,
      total: hasMore ? -1 : (page - 1) * pageSize + list.length,
    };
  } catch (e) {
    console.error("feedPosts 查询失败:", e);
    return {
      success: false,
      error: (e.errMsg || e.message || e) + "（检查 baozi_posts 集合是否存在）",
    };
  }
};
