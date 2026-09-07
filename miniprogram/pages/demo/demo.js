// pages/demo/demo.js
// 包子行业信息平台 · 首页(tdesign-miniprogram)
// 数据源：feedPosts 云函数（七大类型各拉 20 条，失败自动回退本地 mock）

// 七大类型（六大板块 + 其他兜底）
const PUBLISH_TYPES = [
  { id: 'recruit',    name: '招工',     emoji: '👨', image: '', bg: '#F0F5FF', color: '#597EF7', light: '#F0F5FF' },
  { id: 'transfer',   name: '转让',     emoji: '🥟', image: '', bg: '#FFF1E8', color: '#FF7A45', light: '#FFF1E8' },
  { id: 'equip_sell', name: '设备出售', emoji: '🛒', image: '', bg: '#FFF7E6', color: '#FA8C16', light: '#FFF7E6' },
  { id: 'want_shop',  name: '求店',     emoji: '🔎', image: '', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'jobseek',    name: '求职',     emoji: '🙋', image: '', bg: '#F9F0FF', color: '#9254DE', light: '#F9F0FF' },
  { id: 'equip_buy',  name: '设备求购', emoji: '🧰', image: '', bg: '#F6FFED', color: '#73D13D', light: '#F6FFED' },
  { id: 'carpool',    name: '顺风车',   emoji: '🚗', image: '', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'other',      name: '其他',     emoji: '📦', image: '', bg: '#FAFAFA', color: '#8C8C8C', light: '#FAFAFA' },
];

