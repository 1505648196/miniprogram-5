// cloudfunctions/recruitAI/index.js
// 招工对话路由（详细流程图版 · 2026-08-24 落地）
//
// 入口状态机（客户消息 = 默认查询态）：
//   ① 有进行中发布草稿?（按 openid 查 recruit_drafts）──是──→ 发布模式（⑤⑥⑦⑧⑨）
//     ↓否
//   ② 含求职词（找/想找活…）且不含招工词? ──是──→ "求职功能暂未开放"
//     ↓否
//   ③ 查询 override?（有没有/哪里有/谁家/推荐/附近）──是──→ 查询流
//     ↓否
//   ④ 发布信号?（招/招聘词 或 ≥3必填+phone 或 留电话式:联系词+phone+岗位/城市）──是──→ 发布模式（⑤⑥⑦⑧⑨）
//     ↓否
//   查询流 + "需要发布" 提示
//
// 发布模式内部（⑤⑥⑦⑧⑨）：
//   ⑤ 运行 4 必填匹配器：phone正则 / salary数字+上限 / salary_note词 / city词典 / role枚举
//   ⑥ 与草稿合并（若有）
//   ⑦ 4 必填全齐?（role/city/salary/phone）
//     是 → ⑧ 弹确认卡：展示字段 + tags 预览，客户点确认发布 → publishPost
//     否 → ⑨ 启/续草稿：存 openid+已填+缺失+状态  回复：还差 X、Y  → Tips: 需查询？点我（查询信息）
//
// action 路由（前端按钮触发，不经主流程）：
//   action=publish → handlePublish   确认发布：publishPost 入库 + 删草稿
//   action=cancel  → handleCancel    取消草稿：按 openid 删最新草稿
//
// 入参：{ question | messages } 或 { action: "publish" | "cancel" }
// 环境变量：DEEPSEEK_API_KEY（仅"分析"类需要）
const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";

// 全国行政区划代码词典（公共数据词典，与 aiChat/cityCodes.js 逐字一致）
const CODES = require("./cityCodes.js");
const CITIES = Object.keys(CODES.CITY_CODES);
const PROVINCES = Object.keys(CODES.PROVINCE_CODES);
const { getDraft, saveDraft, deleteDraftById, MAX_SALARY } = require("./drafts.js");

// 发布相关常量（与 publish.js 一致）
const ROLE_OPTIONS = [
  "大师傅", "夫妻工", "短期/顶班", "售卖员", "学徒工", "小笼包师傅", "饼类师傅",
  "二把手", "油炸类师傅", "中工", "生煎类师傅", "全能面点大师", "工厂", "其他类型",
];
const WELFARE_OPTIONS = ["包吃", "包住", "双休", "高薪", "住宿环境好", "休息长"];
const BOSS_REGION_OPTIONS = ["湖南老板", "山东老板", "福建老板", "湖北老板", "安徽老板"];
const SHOP_TYPE_OPTIONS = ["工厂/食堂", "品牌包子店", "个体包子店"];
const ALL_TAG_OPTIONS = [...WELFARE_OPTIONS, ...BOSS_REGION_OPTIONS, ...SHOP_TYPE_OPTIONS];

// ② 求职词
const JOBSEEK_KEYWORDS = ["找活", "想找活", "找工作", "求职", "我是师傅", "我找工作", "待业"];
// 招工词（② 排除 + ④ 信号）
const RECRUIT_KEYWORDS = ["招", "招聘", "招工", "招人", "请人", "雇", "招师傅", "招阿姨", "招学徒"];
// ③ 查询 override
const QUERY_OVERRIDE_KEYWORDS = ["有没有", "哪里有", "谁家", "推荐", "附近", "查一下", "搜一下", "哪些", "在哪", "哪里"];
// ④ 发布信号
const PUBLISH_KEYWORDS = [...RECRUIT_KEYWORDS, "我要发", "帮我发", "我要招", "发布", "发个", "发一条", "发个招工"];
// ④b 留电话式发布：雇主要求应聘者电话联系（"饼类师傅…请在上班时间内联系 138xxxx"）
const CONTACT_KEYWORDS = ["联系", "联系电话", "联系我", "致电", "打电话", "欢迎联系", "有意者联系", "随时联系", "方便联系"];
// ⑨ 显式放弃草稿
const ABANDON_KEYWORDS = ["取消", "不发了", "算了", "放弃", "不要了", "清空", "退出", "回到查询"];

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 状态机入口 + ⑤⑥⑦⑧⑨ 发布模式 + handleQuery
// 详细路由见文件头部注释
exports.main = async (event) => {
  const wx = cloud.getWXContext();
  const openid = wx.OPENID || "";
  const question = String(event.question || lastUserMessage(event.messages) || "").trim();
  console.log("[recruitAI] action =", event.action || "(无)", "| question =", question);

  // 0. action 路由（按钮触发，不走主状态机）
  if (event.action === "publish") return handlePublish(openid);
  if (event.action === "cancel") return handleCancel(openid);
  if (event.action === "clear") return handleClear(openid);
  if (event.action === "skip") return handleSkip(openid);
  if (event.action === "peek_draft") return handlePeekDraft(openid);
  if (!question) return { msgType: "text", reply: buildGuide() };

  // ① 草稿检查（按 openid 查 recruit_drafts）
  const draft = await getDraft(openid);
  if (draft) {
    console.log("[recruitAI] ① 命中草稿, 已填 =", summarize(draft));
    // 用户消息是补字段意图 → 走发布流（合并 + 校验）
    if (isCompletingDraft(question)) {
      return handlePublishFlow(openid, question, draft);
    }
    // 非补字段意图（查询/闲聊）：返回草稿提示卡（不拼接用户消息到 desc），
    // 等待用户显式选择"继续补充"或"跳过"，避免把"上海有哪些包子店在招工"这种查询问句吞进 desc
    return {
      msgType: "card", cardType: "draft_pending",
      reply: "您有一条未发布的招工草稿",
      fields: formatFieldsForCard(draft),
      missing: checkMissing(draft),
      pendingQuestion: question,
    };
  }

  // ② 求职词（命中且招工词未命中 → 暂未开放）
  if (isJobseekOnly(question)) {
    return { msgType: "text",
      reply: "求职功能暂未开放（先不管），看看招工信息吧。\n\n试试：'上海有哪些包子店在招工'" };
  }

  // ③ 查询 override
  if (hasQueryOverride(question)) return await handleQuery(question, false);

  // ④ 发布信号
  if (hasPublishSignal(question)) {
    console.log("[recruitAI] ④ 命中发布信号");
    return handlePublishFlow(openid, question, null);
  }

  // ④否 → 查询流 + 切发布提示
  return await handleQuery(question, true);
};

