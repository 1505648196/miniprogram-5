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

  // agent 模式：前端入口已固定领域（如招工页传 type=recruit），不再猜类型
  const agentType = event.type && DATA_TYPE_LABEL[event.type] ? event.type : null;

  if (!question) {
    return { msgType: "text", reply: agentType ? buildAgentGuide(agentType) : buildGuide() };
  }

  // 1. 意图识别
  const intent = detectIntent(question);

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
      // 诊断：查询集合总记录数，区分"集合空"和"条件不匹配"
      let total = -1;
      try {
        const cnt = await db.collection("baozi_posts").count();
        total = cnt.total;
      } catch (e2) {
        total = -1;
      }
      let hint;
      if (total === -1) hint = "baozi_posts 集合不存在或无法访问。";
      else if (total === 0) hint = "baozi_posts 集合是空的，还没有任何数据。";
      else
        hint = `数据库中共有 ${total} 条记录，但没有匹配当前条件的数据（类型=${intent.dataType || "任意"}${intent.city ? "，城市=" + intent.city : ""}）。`;
      return {
        msgType: "text",
        reply: `暂无${intent.city ? intent.city + "的" : ""}${DATA_TYPE_LABEL[intent.dataType] || "相关"}数据。\n\n${hint}\n\n检查：\n1) aiChat 云函数是否重新部署（改动不生效会出现此现象）；\n2) 数据是否已导入 baozi_posts 集合；\n3) 换个城市或类型再试。`,
      };
    }
    const list = posts.map((p, i) => formatPost(p, i)).join("\n");
    const head = `【${intent.city || "全部"}${DATA_TYPE_LABEL[intent.dataType] || "信息"} · 共${posts.length}条】\n\n`;
    return { msgType: "list", reply: head + list, data: posts };
  }

  // 5. 分析 → 数据拼上下文 → 调 DeepSeek
  if (intent.type === "analysis") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return {
        msgType: "text",
        reply: "分析功能需要配置 DEEPSEEK_API_KEY 环境变量（列表查询不需要）。请到云开发控制台 → 云函数 aiChat → 配置环境变量。",
      };
    }
    const summary = buildSummary(posts, intent);
    try {
      const systemPrompt =
        "你是包子行业数据分析师，基于下方云数据库中的真实帖子数据回答用户问题。" +
        "回答要求：1) 先给整体概览（共几条、关键数值区间/中位数）；2) 再列代表性案例；3) 最后给出对从业者的建议。" +
        "数据只做参考，有缺失的字段要如实说明，不要编造。\n\n" +
        summary;
      const response = await axios.post(
        DEEPSEEK_API_URL,
        {
          model: MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
          ],
          temperature: 0.7,
          max_tokens: 800,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: 60000,
        }
      );
      const reply =
        (response.data &&
          response.data.choices &&
          response.data.choices[0] &&
          response.data.choices[0].message &&
          response.data.choices[0].message.content) ||
        "";
      return {
        msgType: "text",
        reply: reply || "分析结果为空",
        sources: posts.slice(0, 5).map((p) => ({ id: p._id, title: (p.raw_text || "").slice(0, 30) })),
      };
    } catch (err) {
      console.error("aiChat 调用 DeepSeek 失败:", err);
      const msg =
        (err.response && err.response.data && JSON.stringify(err.response.data)) ||
        err.message ||
        "请求 DeepSeek 失败";
      return { msgType: "text", reply: "分析失败：" + msg };
    }
  }

  return { msgType: "text", reply: buildGuide() };
};

// ---------- 意图识别（关键词规则版） ----------
function detectIntent(text) {
  const t = text || "";

  const greetings = ["你好", "您好", "在吗", "hello", "hi", "谢谢", "感谢"];
  if (greetings.some((g) => t.includes(g))) return { type: "other" };

  const listKw = ["列表", "信息", "有哪些", "给我", "列出", "看看", "帮我找", "推荐", "有没有", "有吗", "找"];
  const analysisKw = ["多不多", "怎么样", "趋势", "建议", "分析", "一般多少", "区间", "怎么看", "平均", "行情", "多少"];
  const isList = listKw.some((k) => t.includes(k));
  const isAnalysis = analysisKw.some((k) => t.includes(k));

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

  // 数量限制（"10条" → limit=10）
  let limit = null;
  const m = t.match(/(\d{1,2})\s*(?:条|个)/);
  if (m) limit = Math.min(parseInt(m[1], 10) || 10, 20);

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
      // 市级：city_code 精确匹配；并 or 上 district_code，兜底县级市/区发布的数据（如监利）
      query._ = db.command.or([{ city_code: intent.cityCode }, { district_code: intent.cityCode }]);
    }
  }

  const limit = intent.limit || 10;
  // 查询出错会向上抛出，由 exports.main 统一捕获并返回给用户，方便排查
  const res = await db
    .collection("baozi_posts")
    .where(query)
    .orderBy("published_at", "desc")
    .limit(limit)
    .get();
  return res.data || [];
}

// ---------- 格式化单条记录 ----------
function formatPost(p, i) {
  const wan = (v) => (v >= 10000 ? (v % 10000 === 0 ? v / 10000 + "万" : (v / 10000).toFixed(1) + "万") : String(v));
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
      if (p.salary_note) parts.push("薪资:" + p.salary_note);
      else if (p.salary_low) parts.push("薪资" + p.salary_low + (p.salary_high ? "-" + p.salary_high : "") + "元");
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

// ---------- 分析上下文 ----------
function buildSummary(posts, intent) {
  if (!posts.length) return "（无匹配数据）";
  let s = `匹配到 ${posts.length} 条${DATA_TYPE_LABEL[intent.dataType] || ""}数据：\n`;
  posts.forEach((p, i) => {
    s += `${i + 1}. ${formatPost(p, i)}\n`;
  });
  return s;
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
