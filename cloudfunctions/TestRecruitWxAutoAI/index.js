// cloudfunctions/TestRecruitWxAutoAI/index.js
// ============================================================
// 测试版云函数：发布信息意图判断 + 三要素完整性校验 + 结构化 JSON
//
// 入口（debugHttpEvent 实测确认）：
//   HTTP 网关把请求体 JSON 直接作为 event 顶层传入：
//     {"question":"招北京大师傅15975937411工资7000", tcbContext:{...}}
//   没有 event.body / event.httpMessage，question 直接读 event.question。
//
// 流程：
//   1) DeepSeek 专用分析器（新写提示词）判断意图：
//        intent 0 = 争吵/暴力/违法/闲聊等无关内容 → 回复「请稍等。」
//        intent 1~6 = 六大发布类型
//   2) 属于六大类型时，再判断是否完整：
//        完整 = 电话 + 地址 + 内容 三要素齐全
//        完整 → 结构化 JSON 入库，回复「已发」
//        不完整 → 提示缺哪几个要素，引导补全
//   3) DeepSeek 需返回 JSON：
//        {"intent":1~6|0, "intent_name":"招聘", "data_type":"recruit",
//         "is_complete":true|false, "missing":[], "fields":{...}}
// ============================================================
const cloud = require("wx-server-sdk");
const axios = require("axios");
const { PROVINCE_CODES, CITY_CODES } = require("./cityCodes.js");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

// 六大发布类型 → baozi_posts.data_type + 中文名
const INTENT_MAP = {
  1: { data_type: "transfer",   name: "转店" },
  2: { data_type: "want_shop",  name: "求店" },
  3: { data_type: "recruit",    name: "招聘" },
  4: { data_type: "jobseek",    name: "求职" },
  5: { data_type: "equip_sell", name: "二手设备出售" },
  6: { data_type: "equip_buy",  name: "二手设备求购" },
};

// ============ 三类发布类型（招工/转让/设备出售）的必填字段（按截图 mind-map 定义） ============
// 只对 intent=1/3/5 生效；其他类型继续走旧的"电话+地址+内容"三要素判断
const REQUIRED_FIELDS_BY_INTENT = {
  3: { // 招聘（招工）
    label: "招工",
    fields: [
      { label: "类型", alwaysFilled: true, value: () => "招聘" },
      { label: "城市", check: (f) => !!String(f.city || "").trim() },
      { label: "电话", check: (f) => /^1\d{10}$/.test(String(f.phone || "").trim()) },
      { label: "工资", check: (f) => Number(f.salary_high) > 0 || Number(f.salary_low) > 0 || String(f.salary_note || "").trim() === "面议" },
      { label: "岗位", check: (f) => !!String(f.role || "").trim() },
      { label: "备注", check: (f) => !!String(f.remark || "").trim() },
    ],
  },
  1: { // 转店（转让）
    label: "转让",
    fields: [
      { label: "类型", alwaysFilled: true, value: () => "转让" },
      { label: "转让费", check: (f) => Number(f.transfer_fee) > 0 },
      { label: "营业额", check: (f) => Number(f.turnover_low) > 0 },
      { label: "租金",   check: (f) => Number(f.rent) > 0 },
      { label: "城市",   check: (f) => !!String(f.city || "").trim() },
      { label: "电话",   check: (f) => /^1\d{10}$/.test(String(f.phone || "").trim()) },
      { label: "品牌",   check: (f) => !!String(f.brand || "").trim() },
      { label: "备注",   check: (f) => !!String(f.remark || "").trim() },
    ],
  },
  5: { // 二手设备出售
    label: "设备出售",
    fields: [
      { label: "类型", alwaysFilled: true, value: () => "设备出售" },
      { label: "城市", check: (f) => !!String(f.equip_region || "").trim() }, // equip_region=所在城市
      { label: "电话", check: (f) => /^1\d{10}$/.test(String(f.phone || "").trim()) },
      { label: "设备", check: (f) => !!String(f.equip_desc || "").trim() },
      { label: "备注", check: (f) => !!String(f.remark || "").trim() },
    ],
  },
};

