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
const AI_RESULT_SETS = "admin_ai_result_sets"; // AI 多轮「结果集记忆」（支持“这里面/这些”指代上一轮结果做二次统计）
const AI_SESSIONS = "admin_ai_sessions"; // AI 会话记忆（页面打开期间的连续对话：条件累积 + 结果集链 + 最近轮次）
const AI_MISTAKES = "admin_ai_mistakes"; // AI 错误库（记录意图识别误判 + 正确做法，注入 prompt 让 AI 越用越聪明）

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
const DEEPSEEK_MODEL = "deepseek-flash";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

// ==================== 条数/分页统一约定（AI 模式与规则模式共用） ====================
// 默认条数 5；AI 意图识别若明确给出 limit，则按 AI 给的来（后端兜底封顶 MAX_LIMIT）。
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 200;      // AI 模式下允许的最大条数（防 token 打爆）
const SINGLE_QUERY_MAX = 100; // 单次查询可返回的最大条数（云开发单次 limit 上限内，稳妥取 100）
// 聚合分析：每批喂给分析 AI 的条目数（分批摘要 → 二次汇总）
const ANALYZE_BATCH = 25;

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

// ==================== 工具注册表（唯一事实来源） ====================
// 原则：AI 看到的「工具说明书」和 后端实际能执行的 handler 必须来自同一份定义。
// 每个工具的 desc/params 会被自动拼成喂给 DeepSeek 的能力文档，handler 用于后端分发。
// 新增工具时只改这里，避免「AI 说得出、代码做不到」的错位。
//
// 字段说明：
//   desc    : 一句话用途（喂给 AI）
//   args    : 参数说明对象 { 参数名: "说明（含枚举/默认值）" }（喂给 AI）
//   ret     : 返回值说明（喂给 AI）
//   handler : 后端执行函数名（字符串，运行时从当前模块取）
//   pageable: 是否支持翻页（前端 onPageChange / handleDeepThinkPage 用）
const TOOLS = {
  stats: {
    desc: "平台数据概览",
    args: {},
    ret: "帖子总数/待审核数/已下架数/用户总数/今日新增/会员数/订单数/商家数，及各类型帖子数量分布",
    handler: "handleStats",
    pageable: false,
  },
  pending: {
    desc: "待审核帖子列表",
    args: { page: "页码，默认1" },
    ret: "待审核帖子（每页5条），每条含标题/类型/地区/价格/脱敏电话/审核状态",
    handler: "handlePending",
    pageable: true,
  },
  offline: {
    desc: "已下架帖子列表",
    args: { page: "页码，默认1" },
    ret: "已下架帖子（每页5条）",
    handler: "handleOffline",
    pageable: true,
  },
  search: {
    desc: "按条件搜帖子列表（查列表用这个；查「平均值/最高/最低/总数」等聚合指标请用 aggregate）",
    args: {
      dataType: "信息类型，枚举见下方【信息类型 dataType 枚举】",
      city: '中文城市名不带"市"字，如"深圳"',
      keyword: "关键词，匹配标题/岗位/联系人/用户名/地址",
      salaryMin: "薪资下限（元）",
      salaryMax: "薪资上限（元）",
      priceMin: "转让费/价格下限（元）",
      priceMax: "转让费/价格上限（元）",
      rentMin: "月租下限（元/月）",
      rentMax: "月租上限（元/月）",
      timeWithinDays: "最近多少天内发布（整数天数）",
      auditState: "审核状态：approved=已过审/pending=待审/offline=已下架",
      limit: `返回条数，默认 ${DEFAULT_LIMIT}，用户说"100条/200条/全部"时填对应数字（上限 ${MAX_LIMIT}）`,
      page: "页码，默认1（翻页用）",
    },
    ret: "帖子列表（含标题/类型/地区/价格/脱敏电话/完整信息），带分页",
    handler: "handleSearch",
    pageable: true,
  },
  phone: {
    desc: "按手机号反查帖子",
    args: { phone: "11位手机号" },
    ret: "该号码发布的帖子（含待审/已过审/已下架）",
    handler: "handlePhone",
    pageable: true,
  },
  users: {
    desc: "最近注册用户",
    args: { page: "页码，默认1" },
    ret: "昵称/脱敏手机号/会员状态(会员/普通/已封禁)",
    handler: "handleUsers",
    pageable: true,
  },
  orders: {
    desc: "支付订单",
    args: { page: "页码，默认1" },
    ret: "业务类型(查看电话/开会员/擦亮/置顶/商家入驻)/金额/状态/付款人/订单号/关联帖子",
    handler: "handleOrders",
    pageable: true,
  },
  merchants: {
    desc: "商家入驻申请",
    args: { page: "页码，默认1" },
    ret: "名称/套餐/是否已付费",
    handler: "handleMerchants",
    pageable: true,
  },
  tops: {
    desc: "置顶帖子",
    args: { dataType: "信息类型（可选，只查某类型的置顶）", page: "页码，默认1" },
    ret: "标题/类型/到期时间",
    handler: "handleTops",
    pageable: true,
  },
  logs: {
    desc: "操作日志",
    args: { page: "页码，默认1" },
    ret: "操作类型/详情/时间",
    handler: "handleLogs",
    pageable: true,
  },
  ads: {
    desc: "广告列表",
    args: { slot: "广告位（见下方【广告位 slot 枚举】）", status: "online=已上线/offline=已下线", page: "页码，默认1" },
    ret: "每条的标题/广告位/类型/上下线状态/是否在有效期",
    handler: "handleAds",
    pageable: true,
  },
  adToggle: {
    desc: "广告上下线",
    args: {
      op: '必填，"offline"下线 / "online"上线',
      adId: "精确ID（优先级最高）",
      adTitle: "广告标题关键词（用户说具体广告名时填这里）",
      slot: "广告位（用户说广告位时才填）",
    },
    ret: "已上下线的广告列表",
    handler: "handleAdToggle",
    pageable: false,
  },
  aggregate: {
    desc: "聚合统计（算指标：平均值/最高/最低/总和/计数/分组）。用户问「平均……是多少」「最高的……」「一共……」「各城市/各类型分布」时用这个；用户说「这里面/这些/刚才那些/其中」（指代上一轮结果）时也用这个并设 onPrevious=true",
    args: {
      dataType: "信息类型，枚举见下方【信息类型 dataType 枚举】（可选）",
      field: `要统计的数值字段，枚举：salary=工资/薪资, price=转让费/价格, monthly_rent=月租, area_sqm=面积（默认 salary）。仅在算 avg/min/max/sum 或「其中多少条有X」时才填；op=count 纯计数时不用填`,
      op: `算子，枚举：avg=平均值, min=最低, max=最高, sum=总和, count=总数, group=分组统计, list=列出明细（用户说「列出来/看看」时用）（默认 avg）`,
      groupBy: `op=group 时按什么分组，枚举：city=城市, data_type=信息类型（默认 city）`,
      city: "限定城市（可选）",
      timeWithinDays: "限定最近多少天内发布（可选，整数天数）",
      limit: `取最近多少条参与统计，默认 ${DEFAULT_LIMIT}，用户说"最近100条"时填 100（上限 ${MAX_LIMIT}）。⚠️ 若同时给了 timeWithinDays（如"最近7天"），表示统计该时间范围内全部数据，此时不必填 limit`,
      salaryMin: "薪资下限（元，可选）",
      salaryMax: "薪资上限（元，可选）",
      excludeZero: "是否排除该字段为 0 的记录（面议/未填），默认 true",
      onPrevious: `布尔。当用户用「这里面/这些/刚才那些/其中/上面这些」指代【上一轮查询结果】、要在这批结果内做二次统计时，必须设为 true（此时不要再填 limit，系统用上一轮的结果集）；若用户在问全新的全库统计则不填`,
      stackIndex: `数值（可选）。仅当 onPrevious=true 时生效：0=指【最早那批】结果集（用户说"最开始那批/最早那个"时填 0）；不填=最新那批（"上一轮/这里面"）`,
      keyword: `关键词（可选）。在结果集内做包含匹配，用于「里面含XXX的」「其中包吃住的」「里面招大师傅的」`,
    },
    ret: "精确统计值（由代码计算，如 {op,field,value,count,min,max} 或分组结果），不是列表",
    handler: "handleAggregate",
    pageable: false,
  },
  // ============ 操作类工具（有动词=操作；只定位目标，由前端弹确认框执行） ============
  audit_pass: {
    desc: "【操作】审核通过某条帖子（用户说『审核通过/通过审核/把X通过』时用这个，不要用 pending）",
    args: {
      keyword: "用于定位帖子标题/描述的关键词（用户描述的那条帖子）",
      postId: "精确帖子ID（若有则优先，一般不用填）",
      phone: "发布者手机号（可选，用于定位）",
      dataType: "信息类型（可选，辅助定位）",
      city: "城市（可选，辅助定位）",
    },
    ret: "{needConfirm:true, action:'audit', target:{id,title,sub}}（前端会弹确认框）",
    handler: "handleOpLocate",
    pageable: false,
  },
  audit_offline: {
    desc: "【操作】下架某条帖子（用户说『下架/下线X』时用这个，不要用 offline 查询）",
    args: {
      keyword: "用于定位帖子标题/描述的关键词",
      postId: "精确帖子ID（可选）",
      phone: "发布者手机号（可选）",
      dataType: "信息类型（可选）",
      city: "城市（可选）",
    },
    ret: "{needConfirm:true, action:'offline', target:{id,title,sub}}（前端会弹确认框）",
    handler: "handleOpLocate",
    pageable: false,
  },
  top_post: {
    desc: "【操作】置顶某条帖子（用户说『置顶X』时用这个，不要用 tops 查询）",
    args: {
      keyword: "用于定位帖子标题/描述的关键词",
      postId: "精确帖子ID（可选）",
      phone: "发布者手机号（可选）",
      dataType: "信息类型（可选）",
      city: "城市（可选）",
      days: "置顶天数，可填 1/3/7/30（用户说『置顶3天』就填 3），不填默认 7",
    },
    ret: "{needConfirm:true, action:'top', days, target:{id,title,sub}}（前端会弹确认框）",
    handler: "handleOpLocate",
    pageable: false,
  },
  forward_post: {
    desc: "【操作】转发某条帖子到朋友圈（用户说『转发X到朋友圈』时用这个）",
    args: {
      keyword: "用于定位帖子标题/描述的关键词",
      postId: "精确帖子ID（可选）",
      phone: "发布者手机号（可选）",
      dataType: "信息类型（可选）",
      city: "城市（可选）",
    },
    ret: "{needConfirm:true, action:'forward', target:{id,title,sub,content}}（前端会弹确认框选发送账号）",
    handler: "handleOpLocate",
    pageable: false,
  },
  answer: {
    desc: "纯文本回复（不查库）。用于闲聊/解释/给建议",
    args: { text: "直接回复的中文内容" },
    ret: "无",
    handler: null,
    pageable: false,
  },
};