// ============== ⑤⑥⑦⑧⑨ 发布模式 ==============
async function handlePublishFlow(openid, question, existingDraft) {
  // 显式放弃
  if (ABANDON_KEYWORDS.some((k) => question.includes(k))) {
    if (existingDraft) await deleteDraftById(openid, existingDraft._id);
    return { msgType: "text",
      reply: "已取消发布草稿，需要时再告诉我（说'招大师傅 上海 6000 18700009563'这种格式最快）。" };
  }
  // ⑤ 4 必填匹配
  const ext = matchRequiredFields(question);
  // ⑥ 与草稿合并
  const merged = mergeDraft(existingDraft, ext);
  // ⑥.5 用户全输入文本 → raw_text 数据源（续草稿逐条追加，保证全文不丢）
  merged.desc = merged.desc ? merged.desc + "\n" + question : question;
  // ⑦ 校验
  const missing = checkMissing(merged);
  console.log("[recruitAI] ⑦ 缺 =", missing.map((m) => m.label).join("、") || "(全齐)");

  if (missing.length === 0) {
    // ⑧ 弹确认卡
    const draftId = await saveDraft(openid, merged);
    return {
      msgType: "card", cardType: "confirm",
      reply: "请确认招工信息",
      fields: formatFieldsForCard(merged),
      tags: merged.tags || [],
      draftId,
    };
  }
  // ⑨ 启/续草稿
  await saveDraft(openid, merged);
  return {
    msgType: "card", cardType: "draft_continue",
    reply: `还差 ${missing.map((m) => m.label).join("、")}`,
    fields: formatFieldsForCard(merged),
    missing, tags: merged.tags || [],
  };
}

// ⑧ 确认发布
async function handlePublish(openid) {
  if (!openid) return { msgType: "text", reply: "发布失败：未拿到 openid，请重新进入小程序后再试。" };
  const draft = await getDraft(openid);
  if (!draft) return { msgType: "text", reply: "没有待发布的草稿（可能已过期或被取消），需要时再告诉我具体信息即可。" };
  const missing = checkMissing(draft);
  if (missing.length) return { msgType: "text",
    reply: `草稿信息不完整，还差 ${missing.map((m) => m.label).join("、")}，请继续补充。` };
  let postId;
  try { postId = await publishToBaoziPosts(draft); }
  catch (e) { return { msgType: "text", reply: "发布失败：" + (e.errMsg || e.message || e) }; }
  await deleteDraftById(openid, draft._id);
  // 发布摘要：供前端成功弹层展示（岗位/城市/薪资）
  let salaryText = "面议";
  if (draft.salary_high || draft.salary_low) {
    salaryText = (draft.salary_low && draft.salary_high && draft.salary_low !== draft.salary_high)
      ? `${draft.salary_low}-${draft.salary_high} 元`
      : `${draft.salary_high || draft.salary_low} 元`;
  }
  return {
    success: true,
    msgType: "text",
    reply: "✅ 发布成功！招工信息已出现在列表里，求职者可以直接看到。",
    postId,
    summary: { role: draft.role || "", city: draft.city || "", salaryText },
  };
}

// 取消草稿
async function handleCancel(openid) {
  if (!openid) return { msgType: "text", reply: "没有待取消的草稿。" };
  const draft = await getDraft(openid);
  if (!draft) return { msgType: "text", reply: "没有待取消的草稿。" };
  await deleteDraftById(openid, draft._id);
  return { msgType: "text", reply: "已取消发布草稿。", tipChip: "上海有哪些包子店在招工" };
}

// 清空对话 & 草稿（前端"清空"按钮专用）：删草稿 + 返回清理结果，不再走状态机
async function handleClear(openid) {
  let hadDraft = false;
  if (openid) {
    const draft = await getDraft(openid);
    if (draft && draft._id) hadDraft = await deleteDraftById(openid, draft._id);
  }
  return {
    success: true,
    cleared: true,
    hadDraft: !!hadDraft,
    reply: hadDraft
      ? "已清空对话，并删除 1 条未发布的招工草稿"
      : "已清空对话（无未发布草稿）",
  };
}

// ============== ②③④ 关键词检测 ==============
function isJobseekOnly(t) {
  return JOBSEEK_KEYWORDS.some((k) => t.includes(k)) && !RECRUIT_KEYWORDS.some((k) => t.includes(k));
}
function hasQueryOverride(t) {
  return QUERY_OVERRIDE_KEYWORDS.some((k) => t.includes(k));
}
function hasPublishSignal(t) {
  if (PUBLISH_KEYWORDS.some((k) => t.includes(k))) return true;
  const ext = matchRequiredFields(t);
  // 留电话式发布：雇主要求应聘者电话联系（如"饼类师傅…请在上班时间内联系 138xxxx"）
  if (ext.phone && CONTACT_KEYWORDS.some((k) => t.includes(k)) && (ext.role || ext.city)) return true;
  let cnt = 0;
  if (ext.phone) cnt++;
  if (ext.city) cnt++;
  if (ext.role) cnt++;
  if (ext.salary_high || ext.salary_low || ext.salary_note) cnt++;
  return cnt >= 3 && !!ext.phone;
}

