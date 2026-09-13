// cloudfunctions/genNews/index.js
// 包子行业信息平台 · AI 快讯生成（DeepSeek 自由生成行业快讯）
//
// 入参：
//   { action: "generate", count?: 5 }        // 后台触发：生成 count 条快讯
//   { action: "list", page?, pageSize? }     // C 端：快讯列表
//   { action: "get", _id }                   // C 端：单条详情
//
// 返回：
//   generate → { success: true, created: N, items: [...] }
//   list     → { success: true, list: [...], total }
//   get      → { success: true, item }
//
// 快讯字段（news 集合）：
//   { title, summary, content, category, tags, status, published_at, created_at }
//
// 依赖：环境变量 DEEPSEEK_API_KEY
//
// 安全：
//   - generate 需口令校验（复用 ADMIN_USER/ADMIN_PASS，与 adminAuth 一致），防任意调用刷内容
//   - DeepSeek 输出白名单校验 + 长度截断 + 分类枚举校验
const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const NEWS = "news";
// 腾讯混元 MaaS 国际版（OpenAI 兼容接口，支持联网搜索 web_search_options）
const HUNYUAN_API_URL = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const HUNYUAN_MODEL = process.env.HUNYUAN_MODEL || "hy3"; // 模型名可配环境变量，默认 hy3

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

// 快讯分类枚举（中文）
const CATEGORIES = ["行业热点", "开店八卦", "品牌动态", "消费趋势", "政策法规", "经营趣闻"];

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

function str(v, max = 200) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

// 调用腾讯混元（联网搜索版，OpenAI 兼容接口）
async function callHunyuan(messages, maxTokens = 4000) {
  const apiKey = process.env.HUNYUAN_API_KEY;
  if (!apiKey) throw new Error("未配置 HUNYUAN_API_KEY 环境变量");
  const res = await axios.post(
    HUNYUAN_API_URL,
    {
      model: HUNYUAN_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: false,
      // 开启联网搜索（Hy3 需已开通联网搜索资源包）
      web_search_options: { enable: true },
    },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      timeout: 120000, // 联网搜索较慢，给足 2 分钟
    }
  );
  const content =
    (res.data && res.data.choices && res.data.choices[0] &&
      res.data.choices[0].message && res.data.choices[0].message.content) || "";
  return content;
}

// 校验并清洗混元输出（单条快讯）
function sanitizeNewsItem(item) {
  if (!item || typeof item !== "object") return null;
  const title = str(item.title, 60);
  const summary = str(item.summary, 120);
  const content = str(item.content, 1500);
  // 标题和正文必须有，否则丢弃
  if (!title || !content) return null;

  let category = str(item.category, 20);
  if (CATEGORIES.indexOf(category) < 0) category = "行业热点";

  // tags：数组或逗号分隔字符串，清洗成数组
  let tags = [];
  if (Array.isArray(item.tags)) {
    tags = item.tags.map((t) => str(t, 12)).filter(Boolean).slice(0, 4);
  } else if (typeof item.tags === "string") {
    tags = item.tags.split(/[,，、;；]/).map((t) => str(t, 12)).filter(Boolean).slice(0, 4);
  }

  return {
    title,
    summary: summary || content.slice(0, 80),
    content,
    category,
    tags,
    // 真实新闻附带字段（可能为空）
    image: str(item.image, 500) || "",
    source_url: str(item.source_url, 500) || "",
    source_name: str(item.source_name, 50) || "",
    publish_time: str(item.publish_time, 50) || "",
  };
}

