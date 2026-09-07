// cloudfunctions/aiAnalyzePost/index.js
// 用 DeepSeek 从帖子摘要(raw_text)抽取结构化字段，只补「空字段」。
//
// 入参：
//   { action: "one", _id: "..." }            // 单条分析（发布后异步调用）
//   { action: "batch", data_type?: "..." }   // 批量分析（老数据迁移后补字段，可传 data_type 过滤）
//
// 返回：
//   { success: true, enriched: {...}, matched: 字段名数组 }
//   | { success: false, error }
//
// 依赖：
//   - 环境变量 DEEPSEEK_API_KEY（DeepSeek API Key，部署后在云函数环境变量中配置）
//   - 环境变量 DEEPSEEK_BASE_URL（可选，默认 https://api.deepseek.com）
//
// 安全原则：
//   - 只输出/写回「当前为空」的字段，已有字段一律不动（不覆盖、不"纠正"）。
//   - DeepSeek 输出经白名单过滤 + 类型校验，非法值丢弃。
//   - 分析失败不影响主流程（静默跳过，日志留痕）。
const cloud = require("wx-server-sdk");
const https = require("https");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTION = "baozi_posts";

// 可被 AI 补充的字段白名单（与 publishPost 字段对齐）
const AI_FIELDS = [
  "data_type", "role", "role_id",
  "salary", "salary_expect", "salary_note",
  "availability", "service_area",
  "want_terms", "terms",
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment",
  "rent_max", "area_min", "cond",
];

// data_type 枚举
const DATA_TYPES = [
  "recruit", "jobseek", "transfer", "want_shop",
  "equip_sell", "equip_buy", "carpool_car", "carpool_person", "other",
];

// 数字字段
const NUMBER_FIELDS = [
  "role_id", "salary", "salary_expect", "price", "monthly_rent",
  "area_sqm", "daily_revenue", "rent_max", "area_min", "cond",
];

// 数组字段（DeepSeek 输出可能给字符串，转数组）
const ARRAY_FIELDS = ["want_terms", "terms"];

// 师傅类型枚举（role_id 1-14，与 recruit 频道一致）
const ROLE_MAP = {
  1: "包子师傅", 2: "二把手", 3: "售卖", 4: "夫妻工", 5: "学徒",
  6: "全能面点师", 7: "生煎师傅", 8: "顶班师傅", 9: "打杂",
  10: "烧麦师傅", 11: "油炸", 12: "收银", 13: "店长", 14: "其他",
};

