/**
 * 业务类型定义 —— 与小程序 C 端一致（全 9 类）
 * 字段口径：docs/API-云函数对接文档.md §3「新版字段」
 *
 * priceField: salary=招工/求职主价格；price=转让/求店/设备主价格；null=无价格（顺风车/其他）
 * roleKind:   master=师傅类型(1-14)；shop=店铺类型(1-5)；null=无角色枚举
 *
 * 注意：后台新增/编辑必须用这里的字段名写库，否则小程序端读不到。
 * 旧字段（transfer_fee / salary_low / area_m2 / equip_price / budget 等）
 * 仅作历史数据只读兜底，不再写入。
 */

export const DATA_TYPES = {
  recruit: { label: "招工", priceField: "salary", roleKind: "master" },
  jobseek: { label: "求职", priceField: "salary", roleKind: "master" },
  transfer: { label: "店铺转让", priceField: "price", roleKind: "shop" },
  want_shop: { label: "求店", priceField: "price", roleKind: "shop" },
  equip_sell: { label: "设备出售", priceField: "price", roleKind: null },
  equip_buy: { label: "设备求购", priceField: "price", roleKind: null },
  carpool_car: { label: "车找人", priceField: null, roleKind: null },
  carpool_person: { label: "人找车", priceField: null, roleKind: null },
  other: { label: "其他", priceField: null, roleKind: null },
};

export const DATA_TYPE_OPTIONS = Object.entries(DATA_TYPES).map(([value, item]) => ({
  label: item.label,
  value,
}));

/** 师傅类型 role_id（1-14）—— 招工 / 求职 共用，与小程序 recruit.js SUB_CATS 对齐 */
export const MASTER_ROLES = [
  { value: 1, label: "大师傅" },
  { value: 2, label: "短期顶班" },
  { value: 3, label: "夫妻工" },
  { value: 4, label: "售卖员" },
  { value: 5, label: "学徒工" },
  { value: 6, label: "小笼包师傅" },
  { value: 7, label: "饼类师傅" },
  { value: 8, label: "油炸类师傅" },
  { value: 9, label: "中工" },
  { value: 10, label: "生煎类师傅" },
  { value: 11, label: "全能面点大师" },
  { value: 12, label: "二把手" },
  { value: 13, label: "工厂" },
  { value: 14, label: "其他类型" },
];

/** 店铺类型 role_id（1-5）—— 转让 / 求店 共用，与小程序 turnover.js SHOP_TYPES 对齐 */
export const SHOP_ROLES = [
  { value: 1, label: "品牌店" },
  { value: 2, label: "自营店" },
  { value: 3, label: "摆摊车" },
  { value: 4, label: "学校" },
  { value: 5, label: "工厂" },
];

/** 通用字段（所有类型都渲染），与 TYPE_FIELDS 分开避免重复声明 */
export const COMMON_FIELDS = [
  { field: "province", label: "省份", type: "text", placeholder: "如：贵州" },
  { field: "city", label: "城市", type: "text", placeholder: "如：贵阳" },
  { field: "district", label: "区县", type: "text" },
  { field: "address", label: "详细地址", type: "text" },
  { field: "phone", label: "联系电话", type: "text", placeholder: "11位手机号" },
  { field: "contact", label: "联系人", type: "text" },
];

/**
 * 各业务类型的专项字段（新版口径）
 * field: 字段名（必须命中 adminAuth.ALLOWED_FIELDS 的新版字段）
 * type:  text / number / textarea / select / switch / array
 */
