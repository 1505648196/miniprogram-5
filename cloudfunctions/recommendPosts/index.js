// cloudfunctions/recommendPosts/index.js
// 发布成功后的互补推荐：根据刚发布的信息类型，推荐「互补类型」的同城最新信息；
// 同城数据为 0 时，回退返回该互补类型的最新信息（不限城市）。
//
// 互补映射：
//   recruit(招工)      → jobseek(求职)
//   jobseek(求职)      → recruit(招工)
//   transfer(转让)     → want_shop(求店)
//   want_shop(求店)    → transfer(转让)
//   equip_sell(设备出售) → equip_buy(设备求购)
//   equip_buy(设备求购)  → equip_sell(设备出售)
//
// 入参：
//   { data_type: "recruit", city_code: "440300" }  // 刚发布的信息类型 + 城市码
//
// 返回：
//   { success: true, recommend_type, recommend_title, recommend_list, matched_city: bool }
//   | { success: false, error }
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const POSTS = "baozi_posts";

// 业务 → 互补推荐业务
const RECOMMEND_MAP = {
  recruit: "jobseek",
  jobseek: "recruit",
  transfer: "want_shop",
  want_shop: "transfer",
  equip_sell: "equip_buy",
  equip_buy: "equip_sell",
};

// 推荐类型中文名（标题文案用）
const RECOMMEND_NAMES = {
  jobseek: "求职",
  recruit: "招工",
  want_shop: "求店",
  transfer: "转让",
  equip_buy: "设备求购",
  equip_sell: "设备出售",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 拉推荐列表：按互补类型 + 可选城市过滤，最新 20 条
async function fetchRecommend(recommendType, cityCode) {
  const where = {
    data_type: recommendType,
    approved: true,
    status: _.neq("offline"),
  };
  if (cityCode) where.city_code = cityCode;

  const res = await db.collection(POSTS)
    .where(where)
    .orderBy("published_at", "desc")
    .limit(20)
    .get();

  return (res.data || []).map((p) => {
    // 脱敏号优先取 phone_masked，否则从 phone 字段现算（138****5678）
    let phoneMasked = String(p.phone_masked || "").trim();
    if (!phoneMasked && p.phone) {
      const ph = String(p.phone).replace(/\D/g, "");
      if (/^1[3-9]\d{9}$/.test(ph)) phoneMasked = `${ph.slice(0, 3)}****${ph.slice(7)}`;
    }
    return {
      _id: p._id,
      data_type: p.data_type,
      title: String(p.raw_text || "").trim().split("\n")[0] || "",
      role: p.role || "",
      salary: Number(p.salary) || 0,
      price: Number(p.price) || 0,
      province: p.province || "",
      city: p.city || "",
      district: p.district || "",
      phone_masked: phoneMasked,
      published_at: p.published_at || 0,
    };
  });
}

exports.main = async (event = {}) => {
  const dataType = String(event.data_type || "").trim();
  if (!dataType) return fail("缺少 data_type", "MISSING_TYPE");

  const recommendType = RECOMMEND_MAP[dataType];
  if (!recommendType) return fail("不支持的发布类型: " + dataType, "BAD_TYPE");

  const cityCode = String(event.city_code || "").trim();

  try {
    // 1) 先按同城匹配
    let list = [];
    let matchedCity = false;
    if (cityCode) {
      list = await fetchRecommend(recommendType, cityCode);
      matchedCity = list.length > 0;
    }

    // 2) 同城无数据 → 回退最新互补信息（不限城市）
    if (!list.length) {
      list = await fetchRecommend(recommendType, "");
    }

    const recommendTitle = "为你匹配到合适的最新信息";
    const recommendSubtitle = `已按「${RECOMMEND_NAMES[recommendType] || ""}」为你筛选${matchedCity ? "同城" : "最新"}信息`;

    return ok({
      recommend_type: recommendType,
      recommend_title: recommendTitle,
      recommend_subtitle: recommendSubtitle,
      recommend_list: list,
      matched_city: matchedCity,
    });
  } catch (e) {
    console.error("[recommendPosts] 失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};
