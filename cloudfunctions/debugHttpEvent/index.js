// cloudfunctions/debugHttpEvent/index.js
// HTTP 事件探测 + 假数据返回（2026-08-25）
// 用途1（探测）：把收到的完整 event 写入数据库 http_event_logs，响应返回 event 结构摘要；
// 用途2（假数据）：question 包含"上海"时，直接返回 10 条模拟的上海招工帖子（msgType:"list"），
//                 结构与 recruitAI 的 list 返回完全一致，用于在没有真实数据时跑通 Python 链路。
// 注意：集合 http_event_logs 会自动尝试创建；测完可删本函数。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 自动创建集合（已存在/无权限则忽略）
async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) {
    // 已存在或无权创建，忽略
  }
}

function maskPhone(p) {
  const s = String(p || "").trim();
  return /^1\d{10}$/.test(s) ? s.slice(0, 3) + "****" + s.slice(7) : "";
}

// 生成 10 条模拟上海招工帖子（结构对齐 baozi_posts 的 recruit 字段）
function buildMockPosts() {
  const roles = ["大师傅", "夫妻工", "短期/顶班", "售卖员", "学徒工", "小笼包师傅", "饼类师傅", "二把手", "油炸类师傅", "中工"];
  const districts = ["浦东新区", "徐汇区", "静安区", "杨浦区", "虹口区", "闵行区", "宝山区", "普陀区", "长宁区", "黄浦区"];
  const salaries = [
    [8000, 10000, ""], [15000, 18000, ""], [0, 0, "面议"], [5000, 6000, ""],
    [3500, 4500, ""], [7000, 8500, ""], [6500, 8000, ""], [6000, 7500, ""],
    [6000, 7500, ""], [5500, 7000, ""],
  ];
  const now = Date.now();
  return roles.map((role, i) => {
    const sal = salaries[i];
    const phone = "1870000000" + (i + 1);
    return {
      _id: "mock_" + String(i + 1).padStart(3, "0"),
      data_type: "recruit",
      role,
      city: "上海市",
      province: "上海市",
      district: districts[i],
      province_code: "310000",
      city_code: "310100",
      district_code: "310115",
      address: districts[i] + "模拟路" + (i + 1) + "号",
      raw_text: `上海${districts[i]}包子店招${role}（模拟数据），包吃住，月薪${sal[1] || "面议"}，老板好相处`,
      phone,
      phone_masked: maskPhone(phone),
      salary_low: sal[0],
      salary_high: sal[1],
      salary_note: sal[2],
      published_at: now - i * 3600000,
      source: "mock",
      needs_review: false,
      tags: ["包吃", "包住"],
    };
  });
}

// 拼 reply（与 formatPost 相近的展示格式）
function buildMockShanghaiReply(posts) {
  const lines = posts.map((p, i) => {
    const loc = p.province === p.city ? p.city : `${p.province} ${p.city}`;
    const salary = p.salary_note ? `薪资${p.salary_note}` : `薪资${p.salary_high}元`;
    const tags = p.tags && p.tags.length ? `[${p.tags.join("·")}]` : "";
    return `${i + 1}. ${loc} ${p.district} | 岗位:${p.role} | ${salary} | ${tags} | ${p.phone_masked}`;
  });
  return `【上海招工 · 共${posts.length}条】\n\n` + lines.join("\n");
}

exports.main = async (event) => {
  console.log("[debugHttpEvent] ① 原始 event =", JSON.stringify(event));
  const question = String(event.question || "").trim();

  // 无论哪种模式都写一条探测日志（排查用）
  await ensureCollection("http_event_logs");
  try {
    await db.collection("http_event_logs").add({
      data: {
        created_at: Date.now(),
        event_raw: JSON.stringify(event).slice(0, 4000),
        keys: Object.keys(event || {}),
        question,
      },
    });
  } catch (e) {
    console.log("[debugHttpEvent] 写库失败:", (e && e.errMsg) || (e && e.message) || e);
  }

  // ===== 假数据模式：question 含"上海" → 返回 10 条模拟招工帖子 =====
  if (question.includes("上海")) {
    const posts = buildMockPosts();
    return {
      msgType: "list",
      reply: buildMockShanghaiReply(posts),
      data: posts,
      tipChip: "我要发布招工",
      mock: true, // 标记：这是假数据，非真实库
    };
  }

  // ===== 默认：探测模式，返回 event 结构摘要 =====
  return {
    msg: "HTTP 事件探测成功（question 不含'上海'，未走假数据分支），完整结构已写入数据库 http_event_logs",
    keys: Object.keys(event || {}),
    question,
    has_http_message: !!(event && event.httpMessage),
    has_body: !!(event && event.body != null),
    body_type: event ? typeof event.body : "event为空",
    http_message_body_type: event && event.httpMessage ? typeof event.httpMessage.body : "无httpMessage",
  };
};