// 金刚位宫格
const KINGKONG = [
  { id: 'recruit_jobseek', name: '招聘求职', types: ['recruit', 'jobseek'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202208/19/175423xtrg0rgyrrh32660.png?v=2', bg: '#F0F5FF', emoji: '👨' },
  { id: 'transfer_want', name: '转让求店', types: ['transfer', 'want_shop'],
    image: 'https://zi.ygzsp.com/source/plugin/tom_tongcheng/images/809.png?v=2', bg: '#FFF1E8', emoji: '🥟' },
  { id: 'equip', name: '二手设备', types: ['equip_sell', 'equip_buy'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202208/16/225454idr9jh97pyv9c720.png?v=2', bg: '#FFF7E6', emoji: '🛒' },
  { id: 'carpool', name: '顺风车', types: [],
    image: 'https://zi.ygzsp.com/source/plugin/tom_tongcheng/images/86z.png?v=2', bg: '#F6FFED', emoji: '🚗' },
  { id: 'other', name: '其他', types: ['other'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202302/25/220139bq4iyupqdumv0zma.png?v=2', bg: '#FAFAFA', emoji: '📦' },
];

const TYPE_META = {
  transfer:   { name: '店铺转让', emoji: '🥟', image: '', color: '#FF7A45', light: '#FFF1E8' },
  want_shop:  { name: '求店',     emoji: '🔎', image: '', color: '#36CFC9', light: '#E6FFFB' },
  recruit:    { name: '招工',     emoji: '👨', image: '', color: '#597EF7', light: '#F0F5FF' },
  jobseek:    { name: '求职',     emoji: '🙋', image: '', color: '#9254DE', light: '#F9F0FF' },
  equip_sell: { name: '设备出售', emoji: '🛒', image: '', color: '#FA8C16', light: '#FFF7E6' },
  equip_buy:  { name: '设备求购', emoji: '🧰', image: '', color: '#73D13D', light: '#F6FFED' },
  other:      { name: '其他',     emoji: '📦', image: '', color: '#8C8C8C', light: '#FAFAFA' },
};

const MAIN_TYPES = ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy'];

const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};

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
    if (d < bestDist) { bestDist = d; best = c; }
  });
  return best && bestDist <= 260 ? { name: best.name, code: best.code, dist: bestDist } : null;
}

// 筛选 Tab
const TABS = [
  { id: 'all',    label: '全部' },
  { id: 'latest', label: '最新' },
  { id: 'nearby', label: '同城' },
  { id: 'face',   label: '可面议' },
  { id: 'cheap',  label: '低租金' },
];

// 底部 TabBar
const TABBAR = [
  { id: 'home',    icon: 'home',        label: '首页' },
  { id: 'nearby',  icon: 'location',    label: '附近' },
  { id: 'publish', icon: 'add-circle',  label: '发布' },
  { id: 'message', icon: 'chat',        label: '消息' },
  { id: 'me',      icon: 'user',        label: '我的' },
];

// 顶部选项卡
const TOP_TABS = [
  { id: 'latest',  label: '最新消息' },
  { id: 'nearby',  label: '附近消息' },
  { id: 'vip',     label: 'VIP信息' },
  { id: 'recruit', label: '求职招聘' },
];

const SUB_TMPL_IDS = [
  'bQSbo99ET7wuboZeBOHnGmxSrLFDBLOhjEUE-ECWdEA',
  'iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag',
];

const LOGIN_STORAGE_KEY = 'baozi_login_done';

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

// 金额：≥1万显示 x万，否则原样数字
function fmtMoney(n) {
  const num = Number(n) || 0;
  if (num <= 0) return '';
  if (num >= 10000) {
    const w = num / 10000;
    const r = Math.round(w * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '万';
  }
  return String(num);
}

Page({
  data: {
    kingkong: KINGKONG,
    tabs: TABS,
    tabbar: TABBAR,
    topTabs: TOP_TABS,
    goodsLeft: [],
    goodsRight: [],
    activeTab: 'all',
    activeGroup: '',
    activeBar: 'home',
    activeTopTab: 'latest',
    isVip: false,
    unread: 0,
    searchKw: '',
    nearbyCity: '',
    locating: false,
    publishTypes: PUBLISH_TYPES,
    publishSheetVisible: false,
    stickyProps: { zIndex: 99, offsetTop: 0 },
    tabsSticky: false,
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: true,
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
    this._all = [];
    this._nearbyCode = '';
    // 只拉 feed。会员状态/未读数放 onShow 拉，避免首次进入时
    // onLoad+onShow 先后触发导致 vip/unread 各请求两遍。
    this.loadFeed();
  },

  onShow() {
    // 首次进入紧随 onLoad 触发、从其他页/切 tab 返回也触发：
    // 在此刷新会员状态（底部"我的"图标）+ 未读消息数（消息 tab 红点）。
    this.loadVipStatus();
    this.refreshUnread();
  },

  // 查询未读站内通知数（消息 tab 红点）
  refreshUnread() {
    wx.cloud
      .callFunction({ name: 'notifyMsg', data: { action: 'list', page: 1, pageSize: 1 }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const unread = Number(r.unread) || 0;
        if (unread !== this.data.unread) this.setData({ unread });
      })
      .catch(() => {});
  },

  // 查询当前用户是否会员（memberService.status）
  loadVipStatus() {
    wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const isVip = !!r.isVip;
        if (isVip !== this.data.isVip) this.setData({ isVip });
      })
      .catch(() => {});
  },

  onPullDownRefresh() {
    this.loadFeed().then(() => { wx.stopPullDownRefresh(); });
  },

  onReachBottom() {
    this.loadMore();
  },

  // 批量模式：一次云函数调用拉多个类型(各取当前页)，等价旧「多类型并发各查一次再拼接」，
  // 但把云函数调用从 N 次降为 1 次。types: 字符串数组；page/cityCode 同单类型语义。
  fetchBatch(types, page, cityCode) {
    const data = { types, page: page || 1, pageSize: this.data.pageSize || 20 };
    if (cityCode) data.city_code = cityCode;
    return wx.cloud
      .callFunction({ name: 'feedPosts', data, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[demo] feedPosts 批量返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[demo] feedPosts 批量调用失败:', types, err && err.errMsg);
        return null;
      });
  },

  async loadFeed() {
    this.setData({ loading: true, loadingMore: false });
    const res = await this.fetchAllTypes(1);
    const real = res.list;
    this.cacheDetails(real);
    this._all = real.map((p) => this.decorate(p)).sort((a, b) => (b.isTop - a.isTop) || (b.ts - a.ts));
    this.setData({ loading: false, firstLoaded: true, page: 1, hasMore: res.hasMore });
    this.renderList();
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const res = await this.fetchAllTypes(nextPage);
    const real = res.list;
    this.cacheDetails(real);
    this._all = this._all.concat(real.map((p) => this.decorate(p))).sort((a, b) => (b.isTop - a.isTop) || (b.ts - a.ts));
    this.setData({ page: nextPage, hasMore: res.hasMore, loadingMore: false });
    this.renderList();
  },

  cacheDetails(rawItems) {
    if (!Array.isArray(rawItems)) return;
    let map = {};
    try { map = wx.getStorageSync('detail_pool') || {}; } catch (e) { map = {}; }
    rawItems.forEach((p) => { if (p && p._id) map[p._id] = p; });
    const keys = Object.keys(map);
    if (keys.length > 200) keys.slice(0, keys.length - 200).forEach((k) => delete map[k]);
    try { wx.setStorageSync('detail_pool', map); } catch (e) {}
  },

  async fetchAllTypes(page) {
    const t = this.data.activeTopTab;
    const isRecruit = t === 'recruit';
    const isNearby = t === 'nearby';
    const cityCode = isNearby ? this._nearbyCode : '';
    const TYPES = isRecruit
      ? ['recruit', 'jobseek']
      : ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy', 'other'];
    // 一次批量调用替代旧「多类型并发各查一次」，云端按 types 内部逐类取当前页再合并，
    // 返回 list 结构与旧 Promise.all 拼接完全一致，hasMore 语义一致（任一类型还有即还有）。
    return this.fetchBatch(TYPES, page, cityCode);
  },

  decorate(p) {
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    const loc = [p.province, p.city, p.district].filter(Boolean).join(' ');
    const raw = String(p.raw_text || '').trim();
    let title = '';
    if (raw) title = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
    else title = `${loc || '全国'}${p.role ? '·' + p.role : meta.name}`;

    // 按 data_type 取对应展示价格（与各频道页语义一致）：
    //   salary 招工/求职(元/月) ｜ price 转让/求店/设备(元，≥1万显示 x万) ｜
    //   顺风车 显示路线 ｜ other 不发价格（恒空）
    let priceText = '';
    const type = p.data_type;
    const isSalary = type === 'recruit' || type === 'jobseek';
    const isCarpool = type === 'carpool_car' || type === 'carpool_person';
    if (type === 'other') {
      // 其他：无价格，不发"面议/查看详情"
    } else if (isSalary) {
      const v = Number(type === 'jobseek' ? (p.salary_expect || p.salary) : p.salary) || 0;
      priceText = v > 0 ? `${v} 元/月` : '面议';
    } else if (isCarpool) {
      priceText = [p.from_place, p.to_place].filter(Boolean).join(' → ');
    } else {
      const v = Number(p.price) || 0;
      priceText = v > 0 ? `${fmtMoney(v)} 元` : '面议';
    }

    const tags = Array.isArray(p.tags) && p.tags.length ? p.tags.slice(0, 3) : [meta.name];
    return {
      id: p._id,
      type: p.data_type,
      typeName: meta.name,
      emoji: meta.emoji,
      image: p.image || meta.image || '',
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      color: meta.color,
      light: meta.light,
      title,
      priceText,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}${Number(p.views) > 0 ? ' · ' + p.views + ' 浏览' : ''}`,
      tags,
      ts: p.published_at || 0,
      isTop: !!p.isTop,
      faceTalk: /面议|查看详情/.test(priceText),
      rentLow: p.data_type === 'transfer' && tags.indexOf('低租金') >= 0,
    };
  },

  renderList() {
    let list = this._all;
    const groupId = this.data.activeGroup;
    if (groupId) {
      const kk = KINGKONG.find((k) => k.id === groupId);
      const types = (kk && kk.types) || [];
      if (kk && kk.id === 'other') list = list.filter((i) => MAIN_TYPES.indexOf(i.type) < 0);
      else if (types.length) list = list.filter((i) => types.indexOf(i.type) >= 0);
    }
    const tab = this.data.activeTab;
    if (tab === 'face') list = list.filter((i) => i.faceTalk);
    else if (tab === 'cheap') list = list.filter((i) => i.rentLow);
    const left = [];
    const right = [];
    list.forEach((it, i) => { if (i % 2 === 0) left.push(it); else right.push(it); });
    this.setData({ goodsLeft: left, goodsRight: right });
  },

  onEntry(e) {
    const key = e.currentTarget.dataset.id;
    if (key === 'recruit_jobseek') { wx.navigateTo({ url: '/pages/recruit/recruit' }); return; }
    if (key === 'transfer_want') { wx.navigateTo({ url: '/pages/turnover/turnover' }); return; }
    if (key === 'equip') { wx.navigateTo({ url: '/pages/equip/equip' }); return; }
    if (key === 'carpool') { wx.navigateTo({ url: '/pages/carpool/carpool' }); return; }
    if (key === 'other') { wx.navigateTo({ url: '/pages/other/other' }); return; }
    if (key === 'ai') { wx.showToast({ title: 'AI 顾问待接入', icon: 'none' }); return; }
    const next = key === this.data.activeGroup ? '' : key;
    this.setData({ activeGroup: next });
    this.renderList();
  },

  onTab(e) {
    const key = e.detail.value;
    if (key === 'nearby') { wx.showToast({ title: '同城需授权定位，待接入', icon: 'none' }); return; }
    this.setData({ activeTab: key });
    this.renderList();
  },

  onTabBar(e) {
    const key = e.detail.value;
    if (key === 'publish') { this.openPublishSheet(); this.setData({ activeBar: 'home' }); return; }
    if (key === 'nearby') {
      wx.showLoading({ title: '正在进入', mask: true });
      wx.navigateTo({ url: '/pages/nearby/nearby' });
      this.setData({ activeBar: 'home' });
      return;
    }
    // 消息：进站内通知页（平台消息）
    if (key === 'message') {
      this.setData({ activeBar: 'home' });
      wx.navigateTo({ url: '/pages/message/message' });
      return;
    }
    // 我的：进个人中心页
    if (key === 'me') {
      this.setData({ activeBar: 'home' });
      wx.navigateTo({ url: '/pages/mine/mine' });
      return;
    }
    this.setData({ activeBar: key });
  },

  testSubscribeFromMessage() {
    if (!SUB_TMPL_IDS.length) { wx.showToast({ title: '未配置订阅模板 ID', icon: 'none' }); return; }
    wx.requestSubscribeMessage({
      tmplIds: SUB_TMPL_IDS,
      success: (res) => {
        const accepted = SUB_TMPL_IDS.some((id) => res && res[id] === 'accept');
        wx.showToast({ title: accepted ? '已授权(accept)' : '订阅结果:reject', icon: accepted ? 'success' : 'none' });
        if (accepted) this.sendTestSubscribe();
      },
      fail: (err) => {
        console.warn('[demo] requestSubscribeMessage fail:', JSON.stringify(err || ''));
        wx.showToast({ title: (err && err.errMsg) || '订阅失败', icon: 'none' });
      },
    });
  },

  onTopTab(e) {
    const key = e.detail.value;
    if (key === 'nearby') { this.locateAndShowNearby(); return; }
    if (key === 'vip') { wx.showToast({ title: 'VIP 专区待接入', icon: 'none' }); return; }
    if (key === this.data.activeTopTab) return;
    this.setData({ activeTopTab: key });
    this.loadFeed();
  },

  locateAndShowNearby() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success: (loc) => {
        const hit = nearestCity(loc.latitude, loc.longitude);
        if (!hit) {
          this.setData({ locating: false, nearbyCity: '', activeTopTab: 'latest' });
          wx.showToast({ title: '暂不支持你所在城市，已切回最新', icon: 'none' });
          return;
        }
        this._nearbyCode = hit.code;
        this.setData({ locating: false, nearbyCity: hit.name, activeTopTab: 'nearby' });
        this.loadFeed();
      },
      fail: (err) => {
        this.setData({ locating: false, nearbyCity: '', activeTopTab: 'latest' });
        console.warn('[demo] 定位失败:', (err && err.errMsg) || err);
        wx.showToast({ title: '需授权定位才能看附近，可在设置中开启', icon: 'none' });
      },
    });
  },

  // 首页 Header 搜索：记录输入，回车/提交 → 全局搜索页
  onHomeSearchChange(e) {
    this.setData({ searchKw: (e.detail && e.detail.value) || '' });
  },
  onHomeSearch(e) {
    const kw = ((e.detail && e.detail.value) || '').trim();
    if (!kw) { wx.showToast({ title: '请输入关键词', icon: 'none' }); return; }
    wx.navigateTo({ url: `/pages/search/search?keyword=${encodeURIComponent(kw)}` });
  },

  onTabsScroll(e) {
    const isFixed = e.detail.isFixed;
    if (isFixed !== this.data.tabsSticky) this.setData({ tabsSticky: isFixed });
  },

  // ---------- 手势：在帖子流上左右滑 → 切换顶部 Tab ----------
  onFeedTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (t) { this._touch = { x: t.clientX, y: t.clientY }; }
  },
  onFeedTouchEnd(e) {
    if (!this._touch) return;
    const t = e.changedTouches && e.changedTouches[0];
    const sx = this._touch.x;
    const sy = this._touch.y;
    this._touch = null;
    if (!t) return;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    // 横向位移足够且明显大于纵向 → 判定为左右滑(而非上下滚动)
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const cur = TOP_TABS.findIndex((o) => o.id === this.data.activeTopTab);
    const next = dx < 0 ? cur + 1 : cur - 1; // 左滑→下一个，右滑→上一个
    if (next < 0 || next >= TOP_TABS.length) return;
    // 判定为滑动 → 短暂抑制紧随其后的卡片 tap，避免误进详情
    this._suppressTapUntil = Date.now() + 500;
    // 复用顶部 Tab 的统一激活逻辑(含 nearby 定位 / vip 占位等)
    this.onTopTab({ detail: { value: TOP_TABS[next].id } });
  },

  openPublishSheet() { this.setData({ publishSheetVisible: true }); },
  onPublishSheetClose(e) {
    if (!e.detail.visible) this.setData({ publishSheetVisible: false });
  },
  onPickPublishType(e) {
    const type = (e && (e.detail || e.currentTarget.dataset.item)) || null;
    this.setData({ publishSheetVisible: false });
    if (!type || !type.id) { wx.showToast({ title: '未识别到发布类型', icon: 'none' }); return; }
    if (type.id === 'recruit') { wx.navigateTo({ url: '/pages/publish_recruit/publish_recruit' }); return; }
    if (type.id === 'carpool') { wx.navigateTo({ url: '/pages/publish_carpool/publish_carpool' }); return; }
    wx.navigateTo({ url: `/pages/publish/publish?type=${type.id}` });
  },
  sendTestSubscribe(type) {
    wx.cloud
      .callFunction({
        name: 'sendSubscribeMsg',
        data: { templateId: SUB_TMPL_IDS[0], content: type ? `您已成功发布「${type.name}」信息` : '您有一条新的未读消息', time: '2026-09-02 12:00', remark: '可在小程序内查看详情' },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) wx.showToast({ title: '已开启实时提醒', icon: 'success' });
        else console.warn('[demo] sendSubscribeMsg 发送失败:', r.error);
      })
      .catch((err) => console.warn('[demo] sendSubscribeMsg 调用异常:', err && err.errMsg));
  },
  onPublish() { this.openPublishSheet(); },
  onTap(e) {
    // 刚完成横向滑动切 Tab 的瞬间抑制卡片 tap，避免误进详情
    if (this._suppressTapUntil && Date.now() < this._suppressTapUntil) {
      this._suppressTapUntil = 0;
      return;
    }
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    if (id === 'publish') { this.openPublishSheet(); return; }
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
