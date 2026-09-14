// pages/notice/notice.js
// 平台公告列表页：分页展示已上线公告（数据源 notifyMsg.notice_list_c）
// 与「消息」页的区别：本页只看公告（type=global），不混入审核/会员等个人通知。

const DAY = 864e5;

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date();
  const t = new Date(ts);
  const sameYear = d.getFullYear() === t.getFullYear();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const hm = `${p(t.getHours())}:${p(t.getMinutes())}`;
  if (sameYear) {
    return `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`;
  }
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${hm}`;
}

Page({
  data: {
    list: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    page: 1,
    pageSize: 20,
    firstLoaded: false,
    skeletonRows: [
      [{ width: '20%', height: '28rpx', type: 'text', marginRight: '16rpx' }, { width: '30%', height: '28rpx', type: 'text' }],
      [{ width: '90%', height: '32rpx', type: 'text' }],
      [{ width: '100%', height: '24rpx', type: 'text' }],
      [{ width: '60%', height: '24rpx', type: 'text' }],
    ],
  },

  onLoad() {
    this.loadFirst();
  },

  onPullDownRefresh() {
    this.loadFirst().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  loadFirst() {
    this.setData({ loading: true, page: 1 });
    return this.fetchList(1)
      .then(({ list, hasMore }) => {
        this.setData({
          list,
          loading: false,
          firstLoaded: true,
          hasMore,
          page: 1,
        });
      })
      .catch(() => {
        this.setData({ loading: false, firstLoaded: true, list: [] });
      });
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const next = this.data.page + 1;
    this.fetchList(next)
      .then(({ list, hasMore }) => {
        this.setData({
          list: this.data.list.concat(list),
          page: next,
          hasMore,
          loadingMore: false,
        });
      })
      .catch(() => this.setData({ loadingMore: false }));
  },

  fetchList(page) {
    return wx.cloud
      .callFunction({
        name: 'notifyMsg',
        data: { action: 'notice_list_c', page: page || 1, pageSize: this.data.pageSize || 20 },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (!r.success) throw new Error(r.message || '加载失败');
        const list = (r.list || []).map((n) => ({
          _id: n._id,
          title: n.title || '',
          content: n.content || '',
          timeText: fmtTime(n.created_at),
        }));
        return { list, hasMore: !!r.hasMore };
      });
  },
});
