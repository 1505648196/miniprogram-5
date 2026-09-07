// tools/import-legacy-posts/enrich.js
// Step2：读 cleaned.json → DeepSeek 补字段（按 data_type 补不同专项字段）→ 写 enriched.json
//
// 用法（命令行）：
//   node enrich.js --dry-run N     # 只跑前 N 条（默认 10），打印补字段效果，不写文件
//   node enrich.js                 # 全量跑，产出 enriched.json（断点续跑）
//   node enrich.js --resume        # 从上次进度续跑（等价于不带参数，脚本自动续跑）
//
// 关键设计（严谨性）：
//   - 按 data_type 用不同的字段白名单 + prompt，避免张冠李戴（转让帖不补师傅类型等）
//   - DeepSeek 输出经白名单过滤 + 类型校验，非法值丢弃
//   - 解析失败/无字段：保留原对象，标记 _ai_enriched: []，不丢弃
//   - 并发 8 跑 DeepSeek，每 50 条落一次盘（断点续跑）
//   - 数字字段强制数字，枚举字段强制枚举
const fs = require("fs");
const path = require("path");
const https = require("https");

// ---- 配置 ----
const CLEANED_FILE = path.join(__dirname, "output", "cleaned.json");
const ENRICHED_FILE = path.join(__dirname, "output", "enriched.json");
const PROGRESS_FILE = path.join(__dirname, "output", "enrich.progress.json");
const ENV_FILE = path.join(__dirname, ".env.local");
const CONCURRENCY = 8; // 并发数

// ---- 读 DeepSeek key（优先 .env.local，其次环境变量）----
function loadApiKey() {
  if (fs.existsSync(ENV_FILE)) {
    const txt = fs.readFileSync(ENV_FILE, "utf8");
    const m = txt.match(/^DEEPSEEK_API_KEY\s*=\s*(\S+)/m);
    if (m && m[1] && !m[1].includes("你的key")) return m[1].trim();
  }
  return process.env.DEEPSEEK_API_KEY || "";
}
const API_KEY = loadApiKey();

// ---- 师傅类型枚举（与 recruit 频道一致）----
const ROLE_MAP = {
  1: "包子师傅", 2: "二把手", 3: "售卖", 4: "夫妻工", 5: "学徒",
  6: "全能面点师", 7: "生煎师傅", 8: "顶班师傅", 9: "打杂",
  10: "烧麦师傅", 11: "油炸", 12: "收银", 13: "店长", 14: "其他",
};
const ROLE_LIST = Object.entries(ROLE_MAP).map(([id, name]) => `${id}=${name}`).join(", ");

// ---- 按 data_type 的字段白名单 + 说明（严谨：各分类各补各的）----
const FIELD_PLAN = {
  recruit: {
    fields: ["role", "role_id", "salary"],
    desc: "招聘帖，只抽师傅类型(role/role_id)和给价(salary)",
  },
  jobseek: {
    fields: ["role", "role_id", "salary_expect", "salary", "salary_note", "availability", "service_area", "want_terms"],
    desc: "求职帖，抽师傅类型(role/role_id)、期望薪资(salary_expect)、到岗方式(availability)、可服务地区(service_area)、诉求标签(want_terms)",
  },
  transfer: {
    fields: ["price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment", "terms"],
    desc: "转让帖，抽转让费(price)、月租(monthly_rent)、面积(area_sqm)、日营业额(daily_revenue)、带设备(has_equipment)、转让条件(terms)",
  },
  want_shop: {
    fields: ["price", "rent_max", "area_min", "want_terms"],
    desc: "求店帖，抽预算(price)、租金上限(rent_max)、面积下限(area_min)、诉求(want_terms)",
  },
  equip_sell: {
    fields: ["price", "cond"],
    desc: "设备出售帖，抽售价(price)、成色(cond 0-10)",
  },
  equip_buy: {
    fields: ["price", "cond"],
    desc: "设备求购帖，抽预算(price)、期望成色(cond 0-10)",
  },
  carpool_car: {
    fields: ["from_place", "to_place", "depart_time", "seats"],
    desc: "车找人帖，抽出发地(from_place)、目的地(to_place)、出发时间(depart_time)、可乘人数(seats)",
  },
  carpool_person: {
    fields: ["from_place", "to_place", "depart_time", "seats"],
    desc: "人找车帖，抽出发地(from_place)、目的地(to_place)、出发时间(depart_time)、人数(seats)",
  },
  other: {
    fields: ["role", "role_id", "salary", "price"],
    desc: "其他类，尝试抽师傅类型(role/role_id)、薪资(salary)、价格(price)；摘要无信息就留空",
  },
};

// 数字字段（强制数字）
const NUMBER_FIELDS = [
  "role_id", "salary", "salary_expect", "price", "monthly_rent",
  "area_sqm", "daily_revenue", "rent_max", "area_min", "cond", "seats",
];

// 数组字段
const ARRAY_FIELDS = ["want_terms", "terms"];