// 生成快讯：用混元联网搜索，抓取包子/早餐行业最新真实新闻
async function actionGenerate(event) {
  const count = Math.min(10, Math.max(1, parseInt(event.count, 10) || 5));

  const todayStr = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });

  const prompt = `今天是 ${todayStr}。请【联网搜索】包子、早餐、面点行业的【最新真实新闻】，整理成 ${count} 条快讯。

【搜索方向（不限，只要真实、够新、有话题度）】
- 包子/早餐品牌的最新动态、融资、扩张、新品、联名、倒闭
- 包子店、早餐店的热点事件、社会新闻、争议话题
- 餐饮/早餐行业的政策、监管、食品安全新闻
- 网红包子、排队现象、猎奇口味、消费趋势
- 开包子店的创业故事、经营案例、行业数据

【严格要求】
1. 必须是【联网搜索到的真实新闻】，不是编造。每条尽量基于真实报道。
2. 【图片必做】联网搜索时，请一并搜索每条新闻的【配图】，找到新闻相关的【图片直链 URL】（形如 https://...jpg 或 https://...png 或 https://...webp）。要真实可访问的图片链接，优先取新闻正文里的实拍图/配图，不要用 logo、头像、占位图。实在搜不到合适的图片，才填空字符串""。
3. 每条快讯字段（输出 JSON）：
   - title：标题（30字以内，抓眼球）
   - summary：摘要（60字以内）
   - content：正文（150-400字，概括新闻要点，口语化）
   - category：分类，必须是【行业热点/开店八卦/品牌动态/消费趋势/政策法规/经营趣闻】之一
   - tags：标签数组（2-4个关键词）
   - image：新闻配图的图片直链 URL（必须真实可访问，搜不到才填""）
   - source_url：新闻原文链接（没有就填空字符串""）
   - source_name：新闻来源名称（如"澎湃新闻""界面新闻"，没有就填空字符串""）
   - publish_time：新闻发布时间（如"2026-09-11"，没有就填空字符串""）
4. 输出必须是合法 JSON，格式：{"items":[{"title":"...","summary":"...","content":"...","category":"...","tags":["..."],"image":"https://...jpg","source_url":"...","source_name":"...","publish_time":"..."}]}
只输出 JSON，不要任何解释文字。`;

  const content = await callHunyuan([
    { role: "system", content: "你是包子早餐行业的资讯编辑，擅长用联网搜索抓取真实行业新闻，整理成结构化快讯。" },
    { role: "user", content: prompt },
  ], 6000);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("混元返回无法解析");
    parsed = JSON.parse(m[0]);
  }

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items = rawItems.map(sanitizeNewsItem).filter(Boolean).slice(0, count);

  if (!items.length) throw new Error("未生成有效快讯");

  const now = Date.now();
  const created = [];
  for (const it of items) {
    const doc = Object.assign({}, it, {
      status: "published",
      published_at: it.publish_time ? new Date(it.publish_time).getTime() || now : now,
      created_at: now,
      source: "hunyuan",
    });
    const res = await db.collection(NEWS).add({ data: doc });
    created.push(Object.assign({ _id: res._id }, doc));
  }

  return ok({ created: created.length, items: created });
}

// 列表（C 端）：只返回已发布，按时间倒序
async function actionList(event) {
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 10));
  const cond = { status: "published" };

  let total = 0;
  try { total = (await db.collection(NEWS).where(cond).count()).total; } catch (e) { total = 0; }

  const res = await db.collection(NEWS)
    .where(cond)
    .orderBy("published_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  const list = (res.data || []).map((n) => ({
    _id: n._id,
    title: n.title,
    summary: n.summary,
    category: n.category,
    tags: n.tags || [],
    image: n.image || "",
    source_name: n.source_name || "",
    published_at: n.published_at,
  }));

  return ok({ list, total, page, pageSize });
}

// 详情（C 端）
async function actionGet(event) {
  const id = str(event._id, 64);
  if (!id) return fail("缺少快讯标识", "MISSING_ID");
  let doc = null;
  try {
    doc = (await db.collection(NEWS).doc(id).get()).data;
  } catch (e) {
    doc = null;
  }
  if (!doc || doc.status !== "published") return fail("快讯不存在", "NOT_FOUND");
  return ok({ item: doc });
}

// ==================== 管理端（需口令校验） ====================

