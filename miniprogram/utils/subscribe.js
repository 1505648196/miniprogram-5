// utils/subscribe.js
// 订阅消息授权封装（统一入口，三个发布页 + 我的发布页复用）
//
// 【为什么需要它】
// 微信「一次性订阅消息」规则：**必须由用户在小程序内主动点击授权**，
// 后台才能在之后发一条服务通知。授权一次 = 可发一条。
// 因此本模块的唯一职责：在合适的用户操作节点（发布成功 / 进入我的发布）弹出授权，
// 把结果记到本地，避免重复打扰；授权结果本身由微信系统保存，无需我们存 openid 映射。
//
// 【模板 ID】（与 cloudfunctions/sendSubscribeMsg 的 TMPL_CFG 保持一致）
//   - AUDIT_TPL  审核结果通知：帖子审核通过/驳回时推送（发布后触发授权）
//   - UNREAD_TPL 消息未读提醒：站内新通知时推送（进消息页/我的发布时触发授权）
//
// 【设计原则】
//   ① 任何异常/拒绝都不阻断主流程（发布成功该返回就返回）
//   ② 同一模板每天最多主动请求一次（微信本身也有频次限制，避免打扰）
//   ③ 仅在用户明确操作后调用（不要 onShow 静默弹，微信会拒绝且体验差）

const AUDIT_TPL = 'iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag'; // 审核结果通知
const UNREAD_TPL = 'bQSbo99ET7wuboZeBOHnGmxSrLFDBLOhjEUE-ECWdEA'; // 消息未读提醒

const STORE_KEY = 'subscribe_req_date'; // { [tmplId]: 'YYYY-MM-DD' }

// 今天日期串（本地时区）
function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 今天是否已请求过该模板（避免一天内反复弹授权）
function requestedToday(tmplId) {
  try {
    const map = wx.getStorageSync(STORE_KEY) || {};
    return map[tmplId] === today();
  } catch (e) {
    return false;
  }
}

// 记录今天已请求
function markRequested(tmplId) {
  try {
    const map = wx.getStorageSync(STORE_KEY) || {};
    map[tmplId] = today();
    wx.setStorageSync(STORE_KEY, map);
  } catch (e) {
    // 存储失败无影响，下次最多再弹一次
  }
}

/**
 * 请求订阅授权（安全版：永不抛错，永不阻断主流程）
 *
 * ⚠️ 重要：`wx.requestSubscribeMessage` 必须由**用户点击手势**触发，
 *   一旦中间夹了 await 云请求，微信会报 "can only be invoked by user TAP gesture"。
 *   因此本函数设计为「在按钮点击的同步流程里立即调用」，回调里再继续后续逻辑
 *   （不要先 await 网络请求再回来调它）。
 *
 * @param {string[]} tmplIds 模板 ID 数组
 * @param {object}  opts     { silent: 不弹 toast 提示 }
 * @returns {Promise<{accepted: string[], rejected: string[], skipped: boolean}>}
 */
function requestSubscribe(tmplIds, opts = {}) {
  const ids = (tmplIds || []).filter(Boolean);
  const empty = { accepted: [], rejected: [], skipped: true };
  if (!ids.length) return Promise.resolve(empty);

  // 未请求过才弹；一天多次调用时直接跳过（静默）
  const toAsk = ids.filter((id) => !requestedToday(id));
  if (!toAsk.length) return Promise.resolve(empty);

  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: toAsk,
      success: (res) => {
        toAsk.forEach(markRequested);
        const accepted = toAsk.filter((id) => res && res[id] === 'accept');
        const rejected = toAsk.filter((id) => res && res[id] === 'reject');
        // 用户点了「总是保持以上选择，不再询问」时返回 ban，同样视为已拒绝
        if (accepted.length && !opts.silent) {
          wx.showToast({ title: '已开启审核结果通知', icon: 'none', duration: 1500 });
        }
        resolve({ accepted, rejected, skipped: false });
      },
      fail: (err) => {
        // 用户取消 / 系统拒绝 / 基础库不支持：都静默放行
        console.warn('[subscribe] requestSubscribeMessage fail:', (err && err.errMsg) || err);
        resolve({ accepted: [], rejected: toAsk, skipped: false });
      },
    });
  });
}

/**
 * 同步版：在用户点击瞬间调用，先拿到 Promise 再去发请求（保持手势上下文）。
 * 用法：`const subP = preRequestAuditSubscribe(); ... await subP;`
 * 与 requestAuditSubscribe 的区别：本函数**立刻就弹**，不等待任何前置 await。
 */
function preRequestAuditSubscribe() {
  return requestSubscribe([AUDIT_TPL], { silent: false });
}

module.exports = {
  AUDIT_TPL,
  UNREAD_TPL,
  requestSubscribe,
  preRequestAuditSubscribe,
  requestedToday,
};