// ============== ① 草稿分支辅助：用户消息是否在补字段 ==============
// 命中补字段 → 走 handlePublishFlow；否则返回草稿提示卡，避免把查询消息吞进 desc
function isCompletingDraft(t) {
  if (!t) return false;
  // 反向：含查询 override 词（有没有/哪里/谁家/…）→ 不是补字段
  if (hasQueryOverride(t)) return false;
  // 反向：显式放弃词（取消/不发了/…）→ 让 handlePublishFlow 走 ABANDON 分支删草稿
  if (ABANDON_KEYWORDS.some((k) => t.includes(k))) return true;
  // 正向：含招工词/联系词 → 是补字段
  if (RECRUIT_KEYWORDS.some((k) => t.includes(k))) return true;
  if (CONTACT_KEYWORDS.some((k) => t.includes(k))) return true;
  // 正向：能提取出有效字段 → 是补字段
  const ext = matchRequiredFields(t);
  return !!(ext.phone || ext.city || ext.role || ext.salary_low || ext.salary_high || ext.salary_note);
}

// 跳过草稿：按 openid 删草稿（前端收到 success 后用 pendingQuestion 重新 sendAi 走查询流）
async function handleSkip(openid) {
  if (openid) {
    const draft = await getDraft(openid);
    if (draft && draft._id) await deleteDraftById(openid, draft._id);
  }
  return { success: true, hidden: true };
}

// 弹层打开时 peek 草稿：仅读取不删，返回 hasDraft + 卡片字段（前端用于立即展示提示卡）
async function handlePeekDraft(openid) {
  if (!openid) return { hasDraft: false };
  const draft = await getDraft(openid);
  if (!draft) return { hasDraft: false };
  return {
    hasDraft: true,
    fields: formatFieldsForCard(draft),
    missing: checkMissing(draft),
  };
}

// ============== ⑤ 4 必填匹配器 ==============
function matchRequiredFields(t) {
  const ext = {
    phone: null, city: null, city_code: null,
    province: null, province_code: null, is_province: false,
    role: null, salary_low: null, salary_high: null, salary_note: null, tags: [],
  };
  const pm = t.match(/\b1[3-9]\d{9}\b/);
  if (pm) ext.phone = pm[0];
  // city 先市后省
  for (const c of CITIES) if (t.includes(c)) {
    ext.city = c; ext.city_code = CODES.CITY_CODES[c];
    if (["北京", "天津", "上海", "重庆"].includes(c)) { ext.province = c; ext.province_code = ext.city_code; }
    break;
  }
  if (!ext.city) for (const p of PROVINCES) if (t.includes(p)) {
    ext.province = p; ext.province_code = CODES.PROVINCE_CODES[p];
    ext.city = p; ext.city_code = ext.province_code; ext.is_province = true; break;
  }
  // role（14 项逐字精确 + 顶班/短期口语兜底）
  for (const r of ROLE_OPTIONS) if (t.includes(r)) { ext.role = r; break; }
  if (!ext.role && /(顶班|短期)/.test(t)) ext.role = "短期/顶班";
  // salary（面议优先；有效范围 3000~100000，低于/高于视为噪音置空）
  if (/(面议|可谈|议价|商量)/.test(t)) ext.salary_note = "面议";
  else {
    const sal = parseSalary(t);
    if (sal.salaryMin && sal.salaryMin >= 3000 && sal.salaryMin <= MAX_SALARY) ext.salary_low = sal.salaryMin;
    if (sal.salaryMax && sal.salaryMax >= 3000 && sal.salaryMax <= MAX_SALARY) ext.salary_high = sal.salaryMax;
  }
  // tags
  for (const tag of ALL_TAG_OPTIONS) if (t.includes(tag)) ext.tags.push(tag);
  return ext;
}

// ============== ⑥ 合并 ==============
function mergeDraft(draft, ext) {
  const m = Object.assign({}, draft || {});
  if (ext.phone) m.phone = ext.phone;
  if (ext.city) {
    m.city = ext.city; m.city_code = ext.city_code;
    m.province = ext.province || m.province;
    m.province_code = ext.province_code || m.province_code;
    m.is_province = !!ext.is_province;
  }
  if (ext.role) m.role = ext.role;
  if (ext.salary_note) { m.salary_note = ext.salary_note; m.salary_low = null; m.salary_high = null; }
  else {
    if (ext.salary_low != null) m.salary_low = ext.salary_low;
    if (ext.salary_high != null) m.salary_high = ext.salary_high;
  }
  if (ext.tags && ext.tags.length) m.tags = Array.from(new Set([...(m.tags || []), ...ext.tags]));
  return m;
}

// ============== ⑦ 校验 ==============
function checkMissing(d) {
  const m = [];
  if (!d.role) m.push({ key: "role", label: "岗位" });
  if (!d.city) m.push({ key: "city", label: "城市" });
  if (!(d.salary_high || d.salary_low || d.salary_note)) m.push({ key: "salary", label: "薪资" });
  if (!d.phone) m.push({ key: "phone", label: "电话" });
  return m;
}

// ============== 卡片构造 ==============
function formatFieldsForCard(d) {
  const f = [];
  if (d.role) f.push({ key: "role", label: "岗位", value: d.role, emoji: ROLE_EMOJI[d.role] || "🧑‍🍳" });
  if (d.city) {
    let loc = d.city;
    if (d.province && d.province !== d.city) loc = `${d.province} ${d.city}`;
    f.push({ key: "city", label: "城市", value: loc, isProvince: !!d.is_province });
  }
  if (d.salary_note === "面议") f.push({ key: "salary", label: "薪资", value: "面议" });
  else if (d.salary_high || d.salary_low) {
    const v = (d.salary_low && d.salary_high && d.salary_low !== d.salary_high)
      ? `${d.salary_low}-${d.salary_high} 元` : `${d.salary_high || d.salary_low} 元`;
    f.push({ key: "salary", label: "薪资", value: v });
  }
  if (d.phone) f.push({ key: "phone", label: "电话", value: maskPhone(d.phone) });
  if (d.address) f.push({ key: "address", label: "地址", value: d.address });
  if (d.contact) f.push({ key: "contact", label: "联系人", value: d.contact });
  return f;
}

function summarize(d) {
  return JSON.stringify({
    role: d.role, city: d.city,
    phone: d.phone ? d.phone.slice(0, 3) + "****" + d.phone.slice(7) : null,
    salary: [d.salary_low, d.salary_high, d.salary_note], tags: d.tags,
  });
}

