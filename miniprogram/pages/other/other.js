// pages/other/other.js
// 包子行业信息平台 · 其他频道页（兜底杂项，通用信息流）
// 数据源：feedPosts 云函数（dataType = 'other'）
// 无专项筛选维度，仅 Header 关键词搜索；卡片通用展示(标题/价格/地区/发布人/图)。

const privacy = require('../../utils/privacy.js');

const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};

const DAY = 864e5;

function fmtAgo(ts) {
  if (!ts) return '';
  const d = new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (ts >= todayStart) return '今天';
  const days = Math.floor((todayStart - ts) / DAY);
  if (days <= 1) return '昨天';
  if (days < 30) return `${days}天前`;
  if (days < 365) return `${Math.floor(days / 30)}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

// 金额：≥1万显示 x万
function fmtMoney(n) {
  const num = Number(n) || 0;
  if (num <= 0) return '';
  if (num >= 10000) {
    const w = num / 10000;
    const rounded = Math.round(w * 10) / 10;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '万';
  }
  return String(num);
}

Page({
  data: {
    keyword: '',
    goodsLeft: [],
    goodsRight: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: true,
    firstLoaded: false,
    emptyText: '暂无其他信息',
    skeletonRows: [
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
      [{ width: '48%', height: '200rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '220rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
    ],
  },

  onLoad() {
    this._all = [];
    this._detailPool = {};
    try {
      const cached = wx.getStorageSync('detail_pool');
      if (cached && typeof cached === 'object') this._detailPool = cached;
    } catch (e) {
      // ignore
    }
    this.loadFeed();
  },

  onPullDownRefresh() {
    this.loadFeed().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },

  fetchFeed(page) {
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data: { dataType: 'other', page: page || 1, pageSize: this.data.pageSize || 20 },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[other] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[other] feedPosts 调用失败:', err && err.errMsg);
        return null;
      });
  },

  async loadFeed() {
    this.setData({ loading: true, loadingMore: false });
    const r = await this.fetchFeed(1);
    const list = (r && r.list) || [];
    const raw = list;
    this._all = raw.map((p) => this.decorate(p)).sort((a, b) => b.ts - a.ts);
    this.cacheDetails(raw);
    this.setData({ loading: false, firstLoaded: true, page: 1, hasMore: !!(r && r.hasMore) });
    this.renderList();
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const r = await this.fetchFeed(nextPage);
    const list = (r && r.list) || [];
    const raw = list;
    this._all = this._all.concat(raw.map((p) => this.decorate(p)));
    this.cacheDetails(raw);
    this.setData({ page: nextPage, hasMore: !!(r && r.hasMore), loadingMore: false });
    this.renderList();
  },

  cacheDetails(rawItems) {
    if (!Array.isArray(rawItems)) return;
    const map = this._detailPool || {};
    rawItems.forEach((p) => {
      if (p && p._id) map[p._id] = p;
    });
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.slice(0, keys.length - 200).forEach((k) => delete map[k]);
    }
    this._detailPool = map;
    try {
      wx.setStorage({ key: 'detail_pool', data: map });
    } catch (e) {
      // ignore
    }
  },

  decorate(p) {
    const loc = [p.province, p.city, p.district].filter(Boolean).join('');
    const raw = String(p.raw_text || '').trim();
    const rawShow = privacy.maskText(raw);
    const typeName = '其他';
    const color = '#8C8C8C';
    const light = '#F5F5F5';
    const emoji = '📦';

    const title = rawShow
      ? (rawShow.length > 30 ? rawShow.slice(0, 30) + '…' : rawShow)
      : `${loc || '全国'}信息`;

    // 有明示价格显示；无则只给"查看"
    const priceText = Number(p.price) > 0 ? `${fmtMoney(p.price)} 元` : '';

    const tags = [];
    if (priceText) tags.push('有报价');
    if (!tags.length) tags.push(typeName);

    return {
      id: p._id,
      data_type: p.data_type || '',
      title,
      priceText,
      tags,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      ts: p.published_at || 0,
      price: Number(p.price) || 0,
      city: p.city || '',
      city_code: p.city_code || '',
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      haystack: raw,
      emoji,
      image: p.image || '',
      color,
      light,
      typeName,
    };
  },

  renderList() {
    let list = this._all;
    const kw = String(this.data.keyword || '').trim();
    if (kw) {
      list = list.filter((i) => i.title.indexOf(kw) >= 0 || i.haystack.indexOf(kw) >= 0);
    }
    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    this.setData({ goodsLeft: left, goodsRight: right, emptyText: kw ? '未找到相关内容' : '暂无其他信息' });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.renderList();
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
