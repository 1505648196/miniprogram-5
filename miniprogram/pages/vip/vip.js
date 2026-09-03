// pages/vip/vip.js
// 包子行业信息平台 · 开通会员（当前为模拟支付，将来接真实微信支付时替换支付步骤）
// 数据源：memberService 云函数
//   - status：查当前会员状态
//   - activate：模拟支付成功 → 升级会员 + 推 member 站内通知
const PLANS = [
  { id: 'month',  name: '月卡',   price: 9.9,   days: 30,  tip: '适合尝鲜体验' },
  { id: 'quarter',name: '季卡',   price: 25.9,  days: 90,  tip: '性价比之选', tag: '推荐' },
  { id: 'year',   name: '年卡',   price: 88.0,  days: 365, tip: '一年畅享', tag: '超值' },
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

  loadStatus() {
    wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        this.setData({ isVip: !!r.isVip, expireText: r.expireText || '' });
      })
      .catch(() => {});
  },

  selectPlan(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ activePlan: id });
  },

  // 模拟支付 → 开通
  onPay() {
    if (this.data.paying) return;
    const plan = this.data.activePlan;
    const p = PLANS.find((x) => x.id === plan) || PLANS[0];
    this.setData({ paying: true });
    wx.showLoading({ title: '开通中…', mask: true });
    // 模拟支付：直接调 activate（将来接真实支付：先 wx.requestPayment，成功后调 activate）
    wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'activate', plan }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        this.setData({ paying: false });
        if (r.success) {
          wx.showToast({ title: `已开通${p.name}`, icon: 'success' });
          this.setData({ isVip: true, expireText: r.expireText || '' });
        } else {
          wx.showToast({ title: r.message || '开通失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ paying: false });
        console.error('[vip] 开通失败:', err && err.errMsg);
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
      });
  },

  // 已开通时的续费：同样走模拟开通(顺延)
  onRenew() {
    this.onPay();
  },
});