function maskPhone(p) {
  const s = String(p || "").trim();
  return /^1\d{10}$/.test(s) ? s.slice(0, 3) + "****" + s.slice(7) : "";
}

// ============== publishToBaoziPosts（内联，避免 cloud→cloud 调用）==============
async function publishToBaoziPosts(d) {
  const phone = String(d.phone || "").trim();
  if (!/^1\d{10}$/.test(phone)) throw new Error("手机号不合法");
  const record = {
    data_type: "recruit", role: d.role,
    city: d.city || "", province: d.province || "", district: d.district || "",
    province_code: d.province_code || "", city_code: d.city_code || "", district_code: d.district_code || "",
    address: d.address || "",
    latitude: d.latitude != null ? Number(d.latitude) : null,
    longitude: d.longitude != null ? Number(d.longitude) : null,
    raw_text: d.desc || "", phone, phone_masked: maskPhone(phone), contact: d.contact || "",
    published_at: Date.now(), source: "user", needs_review: false,
    tags: Array.isArray(d.tags) ? d.tags.slice(0, 12) : [],
  };
  if (d.salary_note === "面议") record.salary_note = "面议";
  else {
    if (d.salary_low) record.salary_low = d.salary_low;
    if (d.salary_high) record.salary_high = d.salary_high;
  }
  const res = await db.collection("baozi_posts").add({ data: record });
  return res._id;
}

// ============== handleQuery（查询流，原 main 主体抽出）==============
// withPublishTip=true 时给结果加 tipChip="我要发布招工"，前端渲染为切发布按钮
async function handleQuery(question, withPublishTip) {
  const intent = detectIntent(question);
  if (intent.type === "other") return withTip({ msgType: "text", reply: buildGuide() }, withPublishTip);

  if (intent.type === "phone") {
    try {
      const res = await db.collection("baozi_posts")
        .where({ data_type: "recruit", needs_review: _.neq(true), phone: intent.phone })
        .limit(1).get();
      const found = (res.data || [])[0];
      if (!found) return withTip({
        msgType: "text",
        reply: `没有找到手机号 ${intent.phone} 对应的招工信息。\n\n试试问"上海有哪些包子店在招工"。`,
      }, withPublishTip);
      return withTip({
        msgType: "list",
        reply: `【${found.city || "全部"}招工 · 手机号精确匹配 1 条】\n\n` + formatPost(found, 0, true),
        data: [found],
      }, withPublishTip);
    } catch (e) {
      return withTip({ msgType: "text", reply: "手机号查询出错：" + (e.errMsg || e.message || e) }, withPublishTip);
    }
  }

  let posts;
  try { posts = await queryPosts(intent); }
  catch (e) {
    return withTip({ msgType: "text",
      reply: "查询数据库出错：" + (e.errMsg || e.message || e) +
        "\n\n可能原因：\n1) baozi_posts 集合还没创建（云开发控制台 → 数据库 → 新建集合，再导入数据）；\n2) 云函数所在环境没开通数据库。",
    }, withPublishTip);
  }

  if (intent.type === "list") {
    if (!posts.length) {
      const timeLabel = intent.timeRange && intent.timeRange.label ? intent.timeRange.label : "";
      // 智能建议：基于意图里实际受限的维度，给出针对性建议（不是模板套话）
      const advice = buildListEmptyAdvice(intent);
      return withTip({
        msgType: "text",
        reply: `暂无${timeLabel}${intent.city ? intent.city + "的" : ""}招工信息。` + advice,
      }, withPublishTip);
    }
    const list = posts.map((p, i) => formatPost(p, i, intent.wantPhone)).join("\n");
    const timeTag = intent.timeRange && intent.timeRange.label ? intent.timeRange.label + " " : "";
    return withTip({
      msgType: "list",
      reply: `【${timeTag}${intent.city || "全部"}招工 · 共${posts.length}条】\n\n` + list,
      data: posts,
    }, withPublishTip);
  }

  if (intent.type === "analysis") {
    const stats = buildStats(posts, intent);
    const blocks = buildBlocks(intent, stats);
    const apiKey = process.env.DEEPSEEK_API_KEY;
    let insight = "";
    if (apiKey && stats && stats.count > 0) {
      try { insight = await callDeepSeekInsight(stats, posts, question); }
      catch (err) { insight = ""; }
    }
    if (insight) blocks.push({ type: "insight", text: insight });
    else blocks.push({ type: "tip", emoji: "💡", text: templateTip(intent, stats) });
    blocks.push({ type: "chips", items: buildChips(intent) });
    const headText = blocks[0] && blocks[0].text ? blocks[0].text : "招工行情分析";
    return withTip({
      msgType: "analysis",
      reply: headText, blocks,
      data: posts.slice(0, 10),
      sources: posts.slice(0, 5).map((p) => ({ id: p._id, title: (p.raw_text || "").slice(0, 30) })),
    }, withPublishTip);
  }

  return withTip({ msgType: "text", reply: buildGuide() }, withPublishTip);
}

function withTip(r, withPublishTip) {
  if (withPublishTip) r.tipChip = "我要发布招工";
  return r;
}

