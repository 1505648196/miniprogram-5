// pages/mine/mine.js
// 包子行业信息平台 · 我的（个人中心，仿闲鱼风格）
// 功能：我的发布(跳转管理页) / 浏览历史 / 清除缓存 / 关于
//       + 仿闲鱼的订单/工具/工具宫格（先做占位，功能后续补）
// 数据源：
//   - 我的发布数量：managePost(action=list_mine) 云函数（按 _openid 归属，全部分类）
//   - 浏览历史数量：本地缓存 detail_pool（列表/详情浏览时写入的帖子快照池）

// 发布类型（与 demo 首页一致）
const PUBLISH_TYPES = [
  { id: 'recruit',    name: '招工',     emoji: '👨', bg: '#F0F5FF', color: '#597EF7', light: '#F0F5FF' },
  { id: 'transfer',   name: '转让',     emoji: '🥟', bg: '#FFF1E8', color: '#FF7A45', light: '#FFF1E8' },
  { id: 'equip_sell', name: '设备出售', emoji: '🛒', bg: '#FFF7E6', color: '#FA8C16', light: '#FFF7E6' },
  { id: 'want_shop',  name: '求店',     emoji: '🔎', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'jobseek',    name: '求职',     emoji: '🙋', bg: '#F9F0FF', color: '#9254DE', light: '#F9F0FF' },
  { id: 'equip_buy',  name: '设备求购', emoji: '🧰', bg: '#F6FFED', color: '#73D13D', light: '#F6FFED' },
  { id: 'carpool',    name: '顺风车',   emoji: '🚗', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'other',      name: '其他',     emoji: '📦', bg: '#FAFAFA', color: '#8C8C8C', light: '#FAFAFA' },
];

