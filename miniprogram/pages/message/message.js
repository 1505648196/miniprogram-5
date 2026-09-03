// pages/message/message.js
// 包子行业信息平台 · 站内通知（平台消息）
// 数据源：notifyMsg 云函数
//   - list：分页拉当前用户可见通知(global + 发给我的 review/member)，含未读数
//   - read：进页默认标全部已读；点击单条也标已读
// 类型图标/文案：
//   global=全局通知 / review=审核通知 / member=会员开通

const DAY = 864e5;

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now.getTime() - DAY);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const year = d.getFullYear() === now.getFullYear();
  return `${year ? '' : d.getFullYear() + '-'}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

Page({
  data: {
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loading: true,
    firstLoaded: false,
    loadingMore: false,
    unread: 0,
    skeletonRows: [
      [{ width: '92%', height: '120rpx', type: 'rect' }],
      [{ width: '92%', height: '120rpx', type: 'rect' }],
      [{ width: '92%', height: '120rpx', type: 'rect' }],
      [{ width: '92%', height: '120rpx', type: 'rect' }],
    ],
  },

  onLoad() {
    this.loadFirst();
  },

  onShow() {
    // 返回本页刷新未读
    if (this.data.firstLoaded) this.refreshUnread();
  },

  onPullDownRefresh() {
    this.loadFirst().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },

  // 首屏：拉第 1 页 + 进页标全部已读
  async loadFirst() {
    this.setData({ loading: true, loadingMore: false });
    const r = await this.fetchList(1);
    const list = r.list.map((m) => this.decorate(m));
    this.setData({
      list,
      page: 1,
      hasMore: r.hasMore,
      unread: r.unread,
      loading: false,
      firstLoaded: true,
    });
    // 进页即把当前可见通知全部标已读
    if (r.unread > 0) this.markAllRead();
  },

  // 触底加载更多
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const r = await this.fetchList(nextPage);
    const more = r.list.map((m) => this.decorate(m));
    const seen = {};
    this.data.list.forEach((i) => { seen[i.id] = 1; });
    const add = more.filter((i) => !seen[i.id]);
    this.setData({
      list: this.data.list.concat(add),
      page: nextPage,
      hasMore: r.hasMore,
      loadingMore: false,
    });
  },

  fetchList(page) {
    return wx.cloud
      .callFunction({ name: 'notifyMsg', data: { action: 'list', page: page || 1, pageSize: this.data.pageSize || 20 }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore, unread: Number(r.unread) || 0 };
        return { list: [], hasMore: false, unread: 0 };
      })
      .catch((err) => {
        console.error('[message] 拉取失败:', err && err.errMsg);
        return { list: [], hasMore: false, unread: 0 };
      });
  },

  decorate(m) {
    const typeMap = {
      global: { icon: 'notification', color: '#597EF7', bg: '#F0F5FF', label: '平台通知' },
      review: { icon: 'check-circle', color: '#36CFC9', bg: '#E6FFFB', label: '审核通知' },
      member: { icon: 'user-vip', color: '#FFD666', bg: '#FFF7E6', label: '会员通知' },
    };
    const t = typeMap[m.type] || typeMap.global;
    return {
      id: m._id,
      type: m.type || 'global',
      typeName: t.label,
      icon: t.icon,
      color: t.color,
      bg: t.bg,
      title: m.title || t.label,
      content: m.content || '',
      timeText: fmtTime(m.created_at),
      isRead: !!m.isRead,
      hasPost: !!m.post_id,
    };
  },

  // 点击单条：标已读（并可跳到关联帖子）
  onTap(e) {
    const { id, post } = e.currentTarget.dataset;
    if (id) this.markRead(id);
    if (post) {
      wx.navigateTo({ url: `/pages/detail/detail?id=${post}` });
    }
  },

  markRead(id) {
    wx.cloud.callFunction({ name: 'notifyMsg', data: { action: 'read', _id: id }, config: { timeout: 10000 } }).catch(() => {});
    this.markLocalRead(id);
  },

  markAllRead() {
    wx.cloud.callFunction({ name: 'notifyMsg', data: { action: 'read', all: 1 }, config: { timeout: 10000 } }).catch(() => {});
    this.markAllLocalRead();
  },

  markLocalRead(id) {
    const list = this.data.list.map((m) => (m.id === id ? Object.assign({}, m, { isRead: true }) : m));
    this.setData({ list, unread: Math.max(0, this.data.unread - 1) });
  },
  markAllLocalRead() {
    const list = this.data.list.map((m) => Object.assign({}, m, { isRead: true }));
    this.setData({ list, unread: 0 });
  },

  refreshUnread() {
    this.fetchList(1).then((r) => this.setData({ unread: Number(r.unread) || 0 }));
  },
});