// list 空结果智能建议：根据 intent 受限维度给出针对性建议（不是模板套话）
// 输入：完整 intent；输出：附加在"暂无XXX信息"后的 \n\n + 建议 + 分析引导
function buildListEmptyAdvice(intent) {
  const lines = [];
  const hasCity = !!intent.city;
  const hasSalaryMin = intent.salaryMin != null && intent.salaryMin > 0;
  const hasSalaryMax = intent.salaryMax != null && intent.salaryMax > 0;
  const hasTime = !!(intent.timeRange && intent.timeRange.label);
  const hasRole = !!intent.role;

  // 1) 工资过紧：上下限同时收紧，且至少一个 ≥5000 → 建议降低
  if (hasSalaryMin && intent.salaryMin >= 5000) {
    const lower = Math.max(3000, intent.salaryMin - 2000);
    lines.push(`工资调低到 ${lower} 元以上试试`);
  } else if (hasSalaryMax && intent.salaryMax <= 5000) {
    lines.push(`工资上限调到 6000-8000 元试试`);
  }

  // 2) 有城市限制但库数据少 → 建议热门城市或全国
  if (hasCity) {
    lines.push(`换个热门城市（上海/北京/广州/深圳/成都）`);
  } else if (!hasCity && hasRole) {
    lines.push(`加个城市过滤（如"上海有哪些包子店在招工"）`);
  }

  // 3) 时间过严
  if (hasTime) {
    lines.push(`扩大时间范围（试试"最近"/"近一个月"）`);
  } else if (hasRole || hasSalaryMin) {
    lines.push(`加时间范围（试试"最近"看新发布的）`);
  }

  // 兜底建议（前面都没给出时）
  if (lines.length === 0) {
    lines.push(`调整工资范围（如 6000-10000）`);
    lines.push(`换其他岗位类型（学徒工/中工/售卖员/短期顶班等）`);
  }

  // 拼接
  let text = "\n\n试试：\n· " + lines.slice(0, 4).join("\n· ");
  text += `\n\n也可以问"${intent.city || " "}师傅工资一般多少"看行情分析`;
  return text;
}

// ---------- 意图识别（招工专属关键词规则） ----------
// 返回：
//   {
//     type: "phone" | "list" | "analysis" | "other",
//     city, cityCode, isProvince,        // 区域（只做市/省精确匹配）
//     role,                              // 岗位（14 项精确匹配）
//     salaryMin, salaryMax,              // 工资区间（阿拉伯数字，用于 gte/lte）
//     wantPhone,                         // 问了电话/联系 → 列表突出联系方式
//     keyword,                           // 描述模糊词（raw_text/tags/address RegExp 模糊查）
//     limit,                             // 数量限制
//   }
function detectIntent(text) {
  const t = text || "";

  // 问候/无关
  const greetings = ["你好", "您好", "在吗", "hello", "hi", "谢谢", "感谢", "再见"];
  if (greetings.some((g) => t.includes(g))) {
    console.log("[recruitAI] detectIntent 问候词命中 → other");
    return { type: "other" };
  }

  // 分析意图（招工专属分析词：薪资行情/建议/趋势等）
  const analysisKw = ["行情", "一般多少", "多少", "建议", "分析", "趋势", "怎么看", "平均", "怎么样", "区间", "多不多", "合适", "注意什么"];
  const isAnalysis = analysisKw.some((k) => t.includes(k));
  console.log("[recruitAI] detectIntent 分析词命中 =", isAnalysis);

  // 区域：先市后省，"吉林"等重名优先命中市级
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
  const cityCode = city
    ? isProvince
      ? CODES.PROVINCE_CODES[city]
      : CODES.CITY_CODES[city]
    : null;
  console.log("[recruitAI] detectIntent 区域命中 =", city || "无", "| isProvince =", isProvince);

  // 岗位：14 项逐字精确匹配（含 "/" 词，直接 includes 即可命中"短期/顶班"）
  let role = null;
  for (const r of ROLE_OPTIONS) {
    if (t.includes(r)) {
      role = r;
      break;
    }
  }
  console.log("[recruitAI] detectIntent 岗位命中 =", role || "无");

  // 岗位未命中 14 项（含口语"师傅"，如"4000以下的师傅"）→ role=null，查全部招聘岗位（不限师傅），
  // 薪资/城市/时间等条件正常过滤；"师傅"仅作口语，不进岗位条件，也不进模糊查询（extractKeyword 剥离）

  // 工资：数字 + 中文数字，统一转阿拉伯数字
  const salary = parseSalary(t);
  console.log(
    "[recruitAI] detectIntent 工资解析 =",
    JSON.stringify({ salaryMin: salary.salaryMin, salaryMax: salary.salaryMax })
  );

  // 电话/联系：问了联系方式 → 列表突出 phone_masked
  const wantPhone = ["电话", "号码", "联系", "联系方式", "怎么找老板", "找老板"].some((k) => t.includes(k));
  console.log("[recruitAI] detectIntent 电话词命中 =", wantPhone);

  // 数量限制（"10条" → limit=10）
  let limit = null;
  const m = t.match(/(\d{1,2})\s*(?:条|个)/);
  if (m) limit = Math.min(parseInt(m[1], 10) || 10, 20);
  if (m) console.log("[recruitAI] detectIntent 数量限制命中 =", t.slice(m.index, m.index + m[0].length), "→ limit =", limit);

  // 时间范围（今天/昨天/近N天/本周/近一个月/最近）→ published_at 查询下限
  const timeRange = parseTimeRange(t);
  console.log("[recruitAI] detectIntent 时间范围 =", JSON.stringify(timeRange || null));

  // 描述模糊词：扣除已识别成分（岗位/区域/数字/通用词/时间词）后剩余的显著片段
  const keyword = extractKeyword(t, { role, city, timeRange });
  console.log("[recruitAI] detectIntent 描述模糊词 =", keyword || "无");

  // 手机号直通降级：岗位/城市/薪资一个都提不出来时才走"查某手机号对应招工帖"。
  // 招工发布消息几乎必带手机号（"饼类师傅…请联系 138xxxx"），不能让它优先短路发布/查询判断
  const phoneMatch = t.match(/\b1[3-9]\d{9}\b/);
  const hasField = role || city || salary.salaryMin != null || salary.salaryMax != null;
  if (phoneMatch && !hasField) {
    console.log("[recruitAI] detectIntent 纯手机号直查 =", phoneMatch[0]);
    return { type: "phone", phone: phoneMatch[0] };
  }

  return {
    type: isAnalysis ? "analysis" : "list",
    city,
    cityCode,
    isProvince,
    role,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    wantPhone,
    timeRange,
    keyword,
    limit,
  };
}

