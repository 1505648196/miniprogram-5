// cloudfunctions/publishPost/index.js
// 发布帖子入库：校验 → 内容安全 → 电话脱敏 → 写 baozi_posts
// 统一支持全部分类（前端发布弹层的 7 类）：
//   recruit 招工 / jobseek 求职 / transfer 店铺转让 / want_shop 求店 /
//   equip_sell 设备出售 / equip_buy 设备求购 / other 其他
//
// 发布收费（先付款后入库，凭证制）：
//   非会员发布必须先付费 2 元拿到「发布凭证」(baozi_publish_quota, status=unused)，
//   本函数入库前校验并消费凭证；会员免费直接入库。
//   云端权威判定会员 + 校验凭证，前端传的 paid 字段一律忽略（防伪造）。
//
// 入参：
//   { action: 'precheck' | 'create'(默认), form: {...} }
//   - action='precheck'：轻量返回 { isVip, hasQuota }，供前端决定是否需要先付费
//   - action='create'：正式入库（非会员需已有可用凭证，否则拒绝）
// 返回：
//   { success: true, _id, needs_review, sec_status }
//   | { success: false, error }
const cloud = require("wx-server-sdk");
const { checkText } = require("./secCheck.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 发布凭证集合（与 payForPhone 的 PUBLISH_QUOTA 同名）
const PUBLISH_QUOTA = "baozi_publish_quota";

// 是否为有效会员（membership=vip 且未过期），与 memberService/payForPhone 同一口径
async function isVipMember(openid) {
  if (!openid) return false;
  try {
    const r = await db.collection("baozi_users").where({ openid_wxapp: openid }).limit(1).get();
    const u = r.data && r.data[0];
    if (!u) return false;
    return u.membership === "vip" && Number(u.membership_expire_at) > Date.now();
  } catch (e) {
    console.error("[publishPost] 会员状态查询失败:", e && e.errMsg);
    return false;
  }
}

// 是否已有可用发布凭证（未消费）
async function hasUnusedQuota(openid) {
  if (!openid) return false;
  try {
    const r = await db
      .collection(PUBLISH_QUOTA)
      .where({ openid, status: "unused" })
      .limit(1)
      .get();
    return !!(r.data && r.data.length);
  } catch (e) {
    console.error("[publishPost] 查询发布凭证失败:", e && e.errMsg);
    return false;
  }
}

// 消费一条可用凭证（原子性尽力而为：先取一条 unused → 置 used 并绑定 postId）
// 返回 true=消费成功，false=无可用凭证
async function consumeQuota(openid, postId) {
  if (!openid) return false;
  try {
    const r = await db
      .collection(PUBLISH_QUOTA)
      .where({ openid, status: "unused" })
      .orderBy("created_at", "asc") // 先消费最早购买的那条（FIFO）
      .limit(1)
      .get();
    const q = r.data && r.data[0];
    if (!q) return false;
    await db.collection(PUBLISH_QUOTA).doc(q._id).update({
      data: { status: "used", used_post_id: postId, used_at: Date.now() },
    });
    return true;
  } catch (e) {
    console.error("[publishPost] 消费发布凭证失败:", e && e.errMsg);
    return false;
  }
}

// 所有分类的通用必填展示字段（无专项的帖子也要能看）
// 脱敏：保留前 3 后 4，中间 4 位 ****（187****9563）
function maskPhone(p) {
  const s = String(p || "").trim();
  if (!/^1\d{10}$/.test(s)) return "";
  return s.slice(0, 3) + "****" + s.slice(7);
}

// 数字安全转 int（>=0；非法返回 fallback）
function int(v, fallback = 0) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^\d-]/g, ""), 10);
  return isNaN(n) || n < 0 ? fallback : n;
}

// 数组化 & 清洗字符串数组（截断长度、去空）
function cleanArr(v, maxLen = 6) {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => String(t == null ? "" : t).trim())
    .filter((t) => t && t.length <= 24)
    .slice(0, maxLen);
}

