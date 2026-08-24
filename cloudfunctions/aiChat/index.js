// cloudfunctions/aiChat/index.js
// 包子行业 AI 顾问：意图识别 → 查 baozi_posts → 按类型返回
//   - 列表类：直接查库格式化返回（不调大模型，秒回）
//   - 分析类：查库后把数据拼成上下文，调 DeepSeek 生成分析
//   - 其他/问候：返回引导语
//
// 入参兼容两种：
//   { question: "东莞有没有包子店转让" }
//   { messages: [{ role: 'user', content: '...' }, ...] }  // 取最后一条 user 消息
//
// 环境变量（云函数控制台配置）：
//   DEEPSEEK_API_KEY   DeepSeek 平台申请的 API Key（仅"分析"类请求需要）
const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";

// 全国行政区划代码词典（发布侧存 *_code，提问侧用 code 精确匹配）
const CODES = require("./cityCodes.js");
const CITIES = Object.keys(CODES.CITY_CODES); // 优先匹配市级（含直辖市、省直管县级市）
const PROVINCES = Object.keys(CODES.PROVINCE_CODES); // 其次匹配省级

const DATA_TYPE_LABEL = {
  transfer: "转让",
  want_shop: "求店",
  recruit: "招聘",
  jobseek: "求职",
  equip_sell: "设备出售",
  equip_buy: "设备求购",
};

// 云函数入口
exports.main = async (event) => {
  const question = String(event.question || lastUserMessage(event.messages) || "").trim();

  // ---- 日志：入参（云开发控制台 → 云函数 aiChat → 日志） ----
  console.log("[aiChat] 入参 question =", question);
  console.log("[aiChat] 入参 type    =", event.type || "(未传)");
  console.log("[aiChat] 入参 messages条数 =", Array.isArray(event.messages) ? event.messages.length : 0);

  // agent 模式：前端入口已固定领域（如招工页传 type=recruit），不再猜类型
  const agentType = event.type && DATA_TYPE_LABEL[event.type] ? event.type : null;

  if (!question) {
    return { msgType: "text", reply: agentType ? buildAgentGuide(agentType) : buildGuide() };
  }

  // 1. 意图识别
  const intent = detectIntent(question);

  // ---- 日志：意图识别结果 ----
  console.log("[aiChat] 意图识别结果 intent =", JSON.stringify(intent));

  // 2. agent 模式下领域固定，覆盖猜测结果
  if (agentType) {
    intent.dataType = agentType;
  }

  // 3. 问候/无关 → 引导语
  if (intent.type === "other") {
    return { msgType: "text", reply: agentType ? buildAgentGuide(agentType) : buildGuide() };
  }

  // 3. 查云数据库 baozi_posts
  let posts;
  try {
    posts = await queryPosts(intent);
  } catch (e) {
    // 查询本身报错（集合不存在/未初始化等），把真实错误返回给用户，方便排查
    console.error("查询 baozi_posts 失败:", e);
    return {
      msgType: "text",
      reply:
        "查询数据库出错：" +
        (e.errMsg || e.message || e) +
        "\n\n可能原因：\n1) baozi_posts 集合还没创建（云开发控制台 → 数据库 → 新建集合，再导入数据）；\n2) 云函数所在环境没开通数据库。",
    };
  }

  // 4. 列表 → 直接返回（不调 AI，秒回）
  if (intent.type === "list") {
    if (!posts.length) {
      // 技术诊断：仅写日志，不暴露给客户
      try {
        const cnt = await db.collection("baozi_posts").count();
        console.log(
          "[aiChat] 暂无匹配，库总条数 =", cnt.total,
          "| 条件 =", JSON.stringify({ dataType: intent.dataType, city: intent.city })
        );
      } catch (e2) {
        console.log("[aiChat] 暂无匹配，count() 失败：", e2.errMsg || e2.message);
      }
      const label = DATA_TYPE_LABEL[intent.dataType] || "相关";
      return {
        msgType: "text",
        reply:
          `暂无${intent.city ? intent.city + "的" : ""}${label}信息。\n\n` +
          `可以试试调整查询条件：\n` +
          `· 换个城市\n` +
          `· 换个信息类型（招工 / 转让 / 求店 / 设备出售 / 设备求购 / 求职）\n` +
          `· 缩小或放宽其他条件\n\n` +
          `💡 也可以直接问我行情，比如"${intent.city || " "}包子店转让行情怎么样"。`,
      };
    }
    const list = posts.map((p, i) => formatPost(p, i)).join("\n");
    const head = `【${intent.city || "全部"}${DATA_TYPE_LABEL[intent.dataType] || "信息"} · 共${posts.length}条】\n\n`;
    return { msgType: "list", reply: head + list, data: posts };
  }

  // 5. 分析 → 服务端算真实统计 + 结构化块（KPI/条形图/案例卡片）；DeepSeek 只写叙事洞察
  if (intent.type === "analysis") {
    const stats = buildStats(posts, intent);
    const blocks = buildBlocks(intent, stats);
    const apiKey = process.env.DEEPSEEK_API_KEY;
    let insight = "";
    if (apiKey && stats && stats.count > 0) {
      try {
        insight = await callDeepSeekInsight(stats, posts, question);
      } catch (err) {
        console.error("aiChat 调用 DeepSeek 失败:", err);
        insight = "";
      }
    }
    if (insight) blocks.push({ type: "insight", text: insight });
    else blocks.push({ type: "tip", emoji: "💡", text: templateTip(intent, stats) });
    blocks.push({ type: "chips", items: buildChips(intent) });
    const headText = blocks[0] && blocks[0].text ? blocks[0].text : "行情分析";
    return {
      msgType: "analysis",
      reply: headText,
      blocks,
      data: posts.slice(0, 10),
      sources: posts.slice(0, 5).map((p) => ({ id: p._id, title: (p.raw_text || "").slice(0, 30) })),
    };
  }

  return { msgType: "text", reply: buildGuide() };
};

