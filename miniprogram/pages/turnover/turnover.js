// pages/turnover/turnover.js
// 包子行业信息平台 · 转让求店频道页（TDesign）
// 数据源：feedPosts 云函数（dataType = 'transfer' | 'want_shop'）
//
// 【字段模型约定（与 baozi_posts 一致）】
//   transfer 店转让 / want_shop 求店 两类帖子共用一套"店铺类型"枚举(role_id 1-5)：
//     1品牌店 / 2自营店 / 3摆摊车 / 4学校 / 5工厂 —— 该枚举存于 dicts 集合(category='shop_type')，
//   这里前端内置一份镜像(shopTypes)保证首屏离线可用，与字典集合保持一致。
//   两类各用 price 存"主价格"：transfer=转让费 / want_shop=预算(0=面议)，与 recruit 的 salary 同构，
//   频道页按 price >= X 统一筛选(由云函数 feedPosts 过滤)。
//
// 【筛选维度】
//   店铺类型(role_id 精确) / 区域(city_code) / 价格(price 下限) 任意组合取 AND，
//   全部交给云函数 feedPosts 过滤，前端只做展示分栏。

const regionData = require('../../utils/regionData.js');
const privacy = require('../../utils/privacy.js');

// 店铺类型（镜像 dicts 集合 category='shop_type' 的 5 条）
// 字段：id(与 role_id 对应)、name(中文)、emoji、bg(金刚位底色)
// TODO: 后续改为发布/筛选共用时从 dicts 集合读取，替换本数组数据来源
const SHOP_TYPES = [
  { id: 'brand',     roleId: 1, name: '品牌店', emoji: '🏬', bg: '#FFF1E8' },
  { id: 'self',      roleId: 2, name: '自营店', emoji: '🏪', bg: '#F0F5FF' },
  { id: 'stallcar',  roleId: 3, name: '摆摊车', emoji: '🚚', bg: '#FFF7E6' },
  { id: 'school',    roleId: 4, name: '学校',   emoji: '🏫', bg: '#E6FFFB' },
  { id: 'factory',   roleId: 5, name: '工厂',   emoji: '🏭', bg: '#F6FFED' },
];

// 信用评分等级：1优秀 / 2极好 / 3良好 / 4一般
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

function findShop(id) {
  for (let i = 0; i < SHOP_TYPES.length; i += 1) {
    if (SHOP_TYPES[i].id === id) return SHOP_TYPES[i];
  }
  return null;
}