export const TYPE_FIELDS = {
  recruit: {
    fields: [
      { field: "role", label: "岗位", type: "text", placeholder: "如：大师傅/售卖员/夫妻工" },
      { field: "role_id", label: "师傅类型", type: "select", options: MASTER_ROLES },
      { field: "salary", label: "给价(元/月)", type: "number", placeholder: "0=面议" },
      { field: "salary_note", label: "薪资备注", type: "text", placeholder: "如：包吃住/面议" },
    ],
  },
  jobseek: {
    fields: [
      { field: "role", label: "期望岗位", type: "text" },
      { field: "role_id", label: "师傅类型", type: "select", options: MASTER_ROLES },
      { field: "salary_expect", label: "期望月薪(元/月)", type: "number", placeholder: "0=面议" },
      { field: "salary_note", label: "薪资备注", type: "text" },
      { field: "availability", label: "到岗时间", type: "text", placeholder: "如：随时/一周内" },
      { field: "service_area", label: "服务地区", type: "text" },
      { field: "want_terms", label: "求职诉求", type: "array", placeholder: "回车添加，如：包吃住" },
    ],
  },
  transfer: {
    fields: [
      { field: "role", label: "店铺类型", type: "text", placeholder: "如：品牌店/自营店" },
      { field: "role_id", label: "店铺类型(枚举)", type: "select", options: SHOP_ROLES },
      { field: "price", label: "转让费(元)", type: "number" },
      { field: "monthly_rent", label: "月租(元/月)", type: "number" },
      { field: "area_sqm", label: "面积(㎡)", type: "number" },
      { field: "daily_revenue", label: "日营业额(元)", type: "number" },
      { field: "has_equipment", label: "带设备", type: "switch" },
      { field: "terms", label: "转让条件", type: "array", placeholder: "回车添加，如：可空转" },
    ],
  },
  want_shop: {
    fields: [
      { field: "role", label: "店铺类型", type: "text" },
      { field: "role_id", label: "店铺类型(枚举)", type: "select", options: SHOP_ROLES },
      { field: "price", label: "预算(元)", type: "number" },
      { field: "rent_max", label: "租金上限(元/月)", type: "number" },
      { field: "area_min", label: "面积下限(㎡)", type: "number" },
      { field: "want_terms", label: "求店要求", type: "array", placeholder: "回车添加，如：临街" },
    ],
  },
  equip_sell: {
    fields: [
      { field: "price", label: "售价(元)", type: "number" },
      { field: "cond", label: "成色(0-10)", type: "number", placeholder: "10=全新" },
    ],
  },
  equip_buy: {
    fields: [
      { field: "price", label: "预算(元)", type: "number" },
      { field: "cond", label: "成色要求(0-10)", type: "number", placeholder: "10=全新" },
    ],
  },
  carpool_car: {
    fields: [
      { field: "from_place", label: "出发地", type: "text" },
      { field: "to_place", label: "目的地", type: "text" },
      { field: "depart_time", label: "出发时间", type: "text", placeholder: "如：每天 07:00" },
      { field: "depart_deadline", label: "截止时间", type: "text" },
      { field: "seats", label: "空位/人数", type: "number" },
    ],
  },
  carpool_person: {
    fields: [
      { field: "from_place", label: "出发地", type: "text" },
      { field: "to_place", label: "目的地", type: "text" },
      { field: "depart_time", label: "出发时间", type: "text", placeholder: "如：每天 07:00" },
      { field: "depart_deadline", label: "截止时间", type: "text" },
      { field: "seats", label: "需要座位", type: "number" },
    ],
  },
  other: {
    fields: [],
  },
};

/** 旧字段 → 新字段（仅供展示历史数据兜底，不用于写库） */
const LEGACY_ALIAS = {
  transfer_fee: "price",
  equip_price: "price",
  equip_budget: "price",
  budget: "price",
  rent: "monthly_rent",
  area_m2: "area_sqm",
  turnover_low: "daily_revenue",
  is_franchise: "has_equipment",
  shop_type: "role",
  equip_region: "city",
};

/** 取新字段值，取不到再回落旧字段（只读） */
function pick(item, field) {
  const v = item?.[field];
  if (v !== undefined && v !== null && v !== "") return v;
  const alias = LEGACY_ALIAS[field];
  if (alias) {
    const av = item?.[alias];
    if (av !== undefined && av !== null && av !== "") return av;
  }
  return undefined;
}

/** 展示薪资（招工给价 / 求职期望）—— 0 或空 = 面议 */
export function formatSalary(item = {}) {
  // 求职：salary_expect 是语义字段，salary 是同值冗余（见 API 文档 §3）
  const raw = item.salary_expect ?? item.salary;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    return item.salary_note || "面议";
  }
  return `${v}元/月`;
}

/** 展示价格（转让费 / 求店预算 / 设备价格） */
export function formatPrice(item = {}) {
  const v = Number(pick(item, "price"));
  if (!Number.isFinite(v) || v <= 0) return "-";
  return `${v}元`;
}

/** 按类型自动选薪资或价格展示（列表 / 详情通用） */
export function formatMoney(item = {}) {
  const kind = DATA_TYPES[item.data_type]?.priceField;
  if (kind === "price") return formatPrice(item);
  if (kind === "salary") return formatSalary(item);
  return "-";
}

/** 展示时间 */
export function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 转单条数据为「类型 + 城市 + 岗位 + 价格/薪资」的摘要 */
export function summarize(item = {}) {
  const typeLabel = DATA_TYPES[item.data_type]?.label || item.data_type || "";
  const parts = [typeLabel];
  if (item.city) parts.push(item.city);
  if (item.role) parts.push(item.role);

  // 顺风车无价格，用「出发地→目的地」代替
  if (item.data_type === "carpool_car" || item.data_type === "carpool_person") {
    if (item.from_place || item.to_place) {
      parts.push(`${item.from_place || "?"}→${item.to_place || "?"}`);
    }
  } else {
    const money = formatMoney(item);
    if (money && money !== "面议" && money !== "-") parts.push(money);
  }
  return parts.filter(Boolean).join(" · ");
}