// ---------- 意图识别（关键词规则版） ----------
function detectIntent(text) {
  const t = text || "";

  const greetings = ["你好", "您好", "在吗", "hello", "hi", "谢谢", "感谢"];
  const hitGreeting = greetings.find((g) => t.includes(g));
  console.log("[aiChat] detectIntent 问候词命中 =", hitGreeting || "无");
  if (greetings.some((g) => t.includes(g))) return { type: "other" };

  const listKw = ["列表", "信息", "有哪些", "给我", "列出", "看看", "帮我找", "推荐", "有没有", "有吗", "找"];
  const analysisKw = ["多不多", "怎么样", "趋势", "建议", "分析", "一般多少", "区间", "怎么看", "平均", "行情", "多少"];
  const isList = listKw.some((k) => t.includes(k));
  const isAnalysis = analysisKw.some((k) => t.includes(k));
  console.log("[aiChat] detectIntent 列表词命中 =", isList, "| 分析词命中 =", isAnalysis);

  // 城市 / 省份（先市后省，"吉林"等重名会优先命中市级）
  let city = null;
  let isProvince = false;
  for (const c of CITIES) {
    if (t.includes(c)) {
      city = c;
      break;
    }
  }
  if (!city) {
    for (const p of PROVINCES) {
      if (t.includes(p)) {
        city = p;
        isProvince = true;
        break;
      }
    }
  }
  console.log("[aiChat] detectIntent 城市/省份命中 =", city || "无", "| isProvince =", isProvince);
  // 翻译成行政区划 code：市→city_code，省→province_code
  const cityCode = city
    ? isProvince
      ? CODES.PROVINCE_CODES[city]
      : CODES.CITY_CODES[city]
    : null;

  // 领域类型
  // 设备类优先判断：文本含设备相关词（设备/机器/二手/蒸炉/和面机等）时先分流到设备类，
  // 避免"转让设备"被误判成店铺转让
  let dataType = null;
  const hasEquipWord =
    t.includes("设备") ||
    t.includes("机器") ||
    t.includes("二手") ||
    t.includes("蒸炉") ||
    t.includes("和面机") ||
    t.includes("压面机") ||
    t.includes("冰柜") ||
    t.includes("蒸包机");
  console.log("[aiChat] detectIntent 设备词命中 =", hasEquipWord);
  if (hasEquipWord) {
    // 求购侧关键词：买/收购/求购/收
    const buyKw = ["买", "收购", "求购", "收"];
    // 出售侧关键词：卖/出售/处理/出手/转让（含"转让设备"场景）
    const sellKw = ["卖", "出售", "处理", "出手", "转让"];
    if (buyKw.some((k) => t.includes(k))) dataType = "equip_buy";
    else if (sellKw.some((k) => t.includes(k))) dataType = "equip_sell";
    else dataType = "equip_sell"; // 只说"设备/二手设备"默认看出售
  } else if (t.includes("求职") || t.includes("找工作")) dataType = "jobseek";
  else if (t.includes("求店") || t.includes("找店")) dataType = "want_shop";
  else if (t.includes("转让") || t.includes("转店") || t.includes("铺子")) dataType = "transfer";
  else if (t.includes("招") || t.includes("招聘")) dataType = "recruit";
  console.log("[aiChat] detectIntent 领域类型 dataType =", dataType || "未识别");

  // 数量限制（"10条" → limit=10）
  let limit = null;
  const m = t.match(/(\d{1,2})\s*(?:条|个)/);
  if (m) limit = Math.min(parseInt(m[1], 10) || 10, 20);
  if (m) console.log("[aiChat] detectIntent 数量限制命中 =", t.slice(m.index, m.index + m[0].length), "→ limit =", limit);

  // 默认 list：用户没提"分析/行情"类词时，直接给列表最快
  return { type: isAnalysis ? "analysis" : "list", city, cityCode, isProvince, dataType, limit };
}