// ---------- 工资解析 ----------
// 支持：区间（6000-8000 / 六千到八千）、上限（8000以内/以下/不超过）、
//       下限（6000以上/起/至少）、约值（6000左右/裸数字 6000）
// 统一把中文数字替换成阿拉伯数字后，用同一套正则解析。
// 返回 { salaryMin, salaryMax }（可能为 null）
//
// 规则（2026-08-24 简化）：
//   1) 不做 ±10% 换算（不做假区间）：单值输入原样返回 low=high=v，显示"薪资8000元"；
//   2) 手机号从文本里抠掉（替换成空格），不整体 bail out；
//   3) "工资/薪资/月薪/底薪"前缀优先，防止"工作10个小时左右"的 10 抢先匹配；
//   4) 裸数字只认 [3000, 100000] 的有效值，过滤"饭补30""工作10小时"等噪音，
//      即工资最低 3000、最高不超过 100000（与 matchRequiredFields 校验一致）。
function parseSalary(text) {
  // 1. 先把 11 位手机号从文本里抠掉（替换成空格，保留位置关系）
  const t = replaceCnNums(String(text || "").replace(/\b1[3-9]\d{9}\b/g, " "));
  const out = { salaryMin: null, salaryMax: null };

  // 2. 工资前缀优先：工资/薪资/月薪/底薪/待遇/薪酬/报酬 + 纯数字
  //    用负向预查排除后接上限/下限/约值/区间修饰词的情况
  //    （如"工资6000以上"留给第 4 步"下限"模式处理；"工资6000-8000"留给"区间"）
  const prefM = t.match(
    /(?:工资|薪资|月薪|底薪|待遇|薪酬|报酬)\s*(\d{2,7})(?!\s*(?:以上|以内|以下|不超过|不高于|封顶|起|至少|不低于|起步|最低|左右|上下|[~\-—到至]))/
  );
  if (prefM) {
    const v = parseInt(prefM[1], 10);
    out.salaryMin = v;
    out.salaryMax = v;
    return out;
  }

  // 3. 区间：6000-8000 / 6000~8000 / 6000到8000 / 6000至8000
  const rm = t.match(/(\d{2,7})\s*[~\-—到至]\s*(\d{2,7})/);
  if (rm) {
    out.salaryMin = parseInt(rm[1], 10);
    out.salaryMax = parseInt(rm[2], 10);
    return out;
  }

  // 4. 上限词：以内/以下/不超过/不高于/封顶
  const um = t.match(/(\d{2,7})\s*(?:以内|以下|不超过|不高于|封顶)/);
  if (um) {
    out.salaryMax = parseInt(um[1], 10);
    return out;
  }

  // 5. 下限词：以上/往上/起/至少/不低于/起步/最低
  const lm = t.match(/(\d{2,7})\s*(?:以上|往上|起|至少|不低于|起步|最低)/);
  if (lm) {
    out.salaryMin = parseInt(lm[1], 10);
    return out;
  }

  // 6. 约值：6000左右/上下 → 原样返回 6000（不做 ±10% 换算）
  const am = t.match(/(\d{2,7})\s*(?:左右|上下)/);
  if (am) {
    const v = parseInt(am[1], 10);
    out.salaryMin = v;
    out.salaryMax = v;
    return out;
  }

  // 7. 裸数字：取第一个落在 [3000, 100000] 的有效工资数字
  //    过滤掉"工作10小时"中的 10、"饭补30"中的 30 等噪音
  const nums = (t.match(/\d{2,7}/g) || []).map(Number);
  const v = nums.find((n) => n >= 3000 && n <= MAX_SALARY);
  if (v) {
    out.salaryMin = v;
    out.salaryMax = v;
    return out;
  }

  return out;
}

// 中文数字 → 阿拉伯数字："六千"→6000、"一万"→10000、"一万二"→12000、"六千五"→6500
// 注意顺序：先替换"万"再替换"千"，否则"一万二"会被"千"规则拆坏
function replaceCnNums(text) {
  return text
    .replace(/([零一二三四五六七八九两]+)(万)([零一二三四五六七八九两]?)/g, (m, lead, unit, tail) => {
      const l = CN_DIGITS[lead] != null ? CN_DIGITS[lead] : 0;
      const t = tail ? CN_DIGITS[tail] : 0;
      return String(l * 10000 + t * 1000);
    })
    .replace(/([零一二三四五六七八九两]+)(千)([零一二三四五六七八九两]?)/g, (m, lead, unit, tail) => {
      const l = CN_DIGITS[lead] != null ? CN_DIGITS[lead] : 0;
      const t = tail ? CN_DIGITS[tail] : 0;
      return String(l * 1000 + t * 100);
    });
}

// 描述模糊词提取：扣掉已识别成分、时间词和通用词后，剩余 2-12 字的片段作为模糊查询词
function extractKeyword(text, recognized) {
  let rest = stripTimePhrase(text); // 先剥离时间词（"最近/三天/今天"等不参与模糊查）
  if (recognized.role) rest = rest.split(recognized.role).join("");
  if (recognized.city) rest = rest.split(recognized.city).join("");
  // 口语词"师傅"无条件剥离：未命中 14 项岗位时岗位不限（查全部招聘岗位），
  // 若残留"师傅"当 keyword，会把 raw_text/tags 不含"师傅"的岗位（如售卖员、学徒工）全过滤掉
  rest = rest.split("师傅").join(" ");
  // 剥离薪资修饰词："4000以下/以上/以内/左右"中的"以下/以上"不是内容词，
  // 残留进模糊查询会导致只有 raw_text 恰好含这些字的帖子才命中（如"5000以下面议"），先剥掉
  rest = rest.replace(/(?:以上|以下|以内|以外|之外|封顶|不超过|不高于|不低于|左右|上下|起步|最低|最高|至少|往上)/g, " ");

  // 去掉数字及单位词
  rest = rest.replace(/[\d零一二三四五六七八九两万千里元块毛票包月薪]/g, "");

  // 去掉通用词（含分析类虚词，避免"平均价格/行情/一般"污染模糊查询）
  const stopWords = [
    "招", "招聘", "招工", "招人", "有没有", "有吗", "有没", "找", "要", "的", "吗", "呢",
    "请", "帮", "我", "查", "看", "下", "一下", "信息", "消息", "岗位", "工作", "工资", "薪资",
    "电话", "联系", "号码", "怎么", "多少", "哪些", "条", "个", "推荐", "介绍", "看看",
    "吧", "啊", "能", "可以", "想", "问", "在", "是", "和", "与", "跟", "了", "给",
    "都", "有", "什么", "啥", "介绍下", "有没有啊",
    "平均", "价格", "行情", "一般", "趋势", "建议", "分析", "怎么样", "合适", "注意",
  ];
  stopWords.forEach((w) => {
    rest = rest.split(w).join(" ");
  });

  rest = rest.replace(/\s+/g, "").trim();
  return rest.length >= 2 && rest.length <= 12 ? rest : null;
}

