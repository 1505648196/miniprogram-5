// utils/topPromotion.js
// 置顶推广 — 共享配置与支付逻辑（发布招工 / 通用发布 / 顺风车发布 三页复用）
//
// 【为什么抽出来】
//   三个发布页的置顶是同一套东西（同样的套餐、同样的支付链路），
//   此前只在 publish_recruit 内实现。抽到此处后：
//     · 套餐价格改一处，三页同步生效，不会出现"某页价格忘了改"的不一致
//     · 支付链路（create → wxpay_order → requestPayment → verify）只维护一份
//
// ⚠️ 价格与天数必须与云函数 payForPhone 的 TOP_FEES 保持一致（服务端权威定价）。
//    前端这里的 price 仅用于展示；真实扣款金额以服务端下单返回为准。
//    若需调价：改 cloudfunctions/payForPhone/index.js 的 TOP_FEES，再同步改这里。

const { callPayCommon, pickPayment } = require('./pay.js');

// 套餐配置（分）。days 必须与云函数 TOP_FEES 的 key 对齐。
const TOP_OPTIONS = [
  {
    days: 1,
    label: '1天置顶',
    desc: '首页置顶展示，优先曝光',
    price: 5000,
    priceText: '¥50',
    originText: '¥80',
  },
  {
    days: 3,
    label: '3天置顶',
    desc: '3 天持续置顶，曝光更稳定',
    price: 15000,
    priceText: '¥150',
    originText: '¥240',
    tag: '推荐',
  },
  {
    days: 7,
    label: '7天置顶',
    desc: '整整一周高曝光，对接更快',
    price: 35000,
    priceText: '¥350',
    originText: '¥560',
  },
];

// 各业务的置顶说明文案（按 data_type 定制，让用户明确"置顶对我这条信息有什么用"）
const TOP_INTRO = {
  recruit: '开启置顶后，您的招聘信息将排在同城搜索结果前列，曝光量提升 3-8 倍，招到合适师傅更快。',
  jobseek: '开启置顶后，您的求职信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快找到合适岗位。',
  transfer: '开启置顶后，您的店铺转让信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快找到接手人。',
  want_shop: '开启置顶后，您的求店信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快找到合适店铺。',
  equip_sell: '开启置顶后，您的设备信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快卖出。',
  equip_buy: '开启置顶后，您的求购信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快找到合适设备。',
  carpool_car: '开启置顶后，您的拼车信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快凑齐同行人。',
  carpool_person: '开启置顶后，您的搭车信息将排在同城搜索结果前列，曝光量提升 3-8 倍，更快找到顺路车。',
  other: '开启置顶后，您的信息将排在同城搜索结果前列，曝光量提升 3-8 倍，获得更多关注。',
};

/**
 * 取某业务类型的置顶说明文案（未匹配时回退到通用文案）
 * @param {string} dataType 帖子的 data_type
 */
function getTopIntro(dataType) {
  return TOP_INTRO[dataType] || TOP_INTRO.other;
}

/**
 * 置顶支付：发布成功后调用。
 * 流程：payForPhone.create（服务端按 days 定价）→ 集成支付下单 → requestPayment → verify 履约
 *
 * @param {string} postId 帖子 id
 * @param {number} days   置顶天数（须为 TOP_OPTIONS 中的 days）
 * @returns {Promise<void>} 成功 resolve；失败 reject（含 errMsg，用户取消时含 'cancel'）
 */
async function payForTop(postId, days) {
  wx.showLoading({ title: '发起置顶支付…', mask: true });

  // 1) 建单（服务端按 days 定价，防前端篡改金额）
  const createRes = await wx.cloud.callFunction({
    name: 'payForPhone',
    data: { action: 'create', biz_type: 'top', post_id: postId, days },
    config: { timeout: 10000 },
  });
  const cr = (createRes && createRes.result) || {};
  if (!cr.success) throw new Error(cr.message || '下单失败');
  const outTradeNo = cr.out_trade_no;
  const amount = Number(cr.amount) || 0;
  if (!outTradeNo) throw new Error('下单参数异常');

  // 2) 集成支付下单
  const order = await callPayCommon('wxpay_order', {
    description: cr.title || `信息置顶 ${days} 天`,
    out_trade_no: outTradeNo,
    amount: { total: amount, currency: 'CNY' },
  });
  if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
    throw new Error(order.msg || '下单失败');
  }
  const p = pickPayment(order);
  if (!p || !p.package) throw new Error('下单失败：未获取到支付参数');

  // 3) 拉起支付（先隐藏 loading，避免遮挡系统支付面板）
  wx.hideLoading();
  await new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: String(p.timeStamp || ''),
      nonceStr: p.nonceStr || '',
      package: p.package,
      signType: p.signType || 'RSA',
      paySign: p.paySign || '',
      success: resolve,
      fail: reject,
    });
  });

  // 4) 核销（校验支付结果并写入置顶记录；幂等）
  const verifyRes = await wx.cloud.callFunction({
    name: 'payForPhone',
    data: { action: 'verify', out_trade_no: outTradeNo },
    config: { timeout: 10000 },
  });
  const vr = (verifyRes && verifyRes.result) || {};
  if (!vr.success) throw new Error(vr.message || '支付核销失败');
}

/**
 * 发布成功后的统一处理：选了置顶就支付，未选就直接走完成回调。
 * 三页复用，保证「发布成功但支付取消」的提示口径一致。
 *
 * @param {object}   opts
 * @param {number}   opts.topDays  已选置顶天数（0=不置顶）
 * @param {string}   opts.postId   刚发布的帖子 id
 * @param {string}   opts.dataType 业务类型（用于文案）
 * @param {Function} opts.onDone   支付流程结束后回调（成功或取消都调用），通常用于跳转
 * @param {Function} opts.notify   提示函数（默认 wx.showToast）
 */