// ---------- 查询云数据库 ----------
async function queryPosts(intent) {
  const query = {};

  // 设备类样本常因缺 city 被标记 needs_review=true，若强制过滤则设备类永远查不到，
  // 所以设备类查询不按 needs_review 过滤；其余类型仍过滤待人工审核（缺城市/电话）的记录
  if (intent.dataType !== "equip_sell" && intent.dataType !== "equip_buy") {
    query.needs_review = _.neq(true);
  }

  if (intent.dataType) query.data_type = intent.dataType;

  if (intent.cityCode) {
    if (intent.dataType === "want_shop") {
      // 求店：偏好城市存 city_prefer（如"东莞或深圳"），无 code，继续用包含匹配
      query.city_prefer = db.RegExp({ regexp: intent.city, options: "i" });
    } else if (intent.dataType === "equip_sell" || intent.dataType === "equip_buy") {
      // 设备类：地区存 equip_region（如"广东/江西/湖北/安徽"），无 code，继续用包含匹配
      query.equip_region = db.RegExp({ regexp: intent.city, options: "i" });
    } else if (intent.isProvince) {
      // 问的是省份：province_code 精确匹配
      query.province_code = intent.cityCode;
    } else {
      // 市级：city_code / district_code 精确匹配 + city 字段文本正则兜底（防历史脏数据 code 缺失/写错）
      query._ = db.command.or([
        { city_code: intent.cityCode },
        { district_code: intent.cityCode },
        ...(intent.city ? [{ city: db.RegExp({ regexp: escapeRe(intent.city), options: "i" }) }] : []),
      ]);
    }
  }

  const limit = intent.limit || 10;
  // ---- 日志：本次查询的完整条件 ----
  console.log("[aiChat] queryPosts 条件 =", JSON.stringify(query));
  console.log("[aiChat] queryPosts limit =", limit, "| orderBy = published_at desc");
  // 查询出错会向上抛出，由 exports.main 统一捕获并返回给用户，方便排查
  const res = await db
    .collection("baozi_posts")
    .where(query)
    .orderBy("published_at", "desc")
    .limit(limit)
    .get();
  // ---- 日志：查询命中条数 ----
  console.log("[aiChat] queryPosts 命中条数 =", (res.data || []).length);
  return res.data || [];
}

