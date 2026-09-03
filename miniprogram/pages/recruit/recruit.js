// pages/recruit/recruit.js
// 包子行业信息平台 · 招工频道页（TDesign）
// 数据源：feedPosts 云函数（dataType = 'recruit'）
//
// 【广告位约定】
//   ads / banners / stats 三个运营位默认是空数组。
//   空数组时 wxml 里整块 wx:if 不渲染 —— 不留空白、不留占位灰块。
//   后续接入数据库 / 运营后台后，把数据灌进这三个数组即可自动显示，
//   无需改动任何 wxml。见下方 loadAdSlots()。

const regionData = require('../../utils/regionData.js');
const privacy = require('../../utils/privacy.js');

// 招工细分品类（金刚位 · 师傅类型）
// 字段说明：
//   id     —— 前端英文标识（仅作 wx:key 与事件定位，不参与筛选）
//   roleId —— 稳定的"角色 ID"数字映射（1-14），入库时写进帖子 role_id 字段，
//             筛选时用 role_id 精确匹配数据库（比中文名稳定，改名不失效）
//   name   —— 师傅类型中文名（展示用，同时写进帖子 role 字段）
//   kw     —— 兜底关键词：命中 role 或 raw_text 任一关键词即算该品类；空数组 = 不筛选
// 历史脏数据兼容：售卖→售卖员(roleId 4)、二把刀→二把手(roleId 12)，迁移时归并到正确 role_id
// TODO: 后续改为从数据库读取品类表，届时只需替换 SUB_CATS 的数据来源
const SUB_CATS = [
  { id: 'master',     roleId: 1,  name: '大师傅',       emoji: '👨‍🍳', bg: '#FFF1E8', kw: ['大师傅'] },
  { id: 'relief',     roleId: 2,  name: '短期顶班',     emoji: '⏱️',   bg: '#FFF7E6', kw: ['顶班', '短期'] },
  { id: 'couple',     roleId: 3,  name: '夫妻工',       emoji: '👫',   bg: '#FFE9E9', kw: ['夫妻工', '夫妻'] },
  { id: 'seller',     roleId: 4,  name: '售卖员',       emoji: '🛎️',   bg: '#E6FFFB', kw: ['售卖', '收银', '服务员'] },
  { id: 'apprentice', roleId: 5,  name: '学徒工',       emoji: '🙋',   bg: '#F9F0FF', kw: ['学徒'] },
  { id: 'xiaolong',   roleId: 6,  name: '小笼包师傅',   emoji: '🥟',   bg: '#E8F6FF', kw: ['小笼包', '灌汤包'] },
  { id: 'bing',       roleId: 7,  name: '饼类师傅',     emoji: '🥞',   bg: '#F6FFED', kw: ['饼类', '酱香饼', '千层饼'] },
  { id: 'zha',        roleId: 8,  name: '油炸类师傅',   emoji: '🍤',   bg: '#FFFBE6', kw: ['油炸', '麻球', '油条'] },
  { id: 'zhong',      roleId: 9,  name: '中工',         emoji: '🔪',   bg: '#F0F5FF', kw: ['中工', '擀皮'] },
  { id: 'shengjian',  roleId: 10, name: '生煎类师傅',   emoji: '🥠',   bg: '#FAFAFA', kw: ['生煎'] },
  // —— 以下为数据库实际存在但前端原缺的类型，金刚位"展开全部"后可见 ——
  { id: 'master_all', roleId: 11, name: '全能面点大师', emoji: '🌟',   bg: '#FFF1E8', kw: ['全能面点', '全能'] },
  { id: 'erba',       roleId: 12, name: '二把手',       emoji: '🪜',   bg: '#FFF7E6', kw: ['二把手', '二把刀'] },
  { id: 'factory',    roleId: 13, name: '工厂',         emoji: '🏭',   bg: '#E6FFFB', kw: ['工厂'] },
  { id: 'other',      roleId: 14, name: '其他类型',     emoji: '📦',   bg: '#FAFAFA', kw: [] },
];

