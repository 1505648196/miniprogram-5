// pages/carpool/carpool.js
// 包子行业信息平台 · 顺风车频道页（TDesign）极简版
// 数据源：feedPosts 云函数（dataType = 'carpool_car' | 'carpool_person'）
//
// 【字段（极简，无价格）】
//   车找人 carpool_car / 人找车 carpool_person 共用字段：
//     from_place(出发地) / to_place(目的地) / depart_time(出发时间) / depart_deadline(最晚出发)
//     / seats(可乘人数) / raw_text(具体描述) / phone+phone_masked(电话)
//   无价格、无品类、无成色 —— 频道页只按 类别(车找人/人找车) + 路线/城市关键词 浏览。

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

Page({
  data: {
    keyword: '',
    // ---------- 信息类别（车找人/人找车 双选卡片） ----------
    typeCards: [
      { value: 'carpool_car',    label: '车找人', desc: '车主有空座' },
      { value: 'carpool_person', label: '人找车', desc: '找顺路车' },
    ],
    selectedTypes: ['carpool_car', 'carpool_person'],
    emptyText: '暂无顺风车信息',

    goodsLeft: [],
    goodsRight: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: true,
    firstLoaded: false,

    // 双列瀑布流骨架
    skeletonRows: [
      [{ width: '48%', height: '180rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '200rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
      [{ width: '48%', height: '200rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
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

  fetchFeed(extra) {
    const sel = Array.isArray(this.data.selectedTypes) ? this.data.selectedTypes : [];
    const hasCar = sel.indexOf('carpool_car') >= 0;
    const hasPerson = sel.indexOf('carpool_person') >= 0;
    const data = {
      page: (extra && extra.page) || 1,
      pageSize: (extra && extra.pageSize) || this.data.pageSize || 20,
    };
    if (hasCar && hasPerson) {
      data.dataTypes = ['carpool_car', 'carpool_person'];
    } else if (hasCar) {
      data.dataType = 'carpool_car';
    } else if (hasPerson) {
      data.dataType = 'carpool_person';
    } else {
      data.dataTypes = ['carpool_car', 'carpool_person'];
    }
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data,
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[carpool] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[carpool] feedPosts 调用失败:', err && err.errMsg);
        return null;
      });
  },

  async loadFeed(extra) {
    this.setData({ loading: true, loadingMore: false });
    const r = await this.fetchFeed(extra);
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
    const extra = {};
    extra.page = nextPage;
    const r = await this.fetchFeed(extra);
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
    const isCar = p.data_type === 'carpool_car';
    const from = String(p.from_place || '').trim();
    const to = String(p.to_place || '').trim();
    const raw = String(p.raw_text || '').trim();
    const rawShow = privacy.maskText(raw);
    const typeName = isCar ? '车找人' : '人找车';
    const color = isCar ? '#597EF7' : '#73D13D';   // 车找人蓝 / 人找车绿
    const light = isCar ? '#F0F5FF' : '#F6FFED';
    const emoji = isCar ? '🚗' : '🧳';

    // 标题：首行描述；无则"出发地→目的地"
    const title = rawShow
      ? (rawShow.length > 30 ? rawShow.slice(0, 30) + '…' : rawShow)
      : `${from || '?'} → ${to || '?'}`;

    // 路线
    const routeText = from && to ? `${from} → ${to}` : (from || to || '');

    // 时间/人数行文案
    const timeText = p.depart_time ? `出发 ${p.depart_time}` : '';
    const deadlineText = p.depart_deadline ? `最晚 ${p.depart_deadline}` : '';
    const seatsText = p.seats != null && Number(p.seats) > 0 ? (isCar ? `剩 ${p.seats} 座` : `${p.seats} 人`) : '';

    return {
      id: p._id,
      data_type: p.data_type || '',
      title,
      routeText,
      timeText,
      deadlineText,
      seatsText,
      meta: `${fmtAgo(p.published_at)}`,
      ts: p.published_at || 0,
      from,
      to,
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      haystack: `${from} ${to} ${raw}`,
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
      list = list.filter((i) => i.haystack.indexOf(kw) >= 0 || i.title.indexOf(kw) >= 0);
    }
    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    const sel = this.data.selectedTypes;
    const onlyCar = Array.isArray(sel) && sel.length === 1 && sel[0] === 'carpool_car';
    const onlyPerson = Array.isArray(sel) && sel.length === 1 && sel[0] === 'carpool_person';
    const emptyText = onlyCar ? '暂无车找人信息' : onlyPerson ? '暂无找车信息' : '暂无顺风车信息';
    this.setData({ goodsLeft: left, goodsRight: right, emptyText });
  },

  onTypeChange(e) {
    let sel = (e.detail && e.detail.value) || [];
    if (!Array.isArray(sel)) sel = [];
    const types = sel.filter((v) => v === 'carpool_car' || v === 'carpool_person');
    const prev = this.data.selectedTypes || [];
    const same = types.length === prev.length && types.every((v) => prev.indexOf(v) >= 0);
    this.setData({ selectedTypes: types });
    if (!same) this.loadFeed();
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.renderList();
  },

  onPublish() {
    wx.showToast({ title: '发布顺风车表单待接入', icon: 'none' });
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