// ---------- 时间范围解析（今天/近N天/本周…） ----------
// 返回 { startMs, label } | null；startMs = published_at 查询下限（当天 0 点为界）
function parseTimeRange(text) {
  const t = replaceCnNums(String(text || "")); // "一万"→"10000" 等，统一阿拉伯数字
  const DAY = 86400000;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  if (/今天|今日/.test(t)) return { startMs: todayStart, label: "今天" };
  if (/昨天|昨日/.test(t)) return { startMs: todayStart - DAY, label: "昨天" };

  // 近3天 / 最近7天 / 三天内 / 两周内（支持中文数字，如"三天"）
  const dn = t.match(/(?:近|最近)?([0-9零一二三四五六七八九两]+)\s*(天|日|周)(?:内|之内|以内|以里)?/);
  if (dn) {
    let n = parseInt(dn[1], 10);
    if (isNaN(n)) n = cnDigitsToInt(dn[1]);
    if (dn[2] === "周") n *= 7;
    if (n >= 1 && n <= 90) return { startMs: todayStart - n * DAY, label: `近${dn[1]}${dn[2] === "周" ? "周" : "天"}` };
  }

  if (/本周|这周/.test(t)) {
    const dow = now.getDay() || 7; // 周日=0 → 按 7 算，回到本周一
    return { startMs: todayStart - (dow - 1) * DAY, label: "本周" };
  }
  if (/近一个月|一个月内|近一月|一月内|本月/.test(t)) return { startMs: todayStart - 30 * DAY, label: "近一个月" };
  if (/最近|最新|新发布|新上的/.test(t)) return { startMs: todayStart - 7 * DAY, label: "最近" }; // 无数值 → 默认近 7 天

  return null;
}

// 中文数字 → 整数（用于时间里的"三天/两周"等，不走 replaceCnNums 的万千规则）
function cnDigitsToInt(s) {
  if (s == null || s === "") return NaN;
  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    return (CN_DIGITS[a] || 1) * 10 + (b ? CN_DIGITS[b] || 0 : 0);
  }
  return CN_DIGITS[s] != null ? CN_DIGITS[s] : NaN;
}

// 剥离时间短语：防止"最近/三天/今天"被 extractKeyword 当模糊查询词
function stripTimePhrase(text) {
  return String(text || "")
    .replace(/今天|今日/g, " ")
    .replace(/昨天|昨日/g, " ")
    .replace(/本周|这周/g, " ")
    .replace(/近一个月|一个月内|近一月|一月内|本月/g, " ")
    .replace(/最近|最新|新发布|新上的/g, " ")
    .replace(/(?:近|最近)?[0-9零一二三四五六七八九两]+\s*(?:天|日|周)(?:内|之内|以内|以里)?/g, " ")
    .replace(/\s+/g, " ");
}

// ---------- 查询云数据库（固定招工类型） ----------
async function queryPosts(intent) {
  const query = {
    data_type: "recruit",
    needs_review: _.neq(true),
  };

  // 岗位：仅命中 14 项具体岗位才精确过滤；未命中（含口语"师傅"）→ 不限岗位，查全部招聘岗位，
  // 薪资/城市/时间等条件正常过滤（"4000以下的师傅" → 全部岗位 salary_high ≤ 4000）
  if (intent.role) {
    query.role = intent.role;
  }

  // 工资：salary_high 为数值字段（面议记录无此字段，天然排除）
  // 注意：上下限必须用 _.and 合并成一个条件，否则后写的会覆盖前者（区间被吞）
  if (intent.salaryMin != null && intent.salaryMax != null) {
    query.salary_high = _.and(_.gte(intent.salaryMin), _.lte(intent.salaryMax));
  } else if (intent.salaryMin != null) {
    query.salary_high = _.gte(intent.salaryMin);
  } else if (intent.salaryMax != null) {
    query.salary_high = _.lte(intent.salaryMax);
  }

  // 时间范围（今天/近N天/本周…）→ published_at 为数字时间戳，直接 gte 下限
  if (intent.timeRange && intent.timeRange.startMs != null) {
    query.published_at = _.gte(intent.timeRange.startMs);
  }

  // 区域 + 描述模糊：合并成一个 or
  const ors = [];
  if (intent.cityCode) {
    if (intent.isProvince) {
      query.province_code = intent.cityCode;
    } else {
      // 市级：city_code / district_code 精确匹配 + city 字段文本正则兜底（防历史脏数据 code 缺失/写错）
      ors.push({ city_code: intent.cityCode }, { district_code: intent.cityCode });
      if (intent.city) ors.push({ city: db.RegExp({ regexp: escapeRe(intent.city), options: "i" }) });
    }
  }
  if (intent.keyword) {
    const re = db.RegExp({ regexp: intent.keyword, options: "i" });
    ors.push({ raw_text: re }, { tags: re }, { address: re });
  }
  if (ors.length) query._ = db.command.or(ors);

  const limit = intent.limit || 10;
  // ---- 日志：本次查询的完整条件 ----
  console.log("[recruitAI] queryPosts 条件 =", JSON.stringify(query));
  console.log("[recruitAI] queryPosts limit =", limit, "| orderBy = published_at desc");

  const res = await db
    .collection("baozi_posts")
    .where(query)
    .orderBy("published_at", "desc")
    .limit(limit)
    .get();
  console.log("[recruitAI] queryPosts 命中条数 =", (res.data || []).length);
  return res.data || [];
}

