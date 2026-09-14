// cloudfunctions/sendSubscribeMsg/index.js
// 发送小程序订阅消息（subscribeMessage.send）
//
// 支持模板（templateId → 后台关键词映射，发送字段自动对位）：
//   1) 消息未读提醒 (模板 1185)
//        bQSbo99ET7wuboZeBOHnGmxSrLFDBLOhjEUE-ECWdEA
//        thing2=消息内容 / time37=时间 / thing7=备注
//   2) 审核结果通知 (模板 786)
//        iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag
//        phrase1=审核结果 / thing2=审核内容 / date3=审核时间 / thing7=备注
//
// 入参（语义字段，云端按 templateId 映射到后台关键词；name 不一致会 43101/47003）：
//   {
//     templateId: "bQSbo...",   // 必填，两个模板之一
//     content: "消息内容/审核内容", // 消息未读提醒=消息内容；审核结果=审核内容
//     result: "通过/驳回",       // 仅"审核结果通知"用（审核结果）
//     time: "2026-09-02 12:00",  // time(date 同用此值，如 2026-09-02)
//     remark: "备注",            // 两个模板都用
//     page: "pages/detail/detail?id=xxx", // 可选，点击通知跳转页（默认首页）
//     toOpenid: ""              // 可选，默认发给当前调用者 OPENID
//     miniprogramState: ""      // 可选，formal(默认)/trial/developer
//   }
// 返回：
//   { success: true, ...res } | { success: false, errCode, error }
//
// ⚠️ 订阅消息为「一次性订阅」：用户每授权一次只能发一条。发失败常见 errCode：
//   43101 = 用户未订阅/已用完（属正常，不代表代码错误，静默跳过即可）
//   47003 = 模板字段名/类型不符
//   40003 = openid 非法
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 模板 → data 映射。key 为后台关键词，value 取入参语义字段
// thing 类型注意字数限制：phrase1 审核结果一般 "通过/驳回" 等短词即可
const TMPL_CFG = {
  // 消息未读提醒(1185)
  "bQSbo99ET7wuboZeBOHnGmxSrLFDBLOhjEUE-ECWdEA": {
    kind: "unread",
    data(event, now) {
      return {
        消息内容: { value: cut(event.content || "您有一条新的消息", 30) },
        时间: { value: event.time || now },
        备注: { value: cut(event.remark || "可在小程序内查看详情", 30) },
      };
    },
  },
  // 审核结果通知(786)
  "iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag": {
    kind: "audit",
    data(event, now) {
      return {
        审核结果: { value: cut(event.result || "审核通过", 5) }, // phrase 一般很短
        审核内容: { value: cut(event.content || "您提交的信息", 20) }, // thing 有字数上限
        审核时间: { value: cut(event.time || now, 20) },
        备注: { value: cut(event.remark || "点击查看详情", 30) },
      };
    },
  },
};

function cut(s, n) {
  return String(s || "").slice(0, n);
}

// 本地格式化时间：YYYY-MM-DD HH:mm
function formatNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const to = event.toOpenid || OPENID;
  if (!to) return { success: false, error: "未获取到用户身份" };

  const templateId = event.templateId;
  if (!templateId) return { success: false, error: "缺少 templateId" };

  const cfg = TMPL_CFG[templateId];
  if (!cfg) {
    return { success: false, error: "未配置该模板(仅支持消息未读提醒/审核结果通知)" };
  }

  const now = formatNow();
  const data = cfg.data(event, now);
  // 跳转页：可指定具体帖子详情 / 消息页；不传回首页
  const page = event.page || "pages/demo/demo";
  // 运行环境：默认正式版；开发自测可在调用时传 "trial"
  const miniprogramState = event.miniprogramState || "formal";

  try {
    const res = await cloud.openapi.subscribeMessage.send({
      touser: to,
      templateId,
      page,
      lang: "zh_CN",
      miniprogramState,
      data,
    });
    console.log("[sendSubscribeMsg] send ok, kind:", cfg.kind, "errCode:", res.errCode, res.errMsg);
    return { success: true, ...res };
  } catch (e) {
    console.error("[sendSubscribeMsg] send failed:", e.errCode, e.errMsg || e.message || e);
    // 43101 = 用户未订阅/次数用尽：属正常业务结果，不是异常，调用方无需重试
    const errCode = e.errCode;
    let error = e.errMsg || e.message || String(e);
    if (errCode === 43101) error = "用户未订阅或订阅次数已用尽（一次性订阅），跳过本次推送";
    else if (errCode === 47003) error = "模板字段名/类型不符（检查 TMPL_CFG 关键词）";
    else if (errCode === 40003) error = "openid 非法";
    return { success: false, errCode, error };
  }
};
