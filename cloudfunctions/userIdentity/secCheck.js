// cloudfunctions/userIdentity/secCheck.js
// 微信内容安全文本检测（security.msgSecCheck v2）
// 与 getOrCreateUser/secCheck.js 同实现（云函数目录相互独立，需各自持有一份）。
const cloud = require("wx-server-sdk");

const MAX_LEN = 2500;

function splitContent(text) {
  const s = String(text || "");
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += MAX_LEN) chunks.push(s.slice(i, i + MAX_LEN));
  return chunks;
}

function worse(a, b) {
  const order = { pass: 0, risky: 1, reject: 2 };
  return order[b] > order[a] ? b : a;
}

async function checkText(content, openid) {
  const chunks = splitContent(content);
  if (!chunks.length) return { suggest: "pass", label: 0, checkedAt: Date.now() };
  let suggest = "pass";
  let label = 0;
  for (const c of chunks) {
    try {
      const res = await cloud.openapi.security.msgSecCheck({
        content: c,
        version: 2,
        scene: 2,
        openid: String(openid || ""),
      });
      const r = res && res.result;
      const s = r && r.suggest;
      if (s === "risky" || s === "reject") {
        suggest = worse(suggest, s);
        if (r.label) label = r.label;
      }
    } catch (e) {
      console.error("[secCheck] msgSecCheck 调用失败:", (e && (e.errCode || e.errMsg)) || e);
      return { suggest: "pending", label: 0, checkedAt: Date.now() };
    }
  }
  return { suggest, label, checkedAt: Date.now() };
}

module.exports = { checkText };