// 单条正则拆分字符串 → 数组（支持"、|，,;/ 空格"分隔），并清洗
function splitTerms(v, maxLen = 6) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  return s
    .split(/[、，,;；/|\\\s]+/)
    .map((t) => t.trim())
    .filter((t) => t && t.length <= 24)
    .slice(0, maxLen);
}

// 分类中文名（仅用于通知文案）
const DATA_TYPE_NAMES = {
  recruit: "招工", jobseek: "求职", transfer: "店铺转让", want_shop: "求店",
  equip_sell: "设备出售", equip_buy: "设备求购", carpool_car: "车找人",
  carpool_person: "人找车", other: "信息",
};

// 给发帖人推一条审核结果站内通知（写 baozi_messages，type=review，发给 to_openid）
// 仅在审核通过(pass)入库成功后调用；失败不影响主流程(吞掉并打日志)。
async function pushReviewNotify(openid, dataType, postId, typeName) {
  if (!openid || !postId) return;
  try {
    await db.collection("baozi_messages").add({
      data: {
        type: "review",
        to_openid: openid,
        title: "发布审核通过",
        content: `您的「${typeName}」信息已审核通过并发布，可在平台查看。`,
        post_id: postId,
        read_by: [],
        sender: "system",
        created_at: Date.now(),
      },
    });
  } catch (e) {
    console.error("publishPost 推送审核通知失败:", e && e.errMsg);
  }
}

// 审核结果通知模板（与 sendSubscribeMsg 的 TMPL_CFG key 保持一致）
const SUB_TMPL_AUDIT = "iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag";

/**
 * 给发帖人推一条微信订阅消息（服务通知）——审核通过时。
 * 与站内通知独立：任一步失败互不影响；用户未授权(43101)属正常，静默跳过。
 * 全程 try/catch：任何异常只打日志，绝不向上抛，确保不影响发布主流程。
 */
