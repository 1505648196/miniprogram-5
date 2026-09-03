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
//     toOpenid: ""              // 可选，默认发给当前调用者 OPENID
//   }
// 返回：
//   { success: true, ...res } | { success: false, errCode, error }
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
        审核时间: { value: event.time || now },
        备注: { value: cut(event.remark || "", 30) },
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

  try {
    const res = await cloud.openapi.subscribeMessage.send({
      touser: to,
      templateId,
      page: "pages/demo/demo", // 点击通知跳首页（后续可指向具体帖/审核详情）
      lang: "zh_CN",
      miniprogramState: "formal", // developer/trial 开发自测可临时改 trial
      data,
    });
    console.log("[sendSubscribeMsg] send ok, kind:", cfg.kind, "errCode:", res.errCode, res.errMsg);
    return { success: true, ...res };
  } catch (e) {
    console.error("[sendSubscribeMsg] send failed:", e.errCode, e.errMsg || e.message || e);
    return {
      success: false,
      errCode: e.errCode,
      error: (e.errMsg || e.message || e) + "（检查模板字段名或 openapi 权限）",
    };
  }
};
