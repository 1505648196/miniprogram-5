// tools/import-legacy-posts/index.js
// 老库数据清洗脚本：读老库 JSON → 清洗 → 产出可导入 baozi_posts 的规范化数据
//
// 用法（命令行）：
//   node index.js                 # 清洗模式：产出 cleaned.json + rejected.log（不落库）
//   node index.js --dry-run       # 试跑模式：只打印前 N 条清洗结果到控制台，不写文件
//
// 老库 JSON 结构（13 字段）：
//   { 昵称, 帖子摘要, 类型, 发布时间, 帖子电话, 帖子微信, 区县, 街道, 纬度, 经度, 详细地址, 是否置顶 }
//   - 类型: "招聘" / "求职" / "转让"
//   - 区县: 省名（如"广东省"）；街道: 市名（如"广州市"）
//   - 经纬度: 百度坐标系(bd09)，暂不做功能，原样存 + 标记 coord_system
//
// 清洗规则（与用户敲定）：
//   - 不去重（原样保留）
//   - 帖子微信不存
//   - 审核默认全过：needs_review=false, sec_status="legacy"
//   - 坐标标 bd09（暂不转换）
//   - 无人认领：_openid="", userid="", claimed=false
//   - 老数据 role/role_id/salary 等业务字段留空，交 DeepSeek 后续补
//   - 浏览量 views=0
const fs = require("fs");
const path = require("path");
const { provinceCode, cityCode } = require("./region-map");

// ---- 配置 ----
const INPUT_FILE = "C:\\Users\\user\\Downloads\\用户帖子日期排序_260906164158.json";
const OUT_DIR = path.join(__dirname, "output");
const CLEANED_FILE = path.join(OUT_DIR, "cleaned.json");
const REJECTED_FILE = path.join(OUT_DIR, "rejected.log");
const DRY_RUN_COUNT = 20; // dry-run 打印前 N 条

// ---- 工具函数 ----
function maskPhone(p) {
  const s = String(p || "").trim();
  return /^1\d{10}$/.test(s) ? s.slice(0, 3) + "****" + s.slice(7) : "";
}

// 归一化电话：去空格/横线/括号/+86，返回纯 11 位数字；非法返回 ""
function normalizePhone(p) {
  let s = String(p || "").replace(/[\s\-()（）]/g, "");
  s = s.replace(/^(\+?86)/, "");
  return /^1\d{10}$/.test(s) ? s : "";
}

// 清洗摘要：去 |+ 垃圾分隔符，去多余空白，截断 2000 字
function cleanText(s) {
  let t = String(s || "")
    .replace(/\|+[\s+]*\|*/g, "") // 去掉 |+|+| 这类垃圾符
    .replace(/\|+/g, "，") // 残留单个 | 转逗号
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length > 2000) t = t.slice(0, 2000);
  return t;
}

// 类型 → data_type 映射（覆盖老库全部 15 种"类型"值）
function mapDataType(type) {
  const t = String(type || "").trim();
  if (t === "招聘" || t === "招聘 VIP信息") return "recruit";
  if (t === "求职") return "jobseek";
  if (t === "转让" || t === "转让 VIP信息") return "transfer";
  if (t === "求店") return "want_shop";
  if (t === "设备出售") return "equip_sell";
  if (t === "设备求购") return "equip_buy";
  if (t === "车找人") return "carpool_car";
  if (t === "人找车") return "carpool_person";
  // 其余杂项（其他需求/商家展示/交友/求货/卖货）统一归 other
  return "other";
}

