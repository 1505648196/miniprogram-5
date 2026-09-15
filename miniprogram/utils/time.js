// utils/time.js
// 时间格式化工具（全站统一）
//
// 【为什么抽出来】
//   此前 12 个页面各自重复定义了一份完全相同的 fmtAgo()，改动时需同步 12 处。
//   抽到本模块后，统一维护一处。
//
// 【使用方式】
//   const { fmtAgo } = require('../../utils/time.js');
//   const text = fmtAgo(post.published_at);  // → '今天' / '昨天' / 'N天前' / 'N个月前' / 'N年前'
//
// 【语义说明】
//   返回相对时间，用于列表卡片的「发布时间」展示：
//     ts >= 今天 00:00          → '今天'
//     ts >= 昨天 00:00          → '昨天'
//     ts < 30 天前              → 'N天前'
//     ts < 365 天前             → 'N个月前'
//     更早                      → 'N年前'
//   ts 为空/0/非法值            → ''（空字符串，由调用方决定是否展示）

const DAY = 864e5; // 1 天（毫秒）

/**
 * 格式化相对时间（今天/昨天/N天前/N个月前/N年前）
 * @param {number} ts 时间戳（毫秒）
 * @returns {string} 相对时间文本；ts 为空/非法时返回空字符串
 */
function fmtAgo(ts) {
  if (!ts) return '';
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (ts >= todayStart) return '今天';
  const days = Math.floor((todayStart - ts) / DAY);
  if (days <= 1) return '昨天';
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

module.exports = { fmtAgo };