// RegExp 特殊字符转义，防止用户输入里的 . * + ? 等破坏正则
function escapeRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- 格式化单条记录 ----------
function formatPost(p, i) {
  const parts = [`${i + 1}. ${p.city || ""}`];

  switch (p.data_type) {
    case "transfer":
      if (p.rent) parts.push("月租" + wan(p.rent));
      if (p.transfer_fee) parts.push("转让费" + wan(p.transfer_fee));
      if (p.turnover_low)
        parts.push("日营" + p.turnover_low + (p.turnover_high ? "~" + p.turnover_high : "+") + "元");
      if (p.area_m2) parts.push(p.area_m2 + "㎡");
      if (p.is_franchise) parts.push("加盟");
      if (p.contract_years) parts.push("合同" + p.contract_years + "年");
      break;
    case "want_shop":
      if (p.city_prefer) parts.push("意向:" + p.city_prefer);
      if (p.turnover_expect) parts.push("期望日营" + p.turnover_expect + "元");
      if (p.rent_max) parts.push("租金≤" + wan(p.rent_max));
      if (p.need_low_rent) parts.push("要低租金");
      break;
    case "recruit":
      if (p.role) parts.push(p.role);
      if (p.salary_high) parts.push("薪资" + p.salary_high + "元");
      else parts.push("薪资面议");
      if (p.address) parts.push("地址:" + p.address);
      if (p.contact) parts.push("联系人:" + p.contact);
      if (p.boss_style) parts.push(p.boss_style);
      if (Array.isArray(p.tags) && p.tags.length) parts.push("[" + p.tags.join("·") + "]");
      break;
    case "jobseek":
      if (p.role) parts.push(p.role);
      if (p.service_area) parts.push("服务:" + p.service_area);
      if (p.availability) parts.push(p.availability);
      break;
    case "equip_sell":
    case "equip_buy":
      if (p.equip_desc) parts.push(p.equip_desc);
      parts.push(p.equip_price != null ? "价格" + wan(p.equip_price) : "价格面议");
      if (p.equip_region) parts.push(p.equip_region);
      break;
  }

  if (p.phone_masked) parts.push(p.phone_masked);
  return parts.join(" | ");
}

// ---------- 引导语 ----------
function buildGuide() {
  return (
    "你好！我是包子行业 AI 顾问，可以帮你查招工、求职、转让、求店、二手设备信息。\n\n" +
    "试试这样问：\n" +
    '· "东莞有没有包子店转让"（直接出列表）\n' +
    '· "深圳的转让行情怎么样"（AI 分析）\n' +
    '· "上海招包子师傅"（查招聘）\n' +
    '· "求购包子设备"（查设备求购）'
  );
}

// agent 专属引导语（入口已定领域）
function buildAgentGuide(agentType) {
  if (agentType === "recruit") {
    return (
      "我是招工顾问，帮你查包子店招聘信息、师傅薪资行情。\n\n" +
      "试试这样问：\n" +
      '· "上海有哪些包子店在招工"（直接出列表）\n' +
      '· "师傅工资一般多少"（AI 分析薪资行情）\n' +
      '· "招大师傅要注意什么"'
    );
  }
  return buildGuide();
}

// ---------- 工具 ----------
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

// ---------- 分析类：真实统计 + 结构化块 ----------
function wan(v) {
  if (v == null) return "";
  return v >= 10000
    ? v % 10000 === 0
      ? v / 10000 + "万"
      : (v / 10000).toFixed(1) + "万"
    : String(v);
}