// 安全转数字
function toNum(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// 时间字符串 → 毫秒；失败返回 0
function toTimestamp(s) {
  const t = Date.parse(String(s || ""));
  return isNaN(t) ? 0 : t;
}

// ---- 单条清洗 ----
function cleanOne(row, index) {
  const phone = normalizePhone(row["帖子电话"]);
  const rawText = cleanText(row["帖子摘要"]);
  const province = String(row["区县"] || "").trim();
  const city = String(row["街道"] || "").trim();
  const address = String(row["详细地址"] || "").trim();
  const publishedAt = toTimestamp(row["发布时间"]);

  // 拒绝条件：电话非法 或 摘要为空
  if (!phone || !rawText) {
    return {
      ok: false,
      reason: !phone ? "电话无效" : "摘要为空",
      raw: row,
    };
  }

  return {
    ok: true,
    doc: {
      data_type: mapDataType(row["类型"]),
      role: "",
      role_id: 0,
      raw_text: rawText,
      province,
      province_code: provinceCode(province),
      city,
      city_code: cityCode(city),
      district: "",
      district_code: "",
      address,
      latitude: toNum(row["纬度"]),
      longitude: toNum(row["经度"]),
      coord_system: "bd09", // 百度坐标系，暂不做地图功能，标注待日后转换
      phone,
      phone_normalized: phone,
      phone_masked: maskPhone(phone),
      contact: "",
      username: String(row["昵称"] || "").trim(),
      credit: 0,
      image: "",
      tags: [],
      // 业务字段留空，交 DeepSeek 补
      salary: 0,
      salary_expect: 0,
      salary_note: "",
      availability: "",
      service_area: "",
      want_terms: [],
      price: 0,
      monthly_rent: 0,
      area_sqm: 0,
      daily_revenue: 0,
      has_equipment: "",
      terms: [],
      rent_max: 0,
      area_min: 0,
      cond: 0,
      // 时间
      published_at: publishedAt || Date.now(),
      created_at: publishedAt || Date.now(),
      updated_at: publishedAt || Date.now(),
      // 审核：默认全过
      needs_review: false,
      sec_status: "legacy",
      sec_checked_at: Date.now(),
      // 归属：无人认领（平台代发），待手机号认证后匹配
      _openid: "",
      userid: "",
      claimed: false,
      source: "import_legacy",
      // 浏览量
      views: 0,
      // 置顶：老库无置顶
      top_level: 0,
      is_top: false,
      top_expire_at: 0,
      top_type: "",
    },
    raw: row,
  };
}

// ---- 主流程 ----
function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error("❌ 找不到输入文件:", INPUT_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_FILE, "utf8");
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (e) {
    console.error("❌ JSON 解析失败:", e.message);
    process.exit(1);
  }
  if (!Array.isArray(rows)) {
    console.error("❌ JSON 顶层不是数组，共", typeof rows);
    process.exit(1);
  }

  console.log(`📥 读取到 ${rows.length} 条老数据`);

  const cleaned = [];
  const rejected = [];
  rows.forEach((row, i) => {
    const r = cleanOne(row, i);
    if (r.ok) cleaned.push(r.doc);
    else rejected.push({ index: i, reason: r.reason, raw: r.raw });
  });

  console.log(`✅ 清洗通过: ${cleaned.length} 条`);
  console.log(`❌ 被丢弃: ${rejected.length} 条`);

  // 统计 data_type 分布
  const dist = {};
  cleaned.forEach((d) => {
    dist[d.data_type] = (dist[d.data_type] || 0) + 1;
  });
  console.log("📊 data_type 分布:", JSON.stringify(dist));

  if (dryRun) {
    console.log(`\n===== DRY-RUN：前 ${Math.min(DRY_RUN_COUNT, cleaned.length)} 条清洗结果 =====\n`);
    cleaned.slice(0, DRY_RUN_COUNT).forEach((d, i) => {
      console.log(`--- 第 ${i + 1} 条 ---`);
      console.log(JSON.stringify({
        data_type: d.data_type,
        username: d.username,
        raw_text: d.raw_text.slice(0, 60) + (d.raw_text.length > 60 ? "…" : ""),
        province: d.province, province_code: d.province_code,
        city: d.city, city_code: d.city_code,
        phone_masked: d.phone_masked,
        phone_normalized: d.phone_normalized,
        lat: d.latitude, lng: d.longitude,
        published_at: d.published_at,
        claimed: d.claimed, source: d.source, views: d.views,
      }, null, 2));
    });
    console.log("\n（dry-run 模式，未写任何文件）");
    return;
  }

  // 写文件
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CLEANED_FILE, JSON.stringify(cleaned, null, 2), "utf8");
  fs.writeFileSync(
    REJECTED_FILE,
    rejected.map((r) => JSON.stringify(r)).join("\n"),
    "utf8"
  );
  console.log(`\n📄 已写出清洗结果：${CLEANED_FILE}`);
  console.log(`📄 已写出丢弃日志：${REJECTED_FILE}`);
}

main();
