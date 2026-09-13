// cloudfunctions/uploadImage/index.js
// 后台图片上传：接收 base64 → 存云存储 → 返回 fileID + 临时 URL
// 供后台广告管理等需要上传图片的场景使用。
//
// 入参：
//   { user, pass, fileName, base64 }   fileName 含扩展名（如 a.png）
// 返回：
//   { success, fileID, url }   url 为临时 https 链接（1小时有效，仅供预览）

const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 从文件名推断 contentType（仅用于记录，云存储主要靠扩展名）
function guessExt(fileName) {
  const m = String(fileName || "").toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/);
  return m ? m[1] : "jpg";
}

exports.main = async (event = {}) => {
  const user = String(event.user || "").trim();
  const pass = String(event.pass || "").trim();
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return fail("未授权", "AUTH_FAILED");
  }

  const base64 = String(event.base64 || "").trim();
  if (!base64) return fail("缺少图片数据", "MISSING_BASE64");

  // 去掉可能的 data:image/xxx;base64, 前缀
  const pure = base64.replace(/^data:image\/\w+;base64,/, "");

  let buffer;
  try {
    buffer = Buffer.from(pure, "base64");
  } catch (e) {
    return fail("图片数据解析失败", "BAD_BASE64");
  }
  if (!buffer || !buffer.length) return fail("图片数据为空", "EMPTY_IMAGE");
  // 限制单张 5MB
  if (buffer.length > 5 * 1024 * 1024) return fail("图片不能超过 5MB", "TOO_LARGE");

  const ext = guessExt(event.fileName);
  const cloudPath = `admin_upload/${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;

  try {
    const up = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    const fileID = up.fileID || "";
    // 换临时 URL 供预览（后台 <img> 不能直接用 cloud://）
    let url = "";
    try {
      const r = await cloud.getTempFileURL({ fileList: [fileID] });
      url = (r.fileList && r.fileList[0] && r.fileList[0].tempFileURL) || "";
    } catch (e) {
      // 换链失败不影响主流程，fileID 仍可用
    }
    return ok({ fileID, url });
  } catch (e) {
    console.error("[uploadImage] 上传失败:", e && (e.errMsg || e.message));
    return fail("上传失败: " + (e && e.errMsg ? e.errMsg : e.message));
  }
};
