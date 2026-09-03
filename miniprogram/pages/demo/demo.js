// pages/demo/demo.js
// 包子行业信息平台 · 首页(tdesign-miniprogram)
// 数据源：feedPosts 云函数（七大类型各拉 20 条，失败自动回退本地 mock）

// 七大类型（六大板块 + 其他兜底）
// 顺序：招工 → 转让 → 设备出售 → 其余保持默认序 → 其他
// TODO: 后续改为从数据库读取类型表，届时只需替换 PUBLISH_TYPES 的数据来源
const PUBLISH_TYPES = [
  // image: 帖子卡片图片地址；为空则卡片不显示图片（占位代码保留，后续有真实图再填）
  { id: 'recruit',    name: '招工',     emoji: '👨', image: '', bg: '#F0F5FF', color: '#597EF7', light: '#F0F5FF' },
  { id: 'transfer',   name: '转让',     emoji: '🥟', image: '', bg: '#FFF1E8', color: '#FF7A45', light: '#FFF1E8' },
  { id: 'equip_sell', name: '设备出售', emoji: '🛒', image: '', bg: '#FFF7E6', color: '#FA8C16', light: '#FFF7E6' },
  { id: 'want_shop',  name: '求店',     emoji: '🔎', image: '', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'jobseek',    name: '求职',     emoji: '🙋', image: '', bg: '#F9F0FF', color: '#9254DE', light: '#F9F0FF' },
  { id: 'equip_buy',  name: '设备求购', emoji: '🧰', image: '', bg: '#F6FFED', color: '#73D13D', light: '#F6FFED' },
  { id: 'other',      name: '其他',     emoji: '📦', image: '', bg: '#FAFAFA', color: '#8C8C8C', light: '#FAFAFA' },
];

