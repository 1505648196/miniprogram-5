// utils/bindPhone.js
// 手机号绑定引导（居中弹窗）的公共逻辑
// 触发时机：进入「我的」页 / 「我的发布」页 / 详情页时调用。
// 去重策略：
//   - 云端已绑定手机号(phone_verified=true) → 永不弹（根本条件）
//   - 「我的」页：每次进入都弹（always=true，未绑定时天天弹，不记 3 天标记）
//   - 详情页 / 「我的发布」：弹过但未绑定 → 隔 3 天再弹一次（本地 storage 记录上次弹的时间戳）

const STORAGE_KEY = 'baozi_bind_guide_last_ts'; // 上次弹过的时间戳（毫秒）
const RECHECK_INTERVAL = 3 * 24 * 60 * 60 * 1000; // 3 天

// 是否已过了 3 天间隔（没弹过也算「该弹」）
function isOverInterval() {
  try {
    const last = Number(wx.getStorageSync(STORAGE_KEY)) || 0;
    if (!last) return true; // 从未弹过
    return Date.now() - last >= RECHECK_INTERVAL;
  } catch (e) {
    return true;
  }
}

// 写「已弹过」时间戳（弹出弹层的同一次调用里立即写，防重复弹）
function markShown() {
  try {
    wx.setStorageSync(STORAGE_KEY, Date.now());
  } catch (e) {}
}

// 查当前用户是否已绑定手机号（调 getOrCreateUser）
// 返回 Promise<boolean>：true=已绑定
function fetchPhoneVerified() {
  return wx.cloud
    .callFunction({ name: 'getOrCreateUser', data: {}, config: { timeout: 10000 } })
    .then((res) => {
      const r = res.result || {};
      return !!(r.success && r.user && r.user.phone_verified);
    })
    .catch(() => false); // 查询失败按未绑定处理（结合 markShown 去重，不反复弹）
}

// 组合判断：是否该弹绑定引导
//   always=true（「我的」页用）：跳过 3 天间隔，只查云端是否已绑定 → 未绑定就每次弹
//   always=false/缺省（详情页/我的发布用）：距上次弹过未满 3 天 → 不弹
//   云端已绑定 → 永不弹（所有场景的根本条件）
async function shouldShowBindSheet(always) {
  if (!always && !isOverInterval()) return false;
  const verified = await fetchPhoneVerified();
  return !verified;
}

module.exports = {
  STORAGE_KEY,
  isOverInterval,
  markShown,
  fetchPhoneVerified,
  shouldShowBindSheet,
};
