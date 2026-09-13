// cloudfunctions/adminChat/index.js
// 包子行业信息平台 · 管理员 AI 对话（后台数据查询与运营反馈）
//
// 与 C 端 aiChat 的区别：
//   1) 面向管理员，可查【全量数据】：含待审核(approved=false)、已下架(status=offline)的帖子，
//      以及用户/会员/订单/商家/置顶/操作日志等管理视角数据。
//   2) 返回结构化 blocks（非拼接文本），前端自定义卡片渲染，视觉美观。
//   3) 支持口令校验（环境变量 ADMIN_USER / ADMIN_PASS，未配置时回落 admin/admin，与 adminAuth 一致）。
//
// 入参：
//   { question: "今天有多少待审核帖子", user, pass }
//
// 返回：
//   { success: true, title, blocks: [{type, ...}], intent }
//   blocks 元素类型：
//     { type:'title',   text }                                 主标题
//     { type:'kpi',     items:[{label,value,unit,color}] }      数字统计卡
//     { type:'section', title }                                 小节标题
//     { type:'list',    items:[{text,sub,tag,tagColor}] }       列表行
//     { type:'text',    text }                                  纯文本
//     { type:'empty',   text }                                  空态

const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CODES = require("./cityCodes.js");
const CITIES = Object.keys(CODES.CITY_CODES);
const PROVINCES = Object.keys(CODES.PROVINCE_CODES);

const COLLECTION = "baozi_posts";
const USERS = "baozi_users";
const PAY_ORDERS = "baozi_pay_orders";
const MERCHANTS = "baozi_merchants";
const TOPS = "baozi_post_tops";
const LOGS = "admin_logs";
const AI_MEMORY = "admin_ai_memory"; // 管理员 AI 共享记忆（偏好/纠正/别名）
const AI_LEARNING_LOG = "admin_ai_learning_log"; // 管理员 AI 学习流水（每次学习动作一条，便于审计/debug）
const ADS = "advertisements"; // 广告运营位（首页轮播图/Banner/信息流/弹窗）

// 广告位中文名映射（供 AI 总结和列表展示）
const AD_SLOT_NAMES = {
  home_banner: "首页轮播图",
  home_banner_card: "首页Banner卡",
  recruit_banner: "招工频道轮播图",
  recruit_feed: "招工频道信息流广告",
  home_feed: "首页信息流广告",
  global_popup: "全局弹窗",
};

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

/**
 * 统一「小程序端」管理员判定（C 端 openid 通道），与 adminAuth.check_admin / wxTask 口径一致：
 *   ① 环境变量 ADMIN_OPENIDS 白名单命中 → 是
 *   ② 未命中 → 查 baozi_users.role === 'admin'
 * 说明：adminChat 是「管理员 AI 助手」，同时服务后台 Web（账密）与小程序（openid）两条调用路径，
 *       所以两套判定都要有；判定入口见 exports.main。
 */