// 把已填字段值格式化成可读字符串（用于卡片显示）
function readFieldValue(label, f) {
  switch (label) {
    case "城市":
      return String(f.city || "");
    case "电话":
      return String(f.phone || "");
    case "工资":
      if (String(f.salary_note || "").trim() === "面议") return "面议";
      if (Number(f.salary_high) > 0 && Number(f.salary_low) > 0) return `${f.salary_low}-${f.salary_high}元`;
      if (Number(f.salary_high) > 0) return `${f.salary_high}元`;
      if (Number(f.salary_low)  > 0) return `${f.salary_low}元`;
      return "";
    case "岗位":
      return String(f.role || "");
    case "备注":
      return String(f.remark || "");
    case "转让费":
      return Number(f.transfer_fee) > 0 ? `${f.transfer_fee}元` : "";
    case "营业额":
      if (Number(f.turnover_low) > 0 && Number(f.turnover_high) > 0) return `${f.turnover_low}-${f.turnover_high}元/日`;
      if (Number(f.turnover_low) > 0) return `${f.turnover_low}元/日`;
      return "";
    case "租金":
      return Number(f.rent) > 0 ? `${f.rent}元/月` : "";
    case "品牌":
      return String(f.brand || "");
    case "设备":
      return String(f.equip_desc || "");
    default:
      return "";
  }
}

// 构建"思维导图样式"的缺字段提示卡；仅适用于 intent=1/3/5
//   missing 为空（全部齐了）→ 返回 null，让调用方直接走发布
function buildIncompleteCard(intent, fields) {
  const schema = REQUIRED_FIELDS_BY_INTENT[intent];
  if (!schema) return null;
  const children = schema.fields.map((f) => {
    // 备注为非必填：始终视为已填（不影响 missing 判断，卡片上仍可展示备注内容）
    const isOptionalRemark = f.label === "备注";
    const filled = f.alwaysFilled ? true : isOptionalRemark ? true : !!f.check(fields);
    return {
      label: f.label,
      status: filled ? "filled" : "missing",
      value: filled ? (f.alwaysFilled ? f.value() : readFieldValue(f.label, fields)) : "",
    };
  });
  const missingLabels = children.filter((c) => c.status === "missing").map((c) => c.label);
  if (missingLabels.length === 0) return null;
  const missingText = missingLabels.join("、");
  const checklist = children.map((c) => `${c.label}${c.status === "filled" ? "✓" : "✗"}`).join("、");
  const reply_to_user =
    `你想发布${schema.label}信息，还缺少必填项：${missingText}。\n` +
    `请补全完整信息发过来`;
  return {
    msgType: "incomplete_card",
    status: "incomplete",
    intent,
    data_type: (INTENT_MAP[intent] && INTENT_MAP[intent].data_type) || "",
    intent_name: (INTENT_MAP[intent] && INTENT_MAP[intent].name) || "",
    mindmap: { root: schema.label, children },
    missing: missingLabels,
    reply_to_user,
    reply: reply_to_user, // 兼容旧字段
  };
}