// 各类型 KPI 数值的口径名称
const KPI_LABEL = {
  transfer: "转让费",
  want_shop: "预算租金",
  recruit: "月薪",
  jobseek: "期望月薪",
  equip_sell: "报价",
  equip_buy: "预算",
};

// 岗位 emoji（仅招工/求职条形图用）
const ROLE_EMOJI = {
  大师傅: "👨🍳",
  中工: "👨🍳",
  学徒工: "🧑🍳",
  短期顶班: "⏱️",
  夫妻工: "👫",
  售卖员: "🛎️",
  收银员: "🛎️",
};

// 从一条帖子提取 [low, high] 数值区间；面议/0/缺失 返回 null（不污染统计）
function pickNum(p, dataType) {
  switch (dataType) {
    case "transfer":
      if (p.transfer_fee > 0) return [p.transfer_fee, p.transfer_fee];
      if (p.rent > 0) return [p.rent, p.rent];
      if (p.turnover_low > 0) return [p.turnover_low, p.turnover_high > 0 ? p.turnover_high : p.turnover_low];
      return null;
    case "want_shop":
      if (p.rent_max > 0) return [p.rent_max, p.rent_max];
      if (p.transfer_fee_expect > 0) return [p.transfer_fee_expect, p.transfer_fee_expect];
      if (p.turnover_expect > 0) return [p.turnover_expect, p.turnover_expect];
      return null;
    case "recruit":
    case "jobseek":
      if (p.salary_low > 0) return [p.salary_low, p.salary_high > 0 ? p.salary_high : p.salary_low];
      return null;
    case "equip_sell":
    case "equip_buy":
      if (p.equip_price > 0) return [p.equip_price, p.equip_price];
      return null;
    default:
      return null;
  }
}

// 服务端真实统计：样本量 / 中位数 / 最高值 / 岗位薪资条形图
function buildStats(posts, intent) {
  if (!posts.length) return null;
  const dataType = intent.dataType;
  const nums = posts.map((p) => pickNum(p, dataType)).filter(Boolean);
  const highs = nums.map((r) => r[1]).sort((a, b) => a - b);
  const median = highs.length ? highs[Math.floor(highs.length / 2)] : 0;
  const max = highs.length ? highs[highs.length - 1] : 0;
  const stats = {
    count: posts.length,
    kpiLabel: KPI_LABEL[dataType] || "金额",
    median,
    max,
    medianText: wan(median),
    maxText: wan(max),
  };
  // 岗位条形图：仅招工/求职有 role 维度
  if (dataType === "recruit" || dataType === "jobseek") {
    const byRole = {};
    posts.forEach((p) => {
      if (!p.role) return;
      const r = pickNum(p, dataType);
      if (!r) return;
      (byRole[p.role] = byRole[p.role] || []).push(r);
    });
    const entries = Object.entries(byRole);
    const maxHigh = Math.max(...entries.map(([, arr]) => Math.max(...arr.map((r) => r[1]))), 1);
    const bars = entries
      .map(([label, arr]) => {
        const lows = arr.map((r) => r[0]);
        const highs2 = arr.map((r) => r[1]);
        const high = Math.round(highs2.reduce((a, b) => a + b, 0) / highs2.length);
        return {
          label,
          emoji: ROLE_EMOJI[label] || "🧑🍳",
          low: Math.round(lows.reduce((a, b) => a + b, 0) / lows.length),
          high,
          max: maxHigh,
          pct: Math.round((high / maxHigh) * 100),
          cnt: arr.length,
        };
      })
      .sort((a, b) => b.high - a.high);
    if (bars.length) bars[0].hot = true;
    stats.bars = bars;
  }
  return stats;
}

