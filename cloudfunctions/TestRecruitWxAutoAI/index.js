// cloudfunctions/TestRecruitWxAutoAI/index.js
// ============================================================
// 测试版云函数：意图判断（查/发/其他 + 六大业务）+ 发布三要素校验 + 查询列表
//
// 入口（debugHttpEvent 实测确认）：
//   HTTP 网关把请求体 JSON 直接作为 event 顶层传入：
//     {"question":"有没有包子店在转让", tcbContext:{...}}
//   没有 event.body / event.httpMessage，question 直接读 event.question。
//
// 流程：
//   1) DeepSeek 意图分析器输出两个维度：
//        action = query(查询) / publish(发布) / other(无关)
//        biz    = transfer/want_shop/recruit/jobseek/equip_sell/equip_buy
//   2) action=other → 回复「请稍等。」
//   3) action=query → 走查询流程：按 biz 查 baozi_posts 最新 5 条，
//        支持城市/手机号/薪资过滤，返回 msgType:"list" 卡片列表
//   4) action=publish → 判断信息是否完整（电话+地址+内容）：
//        完整 → 结构化 JSON 入库，回复「已发」
//        不完整 → 提示缺哪几个要素，引导补全
//   5) DeepSeek 需返回 JSON：
//        {"action":"query|publish|other", "biz":"transfer", "biz_name":"转店",
//         "is_complete":true|false, "missing":[], "fields":{...}}
// ============================================================
const cloud = require("wx-server-sdk");
const axios = require("axios");
const { PROVINCE_CODES, CITY_CODES } = require("./cityCodes.js");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command; // 查询过滤 needs_review 用（_.neq）

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
  return `请按以下格式补全您的「${tpl.name}」信息，然后重发：\n\n${lines.join("\n")}`;
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

  // intent=0 / action=other：争吵/暴力/违法/闲聊等无关内容 → 请稍等
  if (analysis.intent === 0 || analysis.action === "other") {
    return {
      msgType: "text",
      status: "irrelevant",
      intent: analysis.intent,
      action: analysis.action,
      reply: "请稍等。",
      analysis,
    };
  }

  // ============ 查询意图（action=query）→ 走查询流程，不碰发布 ============
  if (analysis.action === "query" && analysis.biz) {
    console.log("[TestRecruitWxAutoAI] ③ 查询意图 → 走查询流程 | biz =", analysis.biz, "| fields =", JSON.stringify(analysis.fields || {}));
    return await handleQuery(analysis);
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

// 提示词：判断业务（六大板块）+ 动作（查/发/其他）+ 完整性 + 结构化 JSON 提取
const ANALYZE_SYSTEM_PROMPT =
  "你是包子行业信息平台的意图分析器。用户会发送一段文本，你的任务是：\n" +
  "1) 判断业务（biz）：属于哪个板块；\n" +
  "2) 判断动作（action）：用户是要查信息还是发布信息；\n" +
  "3) 若是发布，判断信息是否完整并结构化提取字段；若是查询，提取城市/手机号等过滤条件。\n\n" +
  "六大业务板块（biz 值）：\n" +
  "transfer=转店：把包子店/餐饮店转让出去（转让费、租金、设备随店转让等）\n" +
  "want_shop=求店：想接手/盘下一家包子店（求转让、找店、想开店）\n" +
  "recruit=招聘：老板招师傅/员工（招大师傅、招工、招人）\n" +
  "jobseek=求职：师傅找活干（求职、找师傅岗位、顶班、可到岗）\n" +
  "equip_sell=二手设备出售：卖设备（出售和面机/蒸笼/冰柜）\n" +
  "equip_buy=二手设备求购：买二手设备（求购设备、收设备）\n\n" +
  "查询视角规则（仅 query 场景按此定 biz，关键）：\n" +
  "biz 不是'用户的角色'，而是'用户想看的帖子发布者的角色'——用户要的信息永远在对端：\n" +
  "1) 用户想要'店'（有没有店、想接手、转让的店、广州有店吗）→ biz=transfer（查转让者发的帖）\n" +
  "2) 用户想要'师傅/员工'（有没有师傅、师傅有吗、5000的师傅）→ biz=jobseek（查求职者发的帖）\n" +
  "3) 用户想要'岗位/活'（哪里招人、招聘信息、招人的店）→ biz=recruit（查招聘者发的帖）\n" +
  "4) 用户想要'二手设备'（还有设备吗、有没有设备卖）→ biz=equip_sell（查出售者发的帖）\n" +
  "5) 用户想'转让店找接手人'（有没有人要店、找店的人）→ biz=want_shop（查求店者发的帖）\n" +
  "6) 用户想'卖设备找收购方'（有没有人收设备）→ biz=equip_buy（查求购者发的帖）\n" +
  "判断步骤：先看用户是想要东西（要店/要师傅/要设备/要岗位 → 查提供方）还是想出手（转店/卖设备 → 查需求方）。\n\n" +
  "动作判断（action 值）：\n" +
  "query=查询：想找信息、看帖子、了解行情（有没有、哪里有、谁家、推荐、附近、查一下、搜一下、哪些、在哪、哪里、多少钱、工资多少、行情、看看、有转让吗、有人收吗）\n" +
  "publish=发布：想发布自己的信息（我要、想发、招/求职/转让/卖设备/收设备，通常带联系电话或具体内容描述）\n" +
  "other=无关：闲聊、问候、争吵、辱骂、暴力、违法、色情、广告推销、或无法判断的内容\n" +
  "判断要点：问句或找信息类判 query；陈述自己的信息且带电话/具体内容判 publish；无法归入任何业务板块判 other。\n\n" +
  "完整性（仅 publish 时判断）：电话(11位手机号)+地址(城市/地区)+内容(具体描述) 三要素齐全则 is_complete=true，missing 数组列出缺失要素名称（电话/地址/内容）；query 时 is_complete=true、missing=[]。\n\n" +
  "JSON 字段按业务提取（只填文本中出现的，没出现的不填或填 null）：\n" +
  "公共字段：city(城市)、province(省份)、phone(11位手机号)、content(内容描述)、remark(备注/其他说明，包括紧急程度、到岗时间、随店设备等补充信息)\n" +
  "transfer 额外：rent(月租元/月)、transfer_fee(转让费)、turnover_low(日营业额下限)、turnover_high(日营业额上限)、area_m2(面积)、is_franchise(是否加盟)、brand(品牌名，如巴比、蒸功夫等)\n" +
  "want_shop 额外：turnover_expect(期望日营业额)、rent_max(最高月租)、city_prefer(偏好城市)\n" +
  "recruit 额外：role(岗位，如大师傅)、salary_low(月薪下限)、salary_high(月薪上限)、salary_note(薪资备注)\n" +
  "jobseek 额外：role(岗位)、service_area(可服务地区)、salary_low(期望薪资下限)、salary_high(期望薪资上限)、availability(到岗时间)\n" +
  "equip_sell/equip_buy 额外：equip_desc(设备描述)、equip_price(价格，面议则null)、equip_region(地区)\n\n" +
  "只允许返回一个 JSON 对象，禁止输出任何其他文字、解释或 Markdown 代码块标记。\n" +
  'JSON 格式：{"action":"query|publish|other","biz":"transfer","biz_name":"转店","is_complete":true|false,"missing":[],"fields":{},"reason":"一句话判断理由"}\n' +
  '示例1 用户：有没有包子店在转让\n→ {"action":"query","biz":"transfer","biz_name":"转店","is_complete":true,"missing":[],"fields":{},"reason":"问句，找转让信息"}\n' +
  '示例2 用户：招北京大师傅15975937411工资7000\n→ {"action":"publish","biz":"recruit","biz_name":"招聘","is_complete":true,"missing":[],"fields":{"city":"北京","province":"北京","phone":"15975937411","content":"招大师傅工资7000","role":"大师傅","salary_low":7000},"reason":"带电话和具体招聘内容，属发布"}\n' +
  '示例3 用户：上海包子店转让设备齐全13800001111\n→ {"action":"publish","biz":"transfer","biz_name":"转店","is_complete":true,"missing":[],"fields":{"city":"上海","province":"上海","phone":"13800001111","content":"包子店转让设备齐全"},"reason":"带电话和具体内容，属发布"}\n' +
  '示例4 用户：哪里招包子师傅\n→ {"action":"query","biz":"recruit","biz_name":"招聘","is_complete":true,"missing":[],"fields":{},"reason":"师傅找活，店是主体，查招聘帖"}\n' +
  '示例5 用户：你傻逼吧\n→ {"action":"other","biz":"","biz_name":"","is_complete":false,"missing":[],"fields":{},"reason":"辱骂，与业务无关"}\n' +
  '示例6 用户：想找家包子店接手\n→ {"action":"query","biz":"transfer","biz_name":"转店","is_complete":true,"missing":[],"fields":{"content":"想找家包子店接手"},"reason":"用户想要店，查转让者发的帖"}\n' +
  '示例7 用户：5000左右的师傅有吗\n→ {"action":"query","biz":"jobseek","biz_name":"求职","is_complete":true,"missing":[],"fields":{"salary_low":5000,"salary_high":5000},"reason":"用户要师傅，师傅是求职者，查求职帖，5000为期望薪资过滤"}\n' +
  '示例8 用户：广州有没有店\n→ {"action":"query","biz":"transfer","biz_name":"转店","is_complete":true,"missing":[],"fields":{"city":"广州"},"reason":"用户想接手店，查转让帖，按广州过滤"}\n' +
  '示例9 用户：广州还有设备吗\n→ {"action":"query","biz":"equip_sell","biz_name":"二手设备出售","is_complete":true,"missing":[],"fields":{"city":"广州"},"reason":"用户想买设备，查出卖者发的帖，按广州过滤"}\n' +
  '示例10 用户：有没有人要接手我的店\n→ {"action":"query","biz":"want_shop","biz_name":"求店","is_complete":true,"missing":[],"fields":{},"reason":"用户想转店，找接手人，查求店者发的帖"}\n' +
  '示例11 用户：有没有人收二手设备\n→ {"action":"query","biz":"equip_buy","biz_name":"二手设备求购","is_complete":true,"missing":[],"fields":{},"reason":"用户想卖设备，找收购方，查求购者发的帖"}';

async function analyzePublishInfo(question) {
  const res = await askDeepSeek(ANALYZE_SYSTEM_PROMPT, question);
  if (!res) return null;
  const biz = String(res.biz || "").trim();
  // biz → intent（兼容现有发布逻辑 INTENT_MAP 1~6；无关 → 0）
  const BIZ_TO_INTENT = { transfer: 1, want_shop: 2, recruit: 3, jobseek: 4, equip_sell: 5, equip_buy: 6 };
  const intent = BIZ_TO_INTENT[biz] || 0;
  const fields = res.fields && typeof res.fields === "object" ? res.fields : {};
  return {
    action: String(res.action || "").trim(),   // query | publish | other
    biz,
    intent,                                     // 1~6 或 0（兼容旧发布逻辑）
    intent_name: String(res.biz_name || ""),
    data_type: biz,
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

// ============ 查询流程（action=query）============

// 查询：按 biz 对应的 data_type 查最新帖子，支持城市/手机号/薪资过滤，返回 list 卡协议
async function handleQuery(analysis) {
  const dataType = analysis.biz;
  const fields = analysis.fields && typeof analysis.fields === "object" ? analysis.fields : {};
  const cond = { data_type: dataType, needs_review: _.neq(true) };
  // 城市过滤：剥掉"市"后缀模糊匹配（兼容"东莞市"入库的数据）
  const city = String(fields.city || fields.city_prefer || fields.equip_region || "").trim().replace(/市$/, "");
  if (city) cond.city = db.RegExp({ regexp: city, options: "" });
  // 手机号精确过滤（如"帮我查 15975937411"）
  const phone = String(fields.phone || "").trim();
  if (/^1\d{10}$/.test(phone)) cond.phone = phone;
  // 薪资过滤（仅 jobseek/recruit 有 salary 字段）：期望薪资区间与用户出价 ±500 有交集才命中
  const sLow = Number(fields.salary_low);
  const sHigh = Number(fields.salary_high);
  if (!isNaN(sLow) && sLow > 0) cond.salary_low = _.lte(sLow + 500);
  if (!isNaN(sHigh) && sHigh > 0) cond.salary_high = _.gte(sHigh - 500);
  try {
    let query = db.collection("baozi_posts").where(cond);
    if (!phone) query = query.orderBy("published_at", "desc");
    const res = await query.limit(5).get();
    const posts = res.data || [];
    const name = analysis.intent_name || dataType;
    if (!posts.length) {
      return {
        msgType: "text",
        status: "query_empty",
        intent: analysis.intent,
        data_type: dataType,
        intent_name: name,
        reply: `暂时没有找到${city ? city + "的" : ""}${name}信息，晚点再来看看吧。`,
        analysis,
      };
    }
    const list = posts.map((p, i) => formatQueryPost(p, i)).join("\n");
    return {
      msgType: "list",
      status: "query_ok",
      intent: analysis.intent,
      data_type: dataType,
      intent_name: name,
      // reply: `【最新${city || ""}${name} ， 共${posts.length}条】\n\n` + list,
      reply: list,

      data: posts,
      analysis,
    };
  } catch (e) {
    console.log("[TestRecruitWxAutoAI] 查询失败:", (e && e.message) || e);
    return { msgType: "text", status: "error", reply: "查询出错：" + ((e && e.errMsg) || (e && e.message) || e) };
  }
}

// 每条帖子的文本行（按类型取关键字段，电话脱敏）
function formatQueryPost(p, i) {
  const loc = [p.province, p.city].filter(Boolean).join(" ");
  const phone = p.phone_masked || maskPhone(p.phone);
  const head = `${i + 1}. ${loc ? loc + " · " : ""}${phone ? phone + " ， " : ""}`;
  let body = "";
  switch (p.data_type) {
    case "recruit":
      body = `${p.role || "招工"}，薪资${salaryText(p)}`;
      break;
    case "transfer":
      body = `租金${p.rent ? p.rent + "元/月" : "?"}，营业额${p.turnover_low ? p.turnover_low + "-" + (p.turnover_high || "?") + "元/日" : "?"}，转让费${p.transfer_fee ? p.transfer_fee + "元" : "?"}`;
      break;
    case "want_shop":
      body = `偏好${p.city_prefer || "?"}，期望营业额${p.turnover_expect ? p.turnover_expect + "元/日" : "?"}，最高月租${p.rent_max ? p.rent_max + "元" : "?"}`;
      break;
    case "jobseek":   
      body = `${p.role || "求职"}，可服务${p.service_area || "?"}，期望${salaryText(p)}`;
      break;
    case "equip_sell":
    case "equip_buy":
      body = `${p.equip_desc || "设备"}，${p.equip_price != null ? p.equip_price + "元" : "面议"}，${p.equip_region || "?"}`;
      break;
    default:
      body = (p.raw_text || "").slice(0, 60);
  }
  return head + body;
}

function salaryText(p) {
  if (String(p.salary_note || "").trim() === "面议") return "面议";
  if (p.salary_low && p.salary_high) return `${p.salary_low}-${p.salary_high}元`;
  if (p.salary_high) return `${p.salary_high}元`;
  if (p.salary_low) return `${p.salary_low}元`;
  return "面议";
}