async function isAdminOpenid(openid) {
  if (!openid) return false;
  const wl = String(process.env.ADMIN_OPENIDS || "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (wl.includes(openid)) return true;
  try {
    const r = await db
      .collection(USERS)
      .where({ openid_wxapp: openid, role: "admin" })
      .limit(1)
      .get();
    return !!(r.data && r.data.length);
  } catch (e) {
    console.error("[adminChat] isAdminOpenid 查 role 失败:", e && e.errMsg);
    return false;
  }
}

const TYPE_NAMES = {
  recruit: "招工", jobseek: "求职", transfer: "转让", want_shop: "求店",
  equip_sell: "设备出售", equip_buy: "设备求购", carpool_car: "车找人",
  carpool_person: "人找车", other: "其他",
};
const ALL_TYPES = Object.keys(TYPE_NAMES);

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ==================== AI 接管模式：系统能力文档 ====================
// 喂给 DeepSeek 的"能力说明书"，让它理解整个后台系统能查什么、怎么调用、返回什么。
// 每次新增查询能力时，务必同步更新此文档（也有一份给人看的 docs/adminChat-能力文档.md）。
const SYSTEM_CAPABILITY_DOC = `你是「包子一哥传媒」微信小程序的【后台管理 AI 助手】，服务对象是平台管理员。
管理员会用自然语言询问平台运营数据、帖子、用户、订单等信息。

【你的工作方式】
你不需要直接查数据库。你只需要：判断管理员想要什么，然后输出一个 JSON「调用指令」，
后端程序会执行真实查询，再把真实结果交给你做总结。你绝不编造数据。

【必须遵守】
1. 只输出一个 JSON 对象，不要 Markdown、不要解释、不要前后缀、不要代码块。
2. 绝不编造任何数字或事实，只能引用后端返回给你的真实数据。
3. 数据为空时如实说「暂无数据」，不要硬凑。
4. 用中文回复。

【你拥有的工具（一次只能选一个）】
1. stats    平台数据概览。入参 {}。返回：帖子总数/待审核数/已下架数/用户总数/今日新增/会员数/订单数/商家数，及各类型帖子数量分布。
2. pending  待审核帖子列表。入参 {page:1}。返回待审核帖子（每页5条），每条含标题/类型/地区/价格/脱敏电话/审核状态。
3. offline  已下架帖子列表。入参 {page:1}。
4. search   按条件搜帖子。入参 {dataType,city,keyword,salaryMin,salaryMax,priceMin,priceMax,rentMin,rentMax,timeWithinDays,auditState,limit,page} 都可选。dataType见下方枚举；city为中文城市名不带"市"字；keyword匹配标题/岗位/联系人/用户名/地址；salaryMin/salaryMax为薪资范围（元）；priceMin/priceMax为转让费/价格范围（元）；rentMin/rentMax为月租范围（元/月）；timeWithinDays为最近多少天内发布（整数天数）；auditState为审核状态（approved=已过审/pending=待审/offline=已下架）。
5. phone    按手机号反查。入参 {phone:"11位手机号"}。返回该号码发布的帖子（含待审/已过审/已下架）。
6. users    最近注册用户。入参 {}。返回昵称/脱敏手机号/会员状态(会员/普通/已封禁)。
7. orders   支付订单。入参 {page:1}。返回业务类型(查看电话/开会员/擦亮/置顶/商家入驻)/金额/状态(待支付/已支付/已履约)/付款人/订单号/关联帖子。
8. merchants 商家入驻申请。入参 {}。返回名称/套餐/是否已付费。
9. tops     置顶帖子。入参 {dataType,page} 都可选。dataType为信息类型（见下方枚举），可只查某类型的置顶（如"招工的置顶"→dataType="recruit"）；不传则查全部置顶。返回标题/类型/到期时间。
10. logs    操作日志。入参 {}。返回操作类型/详情/时间。
11. ads     广告列表。入参 {slot,status,page} 都可选。slot为广告位（见下方枚举）；status为 online(已上线)/offline(已下线)。返回每条的标题/广告位/类型/上下线状态/是否在有效期。
12. adToggle 广告上下线。入参 {op,adTitle,slot,adId}。op="offline"下线 / op="online"上线。定位广告的方式（按优先级）：① adId（精确ID）；② adTitle（广告标题关键词，如"包子快讯"）；③ slot（广告位）。**重要**：用户说的具体广告名字（如"包子快讯""包友群"）是【标题】→ 填 adTitle；只有用户明确说"首页轮播图""全局弹窗"这类【广告位】时才填 slot。例：{"tool":"adToggle","args":{"op":"offline","adTitle":"包子快讯"}}。
13. answer  纯文本回复（不查库）。入参 {text:"直接回复的中文内容"}。用于闲聊/解释/给建议。

【广告位 slot 枚举】
home_banner=首页轮播图, home_banner_card=首页Banner卡, recruit_banner=招工频道轮播图, recruit_feed=招工频道信息流广告, home_feed=首页信息流广告, global_popup=全局弹窗

【信息类型 dataType 枚举】
recruit=招工, jobseek=求职, transfer=转让, want_shop=求店, equip_sell=设备出售, equip_buy=设备求购, carpool_car=车找人, carpool_person=人找车, other=其他

【各维度数值如何理解（重要）】
你要根据管理员话里的关键词，判断数字属于哪个维度，再换算成对应字段（单位统一为"元"）：
1. 薪资/工资/月薪 → salaryMin/salaryMax
   - "8000以内/以下/不超过8000" → salaryMax=8000
   - "8000以上/起/至少8000" → salaryMin=8000
   - "8000左右/上下/大概8000/七八千" → salaryMin≈7000, salaryMax≈9000
2. 转让费/转让价格/价格 → priceMin/priceMax
   - "转让费20-25万" → priceMin=200000, priceMax=250000
   - "转让费20万以内" → priceMax=200000
3. 租金/月租/房租 → rentMin/rentMax
   - "租金10000以下" → rentMax=10000
   - "月租3000以内" → rentMax=3000
4. 时间 → timeWithinDays（用"多少天内"的整数表示，不要自己算时间戳）
   - "今天" → timeWithinDays=1
   - "昨天/最近2天" → timeWithinDays=2
   - "最近3天" → timeWithinDays=3
   - "这周/最近7天" → timeWithinDays=7
   - "最近一个月" → timeWithinDays=30
   - 没有时间限定 → 不填 timeWithinDays
5. 审核状态 → auditState
   - "待审核/待审/未审核" → auditState=pending
   - "已过审/已通过/审核通过" → auditState=approved
   - "已下架/下架的" → auditState=offline
6. 通用规则：
   - "万"换算成元（"20万"=200000，"1.5万"=15000）
   - 区间"X到Y / X-Y / X~Y" → min=X, max=Y
   - 模糊"左右/上下/大概" → 取±10%左右的区间（如"8000左右"→7000~9000）
   - 数字是查询条件，不要当成 keyword 关键词
   - 若同一句里同时有薪资和转让费，分别填 salary* 和 price*，不要混淆

【判断优先级】
手机号→phone；统计概览→stats；待审→pending；下架→offline；订单收入→orders；用户会员→users；商家→merchants；置顶→tops；日志→logs；看广告/查广告列表→ads；下线广告/上线广告/开关广告→adToggle；按城市/类型/关键词找帖子→search；闲聊解释建议→answer；拿不准→stats。

【纠正识别（越用越懂，必须遵守）】
管理员的话如果是在【纠正你 / 教你长期规则】（即定义"某个说法以后该怎么理解"），
你必须【同时】做两件事：① 选一个 tool（通常 answer 或 search）给出回应；② 在 JSON 里【额外带 correction 字段】。
⚠️ 绝不能只口头说"已记住"却漏掉 correction 字段——后端靠 correction 字段才能真正记住规则。
- 判断标准（靠语义理解）：
  长期规则（要记）→ 定义词义/说法，如"以后'收店'就是'求店'"、"师傅默认指大师傅"、"收店=求店"、"以后叫'转店'的都是转让"。
  临时修正（不记）→ 只是本次查错方向，如"不对，我要的是深圳不是广州"。
- correction 结构：
  {"isRule": true, "alias": {"from": "收店", "to": "want_shop"}}
  isRule：true=要长期记住的规则别名；若不是规则纠正，则【整个 correction 字段都不要输出】。
  alias.from：管理员的口头说法/别名（短词，如"收店"）。
  alias.to：该别名对应的【标准 dataType 枚举值】，必须从上面"信息类型 dataType 枚举"里选
    （求店→want_shop、转让→transfer、招工→recruit、求职→jobseek、车找人→carpool_car、人找车→carpool_person、设备出售→equip_sell、设备求购→equip_buy）。
  **关键**：alias.to 无法归一化到上述枚举值时，不要输出 correction 字段。
- 完整示例（注意 tool 和 correction 同时出现）：
  输入"以后收店就是求店"
  输出 {"tool":"answer","args":{"text":"已记住：收店=求店"},"correction":{"isRule":true,"alias":{"from":"收店","to":"want_shop"}}}

【输出格式示例】
{"tool":"search","args":{"dataType":"recruit","city":"深圳","limit":5}}
{"tool":"phone","args":{"phone":"13800138000"}}
{"tool":"answer","args":{"text":"可以点「待审核帖子」查看。"}}`;

// 包子行业黑话/管理员习惯用语对齐表（静态，让 AI 更懂行话）
const DOMAIN_GLOSSARY = [
  "「师傅」通常指「大师傅」岗位",
  "「顶班」=「短期顶班」",
  "「夫妻工」= 两人一起求职/上岗",
  "「擦亮」= 帖子刷新/重新置顶曝光",
  "「看板」= 平台数据概览(stats)",
  "「收店」= 求店/找店(want_shop)",
  "「转店」= 转让(transfer)",
  "「车找人」= carpool_car，「人找车」= carpool_person",
];

// ---------- 意图识别（规则版） ----------
function detectIntent(text, page) {
  const t = text || "";
  const out = { type: "search", dataType: null, city: null, cityCode: null, isProvince: false, keyword: "", limit: 10, page: Math.max(1, parseInt(page, 10) || 1) };

  // 手机号识别（优先级最高，独立于类型判断）
  const phoneMatch = t.match(/1[3-9]\d{9}/);
  if (phoneMatch) out.phone = phoneMatch[0];

  for (const c of CITIES) { if (t.includes(c)) { out.city = c; break; } }
  if (!out.city) {
    for (const p of PROVINCES) { if (t.includes(p)) { out.city = p; out.isProvince = true; break; } }
  }
  if (out.city) {
    out.cityCode = out.isProvince ? CODES.PROVINCE_CODES[out.city] : CODES.CITY_CODES[out.city];
  }

  if (/求职|找工作|师傅求职/.test(t)) out.dataType = "jobseek";
  else if (/求店|找店/.test(t)) out.dataType = "want_shop";
  else if (/转让|转店|铺子/.test(t)) out.dataType = "transfer";
  else if (/设备出售|卖设备|出售设备/.test(t)) out.dataType = "equip_sell";
  else if (/设备求购|买设备|求购设备/.test(t)) out.dataType = "equip_buy";
  else if (/车找人/.test(t)) out.dataType = "carpool_car";
  else if (/人找车/.test(t)) out.dataType = "carpool_person";
  else if (/招工|招聘|招师傅/.test(t)) out.dataType = "recruit";
  else if (/其他/.test(t)) out.dataType = "other";

  if (out.phone) out.type = "phone";
  else if (/统计|看板|概览|总览|多少条|总数|数据统计|dashboard/i.test(t)) out.type = "stats";
  else if (/待审核|待审|未审核|审核/.test(t)) out.type = "pending";
  else if (/用户|会员|注册/.test(t)) out.type = "users";
  else if (/订单|支付|付费|收入|流水/.test(t)) out.type = "orders";
  else if (/商家|入驻/.test(t)) out.type = "merchants";
  else if (/置顶/.test(t)) out.type = "tops";
  else if (/日志|操作记录/.test(t)) out.type = "logs";
  else if (/广告|轮播|banner|弹窗/i.test(t)) out.type = "ads";
  else if (/下架|已下线|offline/.test(t)) out.type = "offline";
  else out.type = "search";

  const m = t.match(/(\d{1,2})\s*(?:条|个|篇)/);
  if (m) out.limit = Math.min(parseInt(m[1], 10) || 10, 50);

  const kwMatch = t.match(/["「](.+?)["」]/);
  out.keyword = kwMatch ? kwMatch[1].trim() : "";

  return out;
}

// ---------- 查询帖子（全量，含待审/下架） ----------
async function queryPosts(intent) {
  const conds = [];
  if (intent.dataType) conds.push({ data_type: intent.dataType });

  if (intent.type === "pending") conds.push({ approved: _.neq(true) });
  else if (intent.type === "offline") conds.push({ status: "offline" });
  else conds.push({});

  if (intent.cityCode) {
    if (intent.isProvince) {
      conds.push({ province_code: intent.cityCode });
    } else {
      conds.push(_.or([
        { city_code: intent.cityCode },
        { district_code: intent.cityCode },
        { city: db.RegExp({ regexp: escapeReg(intent.city), options: "i" }) },
      ]));
    }
  }
  if (intent.keyword) {
    const rx = db.RegExp({ regexp: escapeReg(intent.keyword), options: "i" });
    conds.push(_.or([{ raw_text: rx }, { role: rx }, { contact: rx }, { username: rx }, { address: rx }]));
  }
  // 薪资范围过滤：salaryMin / salaryMax 都是数字（元）
  // recruit 的 salary=给价、jobseek 的 salary=期望薪资，语义各自贴切，统一按 salary 过滤
  // 关键：salary=0 表示"面议/无明确薪资"，必须排除（否则"8000以内"会误把 0 也算进来）
  if (intent.salaryMin != null || intent.salaryMax != null) {
    const ranges = [{ salary: _.gt(0) }];
    if (intent.salaryMin != null) ranges.push({ salary: _.gte(Number(intent.salaryMin)) });
    if (intent.salaryMax != null) ranges.push({ salary: _.lte(Number(intent.salaryMax)) });
    conds.push(ranges.length === 1 ? ranges[0] : _.and(ranges));
  }
  // 转让费/价格范围过滤（transfer 等类型的 price 字段，单位元）
  if (intent.priceMin != null || intent.priceMax != null) {
    const ranges = [{ price: _.gt(0) }];
    if (intent.priceMin != null) ranges.push({ price: _.gte(Number(intent.priceMin)) });
    if (intent.priceMax != null) ranges.push({ price: _.lte(Number(intent.priceMax)) });
    conds.push(ranges.length === 1 ? ranges[0] : _.and(ranges));
  }
  // 月租范围过滤（monthly_rent 字段，单位元/月）
  if (intent.rentMin != null || intent.rentMax != null) {
    const ranges = [{ monthly_rent: _.gt(0) }];
    if (intent.rentMin != null) ranges.push({ monthly_rent: _.gte(Number(intent.rentMin)) });
    if (intent.rentMax != null) ranges.push({ monthly_rent: _.lte(Number(intent.rentMax)) });
    conds.push(ranges.length === 1 ? ranges[0] : _.and(ranges));
  }
  // 时间范围过滤（published_at 毫秒时间戳）
  if (intent.timeMin != null) conds.push({ published_at: _.gte(Number(intent.timeMin)) });
  if (intent.timeMax != null) conds.push({ published_at: _.lte(Number(intent.timeMax)) });
  // 审核状态过滤：approved=true 已过审 / false 待审；status=offline 已下架
  if (intent.auditState === "approved") conds.push({ approved: true });
  else if (intent.auditState === "pending") conds.push({ approved: _.neq(true) });
  else if (intent.auditState === "offline") conds.push({ status: "offline" });

  const query = conds.length === 1 ? conds[0] : _.and(conds);

  // 总数（分页需要）
  let total = 0;
  try {
    total = (await db.collection(COLLECTION).where(query).count()).total;
  } catch (e) {
    total = 0;
  }

  // 分页：page 从 1 开始，pageSize 默认 5
  const page = Math.max(1, parseInt(intent.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(intent.pageSize, 10) || 5));
  const res = await db.collection(COLLECTION)
    .where(query)
    .orderBy("published_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return { list: res.data || [], total, page, pageSize };
}

// 帖子 → 列表行对象
function postToItem(p) {
  const typeName = TYPE_NAMES[p.data_type] || "信息";
  const loc = [p.province, p.city, p.district].filter(Boolean).join(" ");
  const price = Number(p.salary) > 0 ? `${p.salary}元/月` : (Number(p.price) > 0 ? `${p.price}元` : "");
  const title = String(p.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 36);
  const tag = p.approved === true ? "已过审" : "待审";
  const tagColor = p.approved === true ? "success" : "warning";
  return {
    id: p._id,
    type: p.data_type, // 帖子类型（编辑跳转用）
    pending: p.approved !== true, // 是否待审核（前端据此显示审核按钮）
    text: `【${typeName}】${title}`,
    sub: [loc || "未知地区", price, p.phone_masked || ""].filter(Boolean).join(" · "),
    tag,
    tagColor,
    detail: buildDetailText(p, typeName),
  };
}

// 帖子完整信息（排好版，供复制）
function buildDetailText(p, typeName) {
  const lines = [];
  lines.push(`【${typeName}】`);
  if (p.role) lines.push(`岗位/类型：${p.role}`);
  if (Number(p.salary) > 0) lines.push(`薪资：${p.salary} 元/月`);
  if (Number(p.price) > 0) lines.push(`价格/转让费：${p.price} 元`);
  const region = [p.province, p.city, p.district].filter(Boolean).join("");
  if (region) lines.push(`地区：${region}`);
  if (p.address) lines.push(`地址：${p.address}`);
  if (p.contact) lines.push(`联系人：${p.contact}`);
  if (p.phone) lines.push(`电话：${p.phone}`);
  if (p.phone_masked) lines.push(`电话(脱敏)：${p.phone_masked}`);
  // 类型专属字段
  if (p.monthly_rent > 0) lines.push(`月租：${p.monthly_rent} 元/月`);
  if (p.area_sqm > 0) lines.push(`面积：${p.area_sqm} ㎡`);
  if (p.daily_revenue > 0) lines.push(`日营业额：${p.daily_revenue} 元/天`);
  if (p.rent_max > 0) lines.push(`租金上限：${p.rent_max} 元/月`);
  if (p.area_min > 0) lines.push(`面积下限：${p.area_min} ㎡`);
  if (p.cond > 0) lines.push(`成色：${p.cond} 成新`);
  if (p.salary_expect > 0) lines.push(`期望薪资：${p.salary_expect} 元/月`);
  if (p.availability) lines.push(`到岗方式：${p.availability}`);
  if (p.service_area) lines.push(`可服务地区：${p.service_area}`);
  if (p.from_place && p.to_place) lines.push(`行程：${p.from_place} → ${p.to_place}`);
  if (p.depart_time) lines.push(`出发时间：${p.depart_time}`);
  if (p.seats > 0) lines.push(`可乘人数：${p.seats}`);
  const raw = String(p.raw_text || "").trim();
  if (raw) lines.push(`描述：${raw}`);
  return lines.join("\n");
}

// ---------- 各意图处理（返回 {title, blocks}） ----------
async function handleStats() {
  const out = {};
  const day = 86400000;
  const now = Date.now();
  try { out.posts_total = (await db.collection(COLLECTION).count()).total; } catch (e) { out.posts_total = 0; }
  try { out.pending = (await db.collection(COLLECTION).where({ approved: _.neq(true) }).count()).total; } catch (e) { out.pending = 0; }
  try { out.offline = (await db.collection(COLLECTION).where({ status: "offline" }).count()).total; } catch (e) { out.offline = 0; }
  try { out.users_total = (await db.collection(USERS).count()).total; } catch (e) { out.users_total = 0; }
  try { out.users_new_today = (await db.collection(USERS).where({ created_at: _.gte(now - day) }).count()).total; } catch (e) { out.users_new_today = 0; }
  try { out.vip = (await db.collection(USERS).where({ membership: "vip" }).count()).total; } catch (e) { out.vip = 0; }
  try { out.orders = (await db.collection(PAY_ORDERS).count()).total; } catch (e) { out.orders = 0; }
  try { out.merchants = (await db.collection(MERCHANTS).count()).total; } catch (e) { out.merchants = 0; }

  const byType = {};
  for (const t of ALL_TYPES) {
    try { byType[t] = (await db.collection(COLLECTION).where({ data_type: t }).count()).total; } catch (e) { byType[t] = 0; }
  }

  const blocks = [
    { type: "title", text: "平台数据概览" },
    {
      type: "kpi",
      items: [
        { label: "帖子总数", value: String(out.posts_total), unit: "条", color: "#597EF7" },
        { label: "待审核", value: String(out.pending), unit: "条", color: "#FA8C16" },
        { label: "用户", value: String(out.users_total), unit: "人", color: "#36CFC9" },
        { label: "支付订单", value: String(out.orders), unit: "笔", color: "#9254DE" },
        { label: "商家", value: String(out.merchants), unit: "家", color: "#FF7A45" },
      ],
    },
    { type: "section", title: "各类型帖子分布" },
    {
      type: "list",
      items: ALL_TYPES.map((t) => ({
        text: TYPE_NAMES[t],
        sub: `${byType[t]} 条`,
        tag: String(byType[t]),
        tagColor: byType[t] > 0 ? "primary" : "default",
      })),
    },
  ];
  return { title: "平台数据概览", blocks };
}

function buildPagination(total, page, pageSize) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return { total, page, pageSize, pageCount };
}

// 通用分页列表查询：统一"先查 pageSize 条 + count 总数"，避免一次性全查。
// 参数：{ collection, where(可选), orderField(可选), orderDir='desc', page, pageSize=5, mapFn }
// 返回：{ list(原始数据), items(mapFn 结果), pagination }
async function pagedList({ collection, where, orderField, orderDir = "desc", page = 1, pageSize = 5, mapFn }) {
  let q = where ? db.collection(collection).where(where) : db.collection(collection);
  if (orderField) q = q.orderBy(orderField, orderDir);

  let total = 0;
  try { total = (await q.count()).total; } catch (e) { total = 0; }

  const p = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(50, Math.max(1, parseInt(pageSize, 10) || 5));
  const list = (await q.skip((p - 1) * size).limit(size).get()).data || [];

  const items = mapFn ? list.map(mapFn) : list;
  return { list, items, pagination: buildPagination(total, p, size) };
}

async function handlePending(intent) {
  const { list, total, page, pageSize } = await queryPosts(Object.assign({}, intent, { type: "pending" }));
  if (!list.length) {
    return { title: "待审核帖子", blocks: [{ type: "empty", text: "暂无待审核帖子，当前均已通过审核" }] };
  }
  return {
    title: `待审核帖子`,
    blocks: [{ type: "list", items: list.map(postToItem), pagination: buildPagination(total, page, pageSize) }],
  };
}

async function handleOffline(intent) {
  const { list, total, page, pageSize } = await queryPosts(Object.assign({}, intent, { type: "offline" }));
  if (!list.length) {
    return { title: "已下架帖子", blocks: [{ type: "empty", text: "暂无已下架帖子" }] };
  }
  return {
    title: `已下架帖子`,
    blocks: [{ type: "list", items: list.map(postToItem), pagination: buildPagination(total, page, pageSize) }],
  };
}

async function handleSearch(intent) {
  const { list, total, page, pageSize } = await queryPosts(intent);
  if (!list.length) {
    return { title: "查询结果", blocks: [{ type: "empty", text: "未找到匹配数据，换个条件试试" }] };
  }
  const typeLabel = intent.dataType ? TYPE_NAMES[intent.dataType] : "";
  const cityLabel = intent.city ? intent.city + "的" : "";
  return {
    title: `${cityLabel}${typeLabel}信息`,
    blocks: [{ type: "list", items: list.map(postToItem), pagination: buildPagination(total, page, pageSize) }],
  };
}

async function handleUsers(intent) {
  const now = Date.now();
  const { items, pagination } = await pagedList({
    collection: USERS,
    orderField: "created_at",
    page: intent && intent.page,
    pageSize: 5,
    mapFn: (u) => {
      const isVip = u.membership === "vip" && Number(u.membership_expire_at) > now;
      const phone = u.phone_masked || u.phone || "未绑定";
      return {
        text: u.username || "未设置昵称",
        sub: phone,
        tag: isVip ? "会员" : (u.status === "banned" ? "已封禁" : "普通"),
        tagColor: isVip ? "warning" : (u.status === "banned" ? "danger" : "default"),
      };
    },
  });
  if (!items.length) {
    return { title: "用户列表", blocks: [{ type: "empty", text: "暂无用户数据" }] };
  }
  return { title: "用户列表", blocks: [{ type: "list", items, pagination }] };
}

async function handleOrders(intent) {
  const statusMap = { pending: "待支付", paid: "已支付", fulfilled: "已履约" };
  const statusColor = { pending: "warning", paid: "primary", fulfilled: "success" };
  const bizMap = { phone: "查看电话", member: "开会员", refresh: "擦亮", top: "置顶", merchant: "商家入驻" };

  // 总数 + 分页
  let total = 0;
  try { total = (await db.collection(PAY_ORDERS).count()).total; } catch (e) { total = 0; }
  const page = Math.max(1, parseInt(intent.page, 10) || 1);
  const pageSize = 5;
  const orders = (await db.collection(PAY_ORDERS)
    .orderBy("created_at", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()).data || [];

  if (!orders.length) {
    return { title: "支付订单", blocks: [{ type: "empty", text: "暂无支付订单" }] };
  }

  // 批量回查：只查本页涉及的 post_id 和 openid，各一次 in 查询（省 N 次单条读）
  const postIds = orders.map((o) => o.post_id).filter(Boolean);
  const openids = orders.map((o) => o.openid).filter(Boolean);

  const postMap = {};
  if (postIds.length) {
    try {
      const r = await db.collection(COLLECTION)
        .where({ _id: _.in(postIds) })
        .field({ _id: true, data_type: true, raw_text: true, city: true })
        .get();
      (r.data || []).forEach((p) => { postMap[p._id] = p; });
    } catch (e) { /* ignore */ }
  }

  const userMap = {};
  if (openids.length) {
    try {
      const r = await db.collection(USERS)
        .where({ openid_wxapp: _.in(openids) })
        .field({ openid_wxapp: true, username: true, phone: true })
        .get();
      (r.data || []).forEach((u) => { userMap[u.openid_wxapp] = u; });
    } catch (e) { /* ignore */ }
  }

  return {
    title: `最近支付订单`,
    blocks: [{
      type: "list",
      items: orders.map((o) => {
        const biz = bizMap[o.biz_type] || o.title || o.biz_type || "订单";
        const amount = Number(o.amount) > 0 ? (o.amount / 100).toFixed(2) + "元" : "-";
        const post = postMap[o.post_id];
        const user = userMap[o.openid];
        return {
          id: o._id,
          text: biz,
          sub: [amount, user ? (user.username || user.phone || '') : '', o.out_trade_no || ""].filter(Boolean).join(" · "),
          tag: statusMap[o.status] || o.status || "未知",
          tagColor: statusColor[o.status] || "default",
          detail: buildOrderDetail(o, bizMap, statusMap, post, user),
        };
      }),
      pagination: buildPagination(total, page, pageSize),
    }],
  };
}

// 订单完整信息（排好版，供复制，不脱敏）。post/user 已由外层批量查好传入。
function buildOrderDetail(o, bizMap, statusMap, post, user) {
  const lines = [];
  lines.push(`【支付订单】`);
  lines.push(`业务：${bizMap[o.biz_type] || o.title || o.biz_type || "订单"}`);
  lines.push(`订单号：${o.out_trade_no || ""}`);
  lines.push(`金额：${Number(o.amount) > 0 ? (o.amount / 100).toFixed(2) + "元" : "-"}`);
  lines.push(`状态：${statusMap[o.status] || o.status || "未知"}`);
  if (o.openid) lines.push(`付款 openid：${o.openid}`);
  if (user) {
    lines.push(`付款用户：${user.username || "未设置昵称"}`);
    if (user.phone) lines.push(`付款手机号：${user.phone}`);
  }
  if (post) {
    const typeName = TYPE_NAMES[post.data_type] || "信息";
    const title = String(post.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 40);
    lines.push(`关联帖子：【${typeName}】${title}${post.city ? "（" + post.city + "）" : ""}`);
  } else if (o.post_id) {
    lines.push(`帖子ID：${o.post_id}`);
  }
  if (o.plan) lines.push(`套餐：${o.plan}`);
  if (o.merchant_id) lines.push(`商家ID：${o.merchant_id}`);
  if (o.created_at) lines.push(`创建时间：${new Date(o.created_at).toLocaleString()}`);
  if (o.updated_at) lines.push(`更新时间：${new Date(o.updated_at).toLocaleString()}`);
  if (o.fulfilled_at) lines.push(`履约时间：${new Date(o.fulfilled_at).toLocaleString()}`);
  return lines.join("\n");
}

async function handleMerchants(intent) {
  const { items, pagination } = await pagedList({
    collection: MERCHANTS,
    orderField: "created_at",
    page: intent && intent.page,
    pageSize: 5,
    mapFn: (m) => ({
      text: m.name || m.shop_name || "未命名",
      sub: m.plan === "pro" ? "高级版" : (m.plan || "基础"),
      tag: m.paid ? "已付费" : "未付费",
      tagColor: m.paid ? "success" : "default",
    }),
  });
  if (!items.length) {
    return { title: "商家入驻", blocks: [{ type: "empty", text: "暂无商家入驻申请" }] };
  }
  return { title: "商家入驻", blocks: [{ type: "list", items, pagination }] };
}

async function handleTops(intent) {
  // 支持按信息类型筛选置顶（如"只查招工的置顶"）
  const where = (intent && intent.dataType) ? { data_type: intent.dataType } : undefined;
  const { list, pagination } = await pagedList({
    collection: TOPS,
    where,
    orderField: "created_at",
    page: intent && intent.page,
    pageSize: 5,
  });

  if (!list.length) {
    return { title: "置顶帖子", blocks: [{ type: "empty", text: "暂无置顶帖子" }] };
  }

  // 批量回查帖子标题（_.in 一次查，替代原来的循环 doc().get()，避免 N+1）
  const postIds = list.map((t) => t.post_id).filter(Boolean);
  const postMap = {};
  if (postIds.length) {
    try {
      const r = await db.collection(COLLECTION)
        .where({ _id: _.in(postIds) })
        .field({ _id: true, raw_text: true })
        .get();
      (r.data || []).forEach((p) => { postMap[p._id] = p; });
    } catch (e) { /* ignore */ }
  }

  const items = list.map((t) => {
    const post = postMap[t.post_id];
    const title = post ? String(post.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 30) : "（已删除）";
    const expireText = t.expire_at === 0
      ? "永久"
      : "到期 " + new Date(t.expire_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return {
      id: t.post_id,            // 帖子ID（用于取消置顶）
      topId: t._id,             // 置顶记录ID（精确操作）
      type: t.data_type || "",  // 帖子类型（用于编辑跳转）
      text: title,
      sub: TYPE_NAMES[t.data_type] || "",
      tag: expireText,
      tagColor: t.expire_at === 0 ? "primary" : (Number(t.expire_at) < Date.now() ? "danger" : "default"),
    };
  });

  return { title: "置顶帖子", blocks: [{ type: "list", items, pagination }] };
}

async function handleLogs(intent) {
  const { items, pagination } = await pagedList({
    collection: LOGS,
    orderField: "created_at",
    page: intent && intent.page,
    pageSize: 5,
    mapFn: (l) => ({
      text: l.action || "操作",
      sub: l.detail || l.target_id || "",
      tag: l.created_at ? new Date(l.created_at).toLocaleTimeString() : "",
      tagColor: "default",
    }),
  });
  if (!items.length) {
    return { title: "操作日志", blocks: [{ type: "empty", text: "暂无操作日志" }] };
  }
  return { title: "操作日志", blocks: [{ type: "list", items, pagination }] };
}

// 按手机号反查帖子（完整号精确匹配 + 脱敏号尾号匹配，覆盖两类字段）
async function handlePhone(intent) {
  const phone = String((intent && intent.phone) || "").trim();
  if (!phone) {
    return { title: "号码查询", blocks: [{ type: "empty", text: "未识别到手机号" }] };
  }
  const tail = phone.slice(-4);
  const rx = db.RegExp({ regexp: escapeReg(tail), options: "i" });

  const { list, pagination } = await pagedList({
    collection: COLLECTION,
    where: _.or([{ phone }, { phone_masked: rx }]),
    orderField: "published_at",
    page: intent && intent.page,
    pageSize: 5,
  });

  if (!list.length) {
    return { title: "号码查询", blocks: [{ type: "empty", text: `未找到号码 ${phone} 关联的帖子` }] };
  }
  return {
    title: `号码 ${phone} 关联的帖子`,
    blocks: [{ type: "list", items: list.map(postToItem), pagination }],
  };
}

// ==================== 广告管理（查询 + 上下线） ====================

// 广告 → 列表行对象
function adToItem(a) {
  const slotName = AD_SLOT_NAMES[a.slot] || a.slot || "未知位";
  const statusText = a.status === "online" ? "已上线" : "已下线";
  const now = Date.now();
  const inWindow = (Number(a.start_at) || 0) <= now && now <= (Number(a.end_at) || Infinity);
  const typeText = a.type === "popup" ? "弹窗" : (a.type === "feed" ? "信息流" : "轮播/Banner");
  return {
    id: a._id,
    text: `${a.title || "未命名"}（${slotName}）`,
    sub: [typeText, statusText, inWindow ? "" : "⚠️不在有效期"].filter(Boolean).join(" · "),
    tag: statusText,
    tagColor: a.status === "online" ? "success" : "default",
  };
}

// 查询广告列表：可按 slot / status 筛选
async function handleAds(intent) {
  const where = {};
  if (intent && intent.slot) where.slot = intent.slot;
  if (intent && intent.status) where.status = intent.status;

  const { list, pagination } = await pagedList({
    collection: ADS,
    where: Object.keys(where).length ? where : undefined,
    orderField: "sort",
    orderDir: "desc",
    page: intent && intent.page,
    pageSize: 5,
  });

  if (!list.length) {
    return { title: "广告管理", blocks: [{ type: "empty", text: "暂无广告" }] };
  }
  return {
    title: "广告管理",
    blocks: [{ type: "list", items: list.map(adToItem), pagination }],
  };
}

// 上下线广告：op=online/offline，可按 _id 或标题 / 广告位定位
async function handleAdToggle(intent) {
  const op = intent && intent.op;
  const targetStatus = op === "online" ? "online" : "offline";

  let found = [];

  // 定位方式1：按 _id 精确
  if (intent && intent.adId) {
    const r = await db.collection(ADS).where({ _id: String(intent.adId).trim() }).limit(1).get();
    found = r.data || [];
  }

  // 定位方式2/3：按标题关键词 / 广告位
  if (!found.length) {
    const conds = [];
    if (intent && intent.adTitle) {
      const rx = db.RegExp({ regexp: escapeReg(intent.adTitle), options: "i" });
      conds.push({ title: rx });
    }
    if (intent && intent.slot) {
      conds.push({ slot: intent.slot });
      // 也把 slot 值当标题兜底（防 DeepSeek 把标题误当 slot）
      conds.push({ title: db.RegExp({ regexp: escapeReg(intent.slot), options: "i" }) });
    }
    if (conds.length) {
      const query = conds.length === 1 ? conds[0] : _.or(conds);
      const r = await db.collection(ADS).where(query).limit(10).get();
      found = r.data || [];
    }
  }

  if (!found.length) {
    return { title: "广告管理", blocks: [{ type: "text", text: "未定位到要操作的广告，请提供广告标题（如「包子快讯」）或广告位" }] };
  }

  // 批量更新状态
  const ids = found.map((a) => a._id);
  await db.collection(ADS).where({ _id: _.in(ids) }).update({
    data: { status: targetStatus, updated_at: Date.now() },
  });

  const verb = targetStatus === "online" ? "上线" : "下线";
  const items = found.map((a) => ({
    id: a._id,
    text: a.title || "未命名",
    sub: AD_SLOT_NAMES[a.slot] || a.slot || "",
    tag: `已${verb}`,
    tagColor: targetStatus === "online" ? "success" : "default",
  }));
  return {
    title: `广告${verb}`,
    blocks: [
      { type: "text", text: `已${verb} ${found.length} 条广告。` },
      { type: "list", items },
    ],
  };
}

// ==================== 共享记忆（越用越懂） ====================
// 记忆存 admin_ai_memory 集合，单文档（共享给所有管理员），字段：
//   { _id:"shared", preferences:{}, corrections:[], shortcuts:{}, stats:{city:{},type:{}}, updated_at }
// 读取失败/无记忆时返回空结构，不阻断主流程。

function emptyMemory() {
  return { preferences: {}, corrections: [], shortcuts: {}, stats: { city: {}, type: {} } };
}

async function loadMemory() {
  try {
    const r = await db.collection(AI_MEMORY).doc("shared").get();
    if (r && r.data && r.data._id) {
      return Object.assign(emptyMemory(), r.data);
    }
  } catch (e) { /* 集合未建/无文档，忽略 */ }
  return emptyMemory();
}

async function saveMemory(mem) {
  mem.updated_at = Date.now();
  // 删除 _id 字段，避免 doc("shared").set 时与主键冲突（loadMemory 读出来带 _id）
  delete mem._id;
  try {
    await db.collection(AI_MEMORY).doc("shared").set({ data: mem });
  } catch (e) {
    console.error("[adminChat] 保存记忆失败:", e && e.errMsg);
  }
}

// 记录一条学习流水（审计/debug 用，每次学习动作新增一条文档，不覆盖）
// type: shortcut=记别名 / correction=记纠正 / preference=记偏好
async function saveLearningLog(type, detail) {
  try {
    await db.collection(AI_LEARNING_LOG).add({
      data: {
        type,
        detail,
        at: Date.now(),
      },
    });
  } catch (e) {
    console.error("[adminChat] 记录学习流水失败:", e && e.errMsg);
  }
}

// 从一次问答中提取偏好：命中城市/类型则累计频次
function extractPrefs(question, tool, args) {
  const t = String(question || "");
  const prefs = {};
  const city = args && args.city;
  if (city) prefs.city = city;
  // 从问题文本里兜底识别城市
  if (!prefs.city) {
    for (const c of CITIES) { if (t.includes(c)) { prefs.city = c; break; } }
  }
  const dt = (args && args.dataType) || null;
  if (dt && TYPE_NAMES[dt]) prefs.dataType = dt;
  return prefs;
}

// 记录一次"提问→所选工具"，用于偏好统计与纠错沉淀
async function remember(question, tool, args) {
  try {
    const mem = await loadMemory();
    const p = extractPrefs(question, tool, args);
    if (p.city) mem.stats.city[p.city] = (mem.stats.city[p.city] || 0) + 1;
    if (p.dataType) mem.stats.type[p.dataType] = (mem.stats.type[p.dataType] || 0) + 1;
    await saveMemory(mem);
  } catch (e) {
    console.error("[adminChat] remember 失败:", e && e.errMsg);
  }
}

// 处理管理员明确纠正（"不对，应该是..."），沉淀为纠正记忆
async function rememberCorrection(text) {
  try {
    const mem = await loadMemory();
    mem.corrections = (mem.corrections || []).slice(-19);
    mem.corrections.push({ text: String(text || "").slice(0, 200), at: Date.now() });
    await saveMemory(mem);
    // 记一条学习流水（审计/debug）
    await saveLearningLog("correction", { text: String(text || "").slice(0, 200) });
  } catch (e) {
    console.error("[adminChat] rememberCorrection 失败:", e && e.errMsg);
  }
}

// 写入一条「别名→枚举值」的快捷规则（覆盖式去重，天然避免重复/矛盾项堆积）
async function saveShortcut(from, to) {
  const key = String(from || "").trim();
  if (!key || !TYPE_NAMES[to]) return false; // 别名非空 且 to 必须是合法枚举
  try {
    const mem = await loadMemory();
    mem.shortcuts = mem.shortcuts || {};
    mem.shortcuts[key] = to;
    await saveMemory(mem);
    // 记一条学习流水（审计/debug）
    await saveLearningLog("shortcut", { from: key, to });
    return true;
  } catch (e) {
    console.error("[adminChat] saveShortcut 失败:", e && e.errMsg);
    return false;
  }
}

// 把记忆拼成一段简短说明，注入 system prompt
function buildMemoryBlock(mem) {
  const parts = [];
  const topCity = Object.entries(mem.stats.city || {}).sort((a, b) => b[1] - a[1])[0];
  const topType = Object.entries(mem.stats.type || {}).sort((a, b) => b[1] - a[1])[0];
  if (topCity && topCity[1] > 0) parts.push(`常查城市：${topCity[0]}（${topCity[1]}次）`);
  if (topType && topType[1] > 0) parts.push(`常查类型：${TYPE_NAMES[topType[0]] || topType[0]}`);
  if (mem.shortcuts && Object.keys(mem.shortcuts).length) {
    parts.push("快捷别名：" + Object.entries(mem.shortcuts).map(([k, v]) => `${k}=${v}`).join("，"));
  }
  if (mem.corrections && mem.corrections.length) {
    parts.push("管理员最近纠正：" + mem.corrections.slice(-3).map((c) => c.text).join("；"));
  }
  return parts.length ? `【管理员偏好（越用越懂）】\n${parts.join("\n")}` : "";
}

// ==================== AI 接管模式 ====================
async function callDeepSeek(messages, temperature, maxTokens) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 DEEPSEEK_API_KEY");
  }
  const res = await axios.post(
    DEEPSEEK_API_URL,
    { model: DEEPSEEK_MODEL, messages, temperature, max_tokens: maxTokens },
    { headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
  );
  return (res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content) || "";
}

async function handleDeepThink(question, history, event) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return fail("未配置 DEEPSEEK_API_KEY，无法启用 AI 接管模式", "NO_API_KEY");
  }

  const mem = await loadMemory();
  const memBlock = buildMemoryBlock(mem);
  const glossary = DOMAIN_GLOSSARY.join("\n");
  const historySafe = Array.isArray(history) ? history.slice(-6) : [];

  // 上下文：上一轮的查询工具 + 参数（前端开启"上下文"开关时传入）
  const ctx = (event && event.context) || null;

  // 上下文摘要：注入 Stage1，让 DeepSeek 知道"这是延续上一轮"
  const ctxBlock = ctx
    ? `\n\n【上下文继承】管理员在连续追问，上一轮查询是：\n工具：${ctx.tool || "search"}\n参数：${JSON.stringify(ctx.args || {})}\n本轮若是对上一轮【追加/收紧筛选条件】（如"8000元以内""那北京的呢"），请【继承上一轮的 tool 与 args】，只在其基础上追加或覆盖本轮提到的新条件；若本轮是全新的查询主题（换了信息类型），则不要继承。`
    : "";

  // 别名硬命中：先用已沉淀的快捷别名对问题文本做一次替换（不依赖模型自觉）
  // 例如「收店」已沉淀为 want_shop，则问题里「收店」直接替换成「求店」，Stage1 更稳
  let resolvedQuestion = question;
  const shortcutEntries = Object.entries(mem.shortcuts || {});
  if (shortcutEntries.length) {
    for (const [alias, typeCode] of shortcutEntries) {
      const typeName = TYPE_NAMES[typeCode];
      if (!alias || !typeName) continue;
      if (resolvedQuestion.includes(alias)) {
        resolvedQuestion = resolvedQuestion.split(alias).join(typeName);
      }
    }
  }

  // ===== Stage1：AI 理解问题 + 选工具 =====
  const stage1System =
    SYSTEM_CAPABILITY_DOC +
    "\n\n【行业黑话对齐】\n" + glossary +
    (memBlock ? "\n\n" + memBlock : "") +
    ctxBlock +
    "\n\n现在请判断用户这句话该调哪个工具，只输出一个 JSON。";

  let plan;
  try {
    const raw = await callDeepSeek(
      [
        { role: "system", content: stage1System },
        ...historySafe,
        { role: "user", content: resolvedQuestion },
      ],
      0.1,
      400
    );
    const m = String(raw || "").trim().match(/\{[\s\S]*\}/);
    plan = JSON.parse(m ? m[0] : raw);
    console.log("[adminChat deepThink] Stage1 输出:", raw);
  } catch (e) {
    console.error("[adminChat deepThink] Stage1 失败:", e);
    return fail("AI 接管模式识别失败，请重试或换种问法", "DEEP_THINK_FAILED");
  }

  // 纠正识别（复用 Stage1 结果，不额外调模型）：命中「长期规则纠正」→ 写快捷别名
  // 命中规则纠正：写 shortcuts（覆盖式去重），同时记一条纠正文本用于追溯
  if (plan && plan.correction && plan.correction.isRule && plan.correction.alias) {
    const { from, to } = plan.correction.alias || {};
    const saved = await saveShortcut(from, to);
    if (saved) {
      await rememberCorrection(`别名规则：${from} = ${to}`);
    }
  }

  // ===== 执行工具 =====
  let toolResult = null;
  let toolTitle = "查询结果";

  switch (plan.tool) {
    case "stats": toolResult = await handleStats(); toolTitle = toolResult.title; break;
    case "pending": toolResult = await handlePending({ page: (plan.args && plan.args.page) || 1 }); toolTitle = "待审核帖子"; break;
    case "offline": toolResult = await handleOffline({ page: (plan.args && plan.args.page) || 1 }); toolTitle = "已下架帖子"; break;
    case "users": toolResult = await handleUsers({ page: (plan.args && plan.args.page) || 1 }); toolTitle = toolResult.title; break;
    case "orders": toolResult = await handleOrders({ page: (plan.args && plan.args.page) || 1 }); toolTitle = "支付订单"; break;
    case "merchants": toolResult = await handleMerchants({ page: (plan.args && plan.args.page) || 1 }); toolTitle = "商家入驻"; break;
    case "tops": toolResult = await handleTops({ dataType: plan.args && plan.args.dataType, page: (plan.args && plan.args.page) || 1 }); toolTitle = "置顶帖子"; break;
    case "logs": toolResult = await handleLogs({ page: (plan.args && plan.args.page) || 1 }); toolTitle = "操作日志"; break;
    case "ads": toolResult = await handleAds({ slot: plan.args && plan.args.slot, status: plan.args && plan.args.status, page: (plan.args && plan.args.page) || 1 }); toolTitle = toolResult.title; break;
    case "adToggle": toolResult = await handleAdToggle({ op: plan.args && plan.args.op, adId: plan.args && plan.args.adId, slot: plan.args && plan.args.slot, adTitle: plan.args && plan.args.adTitle }); toolTitle = toolResult.title; break;
    case "phone": toolResult = await handlePhone({ phone: plan.args && plan.args.phone, page: (plan.args && plan.args.page) || 1 }); toolTitle = "号码反查"; break;
    case "search": {
      const intent = detectIntent(question, 1);
      const args = plan.args || {};
      // 本轮识别到的条件，优先用本轮（覆盖）
      if (args.dataType) intent.dataType = args.dataType;
      if (args.city) intent.city = args.city;
      if (args.keyword) intent.keyword = args.keyword;
      if (args.limit) intent.limit = args.limit;
      // 薪资范围
      if (args.salaryMax != null) intent.salaryMax = Number(args.salaryMax);
      if (args.salaryMin != null) intent.salaryMin = Number(args.salaryMin);
      if (args.salary != null && intent.salaryMax == null) intent.salaryMax = Number(args.salary);
      // 转让费/价格范围
      if (args.priceMin != null) intent.priceMin = Number(args.priceMin);
      if (args.priceMax != null) intent.priceMax = Number(args.priceMax);
      if (args.price != null && intent.priceMax == null) intent.priceMax = Number(args.price);
      // 月租范围
      if (args.rentMin != null) intent.rentMin = Number(args.rentMin);
      if (args.rentMax != null) intent.rentMax = Number(args.rentMax);
      if (args.rent != null && intent.rentMax == null) intent.rentMax = Number(args.rent);
      // 时间范围：DeepSeek 给 timeWithinDays（天数），代码换算成 timeMin 毫秒时间戳
      if (args.timeWithinDays != null) {
        const days = Number(args.timeWithinDays);
        if (days > 0) intent.timeMin = Date.now() - days * 86400000;
      }
      // 审核状态
      if (args.auditState) intent.auditState = args.auditState;

      // 上下文继承：本轮没提到的条件，继承上一轮的
      if (ctx && ctx.args) {
        if (!intent.dataType && ctx.args.dataType) intent.dataType = ctx.args.dataType;
        if (!intent.city && ctx.args.city) intent.city = ctx.args.city;
        if (intent.salaryMin == null && ctx.args.salaryMin != null) intent.salaryMin = Number(ctx.args.salaryMin);
        if (intent.salaryMax == null && ctx.args.salaryMax != null) intent.salaryMax = Number(ctx.args.salaryMax);
        if (intent.priceMin == null && ctx.args.priceMin != null) intent.priceMin = Number(ctx.args.priceMin);
        if (intent.priceMax == null && ctx.args.priceMax != null) intent.priceMax = Number(ctx.args.priceMax);
        if (intent.rentMin == null && ctx.args.rentMin != null) intent.rentMin = Number(ctx.args.rentMin);
        if (intent.rentMax == null && ctx.args.rentMax != null) intent.rentMax = Number(ctx.args.rentMax);
        // 时间：继承 timeWithinDays（天数），再换算成 timeMin
        if (intent.timeMin == null && ctx.args.timeWithinDays != null) {
          const d = Number(ctx.args.timeWithinDays);
          if (d > 0) intent.timeMin = Date.now() - d * 86400000;
        }
        if (!intent.auditState && ctx.args.auditState) intent.auditState = ctx.args.auditState;
      }

      // 关键修复1：intent.city 可能是从 context 继承的中文城市名，但 cityCode 还是空。
      // 必须根据最终的 city 重新解析 cityCode，否则城市过滤失效。
      if (intent.city && !intent.cityCode) {
        const cityRes = detectIntent(intent.city, 1);
        intent.cityCode = cityRes.cityCode || null;
        intent.isProvince = cityRes.isProvince || false;
      }

      // 关键修复2：DeepSeek 可能把纯数字误当成 keyword，清掉它（数字应该走各维度参数）
      if (intent.keyword && /^\d+$/.test(String(intent.keyword).trim())) {
        intent.keyword = "";
      }

      // 把最终生效的条件回写到 plan.args，便于返回给前端记录上下文
      if (intent.dataType) plan.args.dataType = intent.dataType;
      if (intent.city) plan.args.city = intent.city;
      if (intent.salaryMin != null) plan.args.salaryMin = intent.salaryMin;
      if (intent.salaryMax != null) plan.args.salaryMax = intent.salaryMax;
      if (intent.priceMin != null) plan.args.priceMin = intent.priceMin;
      if (intent.priceMax != null) plan.args.priceMax = intent.priceMax;
      if (intent.rentMin != null) plan.args.rentMin = intent.rentMin;
      if (intent.rentMax != null) plan.args.rentMax = intent.rentMax;
      // 时间：保留 DeepSeek 给的 timeWithinDays（天数），便于前端上下文复用；不清成时间戳
      if (intent.auditState) plan.args.auditState = intent.auditState;
      // 清掉多余的纯数字 keyword，避免污染上下文
      if (plan.args && plan.args.keyword && /^\d+$/.test(String(plan.args.keyword).trim())) {
        delete plan.args.keyword;
      }

      toolResult = await handleSearch(intent);
      toolTitle = toolResult.title || "查询结果";
      break;
    }
    case "answer":
    default:
      await remember(question, "answer", {});
      return ok({
        title: "AI 回复",
        blocks: [{ type: "text", text: (plan.args && plan.args.text) || String(raw || "").trim() || "（无内容）" }],
        mode: "deepThink",
      });
  }

  // 记录偏好（非 answer 的查询类）
  await remember(question, plan.tool, plan.args || {});

  // ===== Stage2：AI 基于真实数据写总结 =====
  let insight = "";
  try {
    const dataSummary = JSON.stringify(toolResult.blocks || []).slice(0, 6000);
    const stage2System =
      "你是「包子一哥传媒」后台管理 AI 助手。以下是刚查到的真实数据（结构化卡片 JSON），请用中文给管理员写一段总结。\n" +
      "要求：1) 严禁编造数字，只引用 JSON 内容；2) 2-5 个短句，口语化；3) 纯文本，禁止任何 Markdown（#、**、-、表格）；4) 数据为空就直说「暂无数据」。";
    insight = (await callDeepSeek(
      [
        { role: "system", content: stage2System },
        ...historySafe,
        { role: "user", content: question },
        { role: "assistant", content: `【${toolTitle} 真实数据】\n${dataSummary}` },
        { role: "user", content: "请基于以上真实数据写最终回复。" },
      ],
      0.5,
      500
    )).trim();
  } catch (e) {
    console.error("[adminChat deepThink] Stage2 失败:", e);
  }

  const blocks = [];
  if (insight) blocks.push({ type: "text", text: insight });
  if (toolResult && toolResult.blocks && toolResult.blocks.length) {
    blocks.push({ type: "section", title: toolTitle });
    blocks.push(...toolResult.blocks);
  }
  return ok({ title: toolTitle, blocks, mode: "deepThink", tool: plan.tool, toolArgs: plan.args || {} });
}

