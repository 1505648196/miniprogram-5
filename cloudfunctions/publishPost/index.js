// cloudfunctions/publishPost/index.js
// 发布帖子入库：校验 → 电话脱敏 → 写 baozi_posts
// 目前支持 data_type=recruit（招工），字段与发布表单一一对应
//
// 入参：
//   {
//     form: {
//       role: "大师傅",            // 师傅类型（写死选项）
//       salaryHigh: "6000",        // 工资（唯一薪资字段，面议时为空）
//       salaryNote: "面议",        // 薪资备注（选了"面议"时用）
//       province: "广东省",        // 省
//       city: "深圳市",            // 市
//       district: "南山区",        // 区/县（可空）
//       province_code: "440000",   // 省行政区划 code
//       city_code: "440300",       // 市行政区划 code（直辖市取省级码）
//       district_code: "440305",   // 区/县行政区划 code（可空）
//       address: "xx路xx号",      // 详细地址（定位获取或手填）
//       latitude: 22.54,          // 定位坐标（可选）
//       longitude: 114.06,        // 定位坐标（可选）
//       desc: "店内主营小笼包...",   // 具体描述
//       phone: "18700009563",     // 电话（完整，11 位校验）
//       contact: "张老板",         // 联系人
//     }
//   }
// 返回：
//   { success: true, _id: "..." } | { success: false, error: "..." }
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 脱敏：保留前 3 后 4，中间 4 位 ****（187****9563）
function maskPhone(p) {
  const s = String(p || "").trim();
  if (!/^1\d{10}$/.test(s)) return "";
  return s.slice(0, 3) + "****" + s.slice(7);
}

exports.main = async (event) => {
  const f = event.form || {};

  // ---- 必填校验 ----
  if (!f.role) return { success: false, error: "请选择师傅类型" };
  if (!f.city) return { success: false, error: "请选择区域" };
  if (!f.phone) return { success: false, error: "请填写联系电话" };
  if (!/^1\d{10}$/.test(String(f.phone).trim())) {
    return { success: false, error: "请输入 11 位手机号" };
  }

  const phone = String(f.phone).trim();

  // ---- 工资解析 ----
  // salaryNote 为 "面议" 时存 salary_note；否则解析 salaryHigh（前端只传工资单一值，salaryLow 不再传）
  const record = {
    data_type: "recruit",
    role: f.role,
    city: String(f.city || "").trim(),
    province: String(f.province || "").trim(),
    district: String(f.district || "").trim(),
    province_code: String(f.province_code || "").trim(),
    city_code: String(f.city_code || "").trim(),
    district_code: String(f.district_code || "").trim(),
    address: String(f.address || "").trim(),
    latitude: f.latitude != null ? Number(f.latitude) : null,
    longitude: f.longitude != null ? Number(f.longitude) : null,
    raw_text: String(f.desc || "").trim(),
    phone,
    phone_masked: maskPhone(phone),
    contact: String(f.contact || "").trim(),
    salary_note: "",
    published_at: Date.now(),
    source: "user",
    needs_review: false,
    tags: Array.isArray(f.tags)
      ? f.tags.map((t) => String(t).trim()).filter((t) => t && t.length <= 16).slice(0, 12)
      : [],
  };

  if (String(f.salaryNote || "").trim() === "面议") {
    record.salary_note = "面议";
  } else {
    const lo = parseInt(String(f.salaryLow || "").trim(), 10);
    const hi = parseInt(String(f.salaryHigh || "").trim(), 10);
    if (!isNaN(lo) && lo > 0) record.salary_low = lo;
    if (!isNaN(hi) && hi > 0) record.salary_high = hi;
    if (isNaN(lo) && isNaN(hi)) {
      // 既没填数字也没选面议 → 允许为空，不报错
    }
  }

  try {
    const res = await db.collection("baozi_posts").add({ data: record });
    return { success: true, _id: res._id };
  } catch (e) {
    console.error("publishPost 入库失败:", e);
    return {
      success: false,
      error: (e.errMsg || e.message || e) + "（检查 baozi_posts 集合是否存在）",
    };
  }
};