// 从 TOOLS 自动生成「工具清单」段落（保证 AI 看到的与后端能执行的永远一致）
function buildToolDoc() {
  const lines = ["【你拥有的工具（一次只能选一个）】"];
  let i = 0;
  for (const [name, t] of Object.entries(TOOLS)) {
    i += 1;
    const argParts = Object.entries(t.args || {}).map(([k, v]) => `${k}(${v})`).join("，");
    lines.push(`${i}. ${name}  ${t.desc}。入参 {${argParts || "无"}}。返回：${t.ret}`);
  }
  return lines.join("\n");
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

【⚠️ 最高优先级：先判断是「查询」还是「操作」】
- 如果用户的话里含【动词】（要平台去做某件事）—— 如「审核通过 / 通过 / 下架 / 置顶 / 转发到朋友圈」，
  这是【操作】，必须选对应的操作工具：audit_pass / audit_offline / top_post / forward_post，**绝不要用 search/pending**。
- 如果用户只是【问/看】（如「有多少待审核」「查深圳招工」「待审核列表」），那才是查询，用 search/pending。
- 判别口诀：**有动词=操作；只有名词/数量=查询。**
  - "把 X 审核通过" → audit_pass ✅（不是 pending）
  - "审核通过 X" → audit_pass ✅
  - "下架 X" → audit_offline ✅
  - "置顶 X 3天" → top_post(days=3) ✅
  - "把 X 转发到朋友圈" → forward_post ✅
  - "有多少待审核" → pending（查询）
  - "深圳的招工" → search（查询）

${buildToolDoc()}

【条数（limit）规则】
- 列表类查询默认返回 ${DEFAULT_LIMIT} 条；用户若明确说"查100条""最近100条""全部""前50条"等，就把 limit 设为对应数字（最大 ${MAX_LIMIT}）。
- 用户没提条数时，不要自己填 limit，让后端用默认值。

【聚合统计（aggregate）用法（重要）】
- 用户在问「平均值 / 均值 / 最高 / 最低 / 一共多少 / 总数 / 各城市多少 / 各类型多少」这类【指标】时，必须用 aggregate，不要用 search（search 只返回列表）。
- 例："最近100条数据里平均招聘工资是多少" → {"tool":"aggregate","args":{"dataType":"recruit","field":"salary","op":"avg","limit":100}}
- 例："深圳最高的转让费是多少" → {"tool":"aggregate","args":{"dataType":"transfer","field":"price","op":"max","city":"深圳"}}
- 例："各城市的招聘帖分布" → {"tool":"aggregate","args":{"dataType":"recruit","op":"group","groupBy":"city"}}

【在「上一轮结果」内做二次统计 / 列出明细（重要，一定要用 onPrevious）】
- 当用户用【指代词】——「这里面 / 这些 / 刚才那些 / 其中 / 上面这些 / 这批」——来指代【上一轮查询返回的那批结果】时，
  必须用 aggregate 并设 "onPrevious": true（不要再填 limit，系统会自动用上一轮的结果集）。
- 此时可叠加本轮的新条件（如 dataType/city），含义是「在这批结果里再筛出满足新条件的部分」。
- 例（上一轮查了"最近50条信息"，本轮问）："这里面有多少转让信息" → {"tool":"aggregate","args":{"onPrevious":true,"dataType":"transfer","op":"count"}}
- 例："这些里面深圳的有几条" → {"tool":"aggregate","args":{"onPrevious":true,"city":"深圳","op":"count"}}
- 例："刚才那些的平均工资是多少" → {"tool":"aggregate","args":{"onPrevious":true,"field":"salary","op":"avg"}}
- 【列出明细】用户说「列出来 / 看看 / 显示出来 / 详细列一下 / 是哪几条 / 都有哪些」时，
  用 aggregate 且 "op":"list"（列出这批明细），同样带 onPrevious=true（若是针对上一轮/上一统计结果）。
  - 例："列出来看看" → {"tool":"aggregate","args":{"onPrevious":true,"op":"list"}}
  - 例（上一轮数出8条转让后）："把这8条列出来" → {"tool":"aggregate","args":{"onPrevious":true,"op":"list"}}
  - 例："这些里面深圳的列出来" → {"tool":"aggregate","args":{"onPrevious":true,"city":"深圳","op":"list"}}
- ⚠️ 判断口诀：**含「这里面/这些/刚才那些/列出来/看看」= 在上一轮结果内操作（onPrevious=true，统计用 count/avg…、列明细用 list）；说「最近N条/全库」= 全库查询（不填 onPrevious，用 limit）。**
- ⚠️ 若上一轮没有结果集，onPrevious 会返回"结果集失效"的提示，你如实转达即可。
- ⚠️ 「列出来」是【查询明细】，不是操作工具；不要误选 audit/offline 等操作类工具。

【操作类工具（audit_pass / audit_offline / top_post / forward_post）用法（重要）】
- 用户说「审核通过 / 通过审核」「下架」「置顶」「转发到朋友圈」这类【要改动数据】的话时，用对应操作工具。
- 这类工具【只定位目标】，不会真正执行；后端会返回待确认信息，由小程序弹出确认框、管理员点确认后才真正执行。
- ⚠️ 你【绝不能】在回复里声称"已通过 / 已下架 / 已置顶 / 已转发"，因为还没执行。定位成功后，后端会直接把「待确认卡片 + 确认按钮」返回给用户，你的总结只需简短说明"已定位到这条信息，请确认后执行"即可。
- keyword 填【用户描述里最有辨识度的一个连续词】，不要拼多个词、不要加空格（如用户说"深圳宝安那个大师傅"→ keyword 填 "宝安" 或 "大师傅"，二选一，别填"深圳宝安 大师傅"）；若用户说了手机号则填 phone。
- 例："把深圳福田招大师傅那条审核通过" → {"tool":"audit_pass","args":{"keyword":"深圳福田招大师傅"}}
- 例："下架这条：南山科技园招售卖员" → {"tool":"audit_offline","args":{"keyword":"南山科技园招售卖员"}}
- 例："把广州天河招夫妻工置顶7天" → {"tool":"top_post","args":{"keyword":"广州天河招夫妻工","days":7}}
- 例："把这条转发到朋友圈：成都招学徒工" → {"tool":"forward_post","args":{"keyword":"成都招学徒工"}}
- 【定位不到唯一一条时不要猜】：若目标有多条（如只说"下架这条"但没描述），后端会返回候选让你追问，你如实告知用户"请说清楚是哪一条"。

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

【判断优先级（务必先分查询/操作）】
① 有动词=操作：审核通过→audit_pass；下架某条→audit_offline；置顶某条→top_post；转发某条→forward_post。
② 无动词=查询：手机号→phone；统计概览→stats；查待审列表→pending；查已下架列表→offline；订单收入→orders；用户会员→users；商家→merchants；查置顶列表→tops；日志→logs；看广告/查广告列表→ads；广告上下线→adToggle；按城市/类型/关键词找帖子→search；闲聊解释建议→answer；拿不准→stats。

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

【管理员反馈「你答错了」→ 必须输出 correction.isMistake（越用越聪明）】
- 当管理员指出【上一轮你的回答错了 / 理解错了 / 应该用另一种方式】，即话里含
  「不对」「错了」「答错了」「应该是…」「不是这样」「你理解错了」「我要的是…不是…」「重新查，应该…」等语义时，
  你必须【同时】做两件事：① 选一个 tool 按【正确的理解】重新回答；② 在 JSON 里带 correction 字段，且 isMistake=true。
- correction 结构（isMistake 版）：
  {"isMistake": true, "lesson": "一句话说清错在哪、正确应该怎么理解", "expectTool": "正确的工具名", "expectArgs": {"正确参数": "..."}}
- 字段说明：
  lesson：必填。用管理员的口吻总结这次教训（后端会写入错误库，注入后续 prompt）。
  expectTool / expectArgs：你这次"正确的理解"（也就是你 ① 里实际选的 tool 和 args），便于后端对照学习。
- 示例：
  输入"不对，我要的是深圳不是广州"
  输出 {"tool":"search","args":{"dataType":"recruit","city":"深圳","limit":5},"correction":{"isMistake":true,"lesson":"用户要的是深圳，上一轮误按广州查询了","expectTool":"search","expectArgs":{"city":"深圳"}}}
  输入"错了，这不是查询是要我下架它"
  输出 {"tool":"audit_offline","args":{"keyword":"..."},"correction":{"isMistake":true,"lesson":"这是操作（下架）意图，不是查询，应选 audit_offline","expectTool":"audit_offline","expectArgs":{"keyword":"..."}}}
- ⚠️ 区分两种纠正：
  「教你一个说法/别名」（如"以后收店=求店"）→ 用 isRule（上文）。
  「指出你上一轮答错/理解错」→ 用 isMistake（本段）。两者都不符合则【整个 correction 字段都不要输出】。

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

  // 分页：page 从 1 开始；pageSize 默认 5
  // 兼容两种入参：pageSize（显式分页，规则模式沿用）优先；未给则取 limit（AI 模式给条数）；都没有用默认 5。
  const page = Math.max(1, parseInt(intent.page, 10) || 1);
  const rawSize = intent.pageSize != null ? intent.pageSize : intent.limit;
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, parseInt(rawSize, 10) || DEFAULT_LIMIT));

  const list = await fetchPostsPage(query, page, pageSize);
  return { list, total, page, pageSize };
}

