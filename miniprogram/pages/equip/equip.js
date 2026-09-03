// pages/equip/equip.js
// 包子行业信息平台 · 二手设备频道页（TDesign）
// 数据源：feedPosts 云函数（dataType = 'equip_sell' | 'equip_buy'）
//
// 【字段模型（精简，4 主字段）】
//   出售 equip_sell / 求购 equip_buy 共用一套 4 核心字段：
//     city(城市) / price(主价格) / raw_text(物品描述) / cond(几成新, 0-10 数字成数)
//   - price 语义：出售=售价 / 求购=预算(0=面议)，统一 price 字段
//   - cond 语义：出售=当前成色 / 求购=期望成色下限(0-10；10全新/9九成/8八成…/0需维修)
//   筛选三同构：price(价格下限) / city_code(区域) / cond(成色下限)，云函数统一 AND 过滤。
//   无设备品类枚举(role_id)，靠物品描述区分；金刚位不放品类。

const regionData = require('../../utils/regionData.js');
const privacy = require('../../utils/privacy.js');

// 几成新下拉筛选档位：value 存成数下限(不选=0 全部)
const COND_OPTIONS = [
  { label: '全部', value: 0 },
  { label: '全新', value: 10 },
  { label: '九成新', value: 9 },
  { label: '八成新', value: 8 },
  { label: '七成新', value: 7 },
  { label: '六成新', value: 6 },
];

// 信用评分等级
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

// 成数(数字0-10) → 中文文案
function condText(c) {
  const n = Number(c) || 0;
  if (n >= 10) return '全新';
  if (n >= 9) return '九成新';
  if (n >= 8) return '八成新';
  if (n >= 7) return '七成新';
  if (n >= 6) return '六成新';
  if (n >= 5) return '五成新';
  if (n >= 4) return '四成新';
  if (n >= 3) return '三成新';
  if (n >= 2) return '二成新';
  if (n >= 1) return '一成新';
  return '需维修/较旧';
}

