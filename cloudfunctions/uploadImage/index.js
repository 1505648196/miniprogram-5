// cloudfunctions/uploadImage/index.js
// 后台图片上传：接收 base64 → 存云存储 → 返回 fileID + 临时 URL
// 供后台广告管理等需要上传图片的场景使用。
//
// 入参：
//   { user, pass, fileName, base64 }   fileName 含扩展名（如 a.png）
// 返回：
//   { success, fileID, url }   url 为临时 https 链接（1小时有效，仅供预览）
//
// ⚠️ 鉴权已从「环境变量 ADMIN_USER/ADMIN_PASS」改为「数据库 admin_accounts 账号 + 哈希密码」，
//    与 adminAuth 后台登录同一套账号体系，避免后台登录后上传图片报「未授权」。

const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_ACCOUNTS = "admin_accounts"; // 与 adminAuth 一致的后台账号表（哈希密码）

function ok(data = {}) { return { success: true, ...data }; }
function fail(message, code = "ERROR") { return { success: false, code, message }; }

// 密码哈希：sha256(salt + pass)，与 adminAuth.hashPass 保持一致
function hashPass(pass, salt) {
  return crypto.createHash("sha256").update(String(salt) + String(pass)).digest("hex");
}

// 鉴权：查 admin_accounts 表校验账号密码（与 adminAuth 同一套账号体系）
async function authorize(user, pass) {
  const username = String(user || "").trim();
  const password = String(pass || "");
  if (!username || !password) return false;
  try {
    const r = await db
      .collection(ADMIN_ACCOUNTS)
      .where({ username, status: "active" })
      .limit(1)
      .get();
    const acct = (r.data && r.data[0]) || null;
    if (!acct) return false;
    return hashPass(password, acct.salt) === acct.pass_hash;
  } catch (e) {
    console.error("[uploadImage] 查询管理员账号失败:", e && e.errMsg);
    return false;
  }
}

// 从文件名推断 contentType（仅用于记录，云存储主要靠扩展名）
function guessExt(fileName) {
  const m = String(fileName || "").toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp)$/);
  return m ? m[1] : "jpg";
}

exports.main = async (event = {}) => {
  const user = String(event.user || "").trim();
  const pass = String(event.pass || "").trim();
  // 鉴权：走 admin_accounts 数据库账号（与 adminAuth 后台登录同源），
  // 避免后台登录后上传图片因「环境变量账密」与「数据库账密」不一致而报未授权。
  const authed = await authorize(user, pass);
  if (!authed) {
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
