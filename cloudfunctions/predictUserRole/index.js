// cloudfunctions/predictUserRole/index.js
// 用户角色预测：用 DeepSeek 分析某用户发布过的所有信息，推测其在六大业务上的概率，
// 结果写入 baozi_users.role_prediction 字段。
//
// 六大业务（与帖子 data_type 枚举对齐）：
//   recruit 招工 / transfer 转让 / equip_sell 设备出售 /
//   want_shop 求店 / jobseek 求职 / equip_buy 设备求购
//
// 入参：
//   { openid?: "..." }   // 要预测的目标用户 openid；缺省 = 当前调用者自己
//   { model?: "..." }    // 可选：覆盖默认模型（默认 deepseek-chat）
//   { base_url?: "..." } // 可选：覆盖默认 API 地址（默认读环境变量 DEEPSEEK_BASE_URL / api.deepseek.com）
//
// 返回：
//   { success: true, role_prediction: {...} }
//   | { success: false, error }
//
// 依赖环境变量：
//   DEEPSEEK_API_KEY     // 必填，DeepSeek API Key
//   DEEPSEEK_BASE_URL    // 可选，默认 https://api.deepseek.com
//   DEEPSEEK_MODEL       // 可选，默认 deepseek-chat（可被入参 model 覆盖）
//
// 触发方式：publishPost 发布成功后异步调用本函数（见 publishPost 改造）。
// 安全：预测失败不影响发布主流程；DeepSeek 输出经白名单 + 数值校验，非法值丢弃。
const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const USERS = "baozi_users";
const POSTS = "baozi_posts";

// 六大业务 data_type 枚举（与帖子 data_type 对齐）
const BIZ_TYPES = ["recruit", "transfer", "equip_sell", "want_shop", "jobseek", "equip_buy"];

// 业务中文名（prompt 用）
const BIZ_NAMES = {
  recruit: "招工",
  transfer: "转让",
  equip_sell: "设备出售",
  want_shop: "求店",
  jobseek: "求职",
  equip_buy: "设备求购",
};

// 业务 → 身份映射（预测出最大概率业务后，反推用户身份）
const IDENTITY_MAP = {
  recruit: "老板",     // 发招工 = 老板
  transfer: "转让方",  // 发转让 = 想转店的人
  equip_sell: "卖家",  // 发设备出售 = 卖家
  want_shop: "求店方", // 发求店 = 想找店的人
  jobseek: "求职者",   // 发求职 = 找工作的人
  equip_buy: "买家",   // 发设备求购 = 买家
};

// 业务 → 互补推荐业务（预测出某身份后，推对他最有用的一类信息）
// 老板(招工) → 推求职信息帮他招人；求职者 → 推招工信息帮他找工作；卖↔买、转↔接 同理
const RECOMMEND_MAP = {
  recruit: "jobseek",     // 老板 → 推求职
  jobseek: "recruit",     // 求职者 → 推招工
  transfer: "want_shop",  // 转让方 → 推求店
  want_shop: "transfer",  // 求店方 → 推转让
  equip_sell: "equip_buy",// 卖家 → 推求购
  equip_buy: "equip_sell",// 买家 → 推出售
};

// 身份 → 推荐标题文案
const RECOMMEND_TITLES = {
  recruit: "为你推荐最新求职信息",
  jobseek: "为你推荐最新招工信息",
  transfer: "为你推荐最新求店信息",
  want_shop: "为你推荐最新转让信息",
  equip_sell: "为你推荐最新设备求购信息",
  equip_buy: "为你推荐最新设备出售信息",
};

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 调用 DeepSeek（OpenAI 兼容接口，Node 原生 https，复用 aiAnalyzePost 的方式）
// model / baseUrl 可被入参覆盖，便于切换模型。
function callDeepSeek(messages, opts) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return reject(new Error("未配置 DEEPSEEK_API_KEY 环境变量"));
    const model = (opts && opts.model) || process.env.DEEPSEEK_MODEL || "deepseek-chat";
    const baseUrl = (opts && opts.base_url) || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

    const postData = JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 600,
    });

    const url = new URL(`${baseUrl}/chat/completions`);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`模型请求失败: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          const content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : "";
          resolve(content);
        } catch (e) {
          reject(new Error("模型返回解析失败"));
        }
      });
    });

    req.on("error", (e) => reject(new Error("模型请求出错: " + (e.message || e))));
    req.on("timeout", () => { req.destroy(new Error("模型请求超时")); });
    req.write(postData);
    req.end();
  });
}

// 构造 prompt：让模型基于历史帖子输出六大业务概率
function buildPrompt(posts) {
  const lines = posts.map((p, i) => {
    const name = BIZ_NAMES[p.data_type] || p.data_type || "其他";
    const text = String(p.raw_text || "").trim().replace(/\s+/g, " ").slice(0, 100);
    return `${i + 1}. [${name}] ${text}`;
  }).join("\n");

  return `你是包子行业信息平台的用户角色分析助手。根据用户历史发布的信息，推测该用户未来最可能发布哪类信息的概率。

用户历史发布记录（共 ${posts.length} 条）：
${lines || "（无记录）"}

六大业务类型（只允许这 6 个 key）：
- recruit=招工（发招聘信息，找人来干活）
- transfer=转让（转让店铺）
- equip_sell=设备出售（卖二手设备）
- want_shop=求店（找店/求租店铺）
- jobseek=求职（找工作）
- equip_buy=设备求购（求购二手设备）

规则（严格遵守）：
1. 基于用户历史行为模式推测：发布过某类的次数越多，该类概率越高；历史记录为空时给均衡概率。
2. 六个概率值之和必须等于 1。
3. 概率为 0~1 之间的小数，保留两位（如 0.42）。
4. 只输出 JSON，不要任何解释文字。

