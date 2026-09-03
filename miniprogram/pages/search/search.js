// pages/search/search.js
// 包子行业信息平台 · 全局模糊搜索页
// 数据源：feedPosts 云函数 keyword 参数（云端对 原文/角色/省市区/地址/联系人/备注 做正则模糊，全部分类）
// 交互：t-search 输入即搜(防抖)，也支持点键盘"搜索"；双列卡片；触底分页；点卡片进详情。
const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};
const TYPE_META = {
  transfer:   { name: '转让',     emoji: '🥟', color: '#FF7A45', light: '#FFF1E8' },
  want_shop:  { name: '求店',     emoji: '🔎', color: '#36CFC9', light: '#E6FFFB' },
  recruit:    { name: '招工',     emoji: '👨', color: '#597EF7', light: '#F0F5FF' },
  jobseek:    { name: '求职',     emoji: '🙋', color: '#9254DE', light: '#F9F0FF' },
  equip_sell: { name: '设备出售', emoji: '🛒', color: '#FA8C16', light: '#FFF7E6' },
  equip_buy:  { name: '设备求购', emoji: '🧰', color: '#73D13D', light: '#F6FFED' },
  carpool_car:  { name: '车找人', emoji: '🚗', color: '#597EF7', light: '#F0F5FF' },
  carpool_person:{ name: '人找车', emoji: '🧳', color: '#73D13D', light: '#F6FFED' },
  other:      { name: '其他',     emoji: '📦', color: '#8C8C8C', light: '#F0F0F0' },
};
const DAY = 864e5;

// 防御性 URL 解码：若字符串仍是 %xx 形式则解一次（处理双编码/粘贴已编码片段）；
// 解码后若内容基本不变（含非 ASCII 字符）就视为已解码，正常用
function safeDecode(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str || !/%[0-9A-Fa-f]{2}/.test(str)) return str;
  try {
    const decoded = decodeURIComponent(str);
    // 解后若仍是 %xx 形式（说明嵌套），再解一次
    if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
      try { return decodeURIComponent(decoded); } catch (e) { return decoded; }
    }
    return decoded;
  } catch (e) {
    return str;
  }
}

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
    const r = Math.round(w * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '万';
  }
  return String(num);
}

Page({
  data: {
    keyword: '',
    autoFocus: false,     // 进页是否自动聚焦弹键盘
    searching: false,     // 首次/换词加载态
    goodsLeft: [],
    goodsRight: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    firstLoaded: false,
    showEmpty: false,
    skeletonRows: [
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
    ],
  },

  onLoad(options) {
    this._all = [];
    this._kw = '';
    let initKw = (options && options.keyword) || '';
    // 防御：对 URL 参数再做一次解码（防止外部直接拼了已编码过的链接、或粘贴了编码片段进来）
    initKw = safeDecode(initKw);
    if (initKw) {
      this.setData({ keyword: initKw });
      this.doSearch(initKw);
    } else {
      this.setData({ searching: false, firstLoaded: true });
    }
  },

  onPullDownRefresh() {
    const kw = this.data.keyword;
    this.doSearch(kw).then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    this.loadMore();
  },

  // t-search 输入变化：防抖实时搜
  onSearchChange(e) {
    const v = safeDecode((e.detail && e.detail.value) || '');
    this.setData({ keyword: v });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.doSearch(v), 400);
  },
  // 点键盘"搜索"/清除空值：直接搜
  onSearchSubmit(e) {
    const v = safeDecode((e.detail && e.detail.value) || '');
    this.setData({ keyword: v });
    this.doSearch(v);
  },
  onSearchClear() {
    this.setData({ keyword: '', goodsLeft: [], goodsRight: [], firstLoaded: true, showEmpty: false, searching: false });
    this._all = [];
    this._kw = '';
  },

  // 拉取结果第 page 页
  fetchResults(kw, page) {
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data: { keyword: safeDecode(kw), page: page || 1, pageSize: this.data.pageSize || 20 },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[search] feedPosts 返回失败:', r.error);
        return { list: [], hasMore: false };
      })
      .catch((err) => {
        console.error('[search] feedPosts 调用失败:', err && err.errMsg);
        return { list: [], hasMore: false };
      });
  },

  // 搜索(整块替换第 1 页)；空关键词则清空
  async doSearch(kw) {
    const k = String(kw || '').trim();
    if (this._kw === k && k && this.data.firstLoaded) return; // 词没变不重复拉
    if (!k) { this.onSearchClear(); return; }
    this._kw = k;
    this.setData({ searching: true, loadingMore: false, showEmpty: false });
    const res = await this.fetchResults(k, 1);
    const real = res.list;
    this.cacheDetails(real);
    this._all = real.map((p) => this.decorate(p)).sort((a, b) => b.ts - a.ts);
    this.applyList(this._all, 1, res.hasMore);
    this.setData({ searching: false, firstLoaded: true, showEmpty: this._all.length === 0 });
  },

  // 触底加载更多
  async loadMore() {
    if (this.data.searching || this.data.loadingMore || !this.data.hasMore || !this._kw) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const res = await this.fetchResults(this._kw, nextPage);
    const real = res.list;
    this.cacheDetails(real);
    const more = real.map((p) => this.decorate(p));
    const seen = {};
    this._all.forEach((i) => { seen[i.id] = 1; });
    const add = more.filter((i) => !seen[i.id]);
    this._all = this._all.concat(add).sort((a, b) => b.ts - a.ts);
    this.applyList(this._all, nextPage, res.hasMore);
    this.setData({ loadingMore: false });
  },

  applyList(list, page, hasMore) {
    const left = [];
    const right = [];
    list.forEach((it, i) => { if (i % 2 === 0) left.push(it); else right.push(it); });
    this.setData({ goodsLeft: left, goodsRight: right, page, hasMore, showEmpty: list.length === 0 });
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

  decorate(p) {
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    // 防御：若文本字段意外存了 URL 编码片段，渲染时解码（不影响入库原文）
    const loc = [safeDecode(p.province), safeDecode(p.city), safeDecode(p.district)].filter(Boolean).join(' ');
    const raw = safeDecode(p.raw_text);
    const role = safeDecode(p.role);
    let title = '';
    if (raw) title = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
    else title = `${loc || '全国'}${role ? '·' + role : meta.name}`;

    // 不同分类的价格展示：招工/求职=salary；转让/求店/设备/其他=price
    let priceText = '';
    const isSalary = p.data_type === 'recruit' || p.data_type === 'jobseek';
    if (isSalary) {
      const v = Number(p.data_type === 'jobseek' ? (p.salary_expect || p.salary) : p.salary) || 0;
      priceText = v > 0 ? `${v} 元/月` : (p.data_type === 'jobseek' ? '期望面议' : '面议');
    } else {
      const v = Number(p.price) || 0;
      priceText = v > 0 ? `${fmtMoney(v)} 元` : '面议';
    }
    if (p.data_type === 'carpool_car' || p.data_type === 'carpool_person') {
      priceText = (p.from_place ? p.from_place : '') + (p.to_place ? ' → ' + p.to_place : '');
    }
    const tags = (Array.isArray(p.tags) && p.tags.length) ? p.tags.slice(0, 2).map(safeDecode) : [meta.name];
    return {
      id: p._id,
      type: p.data_type,
      typeName: meta.name,
      emoji: meta.emoji,
      image: p.image || '',
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      color: meta.color,
      light: meta.light,
      title,
      priceText,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      tags,
      ts: p.published_at || 0,
    };
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
