// pages/group/group.js
// 包友群：群列表 + 点卡片弹二维码加群
Page({
  data: {
    list: [],
    loading: true,
    qrVisible: false,
    currentGroup: null,
    skeletonRows: [
      [{ width: '20%', height: '140rpx', type: 'rect' }, { width: '75%', height: '140rpx', type: 'rect' }],
      [{ width: '20%', height: '140rpx', type: 'rect' }, { width: '75%', height: '140rpx', type: 'rect' }],
      [{ width: '20%', height: '140rpx', type: 'rect' }, { width: '75%', height: '140rpx', type: 'rect' }],
    ],
  },

  onLoad() {
    this.loadGroups();
  },

  loadGroups() {
    this.setData({ loading: true });
    wx.cloud.callFunction({
      name: 'groupService',
      data: { action: 'listGroups', page: 1, pageSize: 50 },
      config: { timeout: 10000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      if (r.success) this.setData({ list: r.list || [] });
      else this.setData({ list: [] });
    }).catch(() => {
      this.setData({ list: [] });
    }).finally(() => {
      this.setData({ loading: false });
    });
  },

  // 点击群卡片 → 拉详情（含二维码）→ 弹窗
  onGroupTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showLoading({ title: '加载中…', mask: true });
    wx.cloud.callFunction({
      name: 'groupService',
      data: { action: 'groupDetail', _id: id },
      config: { timeout: 10000 },
    }).then((res) => {
      wx.hideLoading();
      const r = (res && res.result) || {};
      if (r.success && r.item) {
        this.setData({ currentGroup: r.item, qrVisible: true });
      } else {
        wx.showToast({ title: r.message || '加载失败', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    });
  },

  onQrVisibleChange(e) {
    if (!e.detail.visible) this.setData({ qrVisible: false, currentGroup: null });
  },

  onCloseQr() {
    this.setData({ qrVisible: false, currentGroup: null });
  },
});