// 枚举字段
const ENUM_FIELDS = {
  availability: ["长期", "短期", "顶班", "随时可到"],
  has_equipment: ["全带", "部分", "不带"],
};

// ---- 工具 ----
function ok(data = {}) { return { success: true, ...data }; }
function fail(message) { return { success: false, message }; }

// 调用 DeepSeek（OpenAI 兼容，Node 原生 https）
function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error("未配置 DEEPSEEK_API_KEY"));
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
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(postData),
      },
      timeout: 30000,
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        try {
          const json = JSON.parse(body);
          const content = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : "";
          resolve(content);
        } catch (e) { reject(new Error("DeepSeek 返回解析失败")); }
      });
    });
    req.on("error", (e) => reject(new Error("请求出错: " + (e.message || e))));
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.write(postData);
    req.end();
  });
}

// 构造 prompt（按 data_type 动态生成字段说明）
function buildPrompt(rawText, dataType) {
  const plan = FIELD_PLAN[dataType] || FIELD_PLAN.other;
  const fieldDesc = plan.fields.map((f) => `   - ${f}: ${describeField(f)}`).join("\n");

  return `你是包子行业信息平台的字段抽取助手。从帖子摘要中抽取结构化字段。

帖子摘要：
${rawText}

该帖已知分类 data_type = "${dataType}"（${plan.desc}）。

规则（严格遵守）：
1. 只输出「能从摘要中确定」的字段，不确定的不要输出、不要编造、不要猜测。
2. 输出必须是合法 JSON 对象，键只能是下面列出的字段名，不要任何解释文字。
3. 字段定义：
${fieldDesc}
4. role 从枚举选：${ROLE_LIST}；role_id 是对应数字(1-14)，无法确定给 0。
5. 所有数字字段必须是数字，无法确定不要输出。

只输出 JSON，例如：{"role":"包子师傅","role_id":1,"salary":8000}`;
}

function describeField(f) {
  const map = {
    role: "师傅类型中文名（从枚举选）",
    role_id: "师傅类型数字 1-14",
    salary: "给价(元/月，数字)",
    salary_expect: "期望薪资(元/月，数字)",
    salary_note: "薪资补充说明文字",
    availability: "到岗方式，只能从 长期/短期/顶班/随时可到 选一个",
    service_area: "可服务地区文字",
    want_terms: "诉求标签数组(如[\"包吃住\",\"单间\",\"月结\"])",
    price: "转让费/预算/售价(元，数字)",
    monthly_rent: "月租(元/月，数字)",
    area_sqm: "面积(平方米，数字)",
    daily_revenue: "日营业额(元/天，数字)",
    has_equipment: "带不带设备，只能从 全带/部分/不带 选一个",
    terms: "转让条件数组(如[\"证照齐全\",\"有保护\"])",
    rent_max: "租金上限(元/月，数字)",
    area_min: "面积下限(平方米，数字)",
    cond: "成色(0-10，数字)",
    from_place: "出发地文字",
    to_place: "目的地文字",
    depart_time: "出发时间文字",
    seats: "可乘人数/人数(数字)",
  };
  return map[f] || "文字";
}

// 校验并清洗 DeepSeek 输出
function sanitizeAIOutput(parsed, dataType) {
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;
  const plan = FIELD_PLAN[dataType] || FIELD_PLAN.other;
  const allowedFields = plan.fields;

  for (const k of allowedFields) {
    const v = parsed[k];
    if (v === undefined || v === null || v === "") continue;

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
    if (ENUM_FIELDS[k]) {
      const s = String(v).trim();
      if (ENUM_FIELDS[k].indexOf(s) >= 0) out[k] = s;
      continue;
    }
    if (NUMBER_FIELDS.indexOf(k) >= 0) {
      const n = Number(String(v).replace(/[^\d.]/g, ""));
      if (!isNaN(n) && n >= 0) out[k] = n;
      continue;
    }
    if (ARRAY_FIELDS.indexOf(k) >= 0) {
      let arr;
      if (Array.isArray(v)) arr = v.map((x) => String(x).trim());
      else arr = String(v).split(/[,，、;；]/).map((x) => x.trim());
      arr = arr.filter((x) => x && x.length <= 24).slice(0, 6);
      if (arr.length) out[k] = arr;
      continue;
    }
    // 其余字符串
    const s = String(v).trim();
    if (s && s.length <= 200) out[k] = s;
  }
  return out;
}

// 合并 AI 结果到帖子对象：只补"空字段"
function mergeAI(doc, aiOut) {
  const matched = [];
  for (const k of Object.keys(aiOut)) {
    const cur = doc[k];
    const isEmpty = cur === undefined || cur === null || cur === "" || cur === 0 || cur === false;
    if (isEmpty && aiOut[k] !== undefined) {
      doc[k] = aiOut[k];
      matched.push(k);
    }
  }
  return matched;
}

