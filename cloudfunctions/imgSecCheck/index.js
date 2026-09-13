// cloudfunctions/imgSecCheck/index.js
// 图片内容安全检测（微信 security.imgSecCheck v2）
// 入参：{ fileID: "cloud://..." }
// 返回：{ success, suggest: "pass"|"risky"|"reject"|"pending", label, errCode }
//   - pass：合规，可正常使用
//   - risky/reject：违规，前端应提示并拦截
//   - pending：接口异常降级（前端可放行，由发布时文本检测兜底）

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 根据 fileID 扩展名推断 contentType（imgSecCheck 需要准确的 MIME）
function guessContentType(fileID) {
  const s = String(fileID || "").toLowerCase();
  if (/\.png($|\?)/.test(s)) return "image/png";
  if (/\.gif($|\?)/.test(s)) return "image/gif";
  if (/\.webp($|\?)/.test(s)) return "image/webp";
  if (/\.bmp($|\?)/.test(s)) return "image/bmp";
  // 默认 jpeg（小程序最常见）
  return "image/jpeg";
}

exports.main = async (event) => {
  const fileID = String(event.fileID || "").trim();
  if (!fileID) return fail("缺少 fileID", "MISSING_FILEID");

  try {
    // 1) 下载图片内容（buffer）
    const dl = await cloud.downloadFile({ fileID });
    const buffer = dl.fileContent;
    if (!buffer || !buffer.length) {
      return ok({ suggest: "pending", label: 0, note: "图片内容为空" });
    }

    // 2) 调微信图片安全检测
    const res = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: guessContentType(fileID),
        value: buffer,
      },
      version: 2,
    });

    const r = (res && res.result) || {};
    // errCode 0 = 正常；87014 = 内容违规
    const errCode = res.errCode != null ? res.errCode : 0;
    if (errCode === 87014) {
      return ok({ suggest: "reject", label: r.label || 0, errCode });
    }
    const suggest = r.suggest === "risky" || r.suggest === "review" ? "risky" : "pass";
    return ok({ suggest, label: r.label || 0, errCode });
  } catch (e) {
    console.error("[imgSecCheck] 检测失败:", e.errCode, e.errMsg || e);
    // 接口异常（未配权限/网络/额度等）：降级 pending，不阻断上传
    return ok({ suggest: "pending", label: 0, errCode: e.errCode || -1 });
  }
};