// 校验管理口令（与 adminAuth 一致）
function checkAdminAuth(event) {
  const user = String(event.user || "").trim();
  const pass = String(event.pass || "").trim();
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// 管理端列表：返回全量（含下架/草稿）
async function actionAdminList(event) {
  const page = Math.max(1, parseInt(event.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize, 10) || 20));
  const cond = {};

  let total = 0;
  try { total = (await db.collection(NEWS).where(cond).count()).total; } catch (e) { total = 0; }

  const res = await db.collection(NEWS)
    .where(cond)
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  return ok({ list: res.data || [], total, page, pageSize });
}

// 管理端：更新快讯（标题/摘要/正文/分类/标签）
async function actionUpdate(event) {
  const id = str(event._id, 64);
  if (!id) return fail("缺少快讯标识", "MISSING_ID");

  const patch = {};
  if (event.title !== undefined) patch.title = str(event.title, 60);
  if (event.summary !== undefined) patch.summary = str(event.summary, 120);
  if (event.content !== undefined) patch.content = str(event.content, 1500);
  if (event.image !== undefined) patch.image = str(event.image, 500); // 封面图（cloud:// fileID 或 https URL）
  if (event.source_url !== undefined) patch.source_url = str(event.source_url, 500);
  if (event.category !== undefined) {
    const c = str(event.category, 20);
    patch.category = CATEGORIES.indexOf(c) >= 0 ? c : "行业资讯";
  }
  if (event.tags !== undefined) {
    let tags = [];
    if (Array.isArray(event.tags)) {
      tags = event.tags.map((t) => str(t, 12)).filter(Boolean).slice(0, 4);
    } else if (typeof event.tags === "string") {
      tags = event.tags.split(/[,，、;；]/).map((t) => str(t, 12)).filter(Boolean).slice(0, 4);
    }
    patch.tags = tags;
  }
  if (!Object.keys(patch).length) return fail("无更新内容", "EMPTY_PATCH");
  patch.updated_at = Date.now();

  try {
    await db.collection(NEWS).doc(id).update({ data: patch });
    return ok({ _id: id });
  } catch (e) {
    return fail("更新失败，快讯可能不存在", "UPDATE_FAILED");
  }
}

// 管理端：删除快讯
async function actionDelete(event) {
  const id = str(event._id, 64);
  if (!id) return fail("缺少快讯标识", "MISSING_ID");
  try {
    await db.collection(NEWS).doc(id).remove();
    return ok({ _id: id });
  } catch (e) {
    return fail("删除失败，快讯可能不存在", "DELETE_FAILED");
  }
}

// 管理端：上下线（published=上线 / offline=下线）
async function actionToggle(event) {
  const id = str(event._id, 64);
  if (!id) return fail("缺少快讯标识", "MISSING_ID");
  const target = event.status === "offline" ? "offline" : "published";
  try {
    await db.collection(NEWS).doc(id).update({
      data: { status: target, updated_at: Date.now() },
    });
    return ok({ _id: id, status: target });
  } catch (e) {
    return fail("操作失败，快讯可能不存在", "TOGGLE_FAILED");
  }
}

exports.main = async (event = {}) => {
  const action = event.action || "list";
  try {
    if (action === "generate") {
      if (!checkAdminAuth(event)) return fail("未授权", "AUTH_FAILED");
      return await actionGenerate(event);
    }
    if (action === "get") return await actionGet(event);
    if (action === "list") return await actionList(event);

    // 管理端 action：统一口令校验
    if (!checkAdminAuth(event)) return fail("未授权", "AUTH_FAILED");
    if (action === "admin_list") return await actionAdminList(event);
    if (action === "update") return await actionUpdate(event);
    if (action === "delete") return await actionDelete(event);
    if (action === "toggle") return await actionToggle(event);

    return fail("未知操作: " + action, "UNKNOWN_ACTION");
  } catch (e) {
    console.error("[genNews]", action, "失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};