// 拉取某页数据：pageSize 超过单次上限（100）时自动分批，跨过限制拼接，
// 保证 AI 模式下"查 100/200 条"能真正拿到全部数据（而不是被截断）。
async function fetchPostsPage(query, page, pageSize) {
  const skipBase = (page - 1) * pageSize;
  if (pageSize <= SINGLE_QUERY_MAX) {
    const res = await db.collection(COLLECTION)
      .where(query)
      .orderBy("published_at", "desc")
      .skip(skipBase)
      .limit(pageSize)
      .get();
    return res.data || [];
  }
  // 分批拼接：每批最多 SINGLE_QUERY_MAX 条
  const all = [];
  while (all.length < pageSize) {
    const want = Math.min(SINGLE_QUERY_MAX, pageSize - all.length);
    const batch = await db.collection(COLLECTION)
      .where(query)
      .orderBy("published_at", "desc")
      .skip(skipBase + all.length)
      .limit(want)
      .get();
    const got = batch.data || [];
    all.push(...got);
    if (got.length < want) break; // 已到底，无需继续
  }
  return all;
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
    rawList: list, // 结果集记忆用（供「这里面…」二次统计）
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
    rawList: list,
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
    rawList: list, // 结果集记忆用（供「这里面…」二次统计）
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

// ==================== 聚合统计（聚合计算工具） ====================
// 关键原则：平均值/最高/最低等「精确数值」必须由代码计算，绝不让 LLM 心算。
// 支持算子：avg/min/max/sum/count/group（分组统计）。
// 字段枚举：salary/price/monthly_rent/area_sqm。
const AGG_FIELDS = {
  salary: "工资/薪资",
  price: "转让费/价格",
  monthly_rent: "月租",
  area_sqm: "面积",
};
const AGG_FIELD_SET = Object.keys(AGG_FIELDS);
const AGG_OPS = ["avg", "min", "max", "sum", "count", "group", "list"];
const AGG_LIST_MAX = 50; // count/list 自动附明细的最大条数（超出只提示，不列出，防列表过长）
const AGG_GROUP_BY = ["city", "data_type"];

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ==================== 结果集记忆（支持「这里面/这些」二次统计） ====================
// 背景：AI 多轮追问「这里面有多少转让」时，需要「上一轮结果集」这个实体来指代，
// 而不能只靠 tool+args 重新查库（那就变成“全库最近N条”而非“上一次那 N 条”）。
// 做法：每次列表类查询后把结果集快照落库，返回 resultSetId 给前端；下一轮 aggregate
// 带 onPrevious=true 时，按 resultSetId 取回这批帖子 id，仅在该集合内做统计（数字仍由代码算）。
const RESULT_SET_TTL = 24 * 3600 * 1000;   // 结果集有效期（24h，过期视为失效）
const RESULT_SET_MAX_IDS = 500;            // 单个结果集最多保存的帖子 id（防文档过大）
const RESULT_SET_KEEP_MAX = 10;            // 云端最多保留的结果集条数（超出按时间删最旧；收紧以防 onUnload 丢失）

// 清理结果集：① 删除已过期记录 ② 若总条数超过 RESULT_SET_KEEP_MAX，删除最旧的若干条。
// 说明：正常场景由前端「真正关闭页面（onUnload）时清理」负责；但 onUnload 里发请求不可靠
//       （页面销毁时可能发不出），故这里是【关键兜底】，防止结果集无限堆积。
// 全程静默失败，不影响主流程。
async function pruneResultSets() {
  try {
    const now = Date.now();
    // ① 清理过期
    await db.collection(AI_RESULT_SETS)
      .where({ created_at: _.lt(now - RESULT_SET_TTL) })
      .remove();
    // ② 超量清理：按 created_at 升序取「超出部分」的 _id 删掉
    const totalRes = await db.collection(AI_RESULT_SETS).count();
    const total = (totalRes && totalRes.total) || 0;
    if (total > RESULT_SET_KEEP_MAX) {
      const excess = total - RESULT_SET_KEEP_MAX;
      const oldRes = await db.collection(AI_RESULT_SETS)
        .orderBy("created_at", "asc")
        .limit(Math.min(excess, 100))
        .field({ _id: true })
        .get();
      const ids = (oldRes.data || []).map((d) => d._id).filter(Boolean);
      if (ids.length) {
        await db.collection(AI_RESULT_SETS).where({ _id: _.in(ids) }).remove();
      }
    }
  } catch (e) {
    console.error("[adminChat] pruneResultSets 失败:", e && e.errMsg);
  }
}

// 保存一份结果集快照，返回 resultSetId（失败返回 null，不阻断主流程）
async function saveResultSet(question, tool, args, list) {
  try {
    const posts = Array.isArray(list) ? list : [];
    const ids = posts.map((p) => p && p._id).filter(Boolean).slice(0, RESULT_SET_MAX_IDS);
    if (!ids.length) return null;
    // 紧凑摘要（供 AI 在 Stage2 理解这批是什么，不含完整 detail，省 token）
    const summary = posts.slice(0, 50).map((p) => ({
      t: p.data_type || "",
      c: p.city || p.province || "",
      s: Number(p.salary) > 0 ? Number(p.salary) : (Number(p.price) > 0 ? Number(p.price) : 0),
      k: String(p.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 24),
    }));
    const res = await db.collection(AI_RESULT_SETS).add({
      data: {
        question: String(question || "").slice(0, 200),
        tool: tool || "",
        args: args || {},
        ids,
        count: ids.length,
        summary,
        created_at: Date.now(),
      },
    });
    // 写入时顺手清理。必须 await：云函数在 return 后可能被立即冻结，
    // 若 fire-and-forget 则清理很可能根本没执行（这层是 onUnload 请求丢失时的关键兜底）。
    await pruneResultSets();
    return res && res._id ? res._id : null;
  } catch (e) {
    console.error("[adminChat] saveResultSet 失败:", JSON.stringify({
      errMsg: e && e.errMsg, errCode: e && e.errCode, message: e && e.message,
    }));
    return null;
  }
}

// 读取一份结果集（过期返回 null 并顺手删除，避免遗留垃圾）
async function loadResultSet(id) {
  if (!id) return null;
  const key = String(id);
  try {
    const r = await db.collection(AI_RESULT_SETS).doc(key).get();
    const d = r && r.data;
    if (!d || !Array.isArray(d.ids)) return null;
    if (d.created_at && Date.now() - Number(d.created_at) > RESULT_SET_TTL) {
      // 惰性删除：过期即物理删除（不 await，不阻断主流程）
      db.collection(AI_RESULT_SETS).doc(key).remove().catch(() => {});
      return null;
    }
    return d;
  } catch (e) {
    console.error("[adminChat] loadResultSet 失败:", e && e.errMsg);
    return null;
  }
}

// 按 id 数组查回帖子实体（分批 in 查询，跨过单次 in 数量限制）
async function fetchPostsByIds(ids) {
  const all = [];
  const CHUNK = 80;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const r = await db.collection(COLLECTION).where({ _id: _.in(chunk) }).get();
      all.push(...(r.data || []));
    } catch (e) {
      console.error("[adminChat] fetchPostsByIds 失败:", e && e.errMsg);
    }
  }
  return all;
}

// ==================== 会话记忆（页面打开期间的连续对话） ====================
// 目的：让「连续对话」真正连贯——条件可累积、结果集成链（可指代上一轮/上上轮）、
//       保留最近若干轮问答，供 Stage1 理解指代与延续。
// 生命周期：前端打开页面时生成 sessionId，每次提问带上；关闭页面时删除（再打开即新会话）。
const SESSION_TTL = 2 * 3600 * 1000;        // 会话有效期（2h，兜底：前端未清理时自动失效）
const SESSION_TURNS_MAX = 6;                // 只保留最近 N 轮问答（控 token）
const SESSION_RESULT_STACK_MAX = 3;         // 结果集链最多保留最近 N 个（栈）
const SESSION_KEEP_MAX = 30;                // 云端最多保留的会话数（超出删最旧）