// 组装结构化块：标题 → KPI → 条形图 → 案例占位（前端挂卡片）
function buildBlocks(intent, stats) {
  const label = DATA_TYPE_LABEL[intent.dataType] || "信息";
  const cityLabel = intent.city ? intent.city + "的" : "";
  const blocks = [];
  blocks.push({ type: "head", text: `${cityLabel}${label}行情` });
  if (stats) {
    blocks.push({
      type: "kpi",
      items: [
        { label: "匹配样本", value: String(stats.count), unit: "条" },
        { label: `${stats.kpiLabel}中位数`, value: stats.medianText, unit: "元" },
        { label: `${stats.kpiLabel}最高`, value: stats.maxText, unit: "元" },
      ],
    });
    if (stats.bars && stats.bars.length) {
      blocks.push({ type: "bar", title: "岗位薪资排行", items: stats.bars });
    }
  }
  blocks.push({ type: "cases", title: "代表案例" });
  return blocks;
}

// DeepSeek 只写叙事洞察：禁止编数字、禁止 Markdown
async function callDeepSeekInsight(stats, posts, question) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const examples = posts
    .slice(0, 5)
    .map((p, i) => `${i + 1}. ${formatPost(p, i)}`)
    .join("\n");
  const systemPrompt =
    "你是包子行业数据分析师。请根据【统计事实】和【代表案例】，用不超过150字写一段'洞察与建议'。" +
    "要求：1) 只能引用统计事实中的数字，禁止编造；2) 2-4个短句，平实口语；" +
    "3) 纯文本，禁止任何 Markdown 符号（#、**、表格、列表标记）；" +
    "4) 内容侧重：数字反映的趋势 + 对从业者的实用建议。\n\n" +
    `【统计事实】${JSON.stringify({
      count: stats.count,
      kpiLabel: stats.kpiLabel,
      median: stats.median,
      max: stats.max,
      bars: stats.bars || null,
    })}\n` +
    `【代表案例】\n${examples}\n` +
    `【用户问题】${question}`;
  const response = await axios.post(
    DEEPSEEK_API_URL,
    {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
      temperature: 0.7,
      max_tokens: 300,
    },
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      timeout: 60000,
    }
  );
  return (
    (response.data &&
      response.data.choices &&
      response.data.choices[0] &&
      response.data.choices[0].message &&
      response.data.choices[0].message.content) ||
    ""
  ).trim();
}

// 无 AI Key / 调用失败时的模板洞察
function templateTip(intent, stats) {
  const c = intent.city || "该地区";
  const label = DATA_TYPE_LABEL[intent.dataType] || "相关";
  if (!stats) return `${c}暂时没有匹配的${label}数据，换个城市或条件再试试。`;
  return `${c}共收录 ${stats.count} 条${label}信息，${stats.kpiLabel}中位数约 ${stats.medianText} 元，最高 ${stats.maxText} 元。建议多方比价、问清关键条款再决定。`;
}

// 分析回答末尾的引导追问芯片
function buildChips(intent) {
  const c = intent.city ? intent.city : " ";
  switch (intent.dataType) {
    case "recruit":
      return [`${c}有哪些包子店在招工`, `${c}大师傅工资一般多少`, "招工要注意什么"];
    case "transfer":
      return [`${c}包子店转让多少钱`, `${c}求店怎么找`, "接手转让店要注意什么"];
    case "want_shop":
      return [`${c}有哪些店在转让`, `${c}求店租金预算多少合适`, "求店要注意什么"];
    case "jobseek":
      return [`${c}有哪些师傅在求职`, `${c}师傅工资一般多少`, "求职要注意什么"];
    case "equip_sell":
      return [`${c}二手设备多少钱`, `${c}包子设备有哪些`, "买二手设备要注意什么"];
    case "equip_buy":
      return [`${c}有人卖二手设备吗`, `${c}二手设备行情怎么样`, "卖设备要注意什么"];
    default:
      return [`${c}包子店转让行情怎么样`, `${c}招包子师傅`, `${c}二手设备信息`];
  }
}
