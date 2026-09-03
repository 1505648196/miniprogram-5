// pages/nearby/nearby.js
// 包子行业信息平台 · 附近页（定位授权 → 按定位城市 code 查全板块同城帖子）
// 数据源：feedPosts 云函数（7 类各拉一页 + city_code 过滤）
// 定位用 wx.getLocation → 就近匹配热门城市(CITY_GEO)；非热门城市提示切回。

// 帖子类型视觉（与 demo 首页一致）
const TYPE_META = {
  transfer:   { name: '店铺转让', emoji: '🥟', color: '#FF7A45', light: '#FFF1E8' },
  want_shop:  { name: '求店',     emoji: '🔎', color: '#36CFC9', light: '#E6FFFB' },
  recruit:    { name: '招工',     emoji: '👨', color: '#597EF7', light: '#F0F5FF' },
  jobseek:    { name: '求职',     emoji: '🙋', color: '#9254DE', light: '#F9F0FF' },
  equip_sell: { name: '设备出售', emoji: '🛒', color: '#FA8C16', light: '#FFF7E6' },
  equip_buy:  { name: '设备求购', emoji: '🧰', color: '#73D13D', light: '#F6FFED' },
  carpool_car:    { name: '车找人', emoji: '🚗', color: '#597EF7', light: '#F0F5FF' },
  carpool_person: { name: '人找车', emoji: '🧳', color: '#73D13D', light: '#F6FFED' },
  other:      { name: '其他',     emoji: '📦', color: '#8C8C8C', light: '#F5F5F5' },
};

const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};

// 热门城市中心坐标（gcj02）+ city_code，用于定位后就近匹配
const CITY_GEO = [
  { name: '北京', code: '110100', lat: 39.9042, lng: 116.4074 },
  { name: '上海', code: '310100', lat: 31.2304, lng: 121.4737 },
  { name: '广州', code: '440100', lat: 23.1291, lng: 113.2644 },
  { name: '深圳', code: '440300', lat: 22.5431, lng: 114.0579 },
  { name: '东莞', code: '441900', lat: 23.0207, lng: 113.7518 },
  { name: '佛山', code: '440600', lat: 23.0215, lng: 113.1214 },
  { name: '珠海', code: '440400', lat: 22.2710, lng: 113.5530 },
  { name: '中山', code: '442000', lat: 22.5176, lng: 113.3926 },
  { name: '惠州', code: '441300', lat: 23.1115, lng: 114.4162 },
  { name: '杭州', code: '330100', lat: 30.2741, lng: 120.1551 },
  { name: '宁波', code: '330200', lat: 29.8683, lng: 121.5440 },
  { name: '苏州', code: '320500', lat: 31.2990, lng: 120.5853 },
  { name: '无锡', code: '320200', lat: 31.4912, lng: 120.3119 },
  { name: '南京', code: '320100', lat: 32.0603, lng: 118.7969 },
  { name: '成都', code: '510100', lat: 30.5728, lng: 104.0668 },
  { name: '武汉', code: '420100', lat: 30.5928, lng: 114.3055 },
  { name: '长沙', code: '430100', lat: 28.2282, lng: 112.9388 },
  { name: '郑州', code: '410100', lat: 34.7466, lng: 113.6254 },
];

