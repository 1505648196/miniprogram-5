// pages/news-detail/news-detail.js
// 包子行业信息平台 · 快讯详情页
Page({
  data: {
    loading: true,
    loadError: '',
    n: null,
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ loading: false, loadError: '缺少快讯标识' });
      return;
    }
    this.fetchDetail(id);
  },

  fetchDetail(id) {
    this.setData({ loading: true, loadError: '' });
    wx.cloud
      .callFunction({
        name: 'genNews',
        data: { action: 'get', _id: id },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = (res && res.result) || {};
        if (r.success && r.item) {
          const n = r.item;
          const base = {
            title: n.title,
            content: n.content,
            category: n.category,
            tags: n.tags || [],
            image: n.image || '',
            source_url: n.source_url || '',
            source_name: n.source_name || '',
            timeText: this.fmtDateTime(n.published_at),
          };
          // cloud:// 封面图换临时 URL
          if (base.image && base.image.startsWith('cloud://')) {
            wx.cloud
              .getTempFileURL({ fileList: [base.image] })
              .then((tr) => {
                const item = (tr.fileList && tr.fileList[0]) || {};
                if (item.tempFileURL) base.image = item.tempFileURL;
                this.setData({ loading: false, n: base });
              })
              .catch(() => this.setData({ loading: false, n: base }));
          } else {
            this.setData({ loading: false, n: base });
          }
        } else {
          this.setData({ loading: false, loadError: r.message || '快讯不存在' });
        }
      })
      .catch((err) => {
        console.error('[news-detail] 加载失败:', err && err.errMsg);
        this.setData({ loading: false, loadError: '加载失败，请稍后重试' });
      });
  },

  fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => (x < 10 ? '0' + x : '' + x);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // 复制原文链接（小程序内无 webview，改为复制链接）
  onOpenSource(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'success' }),
    });
  },
});
