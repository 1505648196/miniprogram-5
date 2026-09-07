// cloudfunctions/getOrCreateUser/secCheck.js
// 微信内容安全文本检测（security.msgSecCheck v2）
// 与 managePost/secCheck.js 同实现（云函数目录相互独立，需各自持有一份）。
// - 自动分段：单次 content 上限 2500 字符，多段取最严重结果
// - 需在 config.json 的 permissions.openapi 中配置 "security.msgSecCheck"
// 返回：
//   { suggest: "pass"|"risky"|"reject"|"pending", label, checkedAt }
//   - pass：正常；risky：疑似待人工；reject：明确违规；
//   - pending：接口异常时的降级结果（放行，不误杀）
const cloud = require("wx-server-sdk");

const MAX_LEN = 2500;

function splitContent(text) {
  const s = String(text || "");
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += MAX_LEN) chunks.push(s.slice(i, i + MAX_LEN));
  return chunks;
}

// 取更严重的结果：pass < risky < reject
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
        scene: 2, // 评论场景
        openid: String(openid || ""),
      });
      const r = res && res.result;
      const s = r && r.suggest;
      if (s === "risky" || s === "reject") {
        suggest = worse(suggest, s);
        if (r.label) label = r.label;
      }
    } catch (e) {
      // 接口异常（未配置权限/网络/额度等）：降级 pending，放行
      console.error("[secCheck] msgSecCheck 调用失败:", (e && (e.errCode || e.errMsg)) || e);
      return { suggest: "pending", label: 0, checkedAt: Date.now() };
    }
  }
  return { suggest, label, checkedAt: Date.now() };
}

module.exports = { checkText };