// 深度思考翻页直查：复用上次选定的工具，只改 page，不重新做意图识别
async function handleDeepThinkPage(tool, args, page) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const a = args || {};
  let result;
  switch (tool) {
    case "stats": result = await handleStats(); break;
    case "pending": result = await handlePending({ page: p }); break;
    case "offline": result = await handleOffline({ page: p }); break;
    case "users": result = await handleUsers({ page: p }); break;
    case "orders": result = await handleOrders({ page: p }); break;
    case "merchants": result = await handleMerchants({ page: p }); break;
    case "tops": result = await handleTops({ dataType: a.dataType, page: p }); break;
    case "logs": result = await handleLogs({ page: p }); break;
    case "ads": result = await handleAds({ slot: a.slot, status: a.status, page: p }); break;
    case "phone": result = await handlePhone({ phone: a.phone, page: p }); break;
    case "search": {
      const base = detectIntent(a.city ? a.city : "", 1);
      const intent = {
        page: p,
        dataType: a.dataType || null,
        city: a.city || null,
        cityCode: base.cityCode || null,
        isProvince: base.isProvince || false,
        keyword: a.keyword || "",
        limit: a.limit || 10,
        salaryMin: a.salaryMin != null ? Number(a.salaryMin) : null,
        salaryMax: a.salaryMax != null ? Number(a.salaryMax) : null,
        priceMin: a.priceMin != null ? Number(a.priceMin) : null,
        priceMax: a.priceMax != null ? Number(a.priceMax) : null,
        rentMin: a.rentMin != null ? Number(a.rentMin) : null,
        rentMax: a.rentMax != null ? Number(a.rentMax) : null,
        timeMin: a.timeWithinDays != null ? (Date.now() - Number(a.timeWithinDays) * 86400000) : null,
        auditState: a.auditState || null,
      };
      result = await handleSearch(intent);
      break;
    }
    default: return fail("不支持翻页的工具", "BAD_TOOL");
  }
  return ok({ title: result.title, blocks: result.blocks, mode: "deepThink", tool });
}