// RegExp 特殊字符转义，防止用户输入里的 . * + ? 等破坏正则
function escapeRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- 格式化单条招工记录 ----------
function formatPost(p, i, wantPhone) {
  const province = p.province || "";
  const city = p.city || "";
  const loc =
    province && city
      ? province === city
        ? city
        : `${province} ${city}`
      : province || city || "未知地区";

  const parts = [];
  if (p.published_at) parts.push(fmtAgo(p.published_at)); // "今天" / "3天前"
  parts.push(`${i + 1}. ${loc}`);

  if (p.role) parts.push("岗位:" + p.role);
  if (p.salary_high) parts.push("薪资" + p.salary_high + "元");
  else if (p.salary_note) parts.push("薪资" + p.salary_note);
  else parts.push("薪资面议");
  if (p.address) parts.push("地址:" + p.address);
  if (p.contact) parts.push("联系人:" + p.contact);
  if (Array.isArray(p.tags) && p.tags.length) parts.push("[" + p.tags.join("·") + "]");
  if (p.raw_text) parts.push((p.raw_text || "").slice(0, 60));

  // 电话：问了联系方式就提到最前，否则放最后
  const phone = p.phone_masked || "";
  if (wantPhone) parts.unshift("电话:" + phone);
  else if (phone) parts.push(phone);

  return parts.join(" | ");
}

// 相对时间："今天" / "昨天" / "N天前" / "N个月前" / "N年前"
function fmtAgo(ts) {
  if (!ts) return "";
  const DAY = 86400000;
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (ts >= todayStart) return "今天";
  const days = Math.floor((todayStart - ts) / DAY);
  if (days <= 1) return "昨天";
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

// ---------- 招工专属引导语 ----------
function buildGuide() {
  return (
    "我是招工顾问，帮你查包子店招聘信息、师傅薪资行情。\n\n" +
    "试试这样问：\n" +
    '· "上海有哪些包子店在招工"（直接出列表）\n' +
    '· "招大师傅的" / "有没有阿姨岗位"（按岗位筛）\n' +
    '· "工资6000以上的" / "六千到八千的"（按工资筛）\n' +
    '· "包吃住的有没有"（模糊查描述）\n' +
    '· "师傅工资一般多少"（AI 分析薪资行情）'
  );
}

// ---------- 工具 ----------
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

// ---------- 分析类：真实统计 + 结构化块（招工专属） ----------
function wan(v) {
  if (v == null) return "";
  return v >= 10000
    ? v % 10000 === 0
      ? v / 10000 + "万"
      : (v / 10000).toFixed(1) + "万"
    : String(v);
}

// 岗位 emoji：与 ROLE_OPTIONS 14 项对应
const ROLE_EMOJI = {
  大师傅: "👨🍳",
  夫妻工: "👫",
  "短期/顶班": "⏱️",
  售卖员: "🛎️",
  学徒工: "🧑🍳",
  小笼包师傅: "🥟",
  饼类师傅: "🥮",
  二把手: "🍳",
  油炸类师傅: "🍤",
  中工: "👨🍳",
  生煎类师傅: "🍳",
  全能面点大师: "👨🍳",
  工厂: "🏭",
  其他类型: "📦",
};

// 提取招工帖子的 [low, high] 月薪区间；面议/无薪资（0 或缺字段）返回 null
function pickNum(p) {
  if (p.salary_low > 0) return [p.salary_low, p.salary_high > 0 ? p.salary_high : p.salary_low];
  return null;
}

// 服务端真实统计：样本量 / 月薪中位数 / 最高 / 岗位薪资条形图
function buildStats(posts, intent) {
  if (!posts.length) return null;
  const nums = posts.map((p) => pickNum(p)).filter(Boolean);
  const highs = nums.map((r) => r[1]).sort((a, b) => a - b);
  const median = highs.length ? highs[Math.floor(highs.length / 2)] : 0;
  const max = highs.length ? highs[highs.length - 1] : 0;
  const stats = {
    count: posts.length,
    median,
    max,
    medianText: wan(median),
    maxText: wan(max),
  };
  // 岗位条形图：按 role 聚合薪资区间，取平均
  const byRole = {};
  posts.forEach((p) => {
    if (!p.role) return;
    const r = pickNum(p);
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
  return stats;
}

// 组装结构化块：标题 → KPI → 条形图 → 案例占位（前端挂卡片）
function buildBlocks(intent, stats) {
  const cityLabel = intent.city ? intent.city + "的" : "";
  const blocks = [];
  blocks.push({ type: "head", text: `${cityLabel}招工行情` });
  if (stats) {
    blocks.push({
      type: "kpi",
      items: [
        { label: "匹配岗位", value: String(stats.count), unit: "条" },
        { label: "月薪中位数", value: stats.medianText, unit: "元" },
        { label: "月薪最高", value: stats.maxText, unit: "元" },
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
    .map((p, i) => `${i + 1}. ${formatPost(p, i, false)}`)
    .join("\n");
  const systemPrompt =
    "你是包子行业招工资讯分析师。请根据【统计事实】和【代表案例】，用不超过150字写一段'洞察与建议'。" +
    "要求：1) 只能引用统计事实中的数字，禁止编造；2) 2-4个短句，平实口语；" +
    "3) 纯文本，禁止任何 Markdown 符号（#、**、表格、列表标记）；" +
    "4) 内容侧重：数字反映的薪资趋势 + 对求职师傅的实用建议。\n\n" +
    `【统计事实】${JSON.stringify({
      count: stats.count,
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
  if (!stats) return `${c}暂时没有匹配的招工信息，换个城市、岗位或工资条件再试试。`;
  return `${c}共收录 ${stats.count} 条招工信息，月薪中位数约 ${stats.medianText} 元，最高 ${stats.maxText} 元。面议岗位未计入统计，建议求职时问清包吃住与月休天数。`;
}

// 分析回答末尾的引导追问芯片
function buildChips(intent) {
  const c = intent.city ? intent.city : " ";
  return [
    `${c}有哪些包子店在招工`,
    `${c}大师傅工资一般多少`,
    "招工要注意什么",
  ];
}