Page({
  data: {
    // 用户信息（读 getOrCreateUser 当前用户；加载前先占位）
    nickname: '加载中…',
    avatarText: '',
    avatar: '',          // 真实头像(cloud fileID / 网络图)；空则用 avatarText 兜底
    creditTag: '',
    // 统计
    postsCount: 0,
    historyCount: 0,
    favCount: 0,
    loading: true,
    // 弹层
    clearDialogVisible: false,
    aboutDialogVisible: false,
    clearing: false,
    // 仿闲鱼：统计（收藏/历史为真实计数，关注默认 0）
    statList: [
      { key: 'fav',     label: '我的收藏' },
      { key: 'history', label: '历史浏览' },
      { key: 'follow',  label: '我的关注', num: 0 },
    ],
    // 我的交易
    tradeSummary: '在闲鱼赚了 92495.02元',
    tradeBadge: '今日曝 904',
    // 订单 4 项
    orderList: [
      { key: 'sell',     label: '我发布的', count: 12 },
      { key: 'space',    label: '我的认证', count: 0  },
      { key: 'sold',     label: '付款记录', count: 115 },
      { key: 'service',  label: '客服',     count: 0 },
    ],
    // 工具宫格（4 列）
    toolGrid: [
      { key: 'expose',    label: '宝贝曝光数',  count: 220, hint: '查看完整数据' },
      { key: 'deal',      label: '成交数',     count: 0,   hint: '查看完整数据' },
      { key: 'promotion', label: '曝光推广' },
      { key: 'marketing', label: '营销工具' },
    ],
    // 公告/常见问题
    notice: '15号用户 已开通VIP',
    // 鱼力回收（招回/卖等）
    recycleGrid: [
      { key: 'clean',   label: '超强擦亮' },
      { key: 'host',    label: '托管无忧卖' },
      { key: 'law',     label: '闲鱼小法庭' },
      { key: 'loan',    label: '借钱' },
      { key: 'sign',    label: '闲鱼小约' },
    ],
    // 底部真实 TabBar（与 demo 一致，mine 为独立页，点击切换用 reLaunch 清栈）
    tabbar: [
      { id: 'home',    icon: 'home',        label: '首页' },
      { id: 'nearby',  icon: 'location',    label: '附近' },
      { id: 'publish', icon: 'add-circle',  label: '发布' },
      { id: 'message', icon: 'chat',        label: '消息' },
      { id: 'me',      icon: 'user',        label: '我的' },
    ],
    activeBar: 'me',
    // 发布类型弹层（同 demo 首页）
    publishTypes: PUBLISH_TYPES,
    publishSheetVisible: false,
    // 会员状态（来自 memberService.status）
    isVip: false,
    vipExpire: '',
    // 未读站内通知数（消息 tab 红点）
    unread: 0,
  },

  // 说明：数据拉取统一放 onShow，不再写 onLoad。
  // 首次进入页面时 onLoad 与 onShow 会先后触发，若两处都拉同一套数据，
  // 会导致「首次进页即发两遍请求」的放大浪费。navigateTo 返回本页（页面不重建）
  // 时只触发 onShow，因此数据放 onShow 既能保证首次加载、也能保证从收藏/会员等
  // 页面返回后刷新，且首次只请求一次。
  onShow() {
    this.loadStats();
    this.loadUser();
    this.loadVip();
    this.refreshUnread();
  },

  onPullDownRefresh() {
    Promise.all([this.loadStats(), this.loadUser(), this.loadVip()]).then(() => wx.stopPullDownRefresh());
  },

  // 查未读站内通知数（消息 tab 红点）
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

  // 读当前登录用户(openid 建号/查用户)的真实信息，填充头部
  loadUser() {
    return wx.cloud
      .callFunction({ name: 'getOrCreateUser', data: {}, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (!r.success || !r.user) return;
        const u = r.user;
        const username = (u.username || '').trim();
        const avatar = (u.avatar || '').trim();
        this.setData({
          nickname: username || '包子一哥用户',
          avatar: avatar,
          avatarText: username ? username.slice(0, 1) : (avatar ? '' : '包'),
          creditTag: `信用 ${u.credit_score != null ? u.credit_score : 100}分`,
        });
      })
      .catch(() => {});
  },

  async loadStats() {
    this.setData({ loading: true });
    const [posts, history, favs, pays] = await Promise.all([
      this.countMyPosts(),
      this.countHistory(),
      this.countFavorites(),
      this.countPayRecords(),
    ]);
    this.setData({
      postsCount: posts,
      historyCount: history,
      favCount: favs,
      // 付款记录条数用真实值（付费查看电话的订单数），覆盖占位数字
      orderList: this.data.orderList.map((o) => (o.key === 'sold' ? Object.assign({}, o, { count: pays }) : o)),
      loading: false,
    });
  },

  // 我的收藏数（调 favorite.list 取 total，pageSize=1 只查总数不拉数据）
  countFavorites() {
    return wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'list', page: 1, pageSize: 1 }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        return Number(r.total) || 0;
      })
      .catch(() => 0);
  },

  // 查会员状态
  loadVip() {
    wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        this.setData({ isVip: !!r.isVip, vipExpire: r.expireText || '' });
      })
      .catch(() => {});
  },

  // 去会员中心
  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' });
  },

  countMyPosts() {
    return wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'list_mine' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success && Array.isArray(r.list)) return r.list.length;
        return 0;
      })
      .catch((err) => {
        console.error('[mine] 读取我的发布失败:', err && err.errMsg);
        return 0;
      });
  },

  countHistory() {
    try {
      const pool = wx.getStorageSync('detail_pool');
      return pool && typeof pool === 'object' ? Object.keys(pool).length : 0;
    } catch (e) {
      return 0;
    }
  },

  // ---------- 真功能 ----------
  goMyPosts() {
    wx.navigateTo({ url: '/pages/myposts/myposts' });
  },
  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },
  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  onStatTap(e) {
    const { key } = e.currentTarget.dataset;
    if (key === 'history') { this.goHistory(); return; }
    if (key === 'fav') { this.goFavorites(); return; }
    if (key === 'follow') { wx.showToast({ title: '正在制作中', icon: 'none' }); return; }
    if (key === 'coupon') {
      wx.showToast({ title: '该功能待接入', icon: 'none' });
      return;
    }
    wx.showToast({ title: '该功能待接入', icon: 'none' });
  },

  onOrderTap(e) {
    const { key } = e.currentTarget.dataset;
    if (key === 'sell') { this.goMyPosts(); return; }
    // 付款记录：查看历史付费(查看电话)订单，可点进对应信息详情
    if (key === 'sold') { wx.navigateTo({ url: '/pages/payrecords/payrecords' }); return; }
    wx.showToast({ title: '该功能待接入', icon: 'none' });
  },

  // 付款记录数量（付费查看电话的订单条数）
  countPayRecords() {
    return wx.cloud
      .callFunction({ name: 'payForPhone', data: { action: 'list' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        return r.success && Array.isArray(r.list) ? r.list.length : 0;
      })
      .catch(() => 0);
  },

  onToolTap() {
    wx.showToast({ title: '该功能待接入', icon: 'none' });
  },

  onRecycleTap() {
    wx.showToast({ title: '该功能待接入', icon: 'none' });
  },

  onTradeTap() {
    wx.showToast({ title: '交易记录待接入', icon: 'none' });
  },

  onTradeBadgeTap() {
    wx.showToast({ title: '今日曝光详情待接入', icon: 'none' });
  },

  onNoticeTap() {
    wx.showToast({ title: '公告待接入', icon: 'none' });
  },

  onBannerTap() {
    wx.showToast({ title: '闲鱼会员权益说明', icon: 'none' });
  },

  onHeaderRightTap(e) {
    const { what } = e.currentTarget.dataset;
    if (what === 'help') { wx.showToast({ title: '帮助与客服待接入', icon: 'none' }); return; }
    // 设置：进个人资料页，可修改头像 / 昵称 / 绑定手机号
    if (what === 'settings') { wx.navigateTo({ url: '/pages/settings/settings' }); return; }
  },

  // 底部真实 TabBar 点击切换（mine 是 navigateTo 进入的独立页，跨页用 reLaunch 清栈）
  onTabBar(e) {
    const key = e.detail.value;
    if (key === 'me') return; // 已在当前页
    // 发布：在本页弹出发布类型选择（同 demo）
    if (key === 'publish') { this.openPublishSheet(); return; }
    // 附近：独立附近页
    if (key === 'nearby') {
      wx.reLaunch({ url: '/pages/nearby/nearby' });
      return;
    }
    // 消息：进站内通知页
    if (key === 'message') { wx.navigateTo({ url: '/pages/message/message' }); return; }
    // 首页：回首页（清栈）
    if (key === 'home') {
      wx.reLaunch({ url: '/pages/demo/demo' });
      return;
    }
  },

  // ---------- 发布类型选择弹层（同 demo 首页：点发布 tab 弹出） ----------
  openPublishSheet() {
    this.setData({ publishSheetVisible: true });
  },
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

  // ---------- 清除缓存 ----------
  onClearCacheTap() {
    this.setData({ clearDialogVisible: true });
  },
  onClearDialogClose() {
    this.setData({ clearDialogVisible: false });
  },
  async onClearConfirm() {
    if (this.data.clearing) return;
    this.setData({ clearing: true });
    try {
      wx.removeStorageSync('detail_pool');
    } catch (e) {}
    const history = this.countHistory();
    this.setData({
      clearDialogVisible: false,
      clearing: false,
      historyCount: history,
    });
    wx.showToast({ title: '缓存已清除', icon: 'success' });
  },

  onAboutTap() {
    this.setData({ aboutDialogVisible: true });
  },
  onAboutDialogClose() {
    this.setData({ aboutDialogVisible: false });
  },
});