// ---------- 入口 ----------
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();

  const user = String(event.user || "").trim();
  const pass = String(event.pass || "").trim();

  // 统一管理员判定（两通道，命中任一即可放行）：
  //   ① 后台 Web：携带账密 → 比对环境变量 ADMIN_USER / ADMIN_PASS（与 adminAuth 同款）
  //   ② 小程序：未带账密但有服务端 OPENID → 白名单 ADMIN_OPENIDS 或 baozi_users.role === 'admin'
  // 注意：原代码 `OPENID === ADMIN_USER` 是死代码（openid 形如 oREGN7xxx，永远不等于 "admin"），已移除。
  let authed = false;
  if (user && pass) {
    authed = user === ADMIN_USER && pass === ADMIN_PASS;
  } else if (OPENID) {
    authed = await isAdminOpenid(OPENID);
  }
  if (!authed) {
    return fail("未授权：仅管理员可用", "AUTH_FAILED");
  }

  const question = String(event.question || "").trim();
  if (!question) {
    return ok({ title: "管理员 AI 助手", blocks: buildGuideBlocks() });
  }

  // ★ 深度思考翻页直查：翻页时带 tool，跳过意图识别，直接查下一页
  if (event.deepThink && event.tool) {
    return await handleDeepThinkPage(event.tool, event.toolArgs || {}, event.page);
  }

  // ★ AI 全面接管：deepThink=true 时跳过所有规则识别，直接交给 DeepSeek
  if (event.deepThink) {
    return await handleDeepThink(question, event.history || [], event);
  }

  // ---- 规则模式 ----
  const intent = detectIntent(question, event.page);
  console.log("[adminChat] 意图:", JSON.stringify(intent));

  let result = { title: "查询结果", blocks: [] };
  try {
    switch (intent.type) {
      case "stats": result = await handleStats(); break;
      case "pending": result = await handlePending(intent); break;
      case "offline": result = await handleOffline(intent); break;
      case "users": result = await handleUsers(intent); break;
      case "orders": result = await handleOrders(intent); break;
      case "merchants": result = await handleMerchants(intent); break;
      case "tops": result = await handleTops(intent); break;
      case "logs": result = await handleLogs(intent); break;
      case "ads": result = await handleAds(intent); break;
      case "phone": result = await handlePhone(intent); break;
      case "search":
      default: result = await handleSearch(intent); break;
    }
  } catch (e) {
    console.error("[adminChat] 处理失败:", e);
    result = {
      title: "查询失败",
      blocks: [{ type: "text", text: "查询失败：" + (e.errMsg || e.message || e) }],
    };
  }

  return ok({ title: result.title, blocks: result.blocks, intent });
};

function buildGuideBlocks() {
  return [
    { type: "title", text: "管理员 AI 助手" },
    { type: "text", text: "用自然语言查询后台数据，试试：" },
    { type: "list", items: [
      { text: "平台数据概览", sub: "统计看板", tagColor: "primary", tag: "统计" },
      { text: "有多少待审核帖子", sub: "待审列表", tagColor: "warning", tag: "审核" },
      { text: "深圳的招工信息", sub: "按城市+类型查全量帖子", tagColor: "success", tag: "搜索" },
      { text: "最近支付订单", sub: "订单流水", tagColor: "default", tag: "订单" },
    ] },
  ];
}