输出格式（严格）：
{"recruit":0.42,"transfer":0.08,"equip_sell":0.10,"want_shop":0.05,"jobseek":0.15,"equip_buy":0.20}`;
}

// 校验并清洗模型输出，只保留六个合法概率，并归一化
function sanitizeProbabilities(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  const probs = {};
  let total = 0;
  for (const k of BIZ_TYPES) {
    let v = Number(parsed[k]);
    if (isNaN(v) || v < 0) v = 0;
    if (v > 1) v = v / 100; // 容错：如果给的是 0~100，转成 0~1
    probs[k] = Math.round(v * 100) / 100; // 保留两位
    total += probs[k];
  }

  // 归一化：确保六项之和 = 1（保留两位后可能 ±0.01 误差，做一次整体归一）
  if (total > 0) {
    for (const k of BIZ_TYPES) {
      probs[k] = Math.round((probs[k] / total) * 100) / 100;
    }
  } else {
    // 全 0 兜底：均衡概率
    const avg = Math.round((1 / BIZ_TYPES.length) * 100) / 100;
    BIZ_TYPES.forEach((k) => { probs[k] = avg; });
  }
  return probs;
}

// 拉取某用户全部帖子（含 data_type + raw_text，用于分析）
async function fetchUserPosts(openid) {
  // 云函数单次查询上限 100 条；分批拉，最多 500 条（足够覆盖用户历史）
  const all = [];
  const batch = 100;
  let skip = 0;
  for (let i = 0; i < 5; i++) {
    const res = await db.collection(POSTS)
      .where({ _openid: openid })
      .orderBy("published_at", "desc")
      .skip(skip)
      .limit(batch)
      .get();
    const list = res.data || [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < batch) break;
    skip += batch;
  }
  return all;
}

// 拉互补业务的推荐信息（最新 20 条），复用 feedPosts 的查询语义
// 推荐业务类型 recommendType 由 primary_role 映射得出
async function fetchRecommendList(recommendType) {
  try {
    const res = await db.collection(POSTS)
      .where({
        data_type: recommendType,
        approved: true,
        status: _.neq("offline"),
      })
      .orderBy("published_at", "desc")
      .limit(20)
      .get();
    const list = (res.data || []).map((p) => ({
      _id: p._id,
      data_type: p.data_type,
      title: String(p.raw_text || "").trim().split("\n")[0] || "",
      role: p.role || "",
      salary: Number(p.salary) || 0,
      price: Number(p.price) || 0,
      province: p.province || "",
      city: p.city || "",
      district: p.district || "",
      published_at: p.published_at || 0,
    }));
    return list;
  } catch (e) {
    console.error("[predictUserRole] 拉推荐信息失败:", e && e.errMsg);
    return [];
  }
}

// 预测单用户角色
async function predictOne(openid, opts) {
  // 1) 拉历史帖子
  let posts = [];
  try {
    posts = await fetchUserPosts(openid);
  } catch (e) {
    console.error("[predictUserRole] 拉取历史帖子失败:", e && e.errMsg);
    // 拉取失败不阻断，仍用空历史让模型给均衡概率
  }

  // 2) 调模型
  const content = await callDeepSeek(
    [
      { role: "system", content: "你是包子行业信息平台的用户角色分析助手，输出严格的 JSON。" },
      { role: "user", content: buildPrompt(posts) },
    ],
    opts
  );

  // 3) 解析模型输出
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return fail("模型返回无法解析", "PARSE_FAIL");
    try { parsed = JSON.parse(m[0]); } catch (e2) { return fail("模型返回无法解析", "PARSE_FAIL"); }
  }

  const probabilities = sanitizeProbabilities(parsed);
  if (!probabilities) return fail("模型输出缺少概率字段", "BAD_OUTPUT");

  // 4) 计算主角色 + 置信度
  let primary_role = BIZ_TYPES[0];
  let confidence = 0;
  for (const k of BIZ_TYPES) {
    if (probabilities[k] > confidence) {
      confidence = probabilities[k];
      primary_role = k;
    }
  }

  const rolePrediction = {
    model: (opts && opts.model) || process.env.DEEPSEEK_MODEL || "deepseek-chat",
    predicted_at: Date.now(),
    based_on_count: posts.length, // 基于多少条历史信息分析
    probabilities,
    primary_role,
    confidence,
  };

  // 5) 写回 baozi_users
  const users = db.collection(USERS);
  const exist = (await users.where({ openid_wxapp: openid }).limit(1).get()).data;
  if (exist && exist[0]) {
    await users.doc(exist[0]._id).update({
      data: { role_prediction: rolePrediction, updated_at: Date.now() },
    });
  } else {
    // 用户不存在：兜底建一个最小用户文档（仅写 role_prediction + openid）
    await users.add({
      data: {
        openid_wxapp: openid,
        role_prediction: rolePrediction,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
  }

  // 6) 身份映射 + 拉互补业务推荐信息（20 条）
  const identity = IDENTITY_MAP[primary_role] || "";
  const recommendType = RECOMMEND_MAP[primary_role] || "";
  const recommendTitle = RECOMMEND_TITLES[primary_role] || "为你推荐";
  const recommend_list = recommendType ? await fetchRecommendList(recommendType) : [];

  return ok({
    role_prediction: rolePrediction,
    identity,
    primary_role,
    recommend_type: recommendType,
    recommend_title: recommendTitle,
    recommend_list,
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const openid = event.openid || event._openid || OPENID || "";
  if (!openid) return fail("未获取到用户身份", "NO_AUTH");

  const opts = {
    model: event.model || "",
    base_url: event.base_url || "",
  };

  try {
    return await predictOne(openid, opts);
  } catch (e) {
    console.error("[predictUserRole] 失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};