function cityDistance(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestCity(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  CITY_GEO.forEach((c) => {
    const d = cityDistance(lat, lng, c.lat, c.lng);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  });
  return best && bestDist <= 260 ? { name: best.name, code: best.code, dist: bestDist } : null;
}

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

// 全板块类型（附近=同城全看）
const ALL_TYPES = ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy', 'carpool_car', 'carpool_person', 'other'];

Page({
  data: {
    cityName: '定位中…',   // 当前定位城市展示文本
    located: false,        // 是否已定位成功
    locating: true,        // 是否定位中
    failText: '',          // 定位失败提示
    locSticky: false,      // 定位条是否吸顶（吸顶加阴影，避免下方内容透出）
    goodsLeft: [],
    goodsRight: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: false,        // 列表加载中(骨架)
    firstLoaded: false,
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
    // 关掉入口页"正在进入"的 loading（若有）
    wx.hideLoading();
    this._all = [];
    this._nearbyCode = '';
    this._detailPool = {};
    try {
      const cached = wx.getStorageSync('detail_pool');
      if (cached && typeof cached === 'object') this._detailPool = cached;
    } catch (e) {
      // ignore
    }
    this.locate();
  },

  onPullDownRefresh() {
    if (!this.data.located) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadFeed().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },

  // 定位授权 → 就近城市 → 同城查询
  locate() {
    this.setData({ locating: true, located: false, failText: '' });
    wx.getLocation({
      type: 'gcj02',
      success: (loc) => {
        const hit = nearestCity(loc.latitude, loc.longitude);
        if (!hit) {
          this.setData({ locating: false, cityName: '', located: false, failText: '暂不支持你所在城市，可在设置开启定位后重试' });
          return;
        }
        this._nearbyCode = hit.code;
        this.setData({ cityName: hit.name, located: true, locating: false });
        this.loadFeed();
      },
      fail: () => {
        this.setData({ locating: false, located: false, failText: '需要授权定位才能看附近，请在右上角…设置中开启' });
      },
    });
  },

  fetchFeed(dataType, page) {
    const data = { dataType, page: page || 1, pageSize: this.data.pageSize || 20 };
    if (this._nearbyCode) data.city_code = this._nearbyCode;
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data,
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        return null;
      })
      .catch((err) => {
        console.error('[nearby] feedPosts 调用失败:', dataType, err && err.errMsg);
        return null;
      });
  },

  // 全板块各拉一页(带 city_code) → 按时间合并
  async fetchAllTypes(page) {
    const results = await Promise.all(ALL_TYPES.map((t) => this.fetchFeed(t, page)));
    const list = results.filter(Boolean).reduce((a, b) => a.concat(b.list || []), []);
    const hasMore = results.some((r) => r && r.hasMore);
    return { list, hasMore };
  },

  async loadFeed() {
    this.setData({ loading: true, loadingMore: false });
    const res = await this.fetchAllTypes(1);
    const real = res.list || [];
    this.cacheDetails(real);
    this._all = real.map((p) => this.decorate(p)).sort((a, b) => b.ts - a.ts);
    this.setData({ loading: false, firstLoaded: true, page: 1, hasMore: !!res.hasMore });
    this.renderList();
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const res = await this.fetchAllTypes(nextPage);
    const real = res.list || [];
    this.cacheDetails(real);
    this._all = this._all
      .concat(real.map((p) => this.decorate(p)))
      .sort((a, b) => b.ts - a.ts);
    this.setData({ page: nextPage, hasMore: !!res.hasMore, loadingMore: false });
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
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    const loc = [p.province, p.city, p.district].filter(Boolean).join(' ');
    const raw = String(p.raw_text || '').trim();
    let title = raw ? (raw.length > 24 ? raw.slice(0, 24) + '…' : raw) : `${loc || '全国'}·${meta.name}`;
    let priceText = Number(p.price) > 0 ? `${fmtMoney(p.price)} 元` : (Number(p.salary) > 0 ? `${Number(p.salary)} 元/月` : '');
    const tags = Array.isArray(p.tags) && p.tags.length ? p.tags.slice(0, 3) : [];
    if (!tags.length && meta.name) tags.push(meta.name);
    return {
      id: p._id,
      typeName: meta.name,
      color: meta.color,
      light: meta.light,
      image: p.image || '',
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      title,
      priceText,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      tags,
      ts: p.published_at || 0,
    };
  },

  renderList() {
    const left = [];
    const right = [];
    this._all.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    this.setData({ goodsLeft: left, goodsRight: right });
  },

  // 定位失败时点按钮重新授权
  onRetry() {
    wx.openSetting();
  },

  // t-sticky 吸顶状态：detail = { scrollTop, isFixed }，吸顶加阴影
  onLocSticky(e) {
    const isFixed = !!(e && e.detail && e.detail.isFixed);
    if (isFixed !== this.data.locSticky) this.setData({ locSticky: isFixed });
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