// ============ 六大类型的补全模板（信息不完整时按此格式提示用户补齐） ============
// label = 提示行字段名；value = 固定值；key = 直接取 fields[key]；fmt = 自定义格式化
const TEMPLATE_BY_INTENT = {
  1: { // 转店
    name: "转店",
    fields: [
      { label: "类型", value: () => "转店" },
      { label: "城市", key: "city" },
      { label: "电话", key: "phone" },
      { label: "转让费", fmt: (f) => (Number(f.transfer_fee) > 0 ? `${f.transfer_fee}元` : "") },
      { label: "营业额", fmt: (f) => {
        const low = Number(f.turnover_low) > 0 ? f.turnover_low : "";
        const high = Number(f.turnover_high) > 0 ? f.turnover_high : "";
        return low || high ? `${low}${low && high ? "-" : ""}${high}元/日` : "";
      } },
      { label: "租金", fmt: (f) => (Number(f.rent) > 0 ? `${f.rent}元/月` : "") },
      { label: "品牌", key: "brand" },
      { label: "备注", key: "remark" },
    ],
  },
  2: { // 求店
    name: "求店",
    fields: [
      { label: "类型", value: () => "求店" },
      { label: "城市", key: "city_prefer" },
      { label: "电话", key: "phone" },
      { label: "期望营业额", fmt: (f) => (Number(f.turnover_expect) > 0 ? `${f.turnover_expect}元/日` : "") },
      { label: "最高月租", fmt: (f) => (Number(f.rent_max) > 0 ? `${f.rent_max}元/月` : "") },
      { label: "备注", key: "remark" },
    ],
  },
  3: { // 招聘（招工）
    name: "招聘",
    fields: [
      { label: "类型", value: () => "招聘" },
      { label: "城市", key: "city" },
      { label: "电话", key: "phone" },
      { label: "工资", fmt: (f) => {
        if (String(f.salary_note || "").trim() === "面议") return "面议";
        const low = Number(f.salary_low) > 0 ? f.salary_low : "";
        const high = Number(f.salary_high) > 0 ? f.salary_high : "";
        return low || high ? `${low}${low && high ? "-" : ""}${high}元` : "";
      } },
      { label: "岗位", key: "role" },
      { label: "备注", key: "remark" },
    ],
  },
  4: { // 求职
    name: "求职",
    fields: [
      { label: "类型", value: () => "求职" },
      { label: "城市", key: "service_area" },
      { label: "电话", key: "phone" },
      { label: "岗位", key: "role" },
      { label: "期望薪资", fmt: (f) => {
        if (String(f.salary_note || "").trim() === "面议") return "面议";
        const low = Number(f.salary_low) > 0 ? f.salary_low : "";
        const high = Number(f.salary_high) > 0 ? f.salary_high : "";
        return low || high ? `${low}${low && high ? "-" : ""}${high}元` : "";
      } },
      { label: "备注", key: "remark" },
    ],
  },
  5: { // 二手设备出售
    name: "二手设备出售",
    fields: [
      { label: "类型", value: () => "二手设备出售" },
      { label: "城市", key: "equip_region" },
      { label: "电话", key: "phone" },
      { label: "设备", key: "equip_desc" },
      { label: "价格", fmt: (f) => (f.equip_price != null && f.equip_price !== "" ? `${f.equip_price}元` : "") },
      { label: "备注", key: "remark" },
    ],
  },
  6: { // 二手设备求购
    name: "二手设备求购",
    fields: [
      { label: "类型", value: () => "二手设备求购" },
      { label: "城市", key: "equip_region" },
      { label: "电话", key: "phone" },
      { label: "设备", key: "equip_desc" },
      { label: "价格", fmt: (f) => (f.equip_price != null && f.equip_price !== "" ? `${f.equip_price}元` : "") },
      { label: "备注", key: "remark" },
    ],
  },
};

// 生成补全模板文本：已识别到的字段自动填入值，缺失项留空让用户补
function buildFillTemplate(intent, fields) {
  const tpl = TEMPLATE_BY_INTENT[intent];
  if (!tpl) return "";
  const lines = tpl.fields.map((item) => {
    let val = "";
    if (item.value) val = item.value();
    else if (item.fmt) val = item.fmt(fields || {});
    else val = fields && fields[item.key] != null ? String(fields[item.key]) : "";
    return `${item.label}：${val}`;
  });
  return `请按以下格式补全您的「${tpl.name}」信息，然后重送：\n\n${lines.join("\n")}`;
}

