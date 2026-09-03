// utils/privacy.js
// 隐私脱敏：电话号码识别与替换。
// 目的：帖子正文/标题/联系方式/地址等任何展示文本里若夹带了完整手机号/座机，
//       都必须脱敏后展示，避免泄露完整号码；同时把脱敏后的号单独提取展示。
//
// 用法：
//   const privacy = require('../../utils/privacy.js');
//   privacy.maskText('招师傅 电话 13812345678');      // -> '招师傅 电话 138****5678'
//   privacy.extractPhones('13812345678 021-55667788'); // -> ['138****5678', '021-5****6788']

// 11 位大陆手机号（1 开头，第二位 3-9），中间可夹 - 空格。前后不允许再是数字。
// 不用 lookbehind（向后断言个别引擎不稳定），改用捕获"前导非数字或串首"：
//   ($1=边界字符, 需原样带回)
const MOBILE = /(^|[^\d])(1[3-9]\d)[\s-]?(\d{4})[\s-]?(\d{4})(?!\d)/g;
// 座机：区号(0xx/0xxx) + 7~8 位号码，可能带 -。号码较长时保留首 1 位 + 末 3 位，中间填 *
const TEL = /(^|[^\d])(0\d{2,3})[\s-]?(\d{7,8})(?!\d)/g;

// 在 text 里识别并替换所有手机号/座机为脱敏展示号
function maskText(text) {
  if (text == null) return '';
  let s = String(text);
  // 手机号：前 3 位 + **** + 后 4 位
  s = s.replace(MOBILE, (m, lead, p, mid, tail) => `${lead}${p}****${tail}`);
  // 座机：区号 + '-' + 首 1 位 + '****' + 末 3 位
  s = s.replace(TEL, (m, lead, area, num) => {
    const keep = num.length >= 8 ? num.slice(0, 1) + '****' + num.slice(-3) : num.slice(0, 1) + '****' + num.slice(-2);
    return `${lead}${area}-${keep}`;
  });
  return s;
}

// 从 text 里提取所有脱敏后的号码（供单独一栏展示 / 作为可复制文本）
function extractPhones(text) {
  if (text == null) return [];
  const s = String(text);
  const out = [];
  s.replace(MOBILE, (m, lead, p, mid, tail) => {
    out.push(`${p}****${tail}`);
    return m;
  });
  s.replace(TEL, (m, lead, area, num) => {
    const keep = num.length >= 8 ? num.slice(0, 1) + '****' + num.slice(-3) : num.slice(0, 1) + '****' + num.slice(-2);
    out.push(`${area}-${keep}`);
    return m;
  });
  return out;
}

module.exports = { maskText, extractPhones };
