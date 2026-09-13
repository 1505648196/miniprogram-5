// pages/merchant-detail/merchant-detail.js
// 商家详情：对应云函数 merchantApply(action=detail)
Page({
  data: {
    loading: true,
    merchant: null,
    loadError: '',
    skeletonRows: [
      [{ width: '20%', height: '160rpx', type: 'rect' }],
      [{ width: '60%', height: '40rpx', type: 'text' }],
      [{ width: '100%', height: '320rpx', type: 'rect' }],
      [{ width: '100%', height: '120rpx', type: 'text' }],
      [{ width: '100%', height: '80rpx', type: 'text' }],
    ],
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ loading: false, loadError: '缺少商家标识' });
      return;
    }
    this._id = id;
    this.fetchDetail(id);
  },

  fetchDetail(id) {
    this.setData({ loading: true, loadError: '' });
    wx.cloud.callFunction({
      name: 'merchantApply',
      data: { action: 'detail', _id: id },
      config: { timeout: 10000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      if (r.success && r.item) {
        this.setData({ merchant: r.item, loading: false });
      } else {
        this.setData({ loading: false, loadError: r.message || '商家不存在或审核中' });
      }
    }).catch((err) => {
      console.error('[merchant-detail] 加载失败:', err && err.errMsg);
      this.setData({ loading: false, loadError: '加载失败，请重试' });
    });
  },

  // 拨打电话
  onCall() {
    const m = this.data.merchant;
    if (!m || !m.phone) {
      wx.showToast({ title: '该商家未登记电话', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: m.phone }).catch(() => {});
  },

  // 查看微信（有二维码才显示按钮）
  onShowWechat() {
    const m = this.data.merchant;
    if (!m || !m.wechat_qr) return;
    wx.previewImage({ urls: [m.wechat_qr] });
  },
});