// ---------- 入口 ----------
exports.main = async (event) => {
  // ★ 排查日志①：完整打印收到的 event（所有顶层参数）
  console.log("[TestRecruitWxAutoAI] ① 收到 event 顶层字段 keys =", Object.keys(event || {}));
  console.log("[TestRecruitWxAutoAI] ① 收到完整 event =", JSON.stringify(event, null, 2));

  // ★ 排查日志②：单独打印 messages 数组完整内容（若有）
  if (Array.isArray(event.messages)) {
    console.log(
      "[TestRecruitWxAutoAI] ① messages 数组条数 =", event.messages.length,
      "| 完整内容 =", JSON.stringify(event.messages, null, 2)
    );
  }

  // ★ 排查日志③：环境变量状态（DeepSeek 相关）
  console.log("[TestRecruitWxAutoAI] ① 环境变量 | DEEPSEEK_API_KEY =", process.env.DEEPSEEK_API_KEY ? "已配置(" + process.env.DEEPSEEK_API_KEY.slice(0, 6) + "***)" : "未配置", "| DEEPSEEK_API_URL =", process.env.DEEPSEEK_API_URL || "(默认)", "| DEEPSEEK_MODEL =", process.env.DEEPSEEK_MODEL || "(默认)");

  const wx = cloud.getWXContext();
  const openid = wx.OPENID || "";

  // 兼容三种入参形态：event.question / event.messages[-1] / event.action
  const fromQuestion = String(event.question || "").trim();
  const fromMessages = String(lastUserMessage(event.messages) || "").trim();
  const question = fromQuestion || fromMessages;
  const action = String(event.action || "");
  // ★ 排查日志④：标记 question 到底从哪个字段来（判断"是不是没拿到真正的 question"）
  console.log(
    "[TestRecruitWxAutoAI] ② 提取 | question 来源 =", fromQuestion ? "event.question" : fromMessages ? "event.messages[-1]" : "(空)",
    "| event.question =", JSON.stringify(event.question),
    "| messages[-1].content =", JSON.stringify(fromMessages),
    "| 最终 question =", JSON.stringify(question),
    "| action =", action || "(无)",
    "| has_tcbContext =", !!event.tcbContext,
    "| has_body =", !!event.body,
    "| has_httpMessage =", !!event.httpMessage
  );

  // ★ 记录 HTTP 调用日志到 recruit_http_logs（仅 HTTP 网关调用）
  const isHttp = !!(event.httpMethod || (event.httpMessage && event.httpMessage.httpMethod) || event.tcbContext);
  if (isHttp) {
    try {
      await db.collection("recruit_http_logs").add({
        data: {
          _openid: event.openid || "",
          created_at: Date.now(),
          http_method: (event.httpMessage && event.httpMessage.httpMethod) || event.httpMethod || "POST",
          path: (event.httpMessage && event.httpMessage.path) || event.path || "",
          raw_event: JSON.stringify(event).slice(0, 8000),
          question,
          question_source: fromQuestion ? "event.question" : fromMessages ? "event.messages[-1]" : "",
          action,
          has_messages: Array.isArray(event.messages),
        },
      });
      console.log("[TestRecruitWxAutoAI] 已记录 HTTP 日志");
    } catch (e) {
      console.log("[TestRecruitWxAutoAI] 日志写入失败:", (e && e.message) || e);
    }
  }

  if (!question) {
    return { msgType: "text", status: "empty", reply: "请描述您要发布的信息。" };
  }

  // ============ 1) DeepSeek 分析：意图(6类/无关) + 三要素完整性 + 结构化 JSON ============
  const analysis = await analyzePublishInfo(question);
  if (!analysis) {
    return {
      msgType: "text",
      status: "error",
      reply: "暂时无法分析您的信息，请稍后重试；或直接发送完整信息（城市 + 电话 + 内容）。",
    };
  }

  // intent=0：争吵/暴力/违法/闲聊等无关内容 → 请稍等
  if (analysis.intent === 0) {
    return {
      msgType: "text",
      status: "irrelevant",
      intent: 0,
      reply: "请稍等。",
      analysis,
    };
  }

  const meta = INTENT_MAP[analysis.intent] || {};

  // ============ 三大类型（招工/转让/设备出售）→ 用截图 mind-map 必填字段做完整性判断 ============
  //   必填不齐 → 返回结构化卡片（含 reply_to_user 告诉客户还缺啥）
  //   必填齐全 → 放行，进入下面"入库"流程
  if ([1, 3, 5].includes(analysis.intent)) {
    const card = buildIncompleteCard(analysis.intent, analysis.fields || {});
    if (card) {
      // 信息不完整 → 按类型模板提示补全（已识别字段自动填值，缺项留空）
      const tpl = buildFillTemplate(analysis.intent, analysis.fields || {});
      console.log("[TestRecruitWxAutoAI] ③ 数据不全 → 返回缺字段提示 | intent =", analysis.intent, "| missing =", card.missing);
      return { ...card, reply_to_user: tpl, reply: tpl, analysis };
    }
  } else if (!analysis.is_complete) {
    // 其他类型（求店/求职/设备求购）→ 按类型模板提示补全
    const tpl = buildFillTemplate(analysis.intent, analysis.fields || {});
    return {
      msgType: "text",
      status: "incomplete",
      intent: analysis.intent,
      data_type: meta.data_type || "",
      intent_name: meta.name || "",
      missing: analysis.missing || [],
      reply: tpl || `检测到您想发布「${meta.name || ""}」信息，但内容不完整。请按格式补全：类型、城市、电话、内容。`,
      analysis,
    };
  }

  // ============ 2) 信息完整 → 入库 baozi_posts + 回复「已发」 ============
  const postId = await publishPost(analysis, openid);
  return {
    msgType: "text",
    status: "published",
    intent: analysis.intent,
    data_type: analysis.data_type || meta.data_type || "",
    intent_name: meta.name || "",
    reply: "已发",
    id: postId || "",
    analysis,
  };
};