function maskPhone(p) {
  const s = String(p || "").trim();
  return /^1\d{10}$/.test(s) ? s.slice(0, 3) + "****" + s.slice(7) : "";
}

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 调用 DeepSeek（OpenAI 兼容接口，用 Node 原生 https 避免依赖 fetch）
function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return reject(new Error("未配置 DEEPSEEK_API_KEY 环境变量"));
    const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

    const postData = JSON.stringify({
      model: "deepseek-chat",
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
          return reject(new Error(`DeepSeek 请求失败: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          const content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : "";
          resolve(content);
        } catch (e) {
          reject(new Error("DeepSeek 返回解析失败"));
        }
      });
    });

    req.on("error", (e) => reject(new Error("DeepSeek 请求出错: " + (e.message || e))));
    req.on("timeout", () => { req.destroy(new Error("DeepSeek 请求超时")); });
    req.write(postData);
    req.end();
  });
}

// 构造 prompt：只补空字段
function buildPrompt(rawText, dataType) {
  const roleList = Object.entries(ROLE_MAP).map(([id, name]) => `${id}=${name}`).join(", ");
  return `你是包子行业信息平台的字段抽取助手。从帖子摘要中抽取结构化字段。

帖子摘要：
${rawText}

规则（严格遵守）：
1. 只输出「当前为空、且能从摘要中确定」的字段。不确定的字段不要输出，不要编造。
2. 输出必须是合法 JSON 对象，键只能是下面列出的字段名，不要任何解释文字。
3. 字段定义：
   - data_type: 必须是 ${DATA_TYPES.join("/")} 之一（招聘→recruit，求职→jobseek，转让→transfer，求店→want_shop，设备出售→equip_sell，设备求购→equip_buy，车找人→carpool_car，人找车→carpool_person，其他→other）
   - role: 师傅类型中文名，从下面枚举选：${roleList}
   - role_id: 对应 role 的数字(1-14)，无法确定给 0
   - salary: 招工给价(元/月，数字)，招聘帖才输出
   - salary_expect: 求职期望薪资(元/月，数字)，求职帖才输出
   - salary_note: 薪资补充说明文字
   - availability: 到岗方式，只能是"长期/短期/顶班/随时可到"之一
   - service_area: 可服务地区文字
   - want_terms: 诉求标签数组(如["包吃住","单间","月结"])
   - price: 转让费/预算(元，数字)
   - monthly_rent: 月租(元/月，数字)
   - area_sqm: 面积(平方米，数字)
   - daily_revenue: 日营业额(元/天，数字)
   - has_equipment: 带不带设备，只能是"全带/部分/不带"之一
   - rent_max: 租金上限(元/月，数字)
   - area_min: 面积下限(平方米，数字)
   - cond: 成色(0-10，数字)
   - terms: 转让条件数组(如["证照齐全","有保护"])

已知该帖 data_type 是「${dataType}」，如摘要与之一致可复用，否则按摘要判断。

只输出 JSON，例如：{"role":"包子师傅","role_id":1,"salary":8000}`;
}

// 校验并清洗 DeepSeek 输出，只保留合法字段
function sanitizeAIOutput(parsed, dataType) {
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;

  for (const k of AI_FIELDS) {
    const v = parsed[k];
    if (v === undefined || v === null || v === "") continue;

    if (k === "data_type") {
      if (DATA_TYPES.indexOf(String(v)) >= 0) out[k] = String(v);
      continue;
    }
    if (k === "role") {
      const s = String(v).trim();
      if (s && s.length <= 24) out[k] = s;
      continue;
    }
    if (k === "role_id") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n <= 14) out[k] = n;
      continue;
    }
    if (k === "availability") {
      const s = String(v).trim();
      if (["长期", "短期", "顶班", "随时可到"].indexOf(s) >= 0) out[k] = s;
      continue;
    }
    if (k === "has_equipment") {
      const s = String(v).trim();
      if (["全带", "部分", "不带"].indexOf(s) >= 0) out[k] = s;
      continue;
    }
    if (NUMBER_FIELDS.indexOf(k) >= 0) {
      const n = Number(String(v).replace(/[^\d.]/g, ""));
      if (!isNaN(n) && n >= 0) out[k] = n;
      continue;
    }
    if (ARRAY_FIELDS.indexOf(k) >= 0) {
      if (Array.isArray(v)) {
        const arr = v.map((x) => String(x).trim()).filter((x) => x && x.length <= 24).slice(0, 6);
        if (arr.length) out[k] = arr;
      } else if (typeof v === "string") {
        const arr = v.split(/[,，、;；]/).map((x) => x.trim()).filter((x) => x && x.length <= 24).slice(0, 6);
        if (arr.length) out[k] = arr;
      }
      continue;
    }
    // 其余字符串字段
    const s = String(v).trim();
    if (s && s.length <= 200) out[k] = s;
  }
  return out;
}

// 判断帖子哪些字段为空（需要补），并只写回这些空字段
function pickEmptyFields(doc, aiOut) {
  const patch = {};
  const matched = [];
  for (const k of Object.keys(aiOut)) {
    // 仅当原字段为空/0 时才用 AI 值补
    const cur = doc[k];
    const isEmpty = cur === undefined || cur === null || cur === "" || cur === 0 || cur === false;
    if (isEmpty && aiOut[k] !== undefined) {
      patch[k] = aiOut[k];
      matched.push(k);
    }
  }
  return { patch, matched };
}

// 单条分析 + 写回空字段
async function analyzeOne(postId) {
  const res = await db.collection(COLLECTION).doc(postId).get();
  const doc = res.data;
  if (!doc) return fail("帖子不存在", "NOT_FOUND");

  const rawText = String(doc.raw_text || "").trim();
  if (!rawText) return fail("帖子无摘要", "NO_TEXT");

  const dataType = doc.data_type || "other";

  const content = await callDeepSeek([
    { role: "system", content: "你是包子行业信息平台的字段抽取助手。" },
    { role: "user", content: buildPrompt(rawText, dataType) },
  ]);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // DeepSeek 可能返回非纯 JSON，尝试提取 {...}
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return fail("DeepSeek 返回无法解析", "PARSE_FAIL");
    try { parsed = JSON.parse(m[0]); } catch (e2) { return fail("DeepSeek 返回无法解析", "PARSE_FAIL"); }
  }

  const aiOut = sanitizeAIOutput(parsed, dataType);
  const { patch, matched } = pickEmptyFields(doc, aiOut);

  // 无论是否抽到字段，都写 _ai_enriched 标记（空数组表示"处理过但无字段可补"），
  // 避免 batch 下次又把"抽不出字段"的帖子重复选中。
  if (!matched.length) {
    await db.collection(COLLECTION).doc(postId).update({
      data: { _ai_enriched: [], updated_at: Date.now() },
    });
    return ok({ enriched: false, matched: [] });
  }

  patch._ai_enriched = matched; // 标记哪些字段是 AI 补的
  patch.updated_at = Date.now();
  await db.collection(COLLECTION).doc(postId).update({ data: patch });

  return ok({ enriched: true, matched, patch });
}

// 批量分析：只处理「还没补过 _ai_enriched 字段」的老数据(import_legacy)
// 内部循环处理多批，直到剩余为 0 或接近超时上限（避免单次 invoke 串行调用太多而超时）。
// 单批 size 条串行处理，批间靠 _ai_enriched 标记天然去重（幂等）。
async function analyzeBatch(event) {
  const size = Math.min(50, Math.max(1, parseInt(event.size, 10) || 50));
  const startTime = Date.now();
  const MAX_MS = 280 * 1000; // 留 20 秒余量给收尾

  let totalDone = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let remaining = -1;

  while (Date.now() - startTime < MAX_MS) {
    const conds = [
      { source: "import_legacy" },
      { _ai_enriched: _.exists(false) }, // 只处理还没补过字段的（幂等）
    ];
    if (event.data_type) conds.push({ data_type: event.data_type });

    const countRes = await db.collection(COLLECTION).where(_.and(conds)).count();
    remaining = countRes.total;
    if (remaining <= 0) break; // 全部处理完

    const res = await db.collection(COLLECTION)
      .where(_.and(conds))
      .orderBy("published_at", "desc")
      .limit(size)
      .get();

    const list = res.data || [];
    if (!list.length) break;

    for (const doc of list) {
      if (Date.now() - startTime >= MAX_MS) break; // 超时停止，剩余下轮继续
      try {
        const r = await analyzeOne(doc._id);
        if (r.success && r.enriched) totalDone += 1;
        else totalSkipped += 1;
      } catch (e) {
        totalFailed += 1;
        console.error("[aiAnalyzePost] 批量分析单条失败:", doc._id, e && e.message);
      }
    }
  }

  return ok({ done: totalDone, skipped: totalSkipped, failed: totalFailed, remaining });
}

exports.main = async (event = {}) => {
  // 定时触发器触发时 event 里没有 action/_id，默认走 batch（每批补一小批字段）
  const action = event.action || (event._id ? "one" : "batch");
  try {
    if (action === "batch") {
      return await analyzeBatch(event);
    }
    // 单条
    if (!event._id) return fail("缺少 _id");
    return await analyzeOne(event._id);
  } catch (e) {
    console.error("[aiAnalyzePost] 失败:", e);
    return fail(String(e && e.message ? e.message : e));
  }
};