// 金刚位宫格（六大板块两两合并成三大入口 + 其他 + AI）
// 每格：
//   id    —— 金刚位唯一标识（onEntry 用）
//   name  —— 格子名称
//   types —— 点击后要展示的帖子 data_type 数组；'other' = 六大之外的全部；'ai' 为特殊入口
//   image —— 图标图片地址（有则渲染图片，否则回退 emoji）
//   emoji / bg —— 无图时的兜底 emoji 与格子底色
const KINGKONG = [
  { id: 'recruit_jobseek', name: '招聘求职', types: ['recruit', 'jobseek'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202208/19/175423xtrg0rgyrrh32660.png?v=2', bg: '#F0F5FF', emoji: '👨' },
  { id: 'transfer_want', name: '转让求店', types: ['transfer', 'want_shop'],
    image: 'https://zi.ygzsp.com/source/plugin/tom_tongcheng/images/809.png?v=2', bg: '#FFF1E8', emoji: '🥟' },
  { id: 'equip', name: '二手设备', types: ['equip_sell', 'equip_buy'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202208/16/225454idr9jh97pyv9c720.png?v=2', bg: '#FFF7E6', emoji: '🛒' },
  { id: 'carpool', name: '顺风车', types: [], // 顺风车独立入口（暂无对应数据类型，点击为占位提示）
    image: 'https://zi.ygzsp.com/source/plugin/tom_tongcheng/images/86z.png?v=2', bg: '#F6FFED', emoji: '🚗' },
  { id: 'other', name: '其他', types: ['other'],
    image: 'https://zi.ygzsp.com/data/attachment/tomwx/202302/25/220139bq4iyupqdumv0zma.png?v=2', bg: '#FAFAFA', emoji: '📦' },
  // AI 顾问：暂注释（后续接 AI 再启用）
  // { id: 'ai', name: 'AI 顾问', types: [], image: '', emoji: '🤖', bg: '#FFFBE6' },
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

// 六大类型：「其他」= 不属于这六类的所有帖子
const MAIN_TYPES = ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy'];

// 信用评分等级：1优秀 / 2极好 / 3良好 / 4一般；label 展示文案 + color 文字色 + bg 标签底色
const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};

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

// 顶部选项卡(最新/附近/VIP/求职招聘)
const TOP_TABS = [
  { id: 'latest',  label: '最新消息' },
  { id: 'nearby',  label: '附近消息' },
  { id: 'vip',     label: 'VIP信息' },
  { id: 'recruit', label: '求职招聘' },
];

// 订阅消息模板 ID（微信公众平台-小程序-订阅消息 申请后填入；未填则跳过订阅授权）
// 用多条时 push 更多模板 ID，数组顺序即弹窗展示顺序
// 说明：一次性订阅，每次授权=获得一次发送额度
const SUB_TMPL_IDS = [
  'bQSbo99ET7wuboZeBOHnGmxSrLFDBLOhjEUE-ECWdEA', // 消息未读提醒(1185): thing2消息内容/time37时间/thing7备注
  'iYAWAJR4UEG2XUjlCjs8-9eiatRAmAGQJlDL9BMIjag', // 审核结果通知(786): phrase1审核结果/thing2审核内容/date3审核时间/thing7备注
];

// 本地标记 key：记录当前设备是否已完成过"登录/授权"，避免重复弹手机号授权
const LOGIN_STORAGE_KEY = 'baozi_login_done';

// 回退 mock 数据
const MOCK_RAW = [
  { _id: 'm1', data_type: 'transfer',   city: '深圳', district: '南山', raw_text: '深圳南山包子店转让 日营业额3000 带全套设备', tags: ['有厨厕', '可外摆'], published_at: Date.now() - 3 * 864e5 },
  { _id: 'm2', data_type: 'recruit',    city: '上海', district: '浦东', role: '大师傅', raw_text: '上海浦东招大师傅 包吃住 月休4天', salary: 8000, tags: ['包吃', '包住'], published_at: Date.now() - 1 * 864e5 },
  { _id: 'm3', data_type: 'transfer',   city: '东莞', raw_text: '东莞长安临街包子铺转让 日营业额1700-1800', tags: ['低租金'], published_at: Date.now() - 2 * 864e5 },
  { _id: 'm4', data_type: 'equip_sell', province: '广东', raw_text: '九成新包子设备全套 和面机/蒸柜/绞肉机', tags: ['九成新'], published_at: Date.now() - 5 * 864e5 },
  { _id: 'm5', data_type: 'want_shop',  city: '东莞', raw_text: '求东莞或深圳包子店 要求日营业额2500以上', tags: ['求店'], published_at: Date.now() - 7 * 864e5 },
  { _id: 'm6', data_type: 'jobseek',    province: '广东', role: '顶班师傅', raw_text: '顶班师傅求职 广东范围可跑 随时到岗', salary: 0, published_at: Date.now() - 8 * 864e5 },
];

// 临时预览：带图 mock 帖子（混入最新消息流查看图片卡片效果）
// TODO: 预览完删除本数组与 loadFeed 里的 concat 逻辑
// 用不同宽高比的真实图测试瀑布流错落效果（picsum 按尺寸返回随机图）
//   img1 竖长(300x420) / img2 横扁(400x260) / img3 方形(340x340)
const MOCK_IMAGE_POSTS = [
  { _id: 'img1', data_type: 'transfer',   city: '深圳', district: '宝安', raw_text: '深圳宝安临街包子店转让 日营业额3000+ 带全套设备', tags: ['带图示例', '低租金'], username: '包子一哥', credit: 1, published_at: Date.now() - 2 * 864e5, image: 'https://picsum.photos/300/420' },
  { _id: 'img2', data_type: 'recruit',    city: '上海', district: '浦东', role: '大师傅', raw_text: '上海浦东招大师傅 包吃住 月休4天 待遇优', tags: ['包吃', '包住'], username: '王老板', credit: 2, salary: 9000, published_at: Date.now() - 1 * 864e5, image: 'https://picsum.photos/400/260' },
  { _id: 'img3', data_type: 'equip_sell', province: '广东', raw_text: '九成新包子设备全套 和面机/蒸柜/绞肉机 低价出', tags: ['九成新'], username: '李师傅', credit: 3, published_at: Date.now() - 3 * 864e5, image: 'https://picsum.photos/340/340' },
];

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
    kingkong: KINGKONG,
    tabs: TABS,
    tabbar: TABBAR,
    topTabs: TOP_TABS,
    goodsLeft: [],
    goodsRight: [],
    activeTab: 'all',
    // 当前激活的金刚位格子 id（'' = 全部不筛选）；见 KINGKONG 的 types 映射
    activeGroup: '',
    activeBar: 'home',
    activeTopTab: 'latest',
    // 发布类型选择弹层（TDesign t-popup + t-grid）
    publishTypes: PUBLISH_TYPES,
    publishSheetVisible: false,
    // 登录 / 授权弹层状态
    // 手机号授权弹层：true=显示（发布选类型后进入），false=隐藏
    phoneAuthVisible: false,
    // 用户当前登录态（openid 建号结果缓存在实例，供本页判断）
    // 记录选中的发布类型对象（授权完成后回调继续使用）
    pendingPublishType: null,
    // 是否正在处理授权（防重复点击）
    authing: false,
    // t-tabs sticky：透传给内部 t-sticky 的参数，offsetTop 为吸顶距顶部距离(px)
    stickyProps: { zIndex: 99, offsetTop: 0 },
    tabsSticky: false,
    // 分页游标：当前已加载页码 / 是否还有下一页 / 是否正在加载更多
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    // 列表区骨架屏/内容切换：true=显示骨架屏，false=显示列表或空态
    loading: true,
    // 是否已完成首次加载（区分"首屏"与"筛选/刷新"，用于骨架屏 vs 局部反馈）
    firstLoaded: false,
    // 双列瀑布流"图文组合"骨架：每张卡片 = 上方图块(rect) + 两行文字(text)，左右两列并排
    // 纯 TDesign row-col 配置，无需手写 CSS；marginRight 撑出两列间隔
    skeletonRows: [
      // —— 卡片 1：左图+左文 / 右图+右文 ——
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
      // —— 卡片 2：高度错落，模拟瀑布流 ——
      [{ width: '48%', height: '200rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '220rpx', type: 'rect' }],
      [{ width: '48%', height: '24rpx', type: 'text', marginRight: '4%' }, { width: '48%', height: '24rpx', type: 'text' }],
      [{ width: '30%', height: '24rpx', type: 'text', marginRight: '22%' }, { width: '30%', height: '24rpx', type: 'text' }],
    ],
  },

  onLoad() {
    this._all = [];
    this.loadFeed();
  },

  // 下拉刷新：重拉第 1 页并整块替换（带原生下拉指示器）
  onPullDownRefresh() {
    this.loadFeed().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 触底加载更多：页码 +1 追加下一页
  onReachBottom() {
    this.loadMore();
  },

  // ---------- 数据源 ----------
  // 聚合 7 类各取一页；extra.page 控制页码。返回 { list, hasMore }（hasMore=任一类型还有更多）
  fetchFeed(dataType, page) {
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data: { dataType, page: page || 1, pageSize: this.data.pageSize || 20 },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[demo] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[demo] feedPosts 调用失败:', dataType, err && err.errMsg);
        return null;
      });
  },

  // 首屏 / 下拉刷新：每类从第 1 页重拉并整块替换（列表区切骨架屏）
  async loadFeed() {
    // 进入加载态 → 列表区切骨架屏（首屏 & 刷新统一走这里）
    this.setData({ loading: true, loadingMore: false });
    const res = await this.fetchAllTypes(1);
    const real = res.list;
    const raw = (real.length ? real : MOCK_RAW).concat(MOCK_IMAGE_POSTS); // 混入带图 mock 预览
    this._all = raw.map((p) => this.decorate(p)).sort((a, b) => b.ts - a.ts);
    this.setData({
      loading: false,
      firstLoaded: true,
      page: 1,
      hasMore: res.hasMore,
    });
    this.renderList();
  },

  // 触底加载更多：页码 +1，每类拉下一页并追加到现有列表；不切骨架屏，底部局部 loading
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const nextPage = this.data.page + 1;
    const res = await this.fetchAllTypes(nextPage);
    const real = res.list;
    this._all = this._all
      .concat(real.map((p) => this.decorate(p)))
      .sort((a, b) => b.ts - a.ts);
    this.setData({
      page: nextPage,
      hasMore: res.hasMore,
      loadingMore: false,
    });
    this.renderList();
  },

  // 并发拉取 7 类第 page 页；hasMore=任一类型还有更多
  async fetchAllTypes(page) {
    const TYPES = ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy', 'other'];
    const results = await Promise.all(TYPES.map((t) => this.fetchFeed(t, page)));
    const list = results.filter(Boolean).reduce((a, b) => a.concat(b.list || []), []);
    const hasMore = results.some((r) => r && r.hasMore);
    return { list, hasMore };
  },

  // ---------- 展示 ----------
  decorate(p) {
    // 不属于六大类型的，默认归为「其他」
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    const loc = [p.province, p.city, p.district].filter(Boolean).join(' ');
    const raw = String(p.raw_text || '').trim();

    let title = '';
    if (raw) title = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
    else title = `${loc || '全国'}${p.role ? '·' + p.role : meta.name}`;

    let priceText = '';
    if (p.salary > 0) {
      priceText = `${p.salary} 元/月`;
    } else {
      priceText = '点击查看详情';
    }

    const tags = Array.isArray(p.tags) && p.tags.length ? p.tags.slice(0, 3) : [meta.name];

    return {
      id: p._id,
      type: p.data_type,
      typeName: meta.name,
      emoji: meta.emoji,
      image: p.image || meta.image || '', // 帖子卡片图片地址；为空 → wxml 不显示图片区（帖子自带图优先）
      username: p.username || '', // 发布者昵称/称呼（为空则不展示发布人）
      // 信用评分（1优秀/2极好/3良好/4一般）；0/非法 → 不显示信用标签
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      color: meta.color,
      light: meta.light,
      title,
      priceText,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      tags,
      ts: p.published_at || 0,
      faceTalk: priceText === '面议' || priceText === '点击查看详情',
      rentLow: p.data_type === 'transfer' && tags.indexOf('低租金') >= 0,
    };
  },

  renderList() {
    let list = this._all;

    // 按金刚位格子过滤：activeGroup 为空(未选任何格子)则展示全部
    const groupId = this.data.activeGroup;
    if (groupId) {
      const kk = KINGKONG.find((k) => k.id === groupId);
      const types = (kk && kk.types) || [];
      if (kk && kk.id === 'other') {
        // 「其他」= 六大类型之外的全部
        list = list.filter((i) => MAIN_TYPES.indexOf(i.type) < 0);
      } else if (types.length) {
        // 多类型合并格：展示 types 数组内任意一种类型的帖子
        list = list.filter((i) => types.indexOf(i.type) >= 0);
      }
      // kk.id === 'ai' 等无 types 特殊入口 → 不筛帖子，保留全部
    }

    const tab = this.data.activeTab;
    if (tab === 'face') list = list.filter((i) => i.faceTalk);
    else if (tab === 'cheap') list = list.filter((i) => i.rentLow);

    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    this.setData({ goodsLeft: left, goodsRight: right });
  },

  // ---------- 交互 ----------
  onEntry(e) {
    const key = e.currentTarget.dataset.id;
    // 招聘求职：进独立招聘求职频道页（recruit 页已支持 全部/招聘/求职 三态切换）
    if (key === 'recruit_jobseek') {
      wx.navigateTo({ url: '/pages/recruit/recruit' });
      return;
    }
    // 顺风车：独立入口，暂无对应数据类型，点击占位提示（后续接频道页再改）
    if (key === 'carpool') {
      wx.showToast({ title: '顺风车功能待接入', icon: 'none' });
      return;
    }
    // AI 顾问：特殊入口（待接入）
    if (key === 'ai') {
      wx.showToast({ title: 'AI 顾问待接入', icon: 'none' });
      return;
    }
    // 其余金刚位（转让求店/二手设备/其他）→ 首页内按对应类型组筛选
    // 再次点击当前已激活的金刚位 → 取消筛选，回到全部
    const next = key === this.data.activeGroup ? '' : key;
    this.setData({ activeGroup: next });
    this.renderList();
  },

  onTab(e) {
    const key = e.detail.value;
    if (key === 'nearby') {
      wx.showToast({ title: '同城需授权定位，待接入', icon: 'none' });
      return;
    }
    this.setData({ activeTab: key });
    this.renderList();
  },

  onTabBar(e) {
    const key = e.detail.value;
    if (key === 'publish') {
      this.openPublishSheet();
      this.setData({ activeBar: 'home' });
      return;
    }
    // 测试入口：点底部"消息"直接弹订阅授权（由用户点击直接触发，验证订阅是否能弹出）
    if (key === 'message') {
      this.setData({ activeBar: 'home' });
      this.testSubscribeFromMessage();
      return;
    }
    this.setData({ activeBar: key });
  },

  // 测试：底部"消息"点击 → 直接 wx.requestSubscribeMessage，验证订阅框能否由用户手势弹出
  testSubscribeFromMessage() {
    if (!SUB_TMPL_IDS.length) {
      wx.showToast({ title: '未配置订阅模板 ID', icon: 'none' });
      return;
    }
    console.log('[demo] 点消息 → requestSubscribeMessage, tmplIds=', SUB_TMPL_IDS);
    wx.requestSubscribeMessage({
      tmplIds: SUB_TMPL_IDS,
      success: (res) => {
        // res[id] === 'accept' / 'reject'；若没弹窗而直接给 accept/reject，说明之前勾过"不再询问"
        console.log('[demo] requestSubscribeMessage success, res=', JSON.stringify(res));
        const accepted = SUB_TMPL_IDS.some((id) => res && res[id] === 'accept');
        wx.showToast({ title: accepted ? '已授权(accept)' : '订阅结果:reject', icon: accepted ? 'success' : 'none' });
        if (accepted) this.sendTestSubscribe();
      },
      fail: (err) => {
        // errCode：可区分"用户取消/此前拒绝/参数错误"等
        console.warn('[demo] requestSubscribeMessage fail:', JSON.stringify(err || ''));
        wx.showToast({ title: (err && err.errMsg) || '订阅失败', icon: 'none' });
      },
    });
  },

  onTopTab(e) {
    const key = e.detail.value;
    if (key === this.data.activeTopTab) return;
    this.setData({ activeTopTab: key });
    wx.showToast({ title: `${key} 视图待接入`, icon: 'none' });
  },

  // t-tabs 内部 t-sticky 的 scroll 事件：detail = { scrollTop, isFixed }
  onTabsScroll(e) {
    const isFixed = e.detail.isFixed;
    if (isFixed !== this.data.tabsSticky) {
      this.setData({ tabsSticky: isFixed });
    }
  },

  // ---------- 发布类型选择（TDesign t-popup + t-grid） ----------
  // Header「发布」按钮 / Banner「免费发布」/ 底部 TabBar「发布」三个入口统一走这里
  openPublishSheet() {
    this.setData({ publishSheetVisible: true });
  },

  // t-popup 的 visible-change：点遮罩/关闭时 detail.visible = false
  onPublishSheetClose(e) {
    if (!e.detail.visible) {
      this.setData({ publishSheetVisible: false });
    }
  },

  // t-grid-item 的 click 事件：e.detail 就是 data-item 绑定的整个类型对象
  // 流程：选类型 → 关闭发布弹层 → 静默建号 → 弹手机号授权 → 订阅消息授权 → 进发布表单
  onPickPublishType(e) {
    const type = e.detail;
    this.setData({ publishSheetVisible: false, pendingPublishType: type });
    this.startPublishAuth();
  },

  // ---------- 登录 / 发布授权链路 ----------
  // 统一入口：点发布(选类型)后先走"静默建号 → 手机号授权 → 订阅消息"，都完成后才进入发布表单
  async startPublishAuth() {
    if (this.data.authing) return;
    this.setData({ authing: true });
    try {
      // 1) 静默建号：openid 无感登录（无弹窗）。云端已建过则直接返回。
      const login = await this.ensureLogin();
      if (!login || !login.success) {
        wx.showToast({ title: (login && login.error) || '登录失败，请重试', icon: 'none' });
        return;
      }
      // 2) 手机号授权：未绑定过 → 弹授权层；已绑定 → 直接进订阅授权
      if (!login.phone_verified) {
        this.setData({ phoneAuthVisible: true });
        return; // 手机号授权完成回调(onGetPhoneNumber)里继续走订阅
      }
      // 3) 已绑手机号 → 直接订阅授权并收尾
      this.doSubscribeAndFinish();
    } finally {
      this.setData({ authing: false });
    }
  },

  // 静默建号（openid → baozi_users），结果缓存到 this._user
  ensureLogin() {
    return wx.cloud
      .callFunction({ name: 'getOrCreateUser', data: {}, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success) {
          this._user = r.user;
          return { success: true, phone_verified: r.user && r.user.phone_verified };
        }
        console.error('[demo] getOrCreateUser 失败:', r.error);
        return r;
      })
      .catch((err) => {
        console.error('[demo] getOrCreateUser 调用失败:', err && err.errMsg);
        return { success: false, error: '网络异常，请重试' };
      });
  },

  // 手机号授权：button open-type="getPhoneNumber" 触发；e.detail.code 为临时凭证，由云函数解密
  onGetPhoneNumber(e) {
    const code = e.detail && e.detail.code;
    if (!code) {
      // 用户拒绝授权（或该能力未开通）
      wx.showToast({ title: '需授权手机号才能发布，可稍后在我的页补', icon: 'none' });
      this.setData({ phoneAuthVisible: false });
      return;
    }
    wx.showLoading({ title: '绑定中...', mask: true });
    wx.cloud
      .callFunction({ name: 'getOrCreateUser', data: { phoneCode: code }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success && r.phone_bound) {
          console.log('[demo] 手机号绑定成功，立即进入 doSubscribeAndFinish(不再 setTimeout，保证订阅在用户手势链路内触发)');
          this._user = Object.assign(this._user || {}, { phone_verified: true, phone_masked: r.user && r.user.phone_masked });
          this.setData({ phoneAuthVisible: false });
          wx.showToast({ title: '手机号已绑定', icon: 'success' });
          // 立即（同步）调订阅授权并收尾 —— requestSubscribeMessage 需在用户点击同一事件栈内调用才会弹窗
          this.doSubscribeAndFinish();
        } else {
          wx.showToast({ title: r.error || '绑定失败，请重试', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.showToast({ title: '绑定失败，请重试', icon: 'none' });
        console.error('[demo] 绑定手机号失败:', err && err.errMsg);
      })
      .finally(() => wx.hideLoading());
  },

  // 订阅消息授权（实时提醒：发布成功/有人联系等），无模板则跳过；不强制，拒绝仍可发布
  doSubscribeAndFinish() {
    const type = this.data.pendingPublishType;
    console.log('[demo] doSubscribeAndFinish 进入, SUB_TMPL_IDS.length=', SUB_TMPL_IDS.length);
    const finish = () => {
      this.setData({ pendingPublishType: null });
      wx.showToast({ title: type ? `发布「${type.name}」表单待接入` : '发布表单待接入', icon: 'none' });
    };
    if (!SUB_TMPL_IDS.length) {
      // 未配模板 ID → 跳过订阅，直接收尾
      console.log('[demo] 无模板 ID，跳过订阅授权');
      finish();
      return;
    }
    console.log('[demo] 即将调用 wx.requestSubscribeMessage');
    wx.requestSubscribeMessage({
      tmplIds: SUB_TMPL_IDS,
      success: (res) => {
        // 判断用户是否接受了订阅；accept 才发模板消息，否则只是不弹通知、不阻塞发布
        const accepted = SUB_TMPL_IDS.some((id) => res && res[id] === 'accept');
        console.log('[demo] requestSubscribeMessage success, accepted=', accepted, 'res=', JSON.stringify(res));
        // 无论是否同意都放行进入发布
        finish();
        if (accepted) {
          // 已订阅 → 调 sendSubscribeMsg 发一条"发布成功/未读提醒"测试订阅，验证端到端通路
          this.sendTestSubscribe(type);
        }
      },
      fail: (err) => {
        // 用户拒绝/系统异常：不阻塞发布。打印错误以便定位为何没弹订阅框
        console.warn('[demo] requestSubscribeMessage fail:', err && err.errMsg, JSON.stringify(err || ''));
        finish();
      },
    });
  },

  // 端到端验证：授权接受后发一条"消息未读提醒"测试订阅（验证模板字段、openapi 权限是否打通）
  // 真实业务接入发布表单后，改为在"信息已发布/审核通过"等真实节点触发
  sendTestSubscribe(type) {
    wx.cloud
      .callFunction({
        name: 'sendSubscribeMsg',
        data: {
          templateId: SUB_TMPL_IDS[0], // 消息未读提醒
          content: type ? `您已成功发布「${type.name}」信息` : '您有一条新的未读消息',
          time: '2026-09-02 12:00',
          remark: '可在小程序内查看详情',
        },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) {
          wx.showToast({ title: '已开启实时提醒', icon: 'success' });
        } else {
          console.warn('[demo] sendSubscribeMsg 发送失败:', r.error);
          // 不打断发布；发送失败多半是模板字段名与后台不符，属测试期已知项
        }
      })
      .catch((err) => {
        console.warn('[demo] sendSubscribeMsg 调用异常:', err && err.errMsg);
      });
  },

  // t-popup(手机号授权层) 的 visible-change：点遮罩关闭时不放行进表单，仅收起
  onPhoneAuthClose(e) {
    if (!e.detail.visible) {
      this.setData({ phoneAuthVisible: false, pendingPublishType: null });
    }
  },

  // t-button 发布按钮（click 事件）
  onPublish() {
    this.openPublishSheet();
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    // Banner「免费发布」
    if (id === 'publish') {
      this.openPublishSheet();
      return;
    }
    wx.showToast({ title: '帖子详情待接入', icon: 'none' });
  },
});
