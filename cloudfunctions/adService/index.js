// cloudfunctions/adService/index.js
// 广告运营位统一拉取（方案 C：完全数据驱动）
//
// 两张集合：
//   ad_slots       广告位定义（后台可动态创建）
//     字段：_id, slot(唯一标识), page(所属页面), position(位置), type(渲染形态),
//           title(名称), sort, status, created_at
//   advertisements 广告内容（挂到某个广告位）
//     字段：_id, slot(所属广告位), page, position, type, title, image, icon, emoji,
//           sub, bgFrom, bgTo, link, linkType, target, sort, status, start_at, end_at
//
// 入参（优先级从上到下）：
//   { slots: ['home_banner', ...] }                  // 兼容旧写法：精确按 slot 数组
//   { slot: 'home_banner' }                          // 单个 slot
//   { page: 'demo', positions: ['banner', 'card'] }  // 方案 C：按页面 + 广告位列表拉
//   { page: 'demo' }                                 // 按页面拉该页所有广告
//
// 返回：
//   { success: true, list: [广告对象...], slots: [广告位定义...] }
//   广告对象字段：_id, slot, page, position, type, title, image, icon, emoji, sub,
//                 bgFrom, bgTo, link, linkType, target, sort, status, start_at, end_at

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ADS = "advertisements";
const SLOTS = "ad_slots";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 有效期判断（Node 层后置过滤，避免 wx-server-sdk 对 _.or/_.lte 组合的兼容坑）：
// start_at / end_at 为 0（或缺失/非数字）表示「不限」。
//   start_at=0 → 立即生效；end_at=0 → 永不过期。
function inPeriod(ad, now) {
  const s = Number(ad && ad.start_at) || 0;
  const e = Number(ad && ad.end_at) || 0;
  if (s && s > now) return false;   // 指定了开始时间且未到 → 不展示
  if (e && e < now) return false;   // 指定了结束时间且已过期 → 不展示
  return true;
}

// 把广告位定义换算成 {page, position} 精确查询条件（方案 C）
async function resolveSlots(page, positions) {
  const q = { page, status: "online" };
  if (Array.isArray(positions) && positions.length) {
    q.position = _.in(positions);
  }
  const res = await db.collection(SLOTS).where(q).orderBy("sort", "desc").limit(100).get();
  return res.data || [];
}

exports.main = async (event = {}) => {
  try {
    const now = Date.now();
    // 基础条件只放 status:online（有效期在 Node 层过滤，见 inPeriod）
    const cond = { status: "online" };

    let slotList = null;   // 命中广告位的 slot 名数组（用于精准过滤广告内容）

    // 方式1：精确按 slots 数组拉（兼容旧写法）
    if (event.slots && Array.isArray(event.slots) && event.slots.length) {
      cond.slot = _.in(event.slots);
    }
    // 方式2：单个 slot
    else if (event.slot) {
      cond.slot = event.slot;
    }
    // 方式3（方案 C）：按 page + positions 拉 —— 先查 ad_slots 得到该页面/位置的广告位，
    //   再按 slot 精准取广告内容
    else if (event.page) {
      const slots = await resolveSlots(event.page, event.positions);
      const slotNames = slots.map((s) => s.slot);
      if (slotNames.length) {
        cond.slot = _.in(slotNames);
      } else {
        // 该页面下无任何已上线广告位 → 直接返回空，不再查询广告内容
        return ok({ list: [], slots: [] });
      }
      slotList = slots;
    }

    const res = await db.collection(ADS)
      .where(cond)
      .orderBy("sort", "desc")       // sort 越大越靠前
      .orderBy("created_at", "desc") // 同权重按时间倒序
      .limit(100)
      .get();

    // 有效期过滤（0/缺失 = 不限，见 inPeriod）
    const list = (res.data || []).filter((ad) => inPeriod(ad, now));

    return ok({ list, slots: slotList || [] });
  } catch (e) {
    console.error("[adService] 拉取广告失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};