// ============ 工具函数 ============

// 取 messages 数组里最后一条用户消息
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

// 脱敏：中间四位 ****（如 187****9563）
function maskPhone(phone) {
  const p = String(phone || "");
  return p.length === 11 ? p.slice(0, 3) + "****" + p.slice(7) : p;
}

// 入库发布：公共字段 + DeepSeek 分析出的类型专属字段
async function publishPost(analysis, openid) {
  const fields = analysis.fields && typeof analysis.fields === "object" ? analysis.fields : {};
  const meta = INTENT_MAP[analysis.intent] || {};
  const post = {
    data_type: analysis.data_type || meta.data_type || "other",
    city: fields.city || "",
    province: fields.province || "",
    phone: fields.phone || "",
    phone_masked: maskPhone(fields.phone),
    raw_text: analysis.raw_text || "",
    published_at: Date.now(),
    source: "manual",
    needs_review: false,
    _openid: openid || "",
  };
  // 类型专属字段平铺入库（DeepSeek 已按类型输出对应字段）
  for (const key of Object.keys(fields)) {
    if (!(key in post) && fields[key] != null) {
      post[key] = fields[key];
    }
  }
  try {
    const res = await db.collection("baozi_posts").add({ data: post });
    console.log("[TestRecruitWxAutoAI] 入库成功 _id =", res._id);
    return res._id;
  } catch (e) {
    console.log("[TestRecruitWxAutoAI] 入库失败:", (e && e.message) || e);
    return "";
  }
}

// ============ DeepSeek 专用分析器（新写提示词） ============

// 提示词：判断发布类型 + 三要素完整性 + 结构化 JSON 提取
const ANALYZE_SYSTEM_PROMPT =
  "你是包子行业信息平台的发布信息分析器。用户会发送一段文本，你的任务是：\n" +
  "1) 判断这段文本是否属于平台六大发布类型之一，若是，给出类型编号；\n" +
  "2) 判断信息是否完整（必须包含 电话 + 地址 + 内容 三要素）；\n" +
  "3) 把信息结构化提取成 JSON 字段。\n\n" +
  "六大发布类型（intent 值）：\n" +
  "1=转店(transfer)：把包子店/餐饮店转让出去（转让费、租金、设备随店转让等）\n" +
  "2=求店(want_shop)：想接手/盘下一家包子店（求转让、找店、想开店）\n" +
  "3=招聘(recruit)：老板招师傅/员工（招大师傅、招工、招人）\n" +
  "4=求职(jobseek)：师傅找活干（求职、找师傅岗位、顶班、可到岗）\n" +
  "5=二手设备出售(equip_sell)：卖设备（出售和面机/蒸笼/冰柜）\n" +
  "6=二手设备求购(equip_buy)：买二手设备（求购设备、收设备）\n" +
  "0=无关内容：争吵、辱骂、暴力、违法、色情、广告推销、闲聊、或无法判断的内容。\n\n" +
  "完整性三要素：\n" +
  "- 电话：11 位手机号（如 15975937411）；\n" +
  "- 地址：城市/地区（如 北京、上海浦东、东莞）；\n" +
  "- 内容：具体的发布内容描述（如 招大师傅、店铺转让、求购和面机）。\n" +
  "is_complete=true 要求三要素齐全；missing 数组列出缺失的要素名称（电话/地址/内容），齐全则为空数组 []。\n\n" +
  "JSON 字段按类型提取（只填文本中出现的，没出现的不填或填 null）：\n" +
  "公共字段：city(城市)、province(省份)、phone(11位手机号)、content(内容描述)、remark(备注/其他说明，包括紧急程度、到岗时间、随店设备等不属于其他字段的补充信息)\n" +
  "1 转店额外：rent(月租元/月)、transfer_fee(转让费)、turnover_low(日营业额下限)、turnover_high(日营业额上限)、area_m2(面积)、is_franchise(是否加盟)、brand(品牌名，如巴比、蒸功夫等)\n" +
  "2 求店额外：turnover_expect(期望日营业额)、rent_max(最高月租)、city_prefer(偏好城市)\n" +
  "3 招聘额外：role(岗位，如大师傅)、salary_low(月薪下限)、salary_high(月薪上限)、salary_note(薪资备注)\n" +
  "4 求职额外：role(岗位)、service_area(可服务地区)、salary_low(期望薪资下限)、salary_high(期望薪资上限)、availability(到岗时间)\n" +
  "5 设备出售额外：equip_desc(设备描述)、equip_price(价格，面议则null)、equip_region(设备所在地区)\n" +
  "6 设备求购额外：equip_desc(设备描述)、equip_price(价格，面议则null)、equip_region(收购范围)\n\n" +
  "只允许返回一个 JSON 对象，禁止输出任何其他文字、解释或 Markdown 代码块标记。\n" +
  'JSON 格式：{"intent": 1~6或0, "intent_name": "招聘", "data_type": "recruit", "is_complete": true|false, "missing": [], "fields": {}, "reason": "一句话判断理由"}\n' +
  '示例：\n用户：招北京大师傅15975937411工资7000\n→ {"intent": 3, "intent_name": "招聘", "data_type": "recruit", "is_complete": true, "missing": [], "fields": {"city": "北京", "province": "北京", "phone": "15975937411", "content": "招大师傅，工资7000", "role": "大师傅", "salary_low": 7000}, "reason": "有电话、地址、岗位和薪资，信息完整，属于招聘"}\n' +
  '用户：上海包子店转让设备齐全13800001111\n→ {"intent": 1, "intent_name": "转店", "data_type": "transfer", "is_complete": true, "missing": [], "fields": {"city": "上海", "province": "上海", "phone": "13800001111", "content": "包子店转让，设备齐全"}, "reason": "电话地址内容齐全，属于转店"}\n' +
  '用户：你傻逼吧\n→ {"intent": 0, "intent_name": "无关内容", "data_type": "", "is_complete": false, "missing": [], "fields": {}, "reason": "辱骂内容，与发布无关"}\n' +
  '用户：想找家包子店接手\n→ {"intent": 2, "intent_name": "求店", "data_type": "want_shop", "is_complete": false, "missing": ["电话", "地址"], "fields": {"content": "想找家包子店接手"}, "reason": "有意向但缺电话和地址"}';