Page({
  data: {
    shopTypes: SHOP_TYPES,
    activeShop: '',          // 选中店铺类型 id(''=全部)；点击金刚位格设置并驱动 role_id 筛选
    keyword: '',

    // ---------- 信息类别（转让/求店/会员 多选卡片，t-checkbox-group） ----------
    // member 是占位入口，不参与筛选：onTypeChange 会把它从 selectedTypes 里过滤掉，
    // 勾不勾都不改变查询、不触发重查。真正驱动数据源的是 selectedTypes(只含 transfer/want_shop)。
    // 默认两类都选=混排全看；取消任一=只看另一类；全不勾自动回两类全看。
    typeCards: [
      { value: 'transfer',  label: '转让', desc: '店铺转让' },
      { value: 'want_shop', label: '求店', desc: '诚心求租' },
      { value: 'member',    label: '会员', desc: '会员专区' },
    ],
    selectedTypes: ['transfer', 'want_shop'],
    emptyText: '暂无转让/求店信息', // 空态文案（随信息类别变化）

    // ---------- 店铺类型（顶部下拉，与金刚位 activeShop 联动） ----------
    shopOptions: [{ label: '全部类型', value: '__all__' }].concat(
      SHOP_TYPES.map((c) => ({ label: c.name, value: c.id }))
    ),
    shopPick: '',            // 店铺类型选中值(已生效)：''=未选(显示"店铺类型")
    shopLabel: '店铺类型',
    shopDraftPick: '',       // 单选列表草稿值

    // ---------- 区域（t-cascader） ----------
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',          // 已选展示文本，空=未选
    regionCode: '',          // 市级行政区划 code（精确匹配数据库）
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

    // ---------- 价格（下拉内输入，单一最低"转让费/预算"） ----------
    price: '',               // 最低价格（元）
    priceLabel: '价格',       // 下拉标题文案
    priceInputKey: 0,        // 强制重建 t-input 的 key

    goodsLeft: [],
    goodsRight: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: true,
    firstLoaded: false,

    // 双列瀑布流骨架（与 recruit 同款，无需手写 CSS）
    skeletonRows: [
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
      [{ width: '48%', height: '200rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '220rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
    ],

    // ---------- 筛选条吸顶 ----------
    stickyTop: 0,
    tabsSticky: false,
    filterBarVisible: true,  // 打开"查看完整省市区"弹层时隐藏
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
  // 店铺类型(role_id)/区域(city_code)/价格(price)三个筛选参数无论信息类别如何选都传给云端，
  // 由云函数 feedPosts 对选中类型统一 AND 过滤（transfer 给价=price / want_shop 预算=price）。
  fetchFeed(extra) {
    const sel = Array.isArray(this.data.selectedTypes) ? this.data.selectedTypes : [];
    const hasTransfer = sel.indexOf('transfer') >= 0;
    const hasWantShop = sel.indexOf('want_shop') >= 0;
    const data = {
      page: (extra && extra.page) || 1,
      pageSize: (extra && extra.pageSize) || this.data.pageSize || 20,
      price: extra && extra.price,
      city_code: extra && extra.city_code,
      role_id: extra && extra.role_id,
    };
    if (hasTransfer && hasWantShop) {
      data.dataTypes = ['transfer', 'want_shop'];
    } else if (hasTransfer) {
      data.dataType = 'transfer';
    } else if (hasWantShop) {
      data.dataType = 'want_shop';
    } else {
      data.dataTypes = ['transfer', 'want_shop'];
    }
    console.log('[turnover] feedPosts 请求参数 =', JSON.stringify(data), '| extra =', JSON.stringify(extra));
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data,
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[turnover] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[turnover] feedPosts 调用失败:', err && err.errMsg);
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
    this.setData({
      loading: false,
      firstLoaded: true,
      page: 1,
      hasMore: !!(r && r.hasMore),
    });
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

  // 组装当前所有筛选条件：店铺类型(role_id)/区域(city_code)/价格(price)
  buildFilter() {
    const extra = {};
    const shop = this.data.activeShop;
    if (shop) {
      const s = findShop(shop);
      if (s && s.roleId) extra.role_id = s.roleId;
    }
    if (this.data.regionCode) extra.city_code = this.data.regionCode;
    if (this.data.price) extra.price = Number(this.data.price);
    return extra;
  },

  reloadWithFilters() {
    this.loadFeed(this.buildFilter());
  },

  // ---------- 展示 ----------
  // 转让/求店卡片结构一致，只是取值参数不同：
  //   - 主价格：transfer=转让费 price；want_shop=预算 price（同用 price 字段，加语义前缀）
  //   - 店铺类型：role/role_id（两类共用 1-5）
  decorate(p) {
    const isTransfer = p.data_type === 'transfer';
    const loc = [p.province, p.city, p.district].filter(Boolean).join('');
    const raw = String(p.raw_text || '').trim();
    const rawShow = privacy.maskText(raw);
    // 视觉区分：转让=橙 / 求店=青（对齐 demo TYPE_META）
    const typeName = isTransfer ? '转让' : '求店';
    const color = isTransfer ? '#FF7A45' : '#36CFC9';
    const light = isTransfer ? '#FFF1E8' : '#E6FFFB';
    const emoji = isTransfer ? '🥟' : '🔎';

    const roleName = p.role || (isTransfer ? '店铺' : '找店');
    const title = rawShow
      ? (rawShow.length > 30 ? rawShow.slice(0, 30) + '…' : rawShow)
      : `${loc || '全国'}${isTransfer ? roleName + '转让' : roleName + '求租'}`;

    // 主价格：transfer=转让费 / want_shop=预算
    let priceText;
    if (isTransfer) {
      priceText = Number(p.price) > 0 ? `转让费 ${this.fmtMoney(p.price)}` : '转让费面议';
    } else {
      priceText = Number(p.price) > 0 ? `预算 ${this.fmtMoney(p.price)}` : '预算面议';
    }

    // 标签：转让=店铺类型 + terms(条件)；求店=店铺类型 + want_terms(诉求)
    const tags = [];
    if (p.role && tags.indexOf(p.role) < 0) tags.push(p.role);
    const condArr = isTransfer ? (Array.isArray(p.terms) ? p.terms : (Array.isArray(p.tags) ? p.tags : []))
      : (Array.isArray(p.want_terms) ? p.want_terms : (Array.isArray(p.tags) ? p.tags : []));
    condArr.forEach((t) => {
      if (t && tags.indexOf(t) < 0 && tags.length < 3) tags.push(t);
    });
    if (!tags.length) tags.push(typeName);

    const top = Number(p.price) || 0;

    return {
      id: p._id,
      data_type: p.data_type || '',
      title,
      priceText,
      tags,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      ts: p.published_at || 0,
      faceTalk: /面议/.test(priceText),
      // 原始数值（价格筛选用，传给详情等）
      price: top,
      city: p.city || '',
      city_code: p.city_code || '',
      username: p.username || '',
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      // 店铺类型（金刚位筛选检索：卡片可含 role + 原文）
      haystack: `${p.role || ''} ${raw}`,
      emoji,
      image: p.image || '',
      color,
      light,
      typeName,
    };
  },

  // 金额格式化：21万 / 8.8万 / 6万 / 5000
  fmtMoney(n) {
    const num = Number(n) || 0;
    if (num <= 0) return '';
    if (num >= 10000) {
      const w = num / 10000;
      const rounded = Math.round(w * 10) / 10;
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '万';
    }
    return String(num);
  },

  renderList() {
    let list = this._all;
    const shop = this.data.activeShop;
    if (shop) {
      const s = findShop(shop);
      // 店铺类型无关键词也走数据库 role_id 精确匹配，前端无需再过滤（此处兜底按 role 原文）
      if (s && s.roleId) {
        list = list.filter((i) => i.role_id !== undefined ? i.role_id === s.roleId : true);
      }
    }
    const kw = String(this.data.keyword || '').trim();
    if (kw) {
      list = list.filter((i) => i.title.indexOf(kw) >= 0 || i.haystack.indexOf(kw) >= 0);
    }
    const regCode = this.data.regionCode;
    if (regCode) {
      list = list.filter((i) => i.city_code === regCode);
    }
    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    const sel = this.data.selectedTypes;
    const onlyTransfer = Array.isArray(sel) && sel.length === 1 && sel[0] === 'transfer';
    const onlyWantShop = Array.isArray(sel) && sel.length === 1 && sel[0] === 'want_shop';
    const emptyText = onlyTransfer ? '暂无转让信息' : onlyWantShop ? '暂无求店信息' : '暂无转让/求店信息';
    this.setData({ goodsLeft: left, goodsRight: right, emptyText });
  },

  // ---------- 交互 ----------
  // 金刚位点店铺类型：再点一次已选中的 → 取消筛选
  onShopCat(e) {
    const cat = (e && (e.detail || e.currentTarget.dataset.item)) || {};
    const next = cat.id === this.data.activeShop ? '' : cat.id;
    const catObj = next ? findShop(next) : null;
    this.setData({
      activeShop: next,
      shopPick: next || '',
      shopDraftPick: next || '',
      shopLabel: next ? (catObj ? catObj.name : cat.name) : '店铺类型',
    }, () => this.refreshShopLabel());
    this.reloadWithFilters();
  },

  refreshShopLabel() {
    const menu = this.selectComponent('#topDropdownMenu');
    if (menu && typeof menu.getAllItems === 'function') menu.getAllItems();
  },

  // ---------- 信息类别（转让/求店 双选卡片） ----------
  onTypeChange(e) {
    let sel = (e.detail && e.detail.value) || [];
    if (!Array.isArray(sel)) sel = [];
    const types = sel.filter((v) => v === 'transfer' || v === 'want_shop');
    const prev = this.data.selectedTypes || [];
    const same = types.length === prev.length && types.every((v) => prev.indexOf(v) >= 0);
    this.setData({ selectedTypes: types });
    if (!same) this.reloadWithFilters();
  },

  // ---------- 店铺类型（下拉单选，与金刚位联动） ----------
  onShopDropdownOpen() {
    this.setData({ shopDraftPick: this.data.shopPick });
  },
  onShopRowTap(e) {
    const v = (e.currentTarget.dataset || {}).value || '';
    this.setData({ shopDraftPick: v });
    this.applyShopSelection(v);
    this.closeShopDropdown();
  },
  closeShopDropdown() {
    const item = this.selectComponent('#shopDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  applyShopSelection(v) {
    const isAll = v === '__all__';
    const cat = !isAll && v ? findShop(v) : null;
    const label = isAll ? '全部类型' : cat ? cat.name : '店铺类型';
    this.setData({
      shopPick: isAll ? '__all__' : v,
      shopLabel: label,
      activeShop: isAll || !cat ? '' : v,
    }, () => this.refreshShopLabel());
    this.reloadWithFilters();
  },

  // ---------- 区域 ----------
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

  // ---------- 价格（下拉内输入最低"转让费/预算"） ----------
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
    wx.showToast({ title: '发布转让求店表单待接入', icon: 'none' });
  },

  // 点击帖子卡片 → 详情页（与招聘求职同链路：detail_pool 缓存命中零二次请求）
  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
