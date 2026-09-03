// cloudfunctions/favorite/index.js
// 收藏功能（我的收藏）
// 集合 baozi_favorites：{ _openid, post_id, data_type, created_at }（_openid+post_id 唯一索引）
//
// action:
//   toggle  : 入参 post_id（+可选 data_type）；已收藏则取消，否则添加。返回 { is_fav }
//   list    : 分页拉"我收藏的帖子"，返回帖子原始文档（含被收藏时间），可进详情/展示
//   check   : 入参 post_ids=[...]；返回 { favMap:{post_id:true} }（批量判断是否已收藏）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const FAV = "baozi_favorites";
const POSTS = "baozi_posts";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  if (!openid) return fail("未获取到登录身份，请重新进入小程序", "NO_AUTH");

  const action = event.action || "toggle";
  try {
    switch (action) {
      case "toggle": return await actionToggle(openid, event);
      case "list": return await actionList(openid, event);
      case "check": return await actionCheck(openid, event);
      default: return fail("未知操作: " + action, "UNKNOWN_ACTION");
    }
  } catch (e) {
    console.error("[favorite]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};

// 收藏/取消
async function actionToggle(openid, event) {
  const postId = String(event.post_id || "").trim();
  if (!postId) return fail("缺少 post_id");

  const favColl = db.collection(FAV);
  // 判断帖子是否存在且可见
  let post = null;
  try {
    post = (await db.collection(POSTS).doc(postId).get()).data || null;
  } catch (e) { post = null; }
  if (!post) return fail("帖子不存在或已被删除", "NOT_FOUND");

  // 已收藏？
  const exist = (await favColl.where({ _openid: openid, post_id: postId }).limit(1).get()).data;
  if (exist.length) {
    await favColl.where({ _openid: openid, post_id: postId }).remove();
    return ok({ is_fav: false, toggled: "remove" });
  }

  await favColl.add({
    data: {
      _openid: openid,          // 云函数 add 需显式写 _openid（客户端行级规则用）
      post_id: postId,
      data_type: post.data_type || "",
      created_at: Date.now(),
    },
  });
  return ok({ is_fav: true, toggled: "add" });
}

// 我收藏的帖子列表：favorites 按时间倒序 → 批量取帖子
async function actionList(openid, event) {
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 10, 1), 30);
  const favColl = db.collection(FAV);

  const countRes = await favColl.where({ _openid: openid }).count();
  const total = countRes.total;
  const favRes = await favColl
    .where({ _openid: openid })
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const favs = favRes.data || [];
  const postIds = favs.map((f) => f.post_id).filter(Boolean);
  const byId = {};
  if (postIds.length) {
    // in 上限受云函数限制，分批查（每批 20）
    for (let i = 0; i < postIds.length; i += 20) {
      const batch = postIds.slice(i, i + 20);
      const pRes = await db.collection(POSTS).where({ _id: _.in(batch) }).get();
      (pRes.data || []).forEach((p) => { byId[p._id] = p; });
    }
  }

  const list = favs
    .map((f) => {
      const p = byId[f.post_id];
      if (!p) return null;
      return Object.assign({}, p, { faved_at: f.created_at });
    })
    .filter(Boolean);

  return ok({ list, total, page, pageSize, hasMore: page * pageSize < total });
}

// 批量判断是否已收藏
async function actionCheck(openid, event) {
  const ids = Array.isArray(event.post_ids) ? event.post_ids.map((x) => String(x).trim()).filter(Boolean) : [];
  const favMap = {};
  if (!ids.length) return ok({ favMap });
  const favColl = db.collection(FAV);
  // 分批 where _openid+post_id in
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const r = await favColl.where({ _openid: openid, post_id: _.in(batch) }).limit(batch.length).get();
    (r.data || []).forEach((f) => { favMap[f.post_id] = true; });
  }
  return ok({ favMap });
}
