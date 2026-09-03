// cloudfunctions/publishPost/index.js
// 发布帖子入库：校验 → 电话脱敏 → 写 baozi_posts
// 目前支持 data_type=recruit（招工），字段与发布表单一一对应
//
// 入参：
//   {
//     form: {
//       role: "大师傅",            // 师傅类型中文名（写死选项，展示用）
//       roleId: 1,                 // 师傅类型稳定角色 ID（写死选项，入库写 role_id）
//       salary: "6000",            // 薪资（元/月，单一数字；面议时传 0 或不传）
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
//       username: "包子一哥",       // 发布者昵称/称呼（展示发布用户是谁，可空）
//       credit: 1,                 // 信用评分（1优秀/2极好/3良好/4一般，可空=0）
//     }
//   }
// 返回：
//   { success: true, _id: "..." } | { success: false, error: "..." }
const cloud = require("wx-server-sdk");
const { checkText } = require("./secCheck.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 脱敏：保留前 3 后 4，中间 4 位 ****（187****9563）
function maskPhone(p) {
  const s = String(p || "").trim();
  if (!/^1\d{10}$/.test(s)) return "";
  return s.slice(0, 3) + "****" + s.slice(7);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const f = event.form || {};

  // ---- 必填校验 ----
  if (!f.role) return { success: false, error: "请选择师傅类型" };
  if (!f.city) return { success: false, error: "请选择区域" };
  if (!f.phone) return { success: false, error: "请填写联系电话" };
  if (!/^1\d{10}$/.test(String(f.phone).trim())) {
    return { success: false, error: "请输入 11 位手机号" };
  }

  const phone = String(f.phone).trim();

  // ---- 薪资解析 ----
  // 只存单一 salary(元/月)：有明确薪资存数字，面议/未填存 0（前端判空显示"面议"）
  const salary = parseInt(String(f.salary || "").trim(), 10);
  // 师傅类型稳定角色 ID：前端传数字（1-14）；非法/缺省为 0
  const roleId = parseInt(String(f.roleId != null ? f.roleId : "").trim(), 10) || 0;
  const record = {
    data_type: "recruit",
    _openid: OPENID || "",
    userid: OPENID || "", // 显式存唯一用户标识（小程序内即 openid），与 _openid 并存
    role: f.role,
    role_id: roleId > 0 ? roleId : 0,
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
    username: String(f.username || "").trim(), // 发布者昵称/称呼（展示发布用户，可空）
    // 信用评分：1优秀/2极好/3良好/4一般；非法/缺省为 0（前端不显示信用标签）
    credit: parseInt(String(f.credit != null ? f.credit : "").trim(), 10) || 0,
    salary: !isNaN(salary) && salary > 0 ? salary : 0,
    published_at: Date.now(),
    source: "user",
    needs_review: false,
    tags: Array.isArray(f.tags)
      ? f.tags.map((t) => String(t).trim()).filter((t) => t && t.length <= 16).slice(0, 12)
      : [],
  };

  // 内容安全审核：pass → 正常展示；risky/reject/接口异常 → 入库待人工复核（列表不展示）
  const sec = await checkText([f.desc, f.contact, f.address, f.role].join("\n"), OPENID);
  record.needs_review = sec.suggest === "pass" ? false : true;
  record.sec_status = sec.suggest;
  if (sec.label) record.sec_label = sec.label;
  record.sec_checked_at = sec.checkedAt;

  try {
    const res = await db.collection("baozi_posts").add({ data: record });
    return {
      success: true,
      _id: res._id,
      needs_review: record.needs_review,
      sec_status: record.sec_status,
    };
  } catch (e) {
    console.error("publishPost 入库失败:", e);
    return {
      success: false,
      error: (e.errMsg || e.message || e) + "（检查 baozi_posts 集合是否存在）",
    };
  }
};