function emptySession(id) {
  return {
    _id: id,
    condition: {},          // 累积筛选条件（合并，不覆盖）：city/dataType/salaryMax/...
    resultStack: [],        // 结果集链（栈，最新在末尾）：[{ resultSetId, count, desc, at }]
    turns: [],              // 最近若干轮：{ q, a, tool, at }
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

// 读取会话（不存在/过期返回新建的空会话）
async function loadSession(id) {
  const key = String(id || "").trim();
  if (!key) return emptySession("");
  try {
    const r = await db.collection(AI_SESSIONS).doc(key).get();
    const d = r && r.data;
    if (d && d._id) {
      if (d.updated_at && Date.now() - Number(d.updated_at) > SESSION_TTL) {
        // 过期即惰性删除
        db.collection(AI_SESSIONS).doc(key).remove().catch(() => {});
        return emptySession(key);
      }
      return Object.assign(emptySession(key), d);
    }
  } catch (e) { /* 不存在，视为新会话 */ }
  return emptySession(key);
}

// 写入/更新会话（整体 set，简单可靠）
async function saveSession(session) {
  const key = String((session && session._id) || "").trim();
  if (!key) return;
  const data = Object.assign({}, session, { updated_at: Date.now() });
  delete data._id;
  try {
    await db.collection(AI_SESSIONS).doc(key).set({ data });
  } catch (e) {
    console.error("[adminChat] saveSession 失败:", e && e.errMsg);
  }
}

// 把会话拼成一段注入 Stage1 的说明（条件 + 结果集链 + 最近轮次）
function buildSessionBlock(session) {
  if (!session) return "";
  const parts = [];
  const cond = session.condition || {};
  const condKeys = Object.keys(cond).filter((k) => cond[k] != null && cond[k] !== "");
  const stack = Array.isArray(session.resultStack) ? session.resultStack : [];
  const turns = Array.isArray(session.turns) ? session.turns : [];

  if (!condKeys.length && !stack.length && !turns.length) return "";

  parts.push("【多轮会话记忆（本页连续对话）】");
  if (condKeys.length) {
    parts.push(`已累积的筛选条件：${JSON.stringify(cond)}（若本轮未提及某条件，可沿用）`);
  }
  if (stack.length) {
    parts.push(`结果集链（按时间顺序，共 ${stack.length} 个）：`);
    stack.forEach((s, i) => {
      const tag = i === stack.length - 1 ? " ← 最新（“这里面/这些/列出来”默认指它）" : (i === 0 ? " ← 最早（“最开始那批”指它）" : "");
      parts.push(`  ${i + 1}. ${s.desc || "查询结果"}｜${s.count || 0} 条${tag}`);
    });
  }
  if (turns.length) {
    parts.push("最近几轮对话：");
    turns.slice(-4).forEach((t, i) => {
      parts.push(`  第${i + 1}轮：用户「${String(t.q || "").slice(0, 40)}」→ 工具 ${t.tool || ""}`);
    });
  }
  parts.push("【指代规则（重要）】");
  parts.push("A. 【在上一轮结果内操作】用户用「这里面/这些/刚才那些/其中/列出来/看看/只保留某类/平均多少」，" +
    "→ 用 aggregate 并带 onPrevious=true（系统自动关联最新结果集）；列明细用 op=list 或 op=count。");
  parts.push("B. 【指代更早的那批】用户说「最开始那批/最早那批/第一次查的」，→ 用 aggregate 并带 onPrevious=true + stackIndex=0（指最早的）。");
  parts.push("C. 【换主题（全新查询）】出现「改成/换成/那…呢/另外/换个/不看这个了/重新查」+ 一个新的信息类型或城市，" +
    "且与当前结果集主题明显不同 → 【不要】带 onPrevious，走全库查询（用 limit/条件）。");
  parts.push("⚠️ 口诀：【这里面/这些/列出来】=在上一批内；【最开始那批】=最早一批；【改成/换成/另外/重新看】=换主题、走全库。");
  return "\n\n" + parts.join("\n");
}

// 会话收尾：合并条件、push 结果集、追加轮次，并裁剪长度
function updateSession(session, { question, answerText, tool, args, resultSet }) {
  if (!session) return;
  // ① 条件合并（本轮有的覆盖，没有的保留）
  const a = args || {};
  const cond = session.condition || {};
  const COND_KEYS = ["city", "dataType", "salaryMin", "salaryMax", "priceMin", "priceMax", "rentMin", "rentMax", "auditState"];
  COND_KEYS.forEach((k) => { if (a[k] != null && a[k] !== "") cond[k] = a[k]; });
  session.condition = cond;
  // ② 结果集链（push 新结果集）
  if (resultSet && resultSet.resultSetId) {
    const stack = Array.isArray(session.resultStack) ? session.resultStack : [];
    stack.push({
      resultSetId: resultSet.resultSetId,
      count: resultSet.count || 0,
      desc: resultSet.desc || question.slice(0, 30),
      at: Date.now(),
    });
    session.resultStack = stack.slice(-SESSION_RESULT_STACK_MAX);
  }
  // ③ 轮次记录（截断）。同时记 args，供「用户反馈答错」时回填错误库。
  const turns = Array.isArray(session.turns) ? session.turns : [];
  turns.push({
    q: String(question || "").slice(0, 100),
    a: String(answerText || "").slice(0, 120),
    tool: tool || "",
    args: args || {},          // 本轮实际使用的参数（错误库回溯用）
    at: Date.now(),
  });
  session.turns = turns.slice(-SESSION_TURNS_MAX);
}

// ==================== 错误库（越测越聪明：把误判沉淀成经验，注入 prompt） ====================
// 目的：测试/使用中发现的「意图识别误判」，结构化记录（场景/错在哪/应该怎么理解），
//       每次 Stage1 自动读取最近若干条注入 prompt，让 AI 下次遇到类似场景不再犯。
// 与「纠正记忆(corrections)」互补：corrections 记用户教的别名，mistakes 记 AI 的典型误判。
const MISTAKE_KEEP_MAX = 40;     // 错误库最多保留条数（超出删最旧）
const MISTAKE_INJECT_MAX = 12;   // 每次注入 prompt 的最大条数（控 token）

// 写一条错误经验（去重：同 question 场景覆盖式更新）
async function saveMistake({ question, wrongTool, wrongArgs, expectTool, expectArgs, lesson, source }) {
  try {
    const q = String(question || "").slice(0, 120);
    if (!q || !lesson) return null;
    const doc = {
      question: q,
      wrongTool: String(wrongTool || "").slice(0, 40),
      wrongArgs: wrongArgs ? JSON.stringify(wrongArgs).slice(0, 300) : "",
      expectTool: String(expectTool || "").slice(0, 40),
      expectArgs: expectArgs ? JSON.stringify(expectArgs).slice(0, 300) : "",
      lesson: String(lesson).slice(0, 300),
      source: String(source || "manual").slice(0, 30),
      at: Date.now(),
    };
    // 同场景覆盖（避免重复条目堆积）
    const exist = await db.collection(AI_MISTAKES).where({ question: q }).limit(1).get();
    if (exist.data && exist.data.length) {
      await db.collection(AI_MISTAKES).doc(exist.data[0]._id).set({ data: doc });
      return exist.data[0]._id;
    }
    const r = await db.collection(AI_MISTAKES).add({ data: doc });
    await pruneMistakes();   // 必须 await：云函数 return 后会被冻结，fire-and-forget 将导致清理不执行
    return r && r._id ? r._id : null;
  } catch (e) {
    console.error("[adminChat] saveMistake 失败:", e && e.errMsg);
    return null;
  }
}

// 读取最近的错误经验（供注入 prompt）
async function loadMistakes(limit) {
  try {
    const n = Math.min(Number(limit) || MISTAKE_INJECT_MAX, MISTAKE_INJECT_MAX);
    const r = await db.collection(AI_MISTAKES)
      .orderBy("at", "desc").limit(n).get();
    return (r.data || []).reverse();  // 时间正序，便于阅读
  } catch (e) {
    return [];
  }
}

// 超量清理（保留最近 MISTAKE_KEEP_MAX 条）
async function pruneMistakes() {
  try {
    const totalRes = await db.collection(AI_MISTAKES).count();
    const total = (totalRes && totalRes.total) || 0;
    if (total > MISTAKE_KEEP_MAX) {
      const excess = Math.min(total - MISTAKE_KEEP_MAX, 50);
      const oldRes = await db.collection(AI_MISTAKES)
        .orderBy("at", "asc").limit(excess).field({ _id: true }).get();
      const ids = (oldRes.data || []).map((d) => d._id).filter(Boolean);
      if (ids.length) await db.collection(AI_MISTAKES).where({ _id: _.in(ids) }).remove();
    }
  } catch (e) {
    console.error("[adminChat] pruneMistakes 失败:", e && e.errMsg);
  }
}

// 把错误库拼成注入 Stage1 的「经验教训」段落
function buildMistakeBlock(mistakes) {
  const list = Array.isArray(mistakes) ? mistakes.filter((m) => m && m.lesson) : [];
  if (!list.length) return "";
  const lines = ["【历史误判经验（务必避免重犯）】"];
  list.forEach((m, i) => {
    lines.push(`${i + 1}. 场景「${m.question}」：容易错成 ${m.wrongTool || "?"}(${m.wrongArgs || "-"})；正确应 ${m.expectTool || "?"}(${m.expectArgs || "-"})。教训：${m.lesson}`);
  });
  return "\n\n" + lines.join("\n");
}

// 会话超量清理（兜底：前端未清理时防止堆积）
async function pruneSessions() {
  try {
    const now = Date.now();
    await db.collection(AI_SESSIONS).where({ updated_at: _.lt(now - SESSION_TTL) }).remove();
    const totalRes = await db.collection(AI_SESSIONS).count();
    const total = (totalRes && totalRes.total) || 0;
    if (total > SESSION_KEEP_MAX) {
      const excess = Math.min(total - SESSION_KEEP_MAX, 100);
      const oldRes = await db.collection(AI_SESSIONS)
        .orderBy("updated_at", "asc").limit(excess).field({ _id: true }).get();
      const ids = (oldRes.data || []).map((d) => d._id).filter(Boolean);
      if (ids.length) await db.collection(AI_SESSIONS).where({ _id: _.in(ids) }).remove();
    }
  } catch (e) {
    console.error("[adminChat] pruneSessions 失败:", e && e.errMsg);
  }
}

// 组装聚合查询条件（复用 queryPosts 的过滤口径，构造一个 intent）
function buildAggIntent(args) {
  const a = args || {};
  // 条数规则：
  //   · 有【时间范围】(timeWithinDays) 时，统计应对「该时间范围内全部数据」进行，
  //     不能被默认 limit=5 截断（否则「最近7天平均转让费」只算最近5条，结果失真）。
  //   · 无时间范围时：默认 DEFAULT_LIMIT，AI 给了 limit 就用 AI 的（封顶 MAX_LIMIT）。
  const hasTime = a.timeWithinDays != null && Number(a.timeWithinDays) > 0;
  const limitVal = hasTime
    ? Math.min(MAX_LIMIT, Math.max(1, parseInt(a.limit, 10) || MAX_LIMIT))
    : Math.min(MAX_LIMIT, Math.max(1, parseInt(a.limit, 10) || DEFAULT_LIMIT));
  const intent = {
    type: "search",
    dataType: a.dataType || null,
    city: a.city || null,
    cityCode: null,
    isProvince: false,
    keyword: a.keyword || "",
    limit: limitVal,
  };
  if (a.city) {
    const r = detectIntent(String(a.city), 1);
    intent.cityCode = r.cityCode || null;
    intent.isProvince = r.isProvince || false;
  }
  if (a.salaryMin != null) intent.salaryMin = Number(a.salaryMin);
  if (a.salaryMax != null) intent.salaryMax = Number(a.salaryMax);
  if (a.priceMin != null) intent.priceMin = Number(a.priceMin);
  if (a.priceMax != null) intent.priceMax = Number(a.priceMax);
  if (a.rentMin != null) intent.rentMin = Number(a.rentMin);
  if (a.rentMax != null) intent.rentMax = Number(a.rentMax);
  if (a.timeWithinDays != null) {
    const d = Number(a.timeWithinDays);
    if (d > 0) intent.timeMin = Date.now() - d * 86400000;
  }
  if (a.auditState) intent.auditState = a.auditState;
  return intent;
}

async function handleAggregate(args) {
  const a = args || {};
  const field = AGG_FIELD_SET.indexOf(String(a.field)) >= 0 ? String(a.field) : "salary";
  const op = AGG_OPS.indexOf(String(a.op)) >= 0 ? String(a.op) : "avg";
  const groupBy = AGG_GROUP_BY.indexOf(String(a.groupBy)) >= 0 ? String(a.groupBy) : "city";
  const excludeZero = a.excludeZero === false ? false : true;

  // ===== 模式A：在「上一轮结果集」内统计（用户说“这里面/这些/刚才那些”） =====
  // 用 resultSetId 取回上一轮那批帖子实体，仅在这批范围内做过滤与统计（不再全库重查）
  if (a.onPrevious || a.resultSetId) {
    return aggregateOnResultSet(a, { field, op, groupBy, excludeZero });
  }

  // ===== 模式B：全库统计（原有行为） =====
  const intent = buildAggIntent(a);
  const { list } = await queryPosts(intent);
  const scanned = list.length;
  const fieldName = AGG_FIELDS[field];
  const typeName = intent.dataType ? (TYPE_NAMES[intent.dataType] || "") : "";
  const cityName = intent.city || "";
  // 样本范围文案：group 模式描述的是「帖子」，数值模式才带上字段名
  const subject = op === "group" ? "帖子" : fieldName;
  // 有时间范围时，文案说明时间；否则说明取最近 N 条
  const rangeText = (a.timeWithinDays != null && Number(a.timeWithinDays) > 0)
    ? `最近 ${Number(a.timeWithinDays)} 天内`
    : `取最近 ${intent.limit} 条`;
  const scopeLabel = `${cityName ? cityName + "的" : ""}${typeName || "全部"}${subject}（${rangeText}）`;

  if (!scanned) {
    return { title: `${fieldName}统计`, blocks: [{ type: "empty", text: `暂无数据可统计（${scopeLabel}）` }] };
  }

  const built = buildAggBlocks({ list, field, op, groupBy, excludeZero, scopeLabel, scanned });
  if (built) return built;

  return {
    title: `${fieldName}统计`,
    blocks: [{ type: "empty", text: `最近 ${scanned} 条中，没有可用于统计的${fieldName}数据（多为面议/未填）` }],
  };
}

// 解析「要操作哪个结果集」：支持三种来源
//   ① a.resultSetId 精确指定
//   ② a.stackIndex：0=最早（“最开始那批”）、-1=最新（“上一轮/这里面”，默认）
//   ③ 都没有 → 默认最新（栈顶）
// 返回 { rs, label }（rs 为 loadResultSet 的文档）
async function resolveResultSetRef(a) {
  const args = a || {};
  const sessionId = args.__sessionId;           // 由 handleDeepThink 注入
  if (args.resultSetId) {
    return { rs: await loadResultSet(args.resultSetId), label: "指定批次" };
  }
  if (sessionId) {
    const session = await loadSession(sessionId);
    const stack = (session && session.resultStack) || [];
    if (stack.length) {
      const idx = args.stackIndex === 0 ? 0 : (stack.length - 1);
      const item = stack[idx];
      const label = idx === 0 ? "最开始那批" : "上一轮";
      return { rs: await loadResultSet(item.resultSetId), label };
    }
  }
  if (args.resultSetId) return { rs: await loadResultSet(args.resultSetId), label: "指定批次" };
  return { rs: null, label: "上一轮" };
}

// 在「上一轮结果集」内做二次统计：取回该 resultSet 的帖子实体，应用本轮新增过滤条件，再统计。
// 数字仍由代码计算；若结果集不存在/过期，则明确告知而不是兜底重查（避免语义错位）。
async function aggregateOnResultSet(a, { field, op, groupBy, excludeZero }) {
  const fieldName = AGG_FIELDS[field];
  const rsMeta = await resolveResultSetRef(a);   // 支持按 id / 按栈位置（最早/上一轮）
  const rs = rsMeta && rsMeta.rs;
  if (!rs) {
    return {
      title: `${fieldName}统计`,
      blocks: [{ type: "empty", text: "上一轮的结果集已失效（可能过期或未开启上下文），请先重新查询那批数据，再追问「这里面…」。" }],
      resultSetInvalid: true,
    };
  }
  const refLabel = rsMeta.label || "上一轮";

  // 取回帖子实体（保持上一轮的先后顺序）
  const raw = await fetchPostsByIds(rs.ids);
  const order = {};
  rs.ids.forEach((id, i) => { order[id] = i; });
  raw.sort((x, y) => (order[x._id] || 0) - (order[y._id] || 0));

  // 代入本轮新增的过滤条件（在结果集内再筛，如「这里面深圳的有几条」）
  let list = raw;
  if (a.dataType) list = list.filter((p) => p.data_type === a.dataType);
  if (a.city) {
    const r = detectIntent(String(a.city), 1);
    const code = r.cityCode;
    list = list.filter((p) => (code && (p.city_code === code || p.district_code === code)) || p.city === a.city);
  }
  // 关键词过滤（如「其中包吃住的」「里面招大师傅的」）——在结果集内做包含匹配
  if (a.keyword) {
    const words = String(a.keyword).trim().split(/[\s,，、/]+/).map((s) => s.trim()).filter(Boolean);
    if (words.length) {
      list = list.filter((p) => {
        const hay = [
          p.raw_text, p.role, p.contact, p.username, p.address,
          p.service_area, p.remark, p.availability, p.content,
        ].filter(Boolean).join(" ").toLowerCase();
        return words.some((w) => hay.indexOf(String(w).toLowerCase()) >= 0);
      });
    }
  }
  if (a.salaryMin != null) list = list.filter((p) => Number(p.salary) > 0 && Number(p.salary) >= Number(a.salaryMin));
  if (a.salaryMax != null) list = list.filter((p) => Number(p.salary) > 0 && Number(p.salary) <= Number(a.salaryMax));
  if (a.priceMin != null) list = list.filter((p) => Number(p.price) > 0 && Number(p.price) >= Number(a.priceMin));
  if (a.priceMax != null) list = list.filter((p) => Number(p.price) > 0 && Number(p.price) <= Number(a.priceMax));

  const scanned = list.length;
  const prevCount = rs.count || rs.ids.length;
  const scopeLabel = `${refLabel}的 ${prevCount} 条结果${a.dataType ? "中的" + (TYPE_NAMES[a.dataType] || "") : ""}${a.keyword ? `含「${a.keyword}」` : ""}（共匹配 ${scanned} 条）`;

  const built = buildAggBlocks({ list, field, op, groupBy, excludeZero, scopeLabel, scanned, prevCount });
  const result = built || { title: `${fieldName}统计`, blocks: [{ type: "empty", text: `上一轮结果中未匹配到可统计的数据（${scopeLabel}）` }] };

  // ===== 结果集链：把本次「命中集合」固化为新结果集 =====
  // 这样下一轮可继续指代（如「列出来看看」「这8条里深圳的几条」），实现 A→B→C 无限追问。
  // 仅在有命中且为 count/list 类（明细可继续用）时落库，避免 avg 之类无意义快照。
  try {
    if (list.length && (op === "count" || op === "list" || op === "group")) {
      const newId = await saveResultSet(`（上一轮${prevCount}条中）${TYPE_NAMES[a.dataType] || "筛选"}`, "aggregate", a, list);
      if (newId) {
        result.resultSetId = newId;
        result.resultCount = list.length;
        result.__derivedDesc = `上一轮${prevCount}条中的${a.dataType ? (TYPE_NAMES[a.dataType] || "") : "筛选结果"}`;
      }
    }
  } catch (e) {
    console.error("[adminChat] 结果集链落库失败:", e && e.message);
  }
  return result;
}

// 统计块构造（两种模式共用）：group 分组 / 数值统计
// 返回 null 表示「无可统计数值」（交由调用方决定 empty 文案）
function buildAggBlocks({ list, field, op, groupBy, excludeZero, scopeLabel, scanned, prevCount }) {
  const fieldName = AGG_FIELDS[field];
  const listLen = list.length;

  // 分组统计：按 city / data_type 分组
  if (op === "group") {
    if (!listLen) return null;
    const groups = {};
    for (const p of list) {
      const key = groupBy === "city"
        ? ([p.city || p.province || "未知地区"]).join("")
        : (TYPE_NAMES[p.data_type] || p.data_type || "其他");
      groups[key] = (groups[key] || 0) + 1;
    }
    const entries = Object.entries(groups).sort((a2, b2) => b2[1] - a2[1]);
    const items = entries.map(([k, v]) => ({
      text: k,
      sub: `${v} 条 · 占比 ${round2((v / listLen) * 100)}%`,
      tag: String(v),
      tagColor: "primary",
    }));
    return {
      title: `按${groupBy === "city" ? "城市" : "类型"}分组统计`,
      blocks: [
        { type: "text", text: `样本范围：${scopeLabel}，共 ${listLen} 条。` },
        { type: "section", title: "分组结果" },
        { type: "list", items },
      ],
    };
  }

  // 数值统计：仅取该字段有效（>0，或按 excludeZero 决定）的记录
  const nums = [];
  for (const p of list) {
    const v = Number(p[field]);
    if (!isFinite(v)) continue;
    if (excludeZero && !(v > 0)) continue;
    nums.push(v);
  }
  // op=list：只列出命中明细（不统计），用于「列出来看看」
  if (op === "list") {
    if (!listLen) return null;
    const shown = list.slice(0, AGG_LIST_MAX);
    const blocks = [
      { type: "text", text: `样本范围：${scopeLabel}，共 ${listLen} 条。` },
      { type: "section", title: "明细" },
      { type: "list", items: shown.map(postToItem) },
    ];
    if (listLen > shown.length) {
      blocks.push({ type: "text", text: `（仅显示前 ${shown.length} 条，共 ${listLen} 条）` });
    }
    return { title: "明细列表", blocks };
  }

  // op=count：纯计数（数条数）。
  // 若调用方明确给了 field（如“其中多少条有工资”），才附字段维度；否则只给总数，避免误导。
  // 同时：命中数在阈值内时【附带明细列表】，让「有多少」能直接看到是哪些（无需再追问）。
  if (op === "count") {
    const withField = nums.length;
    const items = [
      { label: "总数", value: String(listLen), unit: "条", color: "#597EF7" },
    ];
    if (withField > 0) {
      items.push({ label: `有明确${fieldName}`, value: String(withField), unit: "条", color: "#36CFC9" });
      items.push({ label: "面议/未填", value: String(listLen - withField), unit: "条", color: "#FF7A45" });
    }
    const blocks = [
      { type: "text", text: `样本范围：${scopeLabel}。` },
      { type: "kpi", items },
      { type: "text", text: `结论：${scopeLabel} → 共 ${listLen} 条。` },
    ];
    // 附带明细（阈值内）
    if (listLen > 0 && listLen <= AGG_LIST_MAX) {
      blocks.push({ type: "section", title: "明细" });
      blocks.push({ type: "list", items: list.map(postToItem) });
    } else if (listLen > AGG_LIST_MAX) {
      blocks.push({ type: "text", text: `（命中 ${listLen} 条，超过 ${AGG_LIST_MAX} 条不自动列出；说「列出来看看」可查看前 ${AGG_LIST_MAX} 条）` });
    }
    return { title: `计数统计`, blocks };
  }

  if (!nums.length) return null;
  const count = nums.length;
  const sum = nums.reduce((s, n) => s + n, 0);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = sum / count;
  let value = avg;
  let opLabel = "平均";
  if (op === "min") { value = min; opLabel = "最低"; }
  else if (op === "max") { value = max; opLabel = "最高"; }
  else if (op === "sum") { value = sum; opLabel = "合计"; }

  const unit = field === "area_sqm" ? "㎡" : "元";
  const statText = `${opLabel}${fieldName} ${round2(value)} ${unit}`;
  const pctText = prevCount ? `，占上一轮 ${prevCount} 条的 ${round2((listLen / prevCount) * 100)}%` : "";

  return {
    title: `${fieldName}${opLabel}统计`,
    blocks: [
      { type: "text", text: `样本范围：${scopeLabel}，其中 ${count} 条有明确${fieldName}，${listLen - count} 条为面议/未填已排除${pctText}。` },
      {
        type: "kpi",
        items: [
          { label: `${opLabel}${fieldName}`, value: String(round2(value)), unit, color: "#597EF7" },
          { label: "最低", value: String(round2(min)), unit, color: "#36CFC9" },
          { label: "最高", value: String(round2(max)), unit, color: "#FF7A45" },
          { label: "有效样本", value: String(count), unit: "条", color: "#9254DE" },
        ],
      },
      { type: "text", text: `结论：${scopeLabel} → ${statText}（区间 ${round2(min)}~${round2(max)} ${unit}）。` },
    ],
  };
}

// ==================== 操作类工具：定位目标，返回「待确认」（不直接执行） ====================
// 安全设计：AI 只负责识别意图 + 定位目标，绝不直接改库。
// 云函数返回 { needConfirm:true, action, ...target }，由小程序弹 TDesign 确认层，
// 管理员点确认后才由前端调用 adminAuth / wxTask 真正执行。
//
// action 映射：tool → 执行动作
const OP_TOOL_MAP = {
  audit_pass: { action: "audit", label: "审核通过" },
  audit_offline: { action: "offline", label: "下架" },
  top_post: { action: "top", label: "置顶" },
  forward_post: { action: "forward", label: "转发到朋友圈" },
};

// 定位帖子：优先 postId，其次 phone，最后 keyword（多条件 AND）
// 返回 { list } （最多查 6 条用于判断唯一性）
async function locatePosts(args) {
  const a = args || {};
  const conds = [];

  if (a.postId) {
    try {
      const r = await db.collection(COLLECTION).doc(String(a.postId).trim()).get();
      if (r && r.data && r.data._id) return { list: [r.data] };
    } catch (e) { /* 找不到就继续走其他条件 */ }
  }

  if (a.phone) {
    const phone = String(a.phone).trim();
    const tail = phone.slice(-4);
    const rx = db.RegExp({ regexp: escapeReg(tail), options: "i" });
    conds.push(_.or([{ phone }, { phone_masked: rx }]));
  }
  if (a.dataType) conds.push({ data_type: a.dataType });
  if (a.city) {
    const r = detectIntent(String(a.city), 1);
    if (r.cityCode) {
      conds.push(_.or([
        { city_code: r.cityCode },
        { city: db.RegExp({ regexp: escapeReg(a.city), options: "i" }) },
      ]));
    }
  }
  if (a.keyword) {
    // 关键词按空白/顿号切分后，取【每个词】分别在 raw_text 上做 OR 匹配。
    // 关键：云开发 where 里 _.or 的数组不宜过长，故这里只对 raw_text 一个字段做 OR，
    // 避免"多词 × 多字段"导致的条件数组过大而查询失效（表现为明明有数据却查不到）。
    const words = String(a.keyword).trim().split(/[\s,，、/]+/).map((s) => s.trim()).filter(Boolean);
    const kwOr = words.map((w) => ({ raw_text: db.RegExp({ regexp: escapeReg(w), options: "i" }) }));
    if (kwOr.length === 1) conds.push(kwOr[0]);
    else if (kwOr.length > 1) conds.push(_.or(kwOr));
  }
  if (!conds.length) return { list: [] };

  const query = conds.length === 1 ? conds[0] : _.and(conds);
  const r = await db.collection(COLLECTION)
    .where(query)
    .orderBy("published_at", "desc")
    .limit(6)
    .get();
  return { list: r.data || [] };
}

// 操作类统一入口（handler）：定位 → 唯一则返回待确认；多条/0 条返回提示
async function handleOpLocate(tool, args) {
  const meta = OP_TOOL_MAP[tool] || { action: tool, label: "操作" };
  const a = args || {};

  const { list } = await locatePosts(a);

  if (!list.length) {
    return {
      title: `未找到目标`,
      blocks: [{ type: "empty", text: `没有找到要${meta.label}的帖子。请补充标题关键词、地区或手机号，再说一次。` }],
      opFail: true,
    };
  }

  // 多条：不执行，列出候选让用户说清楚
  if (list.length > 1) {
    return {
      title: `找到多条，请确认是哪一条`,
      blocks: [
        { type: "text", text: `匹配到 ${list.length} 条，为避免误操作，请补充更精确的描述（如城市/岗位/手机号）后再说一次。` },
        { type: "list", items: list.map(postToItem) },
      ],
      opFail: true,
    };
  }

  // 唯一：返回待确认结构（前端弹确认框）
  const p = list[0];
  const typeName = TYPE_NAMES[p.data_type] || "信息";
  const title = String(p.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const loc = [p.province, p.city, p.district].filter(Boolean).join(" ");
  const price = Number(p.salary) > 0 ? `${p.salary}元/月` : (Number(p.price) > 0 ? `${p.price}元` : "");
  const sub = [loc || "未知地区", price, p.phone_masked || ""].filter(Boolean).join(" · ");

  const target = {
    id: p._id,
    type: p.data_type || "",
    title: `【${typeName}】${title}`,
    sub,
  };
  // 转发需要正文
  if (meta.action === "forward") {
    target.content = buildDetailText(p, typeName);
  }
  // 置顶天数（1/3/7/30，默认 7）
  let days = 7;
  if (meta.action === "top") {
    const d = parseInt(a.days, 10);
    days = [1, 3, 7, 30].indexOf(d) >= 0 ? d : 7;
  }

  return {
    title: `${meta.label}确认`,
    blocks: [
      { type: "text", text: `已定位到 1 条，请确认后执行${meta.label}：` },
    ],
    needConfirm: true,
    action: meta.action,
    actionLabel: meta.label,
    days: meta.action === "top" ? days : undefined,
    target,
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

  // 批量更新状态（写库，必须 try/catch：失败要明确告知，不能让用户误以为已生效）
  const ids = found.map((a) => a._id);
  try {
    await db.collection(ADS).where({ _id: _.in(ids) }).update({
      data: { status: targetStatus, updated_at: Date.now() },
    });
  } catch (e) {
    console.error("[adminChat] 广告状态更新失败:", e && e.errMsg);
    return { title: "广告管理", blocks: [{ type: "text", text: "更新广告状态失败，请稍后重试。" }] };
  }

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

// ==================== 自由闲聊模式（无限制测试） ====================
// 与「深度思考」不同：不注入任何系统能力文档、不限定角色、不做意图识别，
// 直接把用户输入丢给 DeepSeek 原样回复，用于测试模型能力 / 闲聊。
// 入参：{ question, history(可选) }
async function handleFreeChat(question, history) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return fail("未配置 DEEPSEEK_API_KEY，无法使用闲聊模式", "NO_API_KEY");
  }
  const historySafe = Array.isArray(history) ? history.slice(-10) : [];
  try {
    const reply = await callDeepSeek(
      [
        { role: "system", content: "你是一个乐于助人的 AI 助手。" },
        ...historySafe,
        { role: "user", content: question },
      ],
      0.7,
      2000
    );
    const text = String(reply || "").trim() || "（无回复）";
    return ok({
      title: "AI 闲聊",
      blocks: [{ type: "text", text }],
      mode: "freeChat",
    });
  } catch (e) {
    console.error("[adminChat freeChat] 调用失败:", e && e.message);
    return fail("闲聊模式调用失败：" + (e && e.message ? e.message : e), "FREE_CHAT_FAILED");
  }
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

// 安全解析 AI 返回的 JSON（多级降级，不依赖任何厂商私有参数 → 换模型也适用）
// ① 直接 JSON.parse（AI 按要求只输出 JSON 时走这里）
// ② 剥掉 ```json ... ``` 代码块后再解析
// ③ 正则抠第一个「平衡的」{...} 再解析（比贪婪匹配更稳，避免多个 JSON 时吃掉多余内容）
// 全部失败返回 null（由调用方决定降级策略）
function safeParseJSON(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  // ① 直接解析
  try { return JSON.parse(s); } catch (e) { /* 继续降级 */ }
  // ② 剥 markdown 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try { return JSON.parse(fence[1].trim()); } catch (e) { /* 继续降级 */ }
  }
  // ③ 扫描第一个「平衡括号」的 JSON 片段
  const start = s.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
  }
  return null;
}

// ==================== 批量插入帖子（管理员「＋」按钮） ====================
// 流程两段式（管理员确认后才真正落库）：
//   ① analyzeInsert：AI 把一段自然语言切成 N 条帖子，识别字段 → 返回预览（不落库）
//   ② confirmInsert：管理员确认后，逐条落库（approved=true 已过审）
// 字段清洗复用 adminAuth 的 sanitizeFields 同款口径（白名单 + 类型校验 + 脱敏自动补）。

// 师傅类型枚举（与 aiAnalyzePost / recruit 频道一致，role_id 1-14）
const INSERT_ROLE_MAP = {
  1: "包子师傅", 2: "二把手", 3: "售卖", 4: "夫妻工", 5: "学徒",
  6: "全能面点师", 7: "生煎师傅", 8: "顶班师傅", 9: "打杂",
  10: "烧麦师傅", 11: "油炸", 12: "收银", 13: "店长", 14: "其他",
};

// 帖子字段白名单 + 类型（与 adminAuth.sanitizeFields 对齐）
const INSERT_ALLOWED_FIELDS = [
  "data_type", "province", "province_code", "city", "city_code",
  "district", "district_code", "address",
  "raw_text", "content", "phone", "phone_masked", "contact", "username",
  "image", "credit", "published_at", "source", "approved", "needs_review", "tags",
  "role", "role_id", "salary",
  "salary_expect", "salary_note", "availability", "service_area", "want_terms",
  "price", "monthly_rent", "area_sqm", "daily_revenue", "has_equipment", "terms",
  "rent_max", "area_min", "cond",
  "from_place", "to_place", "depart_time", "depart_deadline", "seats", "remark",
];
const INSERT_NUMBER_FIELDS = [
  "salary", "salary_expect", "price", "monthly_rent", "area_sqm",
  "daily_revenue", "rent_max", "area_min", "cond", "role_id", "credit", "seats",
];
const INSERT_BOOL_FIELDS = ["has_equipment", "approved", "needs_review"];
const INSERT_ARRAY_FIELDS = ["want_terms", "terms", "tags"];

// 清洗单条帖子字段（白名单 + 类型校验 + 脱敏自动补 + approved 同步）
function sanitizeInsertFields(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of INSERT_ALLOWED_FIELDS) {
    const v = input[k];
    if (v === undefined || v === null || v === "") continue;
    if (INSERT_ARRAY_FIELDS.indexOf(k) >= 0) {
      out[k] = Array.isArray(v) ? v : String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (INSERT_BOOL_FIELDS.indexOf(k) >= 0) {
      out[k] = v === true || v === "true" || v === 1 || v === "1";
      continue;
    }
    if (INSERT_NUMBER_FIELDS.indexOf(k) >= 0) {
      const n = Number(v);
      if (!isNaN(n)) out[k] = n;
      continue;
    }
    out[k] = v;
  }
  // approved 权威，反向推导 needs_review
  if (out.approved !== undefined) out.needs_review = !out.approved;
  else if (out.needs_review !== undefined) out.approved = !out.needs_review;
  // 求职帖 salary = salary_expect 冗余
  if (out.salary_expect !== undefined) out.salary = out.salary_expect;
  // 只填 phone 时自动补脱敏号
  if (out.phone && !out.phone_masked) {
    out.phone_masked = String(out.phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
  }
  if (out.published_at === undefined) out.published_at = Date.now();
  return out;
}

// ① analyzeInsert：AI 把整段文本切成 N 条帖子，识别字段，返回预览（不落库）
async function handleAnalyzeInsert(text) {
  const s = String(text || "").trim();
  if (!s) return fail("请输入要插入的内容", "EMPTY_INPUT");
  if (s.length > 20000) return fail("内容过长，请分批插入（单次不超过 20000 字）", "TOO_LONG");

  const system = `你是包子行业信息平台的发帖录入助手。管理员会粘贴一段「整理好的信息」（可能包含 1 条或多条帖子，用自然语言描述），
你需要把它【切分成独立的一条条帖子】，并为每条识别结构化字段。

【信息类型 data_type 枚举】
recruit=招工, jobseek=求职, transfer=转让, want_shop=求店, equip_sell=设备出售, equip_buy=设备求购, carpool_car=车找人, carpool_person=人找车, other=其他

【师傅类型 role 枚举（role_id）】
包子师傅=1, 二把手=2, 售卖=3, 夫妻工=4, 学徒=5, 全能面点师=6, 生煎师傅=7, 顶班师傅=8, 打杂=9, 烧麦师傅=10, 油炸=11, 收银=12, 店长=13, 其他=14

【字段定义】
- data_type: 信息类型（从上面枚举选）
- raw_text: 这条帖子的原始描述文字（保留原文，用于 C 端展示）
- phone: 11 位手机号（若原文有，务必提取；没有则省略）
- city: 城市名（不带"市"字，如"深圳"；识别不到则省略）
- role: 师傅类型中文名（从 role 枚举选，招工/求职才需要）
- role_id: 对应数字（1-14）
- salary: 薪资数字（元/月，招工给价或求职期望）
- price: 转让费/价格（元，转让/求店/设备类）
- monthly_rent: 月租（元/月）
- area_sqm: 面积（平方米）
- daily_revenue: 日营业额（元/天）
- want_terms: 诉求标签数组（如["包吃住","单间"]）
- availability: 到岗方式（长期/短期/顶班/随时可到）

【规则】
1. 输出必须是合法 JSON 数组，每个元素是一条帖子对象，只包含上面定义的字段。
2. 只输出 JSON，不要任何解释文字、不要 Markdown、不要代码块。
3. 识别不到的字段【不要输出】，宁可缺也别编造。
4. 若管理员粘贴的是一整段含多条信息的话，务必【切分成多条】，每条一个对象。
5. "万"换算成元（"8000"=8000，"1.2万"=12000）。

【输出示例】
[{"data_type":"recruit","raw_text":"深圳招大师傅，月薪8500，包吃住，电话13800138000","phone":"13800138000","city":"深圳","role":"包子师傅","role_id":1,"salary":8500,"want_terms":["包吃住"]}]`;

  let parsed;
  try {
    const raw = await callDeepSeek(
      [
        { role: "system", content: system },
        { role: "user", content: s },
      ],
      0.1,
      3000
    );
    parsed = safeParseJSON(raw);
    if (!parsed || !Array.isArray(parsed)) {
      // 有时模型包了一层 {items:[...]}
      if (parsed && Array.isArray(parsed.items)) parsed = parsed.items;
      else throw new Error("AI 返回不是数组");
    }
  } catch (e) {
    console.error("[adminChat] analyzeInsert 解析失败:", e && e.message);
    return fail("AI 识别失败，请检查粘贴内容或稍后重试", "ANALYZE_FAIL");
  }

  // 清洗 + 归一化每条的 data_type
  const items = [];
  for (const it of parsed) {
    const cleaned = sanitizeInsertFields(it);
    // data_type 必须合法，否则跳过
    if (!cleaned.data_type || !TYPE_NAMES[cleaned.data_type]) {
      cleaned.data_type = "other";
    }
    // 至少要有描述或电话，否则视为无效条目
    if (!cleaned.raw_text && !cleaned.phone) continue;
    // 标记缺失的关键字段，供前端标红
    cleaned._missing = [];
    if (!cleaned.phone) cleaned._missing.push("phone");
    if (!cleaned.city) cleaned._missing.push("city");
    if (!cleaned.role && (cleaned.data_type === "recruit" || cleaned.data_type === "jobseek")) cleaned._missing.push("role");
    items.push(cleaned);
  }

  if (!items.length) return fail("没有识别到有效帖子，请检查内容格式", "NO_ITEMS");
  return ok({ items, count: items.length });
}

// ② confirmInsert：管理员确认后逐条落库（approved=true 已过审）
// openid：当前操作管理员的 openid（归属到管理员本人，便于追溯是谁插入的）
async function handleConfirmInsert(items, openid) {
  if (!Array.isArray(items) || !items.length) return fail("没有要插入的数据", "EMPTY_ITEMS");
  const results = [];
  let successCount = 0;
  for (const it of items) {
    try {
      const cleaned = sanitizeInsertFields(it);
      // 强制已过审上线（管理员确认插入即上线）
      cleaned.approved = true;
      cleaned.needs_review = false;
      cleaned.source = cleaned.source || "admin_batch";
      // 归属到当前操作管理员（openid 双字段并存，与 publishPost/adminAuth 口径一致）
      if (openid) {
        cleaned._openid = openid;
        cleaned.userid = openid;
      }
      if (!cleaned.data_type || !TYPE_NAMES[cleaned.data_type]) cleaned.data_type = "other";
      if (!cleaned.raw_text && !cleaned.phone) {
        results.push({ ok: false, err: "缺描述和电话" });
        continue;
      }
      const res = await db.collection(COLLECTION).add({ data: cleaned });
      results.push({ ok: true, _id: res && res._id });
      successCount += 1;
    } catch (e) {
      console.error("[adminChat] confirmInsert 单条失败:", e && e.errMsg || e && e.message);
      results.push({ ok: false, err: e && e.errMsg || e && e.message || "写入失败" });
    }
  }
  return ok({ total: items.length, successCount, failedCount: items.length - successCount, results });
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

  // ===== 会话记忆（本页连续对话） =====
  // 前端打开页面时生成 sessionId 并每次带上；此处读取，用于注入 Stage1 并驱动结果集链。
  const sessionId = String((event && event.sessionId) || "").trim();
  const session = sessionId ? await loadSession(sessionId) : null;

  // 上下文：优先用【会话记忆】；无 sessionId 时回退到旧的 event.context（兼容旧前端）
  const ctx = (event && event.context) || null;
  // 会话里最新的结果集 id（结果集链栈顶）——本轮 aggregate(onPrevious) 自动关联它
  let ctxResultSetId = null;
  if (session && Array.isArray(session.resultStack) && session.resultStack.length) {
    ctxResultSetId = session.resultStack[session.resultStack.length - 1].resultSetId;
  } else if (ctx && ctx.resultSetId) {
    ctxResultSetId = ctx.resultSetId;
  }

  // 上下文摘要：注入 Stage1，让 DeepSeek 知道"这是延续上一轮"
  const ctxBlock = session
    ? buildSessionBlock(session)
    : (ctx
      ? `\n\n【上下文继承】管理员在连续追问，上一轮查询是：\n工具：${ctx.tool || "search"}\n参数：${JSON.stringify(ctx.args || {})}\n`
        + (ctx.resultSetId ? `上一轮结果集ID：${ctx.resultSetId}（上一轮共返回 ${ctx.resultCount || "若干"} 条，可被"这里面"指代）\n` : "")
        + `本轮若是对上一轮【追加/收紧筛选条件】（如"8000元以内""那北京的呢"），请【继承上一轮的 tool 与 args】，只在其基础上追加或覆盖本轮提到的新条件；\n`
        + `本轮若是用「这里面/这些/刚才那些」指代上一轮结果做二次统计，请用 aggregate 并带 onPrevious=true（系统会自动关联上一轮结果集，无需你填 resultSetId）。\n`
        + `若本轮是全新的查询主题（换了信息类型），则不要继承。`
      : "");

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

  // ===== 错误库：注入历史误判经验（越测越聪明） =====
  const mistakes = await loadMistakes();
  const mistakeBlock = buildMistakeBlock(mistakes);

  // ===== Stage1：AI 理解问题 + 选工具 =====
  const stage1System =
    SYSTEM_CAPABILITY_DOC +
    "\n\n【行业黑话对齐】\n" + glossary +
    (memBlock ? "\n\n" + memBlock : "") +
    (mistakeBlock || "") +
    ctxBlock +
    "\n\n现在请判断用户这句话该调哪个工具，只输出一个 JSON。";

  let plan;
  let raw = "";   // 提到外层作用域：answer 分支兜底文案会用（原来在 try 内 const，块外不可见）
  try {
    raw = await callDeepSeek(
      [
        { role: "system", content: stage1System },
        ...historySafe,
        { role: "user", content: resolvedQuestion },
      ],
      0.1,
      400
    );
    plan = safeParseJSON(raw);
    if (!plan) throw new Error("Stage1 未返回合法 JSON");
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

  // 纠正识别②：管理员反馈「AI 答错了」→ 自动写错误库（越用越聪明）
  // 触发：用户话里含「不对/错了/应该是/不是这样/搞错」等纠正语义（Stage1 输出 correction.isMistake）。
  // 记录：上一轮的原问题 + 上一轮 AI 实际用的工具 + 管理员指出的正确做法。
  if (plan && plan.correction && plan.correction.isMistake) {
    try {
      const prev = (session && Array.isArray(session.turns) && session.turns.length)
        ? session.turns[session.turns.length - 1] : null;
      if (prev) {
        await saveMistake({
          question: prev.q,                                  // 上一轮的原问题（场景）
          wrongTool: prev.tool || "",                        // 上一轮 AI 实际选了什么
          wrongArgs: prev.args || null,                      // 上一轮实际参数
          expectTool: plan.correction.expectTool || "",      // 管理员指出的正确工具
          expectArgs: plan.correction.expectArgs || null,    // 正确参数
          lesson: String(plan.correction.lesson || question || "").slice(0, 300),  // 教训（管理员原话）
          source: "user_feedback",                           // 来源：用户反馈
        });
      }
    } catch (e) {
      console.error("[adminChat] 记录用户反馈误判失败:", e && e.message);
    }
  }

  // ===== 执行工具 =====
  let toolResult = null;
  let toolTitle = "查询结果";

  try {
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
    case "aggregate": {
      const aggArgs = Object.assign({}, plan.args || {});
      // 服务端自动补 resultSetId：AI 只要给 onPrevious=true，就从上下文取上一轮结果集 id，
      // 不要求模型自行填 id（更稳，模型也不必知道 id）。
      // 支持 stackIndex：0=最早那批（"最开始那批"），默认=最新（"这里面"）。
      if (aggArgs.onPrevious && !aggArgs.resultSetId) {
        if (session && Array.isArray(session.resultStack) && session.resultStack.length) {
          const stack = session.resultStack;
          const idx = aggArgs.stackIndex === 0 ? 0 : (stack.length - 1);
          aggArgs.resultSetId = stack[idx] && stack[idx].resultSetId;
        } else if (ctxResultSetId) {
          aggArgs.resultSetId = ctxResultSetId;
        }
      }
      // 供 resolveResultSetRef 兜底（按栈位置解析）
      if (sessionId) aggArgs.__sessionId = sessionId;
      toolResult = await handleAggregate(aggArgs);
      toolTitle = toolResult.title || "聚合统计";
      // 回写，便于前端记录上下文/调试（去掉内部字段）
      delete aggArgs.__sessionId;
      plan.args = aggArgs;
      break;
    }
    // ===== 操作类工具：定位目标后直接返回「待确认」，不做 Stage2 分析 =====
    case "audit_pass":
    case "audit_offline":
    case "top_post":
    case "forward_post": {
      const opResult = await handleOpLocate(plan.tool, plan.args || {});
      await remember(question, plan.tool, plan.args || {});
      // 定位失败/多条：把提示作为普通结果返回，由 AI 语境自然呈现
      if (opResult.opFail) {
        return ok({
          title: opResult.title,
          blocks: opResult.blocks,
          mode: "deepThink",
          tool: plan.tool,
          toolArgs: plan.args || {},
        });
      }
      // 定位成功：返回待确认结构（前端弹确认框），附一条简短说明
      return ok({
        title: opResult.title,
        blocks: opResult.blocks,
        mode: "deepThink",
        tool: plan.tool,
        toolArgs: plan.args || {},
        needConfirm: true,
        action: opResult.action,
        actionLabel: opResult.actionLabel,
        days: opResult.days,
        target: opResult.target,
      });
    }
    case "search": {
      const intent = detectIntent(question, 1);
      const args = plan.args || {};
      // 本轮识别到的条件，优先用本轮（覆盖）
      if (args.dataType) intent.dataType = args.dataType;
      if (args.city) intent.city = args.city;
      if (args.keyword) intent.keyword = args.keyword;
      // 条数：AI 明确给了 limit 就用 AI 的（封顶 MAX_LIMIT），否则保持 detectIntent 的结果
      if (args.limit != null) {
        intent.limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(args.limit, 10) || DEFAULT_LIMIT));
      }
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
  } catch (e) {
    // 工具执行失败兜底：返回友好提示，而不是让整个云函数抛错（500）
    console.error("[adminChat deepThink] 工具执行失败:", (plan && plan.tool), e && (e.errMsg || e.message));
    return ok({
      title: "查询失败",
      blocks: [{ type: "text", text: "查询时出错，请重试或换个问法。" }],
      mode: "deepThink",
      tool: plan.tool,
      toolArgs: (plan && plan.args) || {},
    });
  }

  // 记录偏好（非 answer 的查询类）
  await remember(question, plan.tool, plan.args || {});

  // ===== Stage2：AI 基于真实数据写总结（分批摘要 → 二次汇总） =====
  // 大数据量（如 100/200 条列表）不能一次塞给模型，改为：
  //   ① 把列表按 ANALYZE_BATCH 条一批，逐批交给「分析 AI」写要点；
  //   ② 再把各批要点交给「分析 AI」做二次汇总，产出最终结论。
  let insight = "";
  try {
    insight = await analyzeToolResult(toolResult, toolTitle, question, historySafe);
  } catch (e) {
    console.error("[adminChat deepThink] Stage2 失败:", e);
  }

  const blocks = [];
  if (insight) blocks.push({ type: "text", text: insight });
  if (toolResult && toolResult.blocks && toolResult.blocks.length) {
    blocks.push({ type: "section", title: toolTitle });
    blocks.push(...toolResult.blocks);
  }

  // 结果集记忆：列表类查询（含结果）落一份快照，返回 resultSetId 给前端。
  // 注意：aggregate 走 aggregateOnResultSet 时，toolResult 里可能已带「命中集合」的新结果集
  //       （结果集链，A→B→C），此处优先采用它，避免重复落库、保证链是对的。
  let resultSetId = (toolResult && toolResult.resultSetId) || null;
  let resultCount = (toolResult && toolResult.resultCount) || 0;
  let derivedDesc = (toolResult && toolResult.__derivedDesc) || "";
  if (!resultSetId) {
    try {
      const list = extractListForResultSet(toolResult);
      if (list.length) {
        resultSetId = await saveResultSet(question, plan.tool, plan.args || {}, list);
        resultCount = list.length;
      }
    } catch (e) {
      console.error("[adminChat] 保存结果集失败:", e && e.message);
    }
  }

  // ===== 会话记忆收尾：合并条件、push 结果集链、记轮次 =====
  if (session && sessionId) {
    try {
      updateSession(session, {
        question,
        answerText: insight,
        tool: plan.tool,
        args: plan.args || {},
        resultSet: resultSetId ? { resultSetId, count: resultCount, desc: derivedDesc || question.slice(0, 30) } : null,
      });
      await saveSession(session);
      await pruneSessions();   // 必须 await：见 pruneMistakes 说明
    } catch (e) {
      console.error("[adminChat] 会话保存失败:", e && e.message);
    }
  }

  const payload = { title: toolTitle, blocks, mode: "deepThink", tool: plan.tool, toolArgs: plan.args || {} };
  if (resultSetId) {
    payload.resultSetId = resultSetId;
    payload.resultCount = resultCount;
  }
  return ok(payload);
}

// 从工具结果里提取「可指代的结果集」（列表块的原始帖子数据）
// 说明：列表 items 是 postToItem 的产物（无原始字段），故这里以「该结果对应的 toolResult.rawList」为准。
function extractListForResultSet(toolResult) {
  if (!toolResult) return [];
  if (Array.isArray(toolResult.rawList) && toolResult.rawList.length) return toolResult.rawList;
  return [];
}

// Stage2 分析汇总：分批摘要 + 二次汇总
// - 小数据量（列表条目 ≤ ANALYZE_BATCH）：单次调用直接总结（与旧行为一致）
// - 大数据量：分批摘要，再把摘要合并做二次汇总（解决 100/200 条塞不进一次请求）
async function analyzeToolResult(toolResult, toolTitle, question, historySafe) {
  const stage2System =
    "你是「包子一哥传媒」后台管理 AI 助手。以下是刚查到的真实数据（结构化卡片 JSON），请用中文给管理员写一段总结。\n" +
    "要求：1) 严禁编造数字，只引用 JSON 内容；2) 2-5 个短句，口语化；3) 纯文本，禁止任何 Markdown（#、**、-、表格）；4) 数据为空就直说「暂无数据」。";

  // 取出第一个列表块（最常见的大数据载体）
  const blocks = (toolResult && toolResult.blocks) || [];
  const listBlk = blocks.find((b) => b && b.type === "list" && Array.isArray(b.items));
  const items = listBlk ? listBlk.items : [];

  // 小数据量：单次总结（保留原行为，省时省 token）
  if (items.length <= ANALYZE_BATCH) {
    const dataSummary = JSON.stringify(blocks).slice(0, 6000);
    return (await callDeepSeek(
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
  }

  // 大数据量：分批摘要
  const batchSystem =
    "你是数据分析助手。下面是包子行业平台的一批信息（JSON 数组），请用 2-4 句中文提炼这批的要点（涉及数量、地区、薪资/价格分布等）。\n" +
    "要求：1) 严禁编造数字，只引用给定内容；2) 纯文本，禁止 Markdown；3) 不要罗列每一条，只做归纳。";
  const summaries = [];
  const total = items.length;
  for (let i = 0; i < total; i += ANALYZE_BATCH) {
    const chunk = items.slice(i, i + ANALYZE_BATCH);
    const compact = JSON.stringify(chunk.map((it) => ({
      text: it.text, sub: it.sub, tag: it.tag,
    })));
    try {
      const part = (await callDeepSeek(
        [
          { role: "system", content: batchSystem },
          { role: "user", content: `第 ${Math.floor(i / ANALYZE_BATCH) + 1} 批（第 ${i + 1}~${i + chunk.length} 条，共 ${total} 条）：\n${compact}` },
        ],
        0.3,
        400
      )).trim();
      if (part) summaries.push(part);
    } catch (e) {
      console.error("[adminChat] 分批摘要失败:", e && e.message);
    }
  }

  if (!summaries.length) return "";

  // 二次汇总：把各批要点合并成最终结论
  const finalSystem =
    stage2System +
    `\n注意：这是一份【${total} 条】的大批量数据，已分 ${summaries.length} 批做过要点提炼，以下是各批要点，请你综合它们写最终总结。`;
  return (await callDeepSeek(
    [
      { role: "system", content: finalSystem },
      { role: "user", content: question },
      { role: "assistant", content: `【${toolTitle} 分批次要点】\n${summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}` },
      { role: "user", content: "请综合以上各批要点写最终回复。" },
    ],
    0.5,
    600
  )).trim();
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
        // 翻页沿用上一轮的条数（AI 给的 limit 优先，封顶 MAX_LIMIT），无则默认 5
        limit: Math.min(MAX_LIMIT, Math.max(1, parseInt(a.limit, 10) || DEFAULT_LIMIT)),
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

  // ★ 离开管理员 AI 页面时清理本页产生的结果集（用完即清，避免云端堆积）
  // 入参：{ action:"cleanupResultSets", resultSetIds:[...] }
  if (event.action === "cleanupResultSets") {
    const ids = Array.isArray(event.resultSetIds) ? event.resultSetIds.filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return ok({ cleaned: 0 });
    let cleaned = 0;
    try {
      const r = await db.collection(AI_RESULT_SETS).where({ _id: _.in(ids) }).remove();
      cleaned = (r && r.stats && r.stats.removed) || 0;
    } catch (e) {
      console.error("[adminChat] cleanupResultSets 失败:", e && e.errMsg);
    }
    return ok({ cleaned });
  }

  // ★ 关闭管理员 AI 页面时清理会话（再打开即新对话）
  // 入参：{ action:"cleanupSession", sessionId:"..." }
  if (event.action === "cleanupSession") {
    const sid = String(event.sessionId || "").trim();
    if (!sid) return ok({ cleaned: 0 });
    let cleaned = 0;
    try {
      const r = await db.collection(AI_SESSIONS).doc(sid).remove();
      cleaned = (r && r.stats && r.stats.removed) || 0;
    } catch (e) {
      console.error("[adminChat] cleanupSession 失败:", e && e.errMsg);
    }
    return ok({ cleaned });
  }

  // ★ 错误库：记录一条误判经验（让 AI 越测越聪明）
  // 入参：{ action:"saveMistake", question, wrongTool, wrongArgs, expectTool, expectArgs, lesson }
  if (event.action === "saveMistake") {
    const id = await saveMistake({
      question: event.question, wrongTool: event.wrongTool, wrongArgs: event.wrongArgs,
      expectTool: event.expectTool, expectArgs: event.expectArgs, lesson: event.lesson,
      source: event.source,
    });
    return ok({ saved: !!id, id });
  }

  // ★ 错误库：查看已沉淀的经验
  if (event.action === "listMistakes") {
    try {
      const r = await db.collection(AI_MISTAKES).orderBy("at", "desc")
        .limit(Math.min(Number(event.limit) || 50, 100)).get();
      return ok({ total: (r.data || []).length, items: r.data || [] });
    } catch (e) {
      return ok({ total: 0, items: [] });
    }
  }

  // ★ 批量插入①：AI 分析一段文本 → 切成 N 条帖子 → 返回预览（不落库）
  if (event.action === "analyzeInsert") {
    return await handleAnalyzeInsert(event.text);
  }

  // ★ 批量插入②：管理员确认后逐条落库（approved=true 已过审，归属当前管理员 openid）
  if (event.action === "confirmInsert") {
    return await handleConfirmInsert(event.items, OPENID);
  }

  const question = String(event.question || "").trim();
  if (!question) {
    return ok({ title: "管理员 AI 助手", blocks: buildGuideBlocks() });
  }

  // ★ 自由闲聊模式：不注入能力文档、不限定角色，直接原样回复（测试用）
  if (event.freeChat) {
    return await handleFreeChat(question, event.history || []);
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
  console.log("[adminChat] 规则模式 type:", intent.type, "| dataType:", intent.dataType);

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
