// pages/news/news.js
// 包子行业信息平台 · 快讯列表页（AI 生成的行业快讯）
// 数据源：genNews 云函数（action=list）
Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    loadingMore: false,
  },

  onLoad() {
    this.fetchList(1);
  },

  fetchList(page) {
    if (page === 1) this.setData({ loading: true });
    else this.setData({ loadingMore: true });

    wx.cloud
      .callFunction({
        name: 'genNews',
        data: { action: 'list', page, pageSize: this.data.pageSize },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = (res && res.result) || {};
        const rawList = r.list || [];
        // 先映射基础字段，cloud:// 图片稍后批量换临时 URL
        const list = rawList.map((n) => ({
          _id: n._id,
          title: n.title,
          summary: n.summary,
          category: n.category,
          tags: n.tags || [],
          image: n.image || '',
          source_name: n.source_name || '',
          timeText: this.fmtAgo(n.published_at),
        }));
        // 批量把 cloud:// fileID 换成临时 https URL（后台手动传的封面图）
        return this.resolveImages(list).then((resolvedList) => {
          if (page === 1) {
            this.setData({
              loading: false,
              list: resolvedList,
              page: 1,
              total: r.total || 0,
              hasMore: (r.total || 0) > this.data.pageSize,
            });
          } else {
            this.setData({
              loadingMore: false,
              list: this.data.list.concat(resolvedList),
              page,
              total: r.total || 0,
              hasMore: (r.total || 0) > page * this.data.pageSize,
            });
          }
        });
      })
      .catch((err) => {
        console.error('[news] 加载失败:', err && err.errMsg);
        if (page === 1) {
          this.setData({ loading: false, list: [] });
        } else {
          this.setData({ loadingMore: false });
        }
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  fmtAgo(ts) {
    if (!ts) return '';
    const d = new Date();
    const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.floor((todayStart - ts) / 86400000);
    if (ts >= todayStart) return '今天';
    if (days <= 1) return '昨天';
    if (days < 30) return `${days}天前`;
    if (days < 365) return `${Math.floor(days / 30)}个月前`;
    return `${Math.floor(days / 365)}年前`;
  },

  // 批量把列表里 cloud:// fileID 图片换成临时 https URL
  resolveImages(list) {
    const fileIDs = list.filter((n) => n.image && n.image.startsWith('cloud://')).map((n) => n.image);
    if (!fileIDs.length) return Promise.resolve(list);
    return wx.cloud
      .getTempFileURL({ fileList: fileIDs })
      .then((res) => {
        const urlMap = {};
        (res.fileList || []).forEach((item) => {
          if (item.fileID && item.tempFileURL) urlMap[item.fileID] = item.tempFileURL;
        });
        return list.map((n) => {
          if (n.image && urlMap[n.image]) return Object.assign({}, n, { image: urlMap[n.image] });
          return n;
        });
      })
      .catch(() => list); // 换链失败保持原样（cloud:// 会显示不出，但不阻断）
  },

  // 下拉加载更多（滚动到底部触发）
  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.fetchList(this.data.page + 1);
  },

  // 点击进详情
  onNewsTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/news-detail/news-detail?id=${id}` });
  },
});