async function analyzePublishInfo(question) {
  const res = await askDeepSeek(ANALYZE_SYSTEM_PROMPT, question);
  if (!res) return null;
  const intent = Number(res.intent);
  const validIntent = [0, 1, 2, 3, 4, 5, 6].includes(intent) ? intent : 0;
  const fields = res.fields && typeof res.fields === "object" ? res.fields : {};
  return {
    intent: validIntent,
    intent_name: res.intent_name || "",
    data_type: String(res.data_type || ""),
    is_complete: res.is_complete === true || res.is_complete === "true",
    missing: Array.isArray(res.missing) ? res.missing : [],
    fields,
    reason: res.reason || "",
    raw_text: question,
  };
}

// 通用 DeepSeek JSON 调用（解析失败/无 Key → null，并打印失败原因便于排查）
async function askDeepSeek(systemPrompt, userContent) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log("[TestRecruitWxAutoAI] ★★ 未配置 DEEPSEEK_API_KEY，跳过 DeepSeek 调用（请在云函数环境变量中配置）");
    return null;
  }
  try {
    const resp = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        max_tokens: 1000,
      },
      {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        timeout: 25000,
      }
    );
    const raw =
      (resp.data && resp.data.choices && resp.data.choices[0] &&
        resp.data.choices[0].message && resp.data.choices[0].message.content) || "";
    console.log("[TestRecruitWxAutoAI] DeepSeek 原始返回 =", String(raw).slice(0, 2000)); // ★排查
    // 容错解析：
    //   1) 先剥 ```json 围栏后整体解析（避免嵌套对象被截断）
    const cleaned = String(raw).replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // 2) 整体解析失败（可能带前缀/后缀文字）→ 取 首个 { 到最后一个 } 的贪婪片段再解析
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1 || end <= start) {
        console.log("[TestRecruitWxAutoAI] ★★ JSON 提取失败，raw =", cleaned.slice(0, 2000));
        return null;
      }
      return JSON.parse(cleaned.slice(start, end + 1));
    }
  } catch (e) {
    console.log("[TestRecruitWxAutoAI] DeepSeek 调用失败:", (e && e.message) || e);
    return null;
  }
}