async function pushReviewSubscribe(openid, dataType, postId, typeName) {
  if (!openid || !postId) return;
  try {
    const res = await cloud.callFunction({
      name: "sendSubscribeMsg",
      data: {
        templateId: SUB_TMPL_AUDIT,
        toOpenid: openid,
        result: "通过",
        content: `${typeName || "信息"}已审核通过`.slice(0, 20),
        remark: "已发布，点击查看详情".slice(0, 30),
        page: `pages/detail/detail?id=${postId}`,
      },
    });
    const r = (res && res.result) || {};
    if (r.success) {
      console.log("[publishPost] 审核订阅消息已发送:", postId);
    } else if (r.errCode === 43101) {
      // 用户未订阅/次数用尽：正常业务结果，忽略
      console.log("[publishPost] 审核订阅消息跳过（用户未订阅）:", postId);
    } else {
      console.warn("[publishPost] 审核订阅消息发送失败:", r.errCode, r.error);
    }
  } catch (e) {
    console.error("[publishPost] pushReviewSubscribe 异常:", e && (e.errMsg || e.message));
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const openid = OPENID || "";
  const f = event.form || {};
  const dataType = String(f.data_type || "recruit").trim();

  // ---- 发布收费：先付款后入库（凭证制）----
  // action='precheck'：轻量返回会员/凭证状态，供前端决定是否先付费
  // action='create'（默认）：正式入库，非会员需消费一条可用凭证
  const action = String(event.action || "create").trim();
  if (action === "precheck") {
    return {
      success: true,
      is_vip: await isVipMember(openid),
      has_quota: await hasUnusedQuota(openid),
    };
  }

  // 非会员必须校验并消费一条发布凭证；会员免费直接放行。
  // 前端传的 paid 字段一律忽略（凭证/会员是唯一权威，杜绝"传 paid:true 白嫖"）。
  const isVip = await isVipMember(openid);
  if (!isVip) {
    const hasQ = await hasUnusedQuota(openid);
    if (!hasQ) {
      return { success: false, error: "发布需先支付 2 元，请先完成支付", code: "NEED_PAY" };
    }
  }

  // ---- §2.4 封禁校验：封禁用户不允许发布 ----
  if (openid) {
    try {
      const u = await db
        .collection("baozi_users")
        .where({ openid_wxapp: openid })
        .limit(1)
        .get();
      const me = u.data && u.data[0];
      if (me && me.status === "banned") {
        return { success: false, error: "账号已被封禁，无法发布信息" };
      }
    } catch (e) {
      // 查询失败不阻塞发布：避免因用户表异常导致正常用户无法发帖
      console.error("[publishPost] 封禁校验失败:", e);
    }
  }

  // ---- 必填校验（通用）----
  const phone = String(f.phone || "").trim();
  if (!phone) return { success: false, error: "请填写联系电话" };
  if (!/^1\d{10}$/.test(phone)) return { success: false, error: "请输入 11 位手机号" };

  const city = String(f.city || "").trim();
  const desc = String(f.desc || "").trim();
  if (!city) return { success: false, error: "请选择区域(城市)" };
  if (!desc) return { success: false, error: "请填写具体描述" };

  const regionBase = {
    data_type: dataType,
    _openid: openid,
    userid: openid, // 显式存唯一用户标识（小程序内即 openid），与 _openid 并存
    province: String(f.province || "").trim(),
    province_code: String(f.province_code || "").trim(),
    city,
    city_code: String(f.city_code || "").trim(),
    district: String(f.district || "").trim(),
    district_code: String(f.district_code || "").trim(),
    address: String(f.address || "").trim(),
    latitude: f.latitude != null && f.latitude !== "" ? Number(f.latitude) : null,
    longitude: f.longitude != null && f.longitude !== "" ? Number(f.longitude) : null,
    raw_text: desc,
    phone,
    phone_masked: maskPhone(phone),
    contact: String(f.contact || "").trim(),
    username: String(f.username || "").trim(), // 发布者称呼(可空)
    image: String(f.image || "").trim(), // 封面图：云存储 fileID
    published_at: Date.now(),
    source: "user",
    needs_review: false,
    approved: true, // 结果型别名：approved = !needs_review（true=已通过/可展示）
    // 发布收费（先付款后入库）：能走到这里说明「会员」或「已消费凭证」，
    // 帖子一律按已付费正常展示。不再信任前端 paid 字段。
    paid: true,
    tags: cleanArr(f.tags),
  };

  // ---- 各分类专项字段 ----
  // 师傅类型（招工 1-14 / 求职复用 1-14 / 店铺类型 1-5 走 role_id）
  const roleId = int(f.roleId != null ? f.roleId : f.role_id, 0);
  if (f.role || roleId > 0) {
    regionBase.role = String(f.role || "").trim();
    regionBase.role_id = roleId;
  }

  switch (dataType) {
    case "recruit": {
      // 招工：给价 salary（单一数字）
      regionBase.salary = int(f.salary, 0);
      break;
    }
    case "jobseek": {
      // 求职：期望薪资 salary_expect + 同名字段 salary(=期望值，供统一 salary 筛选)；
      // 到岗方式/可服务地区/诉求(want_terms)/薪资说明
      const exp = int(f.salary_expect != null ? f.salary_expect : f.salary, 0);
      regionBase.salary_expect = exp;
      regionBase.salary = exp; // 与招工同构，混排 salary>=X 筛选对求职也生效
      regionBase.salary_note = String(f.salary_note || "").trim();
      regionBase.availability = String(f.availability || "").trim(); // 长期/短期/顶班/随时可到
      regionBase.service_area = String(f.service_area || "").trim(); // 可服务地区
      regionBase.want_terms = splitTerms(f.want_terms);
      break;
    }
    case "transfer": {
      // 店铺转让：price=转让费 + 月租/面积/日营收/带设备/条件
      regionBase.price = int(f.price, 0);
      regionBase.monthly_rent = int(f.monthly_rent, 0);
      regionBase.area_sqm = int(f.area_sqm, 0);
      regionBase.daily_revenue = int(f.daily_revenue, 0);
      regionBase.has_equipment = String(f.has_equipment || "").trim(); // 全带/部分/不带
      regionBase.terms = splitTerms(f.terms);
      break;
    }
    case "want_shop": {
      // 求店：price=预算 + 租金上限/面积下限/诉求
      regionBase.price = int(f.price, 0);
      regionBase.rent_max = int(f.rent_max, 0);
      regionBase.area_min = int(f.area_min, 0);
      regionBase.want_terms = splitTerms(f.want_terms);
      break;
    }
    case "equip_sell":
    case "equip_buy": {
      // 二手设备：price=售价/预算 + 成色 cond(0-10)
      regionBase.price = int(f.price, 0);
      const cond = int(f.cond, 0);
      regionBase.cond = cond > 10 ? 10 : cond;
      break;
    }
    case "carpool_car":
    case "carpool_person": {
      // 顺风车：车找人/人找车，无价格。存 出发地/目的地/出发时间/最晚出发/可乘人数
      regionBase.from_place = String(f.from_place || "").trim();
      regionBase.to_place = String(f.to_place || "").trim();
      regionBase.depart_time = String(f.depart_time || "").trim();
      regionBase.depart_deadline = String(f.depart_deadline || "").trim();
      regionBase.seats = int(f.seats, 0); // 可乘人数/剩余座位，>0 才有意义
      break;
    }
    case "other": {
      // 其他：无价格（不发/不存 price），仅普通文本信息
      break;
    }
    default: {
      // 未知分类：不落库，避免脏数据
      return { success: false, error: "不支持的信息分类：" + dataType };
    }
  }

  // ---- 内容安全审核：pass → 正常展示；risky/reject/异常 → 入库待复核 ----
  const secText = [desc, regionBase.contact, regionBase.address, regionBase.role]
    .filter((v) => v)
    .join("\n");
  const sec = await checkText(secText, openid);
  regionBase.needs_review = sec.suggest === "pass" ? false : true;
  regionBase.approved = !regionBase.needs_review; // 结果型别名：通过=true，待审=false
  regionBase.sec_status = sec.suggest;
  if (sec.label) regionBase.sec_label = sec.label;
  regionBase.sec_checked_at = sec.checkedAt;

  // 信用分：查发布者 credit_score 冗余写入帖子（新用户默认 100），
  // 替代旧的 credit(1-4 等级)。查不到/异常时回落 100，不阻断发布。
  try {
    const uRes = await db.collection("baozi_users").where({ openid_wxapp: openid }).limit(1).get();
    const u = (uRes.data && uRes.data[0]) || null;
    regionBase.credit_score = u && u.credit_score != null ? Number(u.credit_score) : 100;
  } catch (e) {
    regionBase.credit_score = 100;
  }

  try {
    const res = await db.collection("baozi_posts").add({ data: regionBase });

    // 非会员：入库成功后消费一条发布凭证（绑定本条帖子，防止复用）
    if (!isVip) {
      await consumeQuota(openid, res._id);
    }

    // 审核通过 → 给发帖人推一条站内通知（review）
    // （此时必已付款/会员，不会出现"没付钱却收到审核通过通知"）
    if (!regionBase.needs_review && openid) {
      const typeName = DATA_TYPE_NAMES[dataType] || DATA_TYPE_NAMES.other;
      await pushReviewNotify(openid, dataType, res._id, typeName);
      // 审核通过 → 额外推微信订阅消息（服务通知）。用户未授权(43101)静默跳过，不影响发布。
      await pushReviewSubscribe(openid, dataType, res._id, typeName);
    }
    return {
      success: true,
      _id: res._id,
      data_type: dataType,
      needs_review: regionBase.needs_review,
      sec_status: regionBase.sec_status,
    };
  } catch (e) {
    console.error("publishPost 入库失败:", e);
    return {
      success: false,
      error: (e.errMsg || e.message || e) + "（检查 baozi_posts 集合是否存在）",
    };
  }
};