Page({
  data: {
    condOptions: COND_OPTIONS,
    keyword: '',

    // ---------- 信息类别（出售/求购/会员 多选卡片，t-checkbox-group） ----------
    // member 是占位入口，不参与筛选：onTypeChange 会把它从 selectedTypes 里过滤掉，
    // 勾不勾都不改变查询、不触发重查。真正驱动数据源的是 selectedTypes(只含 equip_sell/equip_buy)。
    typeCards: [
      { value: 'equip_sell', label: '出售', desc: '卖设备' },
      { value: 'equip_buy',  label: '求购', desc: '收设备' },
      { value: 'member',     label: '会员', desc: '会员专区' },
    ],
    selectedTypes: ['equip_sell', 'equip_buy'],
    emptyText: '暂无设备信息',

    // ---------- 几成新（下拉单选，cond>=档位） ----------
    condPick: '',            // 选中档位值(数字字符串 or ''=全部)
    condLabel: '成色',

    // ---------- 区域（t-cascader） ----------
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',
    regionCode: '',
    hotCities: [
      { name: '上海', code: '310100' },
      { name: '深圳', code: '440300' },
      { name: '东莞', code: '441900' },
      { name: '北京', code: '110100' },
      { name: '广州', code: '440100' },
      { name: '杭州', code: '330100' },
      { name: '成都', code: '510100' },
      { name: '武汉', code: '420100' },
      { name: '南京', code: '320100' },
      { name: '长沙', code: '430100' },
    ],

    // ---------- 价格（下拉内输入最低） ----------
    price: '',
    priceLabel: '价格',
    priceInputKey: 0,

    goodsLeft: [],
    goodsRight: [],
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

    stickyTop: 0,
    tabsSticky: false,
    filterBarVisible: true,
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
  onStickyScroll(e) {
    const isFixed = !!(e && e.detail && e.detail.isFixed);
    if (isFixed !== this.data.tabsSticky) this.setData({ tabsSticky: isFixed });
  },

  // ---------- 数据源 ----------
  // 区域(city_code)/成色(cond)/价格(price) 三个筛选参数无论类别怎么选都传给云端，统一 AND 过滤。
  fetchFeed(extra) {
    const sel = Array.isArray(this.data.selectedTypes) ? this.data.selectedTypes : [];
    const hasSell = sel.indexOf('equip_sell') >= 0;
    const hasBuy = sel.indexOf('equip_buy') >= 0;
    const data = {
      page: (extra && extra.page) || 1,
      pageSize: (extra && extra.pageSize) || this.data.pageSize || 20,
      price: extra && extra.price,
      city_code: extra && extra.city_code,
      cond: extra && extra.cond,
    };
    if (hasSell && hasBuy) {
      data.dataTypes = ['equip_sell', 'equip_buy'];
    } else if (hasSell) {
      data.dataType = 'equip_sell';
    } else if (hasBuy) {
      data.dataType = 'equip_buy';
    } else {
      data.dataTypes = ['equip_sell', 'equip_buy'];
    }
    console.log('[equip] feedPosts 请求参数 =', JSON.stringify(data), '| extra =', JSON.stringify(extra));
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data,
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[equip] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[equip] feedPosts 调用失败:', err && err.errMsg);
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
    const extra = this.buildFilter();
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

  buildFilter() {
    const extra = {};
    if (this.data.regionCode) extra.city_code = this.data.regionCode;
    const c = Number(this.data.condPick);
    if (c > 0) extra.cond = c;
    if (this.data.price) extra.price = Number(this.data.price);
    return extra;
  },

  reloadWithFilters() {
    this.loadFeed(this.buildFilter());
  },

  // ---------- 展示 ----------
  decorate(p) {
    const isSell = p.data_type === 'equip_sell';
    const loc = [p.province, p.city, p.district].filter(Boolean).join('');
    const raw = String(p.raw_text || '').trim();
    const rawShow = privacy.maskText(raw);
    const typeName = isSell ? '出售' : '求购';
    const color = isSell ? '#FA8C16' : '#73D13D';   // 出售橙 / 求购绿（对齐 demo TYPE_META）
    const light = isSell ? '#FFF7E6' : '#F6FFED';
    const emoji = isSell ? '🛒' : '🧰';

    // 标题：描述首行；无则"地区+类型"
    const title = rawShow
      ? (rawShow.length > 30 ? rawShow.slice(0, 30) + '…' : rawShow)
      : `${loc || '全国'}${typeName}`;

    // 主价格：出售=售价 / 求购=预算
    let priceText;
    if (isSell) {
      priceText = Number(p.price) > 0 ? `${fmtMoney(p.price)} 元` : '价格面议';
    } else {
      priceText = Number(p.price) > 0 ? `预算 ${fmtMoney(p.price)} 元` : '预算面议';
    }

    // 几成新文案（出售=当前成色；求购=期望成色下限）
    const condLabel = Number(p.cond) > 0 ? condText(p.cond) : '';

    // 标签：出售=「几成新」；求购=「收X」+「期望成色」。用标签体现成色
    const tags = [];
    if (isSell) {
      if (condLabel) tags.push(condLabel);
    } else {
      tags.push('求购');
      if (condLabel) tags.push(`≥${condLabel}`);
    }
    if (!tags.length) tags.push(typeName);

    return {
      id: p._id,
      data_type: p.data_type || '',
      title,
      priceText,
      tags,
      condText: condLabel,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      ts: p.published_at || 0,
      faceTalk: /面议/.test(priceText),
      price: Number(p.price) || 0,
      cond: Number(p.cond) || 0,
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
    const regCode = this.data.regionCode;
    if (regCode) {
      list = list.filter((i) => i.city_code === regCode);
    }
    const c = Number(this.data.condPick);
    if (c > 0) {
      list = list.filter((i) => i.cond >= c);
    }
    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    const sel = this.data.selectedTypes;
    const onlySell = Array.isArray(sel) && sel.length === 1 && sel[0] === 'equip_sell';
    const onlyBuy = Array.isArray(sel) && sel.length === 1 && sel[0] === 'equip_buy';
    const emptyText = onlySell ? '暂无设备出售信息' : onlyBuy ? '暂无设备求购信息' : '暂无设备信息';
    this.setData({ goodsLeft: left, goodsRight: right, emptyText });
  },

  // ---------- 交互 ----------
  // 信息类别（出售/求购 双卡）
  onTypeChange(e) {
    let sel = (e.detail && e.detail.value) || [];
    if (!Array.isArray(sel)) sel = [];
    const types = sel.filter((v) => v === 'equip_sell' || v === 'equip_buy');
    const prev = this.data.selectedTypes || [];
    const same = types.length === prev.length && types.every((v) => prev.indexOf(v) >= 0);
    this.setData({ selectedTypes: types });
    if (!same) this.reloadWithFilters();
  },

  // 几成新下拉单选：value=成数(数字字符串)；0/'' 表示全部
  onCondRowTap(e) {
    const v = (e.currentTarget.dataset || {}).value || '';
    const label = v === '0' ? '成色' : condText(Number(v));
    this.setData({ condPick: v, condLabel: label });
    this.reloadWithFilters();
    const item = this.selectComponent('#condDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },

  // 区域
  onRegionDropdownOpen() {},
  onHotCity(e) {
    const ds = (e.currentTarget && e.currentTarget.dataset) || {};
    const name = ds.name;
    const code = ds.code;
    if (!name || !code) return;
    this.setData({ regionPick: name, regionCode: String(code) });
    this.reloadWithFilters();
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  openCascader() {
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
    this.setData({ regionVisible: true, filterBarVisible: false });
  },
  onRegionClose() {
    this.setData({ regionVisible: false, filterBarVisible: true });
  },
  onRegionReset() {
    this.setData({ regionPick: '', regionCode: '' });
    this.reloadWithFilters();
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  onRegionPick(e) {},
  onRegionChange(e) {
    const opts = e.detail.selectedOptions || [];
    const text = opts.map((o) => o.label).join('/');
    const cityOpt = opts[1] || opts[0] || {};
    const cityCode = cityOpt.value != null ? String(cityOpt.value) : '';
    this.setData({ regionPick: text, regionCode: cityCode, regionVisible: false, filterBarVisible: true });
    this.reloadWithFilters();
  },

  // 价格
  sanitizePrice(v) {
    const digits = String(v || '').replace(/\D/g, '');
    if (!digits) return '';
    const n = Number(digits);
    if (n > 5000000) return '5000000';
    return String(n);
  },
  onPrice(e) {
    this.setData({ price: this.sanitizePrice(e.detail.value) }, this.syncPriceLabel);
  },
  onPriceBlur() {
    if (!this.data.price) return;
    this.reloadWithFilters();
  },
  onPriceClear() {
    this.setData({ price: '', priceInputKey: this.data.priceInputKey + 1 }, this.syncPriceLabel);
    this.reloadWithFilters();
    const item = this.selectComponent('#priceDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  onPriceConfirm() {
    this.syncPriceLabel();
    this.reloadWithFilters();
    const item = this.selectComponent('#priceDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  syncPriceLabel() {
    const s = String(this.data.price || '').trim();
    let label = '价格';
    if (s) label = `${s}以上`;
    this.setData({ priceLabel: label });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.renderList();
  },

  onPublish() {
    wx.showToast({ title: '发布二手设备表单待接入', icon: 'none' });
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