// 单条补字段
async function enrichOne(doc) {
  const rawText = String(doc.raw_text || "").trim();
  if (!rawText) return { doc, matched: [] };
  const dataType = doc.data_type || "other";

  try {
    const content = await callDeepSeek([
      { role: "system", content: "你是包子行业信息平台的字段抽取助手。" },
      { role: "user", content: buildPrompt(rawText, dataType) },
    ]);

    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("非 JSON");
      parsed = JSON.parse(m[0]);
    }

    const aiOut = sanitizeAIOutput(parsed, dataType);
    const matched = mergeAI(doc, aiOut);
    doc._ai_enriched = matched;
    return { doc, matched };
  } catch (e) {
    // 失败/无字段：保留原对象，标记空数组，不丢弃
    doc._ai_enriched = [];
    return { doc, matched: [], error: e.message };
  }
}

// 并发池
async function runPool(list, worker, concurrency, onProgress) {
  const results = new Array(list.length);
  let idx = 0;
  let done = 0;
  async function workerLoop() {
    while (idx < list.length) {
      const i = idx++;
      results[i] = await worker(list[i], i);
      done++;
      if (onProgress) onProgress(done, list.length, results, i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, list.length); w++) workers.push(workerLoop());
  await Promise.all(workers);
  return results;
}

// ---- 主流程 ----
async function main() {
  const args = process.argv;
  const dryRunIdx = args.indexOf("--dry-run");
  const dryRun = dryRunIdx >= 0;
  const dryCount = dryRun ? (parseInt(args[dryRunIdx + 1], 10) || 10) : 0;

  if (!fs.existsSync(CLEANED_FILE)) {
    console.error("❌ 找不到 cleaned.json，请先运行 index.js 清洗");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("❌ 未配置 DEEPSEEK_API_KEY（检查 .env.local）");
    process.exit(1);
  }

  const cleaned = JSON.parse(fs.readFileSync(CLEANED_FILE, "utf8"));
  console.log(`📥 读取清洗数据 ${cleaned.length} 条`);

  if (dryRun) {
    const sample = cleaned.slice(0, dryCount);
    console.log(`\n===== DRY-RUN：跑前 ${sample.length} 条看补字段效果 =====\n`);
    for (let i = 0; i < sample.length; i++) {
      const r = await enrichOne(JSON.parse(JSON.stringify(sample[i])));
      console.log(`--- 第 ${i + 1} 条 [${r.doc.data_type}] ---`);
      console.log(`摘要: ${String(r.doc.raw_text || "").slice(0, 40)}…`);
      console.log(`补到字段: ${JSON.stringify(r.matched)}`);
      console.log(`补后值: ${JSON.stringify(pick(r.doc, r.matched))}`);
      if (r.error) console.log(`⚠️ 失败: ${r.error}`);
      console.log("");
    }
    console.log("（dry-run 模式，未写文件）");
    return;
  }

  // 断点续跑：读取上次进度
  let startIdx = 0;
  let enriched = [];
  if (fs.existsSync(PROGRESS_FILE)) {
    const prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    startIdx = prog.nextIdx || 0;
    enriched = prog.doneList || [];
    console.log(`↩️  断点续跑：从第 ${startIdx} 条继续（已完成 ${enriched.length} 条）`);
  }

  const todo = cleaned.slice(startIdx);
  console.log(`🚀 开始补字段：${todo.length} 条待处理，并发 ${CONCURRENCY}`);

  const startTime = Date.now();
  let lastSave = 0;
  const results = await runPool(todo, enrichOne, CONCURRENCY, (done, total, resArr, i) => {
    // 每 50 条落一次盘（进度保存，resArr 是已填充的结果数组）
    if (done - lastSave >= 50) {
      lastSave = done;
      const completed = enriched.concat(resArr.slice(0, done).map((r) => r.doc));
      saveProgress(startIdx + done, completed);
      console.log(`⏳ 进度 ${startIdx + done}/${cleaned.length}，已用 ${Math.round((Date.now() - startTime) / 1000)}s`);
    }
  });

  // 最终合并 + 写文件
  enriched = enriched.concat(results.map((r) => r.doc));
  const matchedCount = enriched.filter((d) => (d._ai_enriched || []).length > 0).length;
  const failedCount = results.filter((r) => r.error).length;

  if (!fs.existsSync(path.join(__dirname, "output"))) fs.mkdirSync(path.join(__dirname, "output"), { recursive: true });
  fs.writeFileSync(ENRICHED_FILE, JSON.stringify(enriched, null, 2), "utf8");
  // 清空进度文件
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

  const secs = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ 补字段完成：共 ${enriched.length} 条，成功补到字段 ${matchedCount} 条，失败 ${failedCount} 条，用时 ${secs}s`);
  console.log(`📄 已写出 ${ENRICHED_FILE}`);
}

function pick(doc, keys) {
  const o = {};
  keys.forEach((k) => { o[k] = doc[k]; });
  return o;
}

function saveProgress(nextIdx, doneList) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ nextIdx, doneList }), "utf8");
}

main().catch((e) => { console.error("❌ 脚本异常:", e); process.exit(1); });
