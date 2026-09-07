// pages/payrecords/payrecords.js
// 包子行业信息平台 · 我的付款记录
// 数据源：payForPhone(action=list) —— 按 openid 返回本人全部付费记录（含帖子标题/类型/地区）
// 操作：点「查看信息」跳对应帖子详情（已付费，详情页会自动展示完整电话，不重复收费）

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    list: [],
    loading: true,
    // 加载骨架屏：与内容卡片等高，避免加载完成时页面跳动
    skeletonRows: [
      [{ width: '100%', height: '140rpx', type: 'rect' }],
      [{ width: '100%', height: '140rpx', type: 'rect' }],
      [{ width: '100%', height: '140rpx', type: 'rect' }],
    ],
  },

  onLoad() {
    this.loadList();
  },

  // 从详情页返回时刷新（付费后返回可看到新记录）
  onShow() {
    if (this._loaded) this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  loadList() {
    this.setData({ loading: true });
    return wx.cloud
      .callFunction({ name: 'payForPhone', data: { action: 'list' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const list = (r.success && Array.isArray(r.list) ? r.list : []).map((it) => this.decorate(it));
        this._loaded = true;
        this.setData({ list, loading: false });
      })
      .catch((err) => {
        console.error('[payrecords] 读取付款记录失败:', err && err.errMsg);
        this._loaded = true;
        this.setData({ list: [], loading: false });
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  decorate(it) {
    return {
      post_id: it.post_id,
      title: it.title || '信息',
      typeName: it.typeName || '信息',
      region: it.region || '',
      // total_fee 单位「分」，展示转元
      feeText: '¥' + ((Number(it.total_fee) || 0) / 100).toFixed(2),
      timeText: fmtTime(it.created_at),
    };
  },

  // 点卡片：进该条信息详情（已付费，详情页会直接展示完整电话）
  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 点「查看信息」按钮：同上，跳对应帖子详情
  onView(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 空态去逛逛：回首页
  goHome() {
    wx.reLaunch({ url: '/pages/demo/demo' });
  },
});
