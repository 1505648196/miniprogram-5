/**
 * 六大业务类型定义
 * 与 monitor_cloud.py / 云函数 analyzePublishInfo 对齐
 */

export const DATA_TYPES = {
  transfer: { label: "转店", intent: 1 },
  want_shop: { label: "求店", intent: 2 },
  recruit: { label: "招聘", intent: 3 },
  jobseek: { label: "求职", intent: 4 },
  equip_sell: { label: "二手设备出售", intent: 5 },
  equip_buy: { label: "二手设备求购", intent: 6 },
};

export const DATA_TYPE_OPTIONS = Object.entries(DATA_TYPES).map(([value, item]) => ({
  label: item.label,
  value,
}));

/**
 * 各业务类型的字段定义
 * field: 字段名
 * label: 中文名
 * type: 输入类型 (text / number / textarea / select / switch)
 * options: select 用
 * placeholder
 */
export const TYPE_FIELDS = {
  transfer: {
    fields: [
      { field: "city", label: "城市", type: "text", placeholder: "如：贵阳" },
      { field: "province", label: "省份", type: "text", placeholder: "如：贵州" },
      { field: "district", label: "区县", type: "text" },
      { field: "brand", label: "品牌", type: "text", placeholder: "如：三津汤包" },
      { field: "phone", label: "联系电话", type: "text", placeholder: "11位手机号" },
      { field: "rent", label: "租金(元/月)", type: "number" },
      { field: "transfer_fee", label: "转让费(元)", type: "number" },
      { field: "turnover_low", label: "营业额下限", type: "number" },
      { field: "turnover_high", label: "营业额上限", type: "number" },
      { field: "area_m2", label: "面积(㎡)", type: "number" },
      { field: "is_franchise", label: "是否加盟", type: "switch" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
  want_shop: {
    fields: [
      { field: "city", label: "城市", type: "text" },
      { field: "province", label: "省份", type: "text" },
      { field: "district", label: "区县", type: "text" },
      { field: "phone", label: "联系电话", type: "text" },
      { field: "budget", label: "预算(元)", type: "number" },
      { field: "area_m2", label: "面积(㎡)", type: "number" },
      { field: "shop_type", label: "店铺类型", type: "text" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
  recruit: {
    fields: [
      { field: "city", label: "城市", type: "text" },
      { field: "province", label: "省份", type: "text" },
      { field: "district", label: "区县", type: "text" },
      { field: "role", label: "岗位", type: "text", placeholder: "如：大师傅/售卖员/夫妻工" },
      { field: "phone", label: "联系电话", type: "text" },
      { field: "salary_low", label: "月薪下限", type: "number" },
      { field: "salary_high", label: "月薪上限", type: "number" },
      { field: "salary_note", label: "薪资备注", type: "text", placeholder: "如：包吃住/面议" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
  jobseek: {
    fields: [
      { field: "city", label: "城市", type: "text" },
      { field: "province", label: "省份", type: "text" },
      { field: "district", label: "区县", type: "text" },
      { field: "role", label: "期望岗位", type: "text" },
      { field: "phone", label: "联系电话", type: "text" },
      { field: "salary_low", label: "期望薪资下限", type: "number" },
      { field: "salary_high", label: "期望薪资上限", type: "number" },
      { field: "salary_note", label: "薪资备注", type: "text" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
  equip_sell: {
    fields: [
      { field: "city", label: "城市", type: "text" },
      { field: "province", label: "省份", type: "text" },
      { field: "equip_region", label: "设备所在地区", type: "text" },
      { field: "phone", label: "联系电话", type: "text" },
      { field: "equip_desc", label: "设备描述", type: "textarea" },
      { field: "equip_price", label: "设备价格(元)", type: "number" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
  equip_buy: {
    fields: [
      { field: "city", label: "城市", type: "text" },
      { field: "province", label: "省份", type: "text" },
      { field: "equip_region", label: "设备所在地区", type: "text" },
      { field: "phone", label: "联系电话", type: "text" },
      { field: "equip_desc", label: "设备描述", type: "textarea" },
      { field: "equip_budget", label: "预算(元)", type: "number" },
      { field: "remark", label: "备注", type: "textarea" },
    ],
  },
};

/** 通用字段（所有类型都有） */
export const COMMON_FIELDS = [
  { field: "raw_text", label: "原文", type: "textarea", placeholder: "完整原始文本" },
  { field: "source", label: "来源", type: "text", placeholder: "如：微信/小程序/手工录入" },
];

/** 展示薪资格式化 */
export function formatSalary(item) {
  const low = item.salary_low;
  const high = item.salary_high;
  const note = item.salary_note;
  if (low && high) {
    if (low === high) return `${low}元`;
    return `${low}-${high}元`;
  }
  if (note) return note;
  if (low) return `${low}元`;
  return "面议";
}

/** 展示时间 */
export function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 转单条数据为「类型 + 城市 + 岗位 + 薪资」的摘要 */
export function summarize(item) {
  const typeLabel = DATA_TYPES[item.data_type]?.label || item.data_type || "";
  const parts = [typeLabel];
  if (item.city) parts.push(item.city);
  if (item.role) parts.push(item.role);
  const salary = formatSalary(item);
  if (salary !== "面议") parts.push(salary);
  return parts.filter(Boolean).join(" · ");
}