function afterPublish(opts) {
  const { topDays, postId, onDone, notify } = opts || {};
  const toast = notify || ((o) => wx.showToast(o));

  if (!topDays || !postId) {
    toast({ title: '发布成功', icon: 'success' });
    if (onDone) onDone();
    return;
  }

  payForTop(postId, topDays)
    .then(() => {
      toast({ title: `发布成功，已置顶 ${topDays} 天`, icon: 'success' });
      if (onDone) onDone();
    })
    .catch((err) => {
      const msg = String((err && (err.errMsg || err.message)) || '');
      toast({
        title: msg.indexOf('cancel') >= 0
          ? '已取消置顶，可在「我的发布」中重新置顶'
          : '发布成功，置顶支付未完成',
        icon: 'none',
      });
      if (onDone) onDone();
    });
}

/**
 * 查询当前用户是否会员（会员免费发布 / 免费看电话）
 * @returns {Promise<boolean>} true=有效会员
 */
function isVipMember() {
  return wx.cloud
    .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
    .then((res) => {
      const r = res.result || {};
      return !!r.isVip;
    })
    .catch(() => false);
}

/**
 * 发布信息付费：非会员发布时调用（2 元/条）。
 * 流程：payForPhone.create(biz_type=publish) → 集成支付下单 → requestPayment → verify 履约
 * 履约后云函数会写一条「发布凭证」(baozi_publish_quota)，供 publishPost 入库时消费。
 *
 * ⚠️ 先付款后入库：本函数不依赖帖子 id（帖子尚未创建），只负责「买一次发布额度」。
 *
 * @returns {Promise<void>} 成功 resolve；失败 reject（用户取消时 errMsg 含 'cancel'）
 */
async function payForPublish() {
  wx.showLoading({ title: '发起支付…', mask: true });

  // 1) 建单（服务端按 publish 定价 2 元，无需 post_id）
  const createRes = await wx.cloud.callFunction({
    name: 'payForPhone',
    data: { action: 'create', biz_type: 'publish' },
    config: { timeout: 10000 },
  });
  const cr = (createRes && createRes.result) || {};
  if (!cr.success) throw new Error(cr.message || '下单失败');
  const outTradeNo = cr.out_trade_no;
  const amount = Number(cr.amount) || 0;
  if (!outTradeNo) throw new Error('下单参数异常');

  // 2) 集成支付下单
  const order = await callPayCommon('wxpay_order', {
    description: cr.title || '发布信息',
    out_trade_no: outTradeNo,
    amount: { total: amount, currency: 'CNY' },
  });
  if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
    throw new Error(order.msg || '下单失败');
  }
  const p = pickPayment(order);
  if (!p || !p.package) throw new Error('下单失败：未获取到支付参数');

  // 3) 拉起支付
  wx.hideLoading();
  await new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: String(p.timeStamp || ''),
      nonceStr: p.nonceStr || '',
      package: p.package,
      signType: p.signType || 'RSA',
      paySign: p.paySign || '',
      success: resolve,
      fail: reject,
    });
  });

  // 4) 核销（履约：写一条发布凭证）
  const verifyRes = await wx.cloud.callFunction({
    name: 'payForPhone',
    data: { action: 'verify', out_trade_no: outTradeNo },
    config: { timeout: 10000 },
  });
  const vr = (verifyRes && verifyRes.result) || {};
  if (!vr.success) throw new Error(vr.message || '支付核销失败');
}

/**
 * 发布 + 付费 统一入口（先付款后入库，凭证制，三页复用）。
 * 流程：
 *   ① precheck：云端返回 isVip / hasQuota
 *   ② 会员 或 已有可用凭证 → 直接 publishPost 入库
 *   ③ 非会员且无凭证 → 先 payForPublish() 付费拿凭证 → 再 publishPost 入库
 * 返回：publishPost 的 result（{ success, _id, needs_review, ... }）
 *
 * @param {object} form 发布表单（与 publishPost 的 form 字段一致）
 * @returns {Promise<object>} publishPost 的结果对象
 */
async function publishWithPay(form) {
  // ① 云端 precheck：会员 / 有无可用凭证
  const preRes = await wx.cloud.callFunction({
    name: 'publishPost',
    data: { action: 'precheck', form: form || {} },
    config: { timeout: 10000 },
  });
  const pre = (preRes && preRes.result) || {};
  const needPay = !pre.is_vip && !pre.has_quota;

  // ② 非会员且无凭证：先付费拿凭证
  if (needPay) {
    await payForPublish();
  }

  // ③ 入库（云端会再次校验会员/凭证，权威兜底）
  const pubRes = await wx.cloud.callFunction({
    name: 'publishPost',
    data: { action: 'create', form: form || {} },
    config: { timeout: 10000 },
  });
  const pr = (pubRes && pubRes.result) || {};
  if (!pr.success && pr.code === 'NEED_PAY') {
    // 极端情况：precheck 判断有凭证，但并发下被消费光了 → 提示重试
    const err = new Error(pr.error || '发布需先支付');
    err.needPay = true;
    throw err;
  }
  return pr;
}

module.exports = {
  TOP_OPTIONS,
  TOP_INTRO,
  getTopIntro,
  payForTop,
  afterPublish,
  isVipMember,
  payForPublish,
  publishWithPay,
};
