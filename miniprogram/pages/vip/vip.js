// pages/vip/vip.js
// 包子行业信息平台 · 开通会员（真实微信支付）
// 数据源：
//   - 会员状态：memberService(action=status)
//   - 下单/履约：payForPhone 云函数（统一支付中心）
//     create（服务端建单，返回 out_trade_no + amount）
//     → wx.cloud.callHTTPFunction 调集成支付函数下单
//     → wx.requestPayment 拉起支付
//     → verify（服务端校验订单并开通会员，幂等）
//
// ⚠️ 金额由服务端定价（PLAN_FEES），前端传价无效，杜绝改价。
const { callPayCommon, pickPayment } = require('../../utils/pay.js')

// 正式定价：天卡 9.9 / 月卡 50 / 年卡 299（服务端 PLAN_FEES 同步为 990/5000/29900 分）
const PLANS = [
  { id: 'day',   name: '天卡',   price: 9.9,  days: 1,   tip: '先试用一天' },
  { id: 'month', name: '月卡',   price: 50,   days: 30,  tip: '性价比之选', tag: '推荐' },
  { id: 'year',  name: '年卡',   price: 299,  days: 365, tip: '一年畅享', tag: '超值' },
];

Page({
  data: {
    plans: PLANS,
    activePlan: 'month',
    isVip: false,
    expireText: '',
    paying: false,
  },

  onLoad() {
    this.loadStatus();
  },

  onShow() {
    this.loadStatus();
  },

  // 查会员状态；传 done 回调时，结束后会调用（供支付后等待刷新完成）
  loadStatus(done) {
    return wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        this.setData({ isVip: !!r.isVip, expireText: r.expireText || '' });
        if (typeof done === 'function') done();
      })
      .catch(() => {
        if (typeof done === 'function') done();
      });
  },

  selectPlan(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ activePlan: id });
  },

  // 真实微信支付 → 开通/续费会员
  // 链路：服务端建单(create) → 集成支付函数下单(wxpay_order) → 拉起支付
  //      → 服务端校验并履约(verify) → 刷新会员状态
  async onPay() {
    if (this.data.paying) return;
    const plan = this.data.activePlan;
    const p = PLANS.find((x) => x.id === plan) || PLANS[0];
    this.setData({ paying: true });

    try {
      // 1) 服务端建单：拿 out_trade_no + 权威金额（防伪造/防改价）
      wx.showLoading({ title: '下单中…', mask: true });
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: 'member', plan },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 0; // 单位：分
      if (!outTradeNo || !amount) throw new Error('下单参数异常');

      // 2) 调集成支付函数下单，拿支付参数
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || `开通会员(${p.name})`,
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
      });
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const payParams = pickPayment(order);
      if (!payParams || !payParams.package) {
        console.error('[vip] 未取到 package，完整返回：', order);
        throw new Error('下单失败：未获取到支付参数');
      }

      // 3) 拉起微信支付
      wx.hideLoading();
      await new Promise((resolve, reject) => {
        wx.requestPayment({
          timeStamp: String(payParams.timeStamp || ''),
          nonceStr: payParams.nonceStr || '',
          package: payParams.package,
          signType: payParams.signType || 'RSA',
          paySign: payParams.paySign || '',
          success: resolve,
          fail: reject,
        });
      });

      // 4) 服务端校验订单并履约（幂等：重复 verify 不重复开通）
      wx.showLoading({ title: '开通中…', mask: true });
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      wx.hideLoading();
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || '开通失败');

      // 5) 刷新会员状态
      await new Promise((resolve) => {
        this.loadStatus(resolve);
      });
      this.setData({ paying: false });
      wx.showToast({ title: `已开通${p.name}`, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (err) {
      wx.hideLoading();
      this.setData({ paying: false });
      console.error('[vip] 支付/开通失败:', err && (err.errMsg || err.message));
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },

  // 已开通时的续费：同样走真实支付（在原到期时间上顺延）
  onRenew() {
    this.onPay();
  },
});