// 金刚位默认露出的数量（column=5，前 9 个 + 第 10 格"更多"按钮 = 共 10 格 = 两行）
// 点"更多"后下方展示剩余 5 个（生煎类/全能/二把/工厂/其他）
const DEFAULT_VISIBLE_SUB = 4;

// 信用评分等级：1优秀 / 2极好 / 3良好 / 4一般；label 展示文案 + color 文字色 + bg 标签底色
const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
};

// 高薪阈值（元/月），工资筛选未设置时用于"高薪"标记
const HIGH_PAY = 8000;

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

function findCat(id) {
  for (let i = 0; i < SUB_CATS.length; i += 1) {
    if (SUB_CATS[i].id === id) return SUB_CATS[i];
  }
  return null;
}

Page({
  data: {
    subCats: SUB_CATS,
    // 金刚位实际渲染的品类：默认只露出前 4 个师傅类型，第 5 格是"更多类型"按钮（一行共 5 格）
    visibleSubCats: SUB_CATS.slice(0, DEFAULT_VISIBLE_SUB),
    // 默认隐藏、点"更多类型"后展示在网格下方的剩余品类
    extraSubCats: SUB_CATS.slice(DEFAULT_VISIBLE_SUB),
    // 是否已展开全部品类（控制第 5 格"更多类型"按钮文案为"更多/收起"）
    subExpanded: false,
    activeSub: '',
    keyword: '',

    // ---------- 信息类别（招聘/求职 多选卡片，t-checkbox-group） ----------
    // typeCards: 三张卡(招聘/求职/会员)。member 是占位入口，不参与筛选：
    //   onTypeChange 会把它从 selectedTypes 里过滤掉，勾不勾都不改变查询、不触发重查。
    // selectedTypes: 真正驱动数据源的勾选数组(只会含 recruit/jobseek)。
    //   从 demo 金刚位进入时默认空(selectedTypes=[])= 不限定 → 招聘+求职混排全看；
    //   勾选"招聘/求职"后才收窄为只看对应类型。
    typeCards: [
      { value: 'recruit', label: '招聘', desc: '老板招人' },
      { value: 'jobseek', label: '求职', desc: '师傅找活' },
      { value: 'member', label: '会员', desc: '会员专区' },
    ],
    selectedTypes: [],
    emptyText: '暂无招聘/求职信息', // 空态文案（随信息类别变化）


    // ---------- 运营位：默认空数组 → 整块不渲染 ----------
    ads: [],      // 轮播图  [{ value: 'https://...', path: '/pages/...' }]
    banners: [],  // 双卡位  [{ id, emoji, title, sub, bgFrom, bgTo, path }]
    stats: [],    // 数字卡  [{ id, value, label }]
    // 轮播指示器配置（放在 data 里，避免 Mustache 内写对象字面量的兼容风险）
    swiperNav: { type: 'dots' },

    // ---------- 师傅类型（顶部下拉，与金刚位 activeSub 联动） ----------
    // '__all__' 表示"全部"，选中后清空 activeSub 不筛选；具体 id 走 findCat 筛选
    subOptions: [{ label: '全部师傅', value: '__all__' }].concat(
      SUB_CATS.map((c) => ({ label: c.name, value: c.id }))
    ),
    subPick: '',           // 师傅类型选中值(已生效)：''=未选(显示"师傅类型")
    subLabel: '师傅类型',   // 师傅类型下拉标题文案
    subDraftPick: '',      // 单选列表草稿值，点"确定"后写入 subPick

    // ---------- 区域（t-cascader） ----------
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',          // 当前已选展示文本，例"广东/深圳"，空 = 未选
    regionCode: '',          // 当前已选市级行政区划 code（用于数据库精确匹配）
    // 区域下拉内"常用城市"快捷标签（含市级 code，点选后用 code 精确匹配数据库）
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

    // ---------- 薪资（下拉内输入，单一最低薪资） ----------
    salary: '',              // 最低薪资（元/月）
    // 菜单标题上的展示文案（必须是 data 属性，wxml 读不到 Page 方法）
    salaryLabel: '工资',
    // 强制重建 t-input 的 key：重置时自增，让组件用空 prop 重新初始化
    salaryInputKey: 0,

    goodsLeft: [],
    goodsRight: [],
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

    // ---------- 筛选条吸顶（t-sticky） ----------
    // t-sticky 吸顶时距页面顶部距离(px)：无自定义导航栏，直接吸顶到顶部
    stickyTop: 0,
    // 是否处于吸顶态：吸顶后给筛选条加纯白底+阴影，避免内容透出
    tabsSticky: false,
    // 筛选条 + 信息类别卡片整体显示开关：打开"查看完整省市区"弹层时隐藏以避免遮挡
    filterBarVisible: true,
  },

  onLoad() {
    this._all = [];
    // 详情缓存池(内存)：key=帖子 id(_id)，value=feedPosts 下发的原始帖子对象(白名单快照)。
    // 从 storage 恢复上次已浏览的帖子，列表点详情可直接命中、零二次云请求。
    this._detailPool = {};
    try {
      const cached = wx.getStorageSync('detail_pool');
      if (cached && typeof cached === 'object') this._detailPool = cached;
    } catch (e) {
      // 无缓存/异常直接忽略，详情走兜底查库
    }
    this.loadFeed();
    this.loadAdSlots();
  },

  onPullDownRefresh() {
    Promise.all([this.loadFeed(), this.loadAdSlots()]).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 触底加载更多：页码 +1 追加下一页
  onReachBottom() {
    this.loadMore();
  },

  // t-sticky 吸顶状态：detail = { scrollTop, isFixed }
  // 吸顶(isFixed=true)时给筛选条加白底+阴影，避免下方内容透出
  onStickyScroll(e) {
    const isFixed = !!(e && e.detail && e.detail.isFixed);
    if (isFixed !== this.data.tabsSticky) {
      this.setData({ tabsSticky: isFixed });
    }
  },

  // ---------- 数据源 ----------
  // 信息类别由横向卡片多选 selectedTypes 决定，并与师傅类型/区域/工资联动：
  //   - 只要勾选了 'recruit'（含纯招聘 与 招聘+求职混排）→ 都把师傅类型(role_id)/区域(city_code)/薪资(salary)
  //     传给 feedPosts，对"招聘"内容过滤；
  //     若同时勾了 jobseek，云函数用 OR：求职帖不受招工维度筛选影响（见 feedPosts）。
  //   - 仅勾 'jobseek' → 单查求职，不带招工维度库筛选（求职帖字段未规范暂缺）
  //   - 全不勾 → 两类混排，不做库筛选（=全部浏览）
  // extra.page 控制分页；返回 { list, hasMore } 供分页追加/判断是否还有更多
  fetchFeed(extra) {
    const sel = Array.isArray(this.data.selectedTypes) ? this.data.selectedTypes : [];
    const hasRecruit = sel.indexOf('recruit') >= 0;
    const hasJobseek = sel.indexOf('jobseek') >= 0;
    // 招聘/求职现在都有 role_id/city_code/salary 字段：三个筛选参数**无论信息类别如何选都传给云端**，
    // 由云函数对当前选中类型统一 AND 过滤（不再豁免/丢弃），保证工资/区域/师傅类型对两类都生效。
    const data = {
      page: (extra && extra.page) || 1,
      pageSize: (extra && extra.pageSize) || this.data.pageSize || 20,
      salary: extra && extra.salary,
      city_code: extra && extra.city_code,
      role_id: extra && extra.role_id,
    };
    if (hasRecruit && hasJobseek) {
      data.dataTypes = ['recruit', 'jobseek'];
    } else if (hasRecruit) {
      data.dataType = 'recruit';
    } else if (hasJobseek) {
      data.dataType = 'jobseek';
    } else {
      // 全不勾 = 两类都看
      data.dataTypes = ['recruit', 'jobseek'];
    }
    console.log('[recruit] feedPosts 请求参数 =', JSON.stringify(data), '| extra =', JSON.stringify(extra));
    return wx.cloud
      .callFunction({
        name: 'feedPosts',
        data,
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[recruit] feedPosts 返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[recruit] feedPosts 调用失败:', err && err.errMsg);
        return null;
      });
  },

  // 首屏 / 筛选 / 下拉刷新：从第 1 页重拉并整块替换（列表区切骨架屏）
  async loadFeed(extra) {
    // 进入加载态 → 列表区切骨架屏（首屏 & 筛选/刷新统一走这里）
    this.setData({ loading: true, loadingMore: false });
    const r = await this.fetchFeed(extra);
    const list = (r && r.list) || [];
    // 只走真实数据库：云函数失败返回 null → 用空列表显示空态（不回退 mock）
    // 原始帖子对象(raw)缓存到详情池，供详情页复用；展示走 decorate。
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

  // 触底加载更多：页码 +1 拉下一页，追加到现有列表；不切骨架屏，底部显示局部 loading
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
    this.setData({
      page: nextPage,
      hasMore: !!(r && r.hasMore),
      loadingMore: false,
    });
    this.renderList();
  },

  // 把本次拉到帖子的**原始对象**(feedPosts 白名单快照)按 id 写入本页内存池 + storage。
  // 详情页点卡片时用这份原始数据重新 decorate(与列表处理同一原始对象，语义一致) → 零二次云调用。
  // 缓存未命中(分享/收藏直达)详情页再兜底调 managePost(detail) 查库一次。
  // storage 用 LRU 上限，防止越积越多。
  cacheDetails(rawItems) {
    if (!Array.isArray(rawItems)) return;
    const map = this._detailPool || {};
    rawItems.forEach((p) => {
      if (p && p._id) map[p._id] = p;
    });
    // 内存池上限：只保留最近 200 条，防止无限膨胀
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.slice(0, keys.length - 200).forEach((k) => delete map[k]);
    }
    this._detailPool = map;
    try {
      wx.setStorage({
        key: 'detail_pool',
        data: map,
      });
    } catch (e) {
      // storage 满/异常时静默降级：详情页会走兜底查库
    }
  },

  // 组装当前所有筛选条件（师傅类型/区域/薪资），供 loadFeed 与 loadMore 复用
  buildFilter() {
    const extra = {};
    // 师傅类型：用 SUB_CATS 找到稳定的角色 ID（数据库 role_id 字段）；'__all__'/空 = 不筛选
    const sub = this.data.activeSub;
    if (sub) {
      const cat = findCat(sub);
      if (cat && cat.roleId) extra.role_id = cat.roleId;
    }
    if (this.data.regionCode) extra.city_code = this.data.regionCode;
    if (this.data.salary) extra.salary = Number(this.data.salary);
    return extra;
  },

  // 三个筛选条件任意变化时统一调用：从 data 取当前所有筛选条件，重新走数据库
  // 师傅类型(activeSub→role_id)、区域(regionCode)、薪资(salary) 全部传 feedPosts 后端过滤
  reloadWithFilters() {
    this.loadFeed(this.buildFilter());
  },

  // ---------- 运营位（广告 / Banner / 数字卡） ----------
  // 现在没有数据源，三个数组都返回空 → 页面上这三块完全不渲染。
  // TODO: 接入数据库后改成拉取运营位集合，例如：
  //   const res = await wx.cloud.callFunction({ name: 'adSlots', data: { page: 'recruit' } });
  //   return res.result || { ads: [], banners: [], stats: [] };
  // 只有拉到的数组非空，对应区块才会出现。
  loadAdSlots() {
    return Promise.resolve({ ads: [], banners: [], stats: [] }).then((d) => {
      this.setData({
        ads: d.ads || [],
        banners: d.banners || [],
        stats: d.stats || [],
      });
    });
  },

  // ---------- 展示 ----------
  // 招聘/求职卡片**结构完全一致**，只是取值参数不同（对齐"招聘展示什么，求职就展示什么"）：
  //   - 角色   ：招聘 = 要招的岗位 role；求职 = 求职者的师傅类型 role
  //   - 薪资   ：招聘 = 给价 salary；求职 = 期望薪资 salary_expect（文本加"期望"前缀）
  //   - 标签   ：招聘 = role + 工作条件 tags；求职 = role + 求职诉求 want_terms(精简)，不再整段塞 service_area
  //   - 地区时间/发布人/信用：两类一致
  decorate(p) {
    const isJobseek = p.data_type === 'jobseek';
    const loc = [p.province, p.city, p.district].filter(Boolean).join('');
    const raw = String(p.raw_text || '').trim();           // 原文：内部检索/筛选用(不直接展示)
    const rawShow = privacy.maskText(raw);                 // 脱敏后文本：列表 title 展示，防原文藏电话泄露
    const typeName = isJobseek ? '求职' : '招工';
    const color = isJobseek ? '#9254DE' : '#597EF7';
    const light = isJobseek ? '#F9F0FF' : '#F0F5FF';
    const emoji = isJobseek ? '🙋' : '👨';

    // 标题：展示用脱敏后的原文(过长截断)；无原文时用"地区+角色"兜底，语义区分招/求职
    const roleName = p.role || (isJobseek ? '师傅' : '招师傅');
    const title = rawShow
      ? (rawShow.length > 30 ? rawShow.slice(0, 30) + '…' : rawShow)
      : `${loc || '全国'}${isJobseek ? (roleName + '求职') : roleName}`;

    // 薪资文本：语义不同 —— 招聘=给价 salary；求职=期望 salary_expect(优先)/salary
    let priceText;
    if (isJobseek) {
      const exp = Number(p.salary_expect) > 0 ? Number(p.salary_expect) : Number(p.salary) || 0;
      priceText = exp > 0 ? `期望 ${exp} 元/月` : '期望面议';
    } else {
      priceText = Number(p.salary) > 0 ? `${Number(p.salary)} 元/月` : '面议';
    }

    // 标签：招聘=role + 工作条件 tags；求职=role + 求职诉求 want_terms(精简截取) + 到岗方式
    const tags = [];
    if (p.role && tags.indexOf(p.role) < 0) tags.push(p.role);
    if (isJobseek) {
      (Array.isArray(p.want_terms) ? p.want_terms : []).forEach((t) => {
        if (t && tags.indexOf(t) < 0 && tags.length < 3) tags.push(t);
      });
      if (p.availability && tags.length < 3 && tags.indexOf(p.availability) < 0) tags.push(p.availability);
    } else {
      (Array.isArray(p.tags) ? p.tags : []).forEach((t) => {
        if (t && tags.indexOf(t) < 0 && tags.length < 3) tags.push(t);
      });
    }
    if (!tags.length) tags.push(typeName);

    // 高薪判断：求职用期望薪资，招聘用薪资
    const top = Number(p.salary_expect) > 0 ? Number(p.salary_expect) : Number(p.salary) || 0;

    return {
      id: p._id,
      data_type: p.data_type || '',
      title,
      priceText,
      tags,
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      ts: p.published_at || 0,
      faceTalk: /面议/.test(priceText),
      highPay: top >= HIGH_PAY,
      // 原始数值（用于工资筛选）
      salary: Number(p.salary) || 0,
      // 城市（用于区域筛选；用 city_code 精确匹配数据库）
      city: p.city || '',
      city_code: p.city_code || '',
      // 发布者昵称/称呼（为空则不展示发布人）
      username: p.username || '',
      // 信用评分（1优秀/2极好/3良好/4一般）；0/非法 → 不显示信用标签
      credit: Number(p.credit) || 0,
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      // 品类筛选检索串
      haystack: `${p.role || ''} ${raw}`,
      // 卡片视觉
      emoji,
      image: p.image || '',   // 有图才渲染图片区
      color,
      light,
      typeName,
      // 注：详情数据不在此冗余携带——详情页点卡片时直接从 detail_pool 缓存取
      //     原始帖子对象(feedPosts 白名单快照)自行展示，避免卡片对象内存膨胀。
    };
  },

  renderList() {
    let list = this._all;

    // 细分品类筛选
    const sub = this.data.activeSub;
    if (sub) {
      const cat = findCat(sub);
      if (cat && cat.kw.length) {
        list = list.filter((i) => {
          for (let k = 0; k < cat.kw.length; k += 1) {
            if (i.haystack.indexOf(cat.kw[k]) >= 0) return true;
          }
          return false;
        });
      }
    }

    // 关键词搜索
    const kw = String(this.data.keyword || '').trim();
    if (kw) {
      list = list.filter((i) => i.title.indexOf(kw) >= 0 || i.haystack.indexOf(kw) >= 0);
    }

    // 薪资已改走数据库查询（feedPosts 带 salary 下限），此处不再本地过滤

    // 区域：用市级行政区划 code(city_code) 精确匹配数据库，避免城市名带不带"市"的歧义
    const regCode = this.data.regionCode;
    if (regCode) {
      const before = list.length;
      list = list.filter((i) => i.city_code === regCode);
      console.log('[区域-筛选] regionCode =', regCode, '| 筛选前', before, '条 → 命中', list.length, '条 | _all中首个city_code =', this._all.length ? this._all[0].city_code : '(空)');
    }

    const left = [];
    const right = [];
    list.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    // 空态文案随信息类别变化（招聘/求职/全部）
    const sel = this.data.selectedTypes;
    const onlyRecruit = Array.isArray(sel) && sel.length === 1 && sel[0] === 'recruit';
    const onlyJobseek = Array.isArray(sel) && sel.length === 1 && sel[0] === 'jobseek';
    const emptyText = onlyRecruit ? '暂无招聘信息' : onlyJobseek ? '暂无求职信息' : '暂无招聘/求职信息';
    this.setData({ goodsLeft: left, goodsRight: right, emptyText });
  },

  // ---------- 交互 ----------
  // 金刚位第 10 格"更多/收起"按钮：切换 extraSubCats 的展示
  // 前 9 个品类位置不变；展开后下方额外显示剩余 5 个（生煎类/全能/二把/工厂/其他）
  toggleSubExpand() {
    this.setData({ subExpanded: !this.data.subExpanded });
  },

  // t-grid-item 的 click：e.detail 就是 data-item 绑定的整个品类对象
  onSubCat(e) {
    // t-grid-item 的 click：优先用 e.detail(绑定的 item 对象)；兜底用 currentTarget.dataset.item
    const cat = (e && (e.detail || e.currentTarget.dataset.item)) || {};
    // 再点一次已选中的品类 → 取消筛选；'other' 无关键词 = 直接看全部
    const next = cat.id === this.data.activeSub ? '' : cat.id;
    const catObj = next ? findCat(next) : null;
    // 金刚位点击时同步"师傅类型"下拉的标题(subLabel)、选中值(subPick/subDraftPick)
    this.setData({
      activeSub: next,
      subPick: next || '',
      subDraftPick: next || '',
      subLabel: next ? (catObj ? catObj.name : cat.name) : '师傅类型',
    }, () => this.refreshSubLabel());
    // 师傅类型变化 → 走数据库查询（区域、薪资保留）
    this.reloadWithFilters();
  },

  // 强制刷新"师傅类型"下拉标题：dropdown-menu 用 getAllItems 收集子项 label，
  // setData 改 label 后主动调用一次，确保标题即时变为当前师傅类型
  refreshSubLabel() {
    const menu = this.selectComponent('#topDropdownMenu');
    if (menu && typeof menu.getAllItems === 'function') menu.getAllItems();
  },

  // ---------- 信息类别（招聘/求职 多选卡片，t-checkbox-group） ----------
  // value = 勾选数组(selectedTypes)。多选语义：
  //   勾"招聘" → 看招聘；勾"求职" → 看求职；两者都勾 → 全部混排；
  //   全不勾时自动回到两类全看，保证信息类别至少保留一类（fetchFeed 对空数组也按混排处理）
  // 事件源：e.detail.value = 勾选值数组（checkbox-group 受控，必须写回 selectedTypes）
  onTypeChange(e) {
    let sel = (e.detail && e.detail.value) || [];
    if (!Array.isArray(sel)) sel = [];
    // "会员"等占位项不参与筛选：只保留 recruit/jobseek 进 selectedTypes
    const types = sel.filter((v) => v === 'recruit' || v === 'jobseek');
    // 会员勾选不会改变 recruit/jobseek 组合 → 仅更新展示、不触发重查(返回空即不影响)
    const prev = this.data.selectedTypes || [];
    const same = types.length === prev.length && types.every((v) => prev.indexOf(v) >= 0);
    this.setData({ selectedTypes: types });
    if (!same) this.reloadWithFilters();
  },

  // ---------- 师傅类型（t-dropdown-item 单选列表，点击即选即生效） ----------
  // 下拉打开：草稿值初始化为当前选中
  onSubDropdownOpen() {
    this.setData({ subDraftPick: this.data.subPick });
  },
  // 点单选项：即选即生效，更新草稿+应用选择+关闭下拉
  onSubRowTap(e) {
    const v = (e.currentTarget.dataset || {}).value || '';
    this.setData({ subDraftPick: v });
    this.applySubSelection(v);
    this.closeSubDropdown();
  },
  // 关闭师傅类型下拉
  closeSubDropdown() {
    const item = this.selectComponent('#subDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  // 统一应用师傅类型选择：更新 subPick/subLabel/activeSub
  applySubSelection(v) {
    const isAll = v === '__all__';
    const cat = !isAll && v ? findCat(v) : null;
    const label = isAll ? '全部师傅' : cat ? cat.name : '师傅类型';
    this.setData({
      subPick: isAll ? '__all__' : v,
      subLabel: label,
      activeSub: isAll || !cat ? '' : v,
    }, () => this.refreshSubLabel());
    // 师傅类型变化 → 走数据库查询（区域、薪资保留）
    this.reloadWithFilters();
  },

  // ---------- 区域（下拉内快捷城市 + t-cascader） ----------
  // 区域 dropdown 展开时触发（无需额外动作，快捷城市即时可见）
  onRegionDropdownOpen() {},
  // 点常用城市快捷标签：直接作为市级筛选，用市级 code 精确匹配数据库
  // t-tag 的 click 事件 detail 是事件对象，城市名/码从 data-name / data-code 读取
  onHotCity(e) {
    const ds = (e.currentTarget && e.currentTarget.dataset) || {};
    const name = ds.name;
    const code = ds.code;
    console.log('[区域-热门城市] dataset =', ds, '| name =', name, '| code =', code);
    if (!name || !code) return;
    this.setData({ regionPick: name, regionCode: String(code) });
    // 任意筛选变化 → 走 reloadWithFilters，保留师傅类型/薪资
    this.reloadWithFilters();
    // 即选即生效，关闭区域下拉
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  // "选择完整省市区"入口：先关闭 dropdown 弹层，再打开 t-cascader；同时
  // 隐藏顶部筛选条 + 信息类别卡片，避免被 t-cascader 弹层遮挡(由用户提议)
  openCascader() {
    // 关闭区域 dropdown-item（selectComponent 拿实例调用 closeDropdown）
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
    this.setData({ regionVisible: true, filterBarVisible: false });
  },
  // t-cascader 内部 popup 关闭时触发的事件名是 close（不是 visible-change）
  // 选完省市区可能走 onRegionChange 关闭，也可能用户点 X / 外部触发 close —— 都恢复筛选条
  onRegionClose() {
    this.setData({ regionVisible: false, filterBarVisible: true });
  },
  // 区域重置：清空已选区域并刷新列表（含常用城市快捷选中与 cascader 选中），然后关闭下拉
  onRegionReset() {
    this.setData({ regionPick: '', regionCode: '' });
    // 重置走 reloadWithFilters：保留师傅类型/薪资，仅清掉 city_code
    this.reloadWithFilters();
    // 即选即生效后关闭区域下拉（与常用城市点击行为一致）
    const item = this.selectComponent('#regionDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  // t-cascader 选中任一级触发 bind:pick：{ value, label, index, level }
  // 1.16.0 在 handleSelect 里触发；此处仅记录高亮，最终提交走 onRegionChange
  onRegionPick(e) {
    // 可选:用于实时反馈选中了哪一级;当前筛选按城市粒度,交由 change 统一处理
  },
  // t-cascader 选完触发 bind:change：{ value, selectedOptions }
  // 注意：value 是最终选中叶子节点的 value(单个 string/number)，不是数组！
  //      selectedOptions 是 [{label,value}] 对象数组，index 0 省 / 1 市 / 2 区
  // 取市级行政区划 code：取第 2 级(index 1)的 value；直辖市(北京/上海等)同样 index 1 是市级
  onRegionChange(e) {
    const opts = e.detail.selectedOptions || [];
    const text = opts.map((o) => o.label).join('/');
    const cityOpt = opts[1] || opts[0] || {};
    const cityCode = cityOpt.value != null ? String(cityOpt.value) : '';
    console.log('[区域-cascader] e.detail =', e.detail, '| opts =', opts, '| cityCode =', cityCode, '| text =', text);
    // 关闭 cascader 并恢复筛选条 + 信息类别卡片
    this.setData({ regionPick: text, regionCode: cityCode, regionVisible: false, filterBarVisible: true });
    // 任意筛选变化 → 走 reloadWithFilters，保留师傅类型/薪资
    this.reloadWithFilters();
  },

  // ---------- 薪资（下拉内输入，单一最低薪资） ----------
  // 仅允许纯数字，且不超过 10 万
  sanitizeSalary(v) {
    // 去除非数字字符
    const digits = String(v || '').replace(/\D/g, '');
    if (!digits) return '';
    const n = Number(digits);
    if (n > 100000) return '100000';
    return String(n);
  },
  onSalary(e) {
    this.setData({ salary: this.sanitizeSalary(e.detail.value) }, this.syncSalaryLabel);
  },
  // 工资输入失焦：自动按当前薪资重拉，无需再点"确定"按钮
  // （确定按钮仍保留，作为兜底入口）
  onSalaryBlur() {
    if (!this.data.salary) return;
    this.reloadWithFilters();
  },
  // 清空（下拉内"清空"按钮）：清掉薪资筛选重新查数据库（保留师傅类型/区域），然后关闭下拉
  onSalaryClear() {
    this.setData(
      { salary: '', salaryInputKey: this.data.salaryInputKey + 1 },
      this.syncSalaryLabel
    );
    this.reloadWithFilters();
    // 关闭工资 dropdown（与"确定"按钮行为一致）
    const item = this.selectComponent('#salaryDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },
  // 确定：薪资走数据库真实查询（feedPosts 带 salary 下限），其他筛选保留
  onSalaryConfirm() {
    this.syncSalaryLabel();
    this.reloadWithFilters();
    // 关闭工资 dropdown，收起面板（与区域下拉"确定/重置"行为一致）
    const item = this.selectComponent('#salaryDropdownItem');
    if (item && typeof item.closeDropdown === 'function') item.closeDropdown();
  },

  // 同步"工资"按钮的展示文案到 data（wxml 只能读 data，读不到 Page 方法）
  syncSalaryLabel() {
    const s = String(this.data.salary || '').trim();
    let label = '工资';
    if (s) label = `${s}以上`;
    this.setData({ salaryLabel: label });
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.renderList();
  },

  onAdTap(e) {
    const ad = this.data.ads[e.detail.index];
    if (ad && ad.path) wx.navigateTo({ url: ad.path });
  },

  onBannerTap(e) {
    const item = e.currentTarget.dataset.item;
    if (item && item.path) wx.navigateTo({ url: item.path });
  },

  onPublish() {
    wx.showToast({ title: '发布招工表单待接入', icon: 'none' });
  },

  // 点击帖子卡片 → 进入详情页。
  // 省资源策略：只传帖子 id，详情页优先从本页已写入的 detail_pool 缓存读完整快照
  // (列表接口已下发全字段，命中即零二次云调用)；缓存未命中才兜底查库。
  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },
});
