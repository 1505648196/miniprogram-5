// pages/mine/mine.js
const bindPhone = require('../../utils/bindPhone.js');
// 包子行业信息平台 · 我的（个人中心，仿闲鱼风格）
// 功能：我的发布(跳转管理页) / 浏览历史 / 清除缓存 / 关于
//       + 仿闲鱼的订单/工具/工具宫格（先做占位，功能后续补）
// 数据源：
//   - 我的发布数量：managePost(action=list_mine) 云函数（按 _openid 归属，全部分类）
//   - 浏览历史数量：本地缓存 detail_pool（列表/详情浏览时写入的帖子快照池）

// 发布类型（与 demo 首页一致；icon 为 TDesign 内置图标名，取代旧 emoji 方案）
const PUBLISH_TYPES = [
  { id: 'recruit',    name: '招工',     icon: 'user-search', bg: '#F0F5FF', color: '#597EF7', light: '#F0F5FF' },
  { id: 'transfer',   name: '转让',     icon: 'store',       bg: '#FFF1E8', color: '#FF7A45', light: '#FFF1E8' },
  { id: 'equip_sell', name: '设备出售', icon: 'cart',        bg: '#FFF7E6', color: '#FA8C16', light: '#FFF7E6' },
  { id: 'want_shop',  name: '求店',     icon: 'map-search',  bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'jobseek',    name: '求职',     icon: 'user-vip',    bg: '#F9F0FF', color: '#9254DE', light: '#F9F0FF' },
  { id: 'equip_buy',  name: '设备求购', icon: 'tools',       bg: '#F6FFED', color: '#73D13D', light: '#F6FFED' },
  { id: 'carpool',    name: '顺风车',   icon: 'vehicle',     bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'other',      name: '其他',     icon: 'layers',      bg: '#FAFAFA', color: '#8C8C8C', light: '#FAFAFA' },
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
    // 统计（收藏/历史为真实计数；已去掉无实现的「我的关注」占位项）
    statList: [
      { key: 'fav',     label: '我的收藏' },
      { key: 'history', label: '历史浏览' },
    ],
    // 我的交易（订单 3 项，均为真实功能：我发布的/付款记录/客服）
    orderList: [
      { key: 'sell',     label: '我发布的', count: 0 }, // onShow 会覆盖为真实发布数
      { key: 'sold',     label: '付款记录', count: 0 }, // onShow 会覆盖为真实付款记录数
      { key: 'service',  label: '客服',     count: '人工客服' },
    ],
    // 公告（来自 notifyMsg.notice_latest 的最新一条；无公告时显示「暂无公告」）
    notice: '暂无公告',
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
    // 手机号绑定半屏弹层
    bindSheetVisible: false,
    bindPhoneLoading: false,
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
    this.loadNotice();
    this.tryShowBindSheet();
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

  // 取最新一条已上线公告（公告条展示）；无公告则显示「暂无公告」
  loadNotice() {
    wx.cloud
      .callFunction({ name: 'notifyMsg', data: { action: 'notice_latest' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const n = r.success ? r.notice : null;
        // 公告条只展示标题；无公告或空标题 → 兜底文案
        const text = n && n.title ? n.title : (n && n.content ? n.content : '暂无公告');
        if (text !== this.data.notice) this.setData({ notice: text });
      })
      .catch(() => {
        // 拉取失败：保持「暂无公告」兜底，不打断页面
      });
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
      // 复用已查到的 posts/pays，不额外发请求：覆盖「我发布的」「付款记录」两个占位数字
      orderList: this.data.orderList.map((o) => {
        if (o.key === 'sell') return Object.assign({}, o, { count: posts });
        if (o.key === 'sold') return Object.assign({}, o, { count: pays });
        return o;
      }),
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
  },

  onOrderTap(e) {
    const { key } = e.currentTarget.dataset;
    if (key === 'sell') { this.goMyPosts(); return; }
    // 付款记录：查看历史付费(查看电话)订单，可点进对应信息详情
    if (key === 'sold') { wx.navigateTo({ url: '/pages/payrecords/payrecords' }); return; }
    // 客服：弹出「联系一哥」并支持直接拨打
    if (key === 'service') { this.contactService(); return; }
  },

  // 客服：弹出联系电话，可一键拨打
  contactService() {
    wx.showActionSheet({
      itemList: ['拨打 15026893448'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.makePhoneCall({ phoneNumber: '15026893448' }).catch(() => {});
        }
      },
    });
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

  onNoticeTap() {
    wx.navigateTo({ url: '/pages/notice/notice' });
  },

  onHeaderRightTap(e) {
    const { what } = e.currentTarget.dataset;
    // 帮助与客服：复用「客服」的弹出（联系一哥）
    if (what === 'help') { this.contactService(); return; }
    // 设置：进个人资料页，可修改头像 / 昵称 / 绑定手机号
    if (what === 'settings') { wx.navigateTo({ url: '/pages/settings/settings' }); return; }
  },

  // 底部真实 TabBar 点击切换（mine 是 navigateTo 进入的独立页，跨页用 reLaunch 清栈）
  onTabBar(e) {
    const key = e.detail.value;
    if (key === 'me') return; // 已在当前页
    // 发布：跳转「我的发布」列表页（与首页 demo 点发布一致）
    if (key === 'publish') { wx.navigateTo({ url: '/pages/myposts/myposts' }); return; }
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

  // 我的认证：进身份认证中心（店主/师傅/商家）
  onIdentityTap() {
    wx.navigateTo({ url: '/pages/identity/identity' });
  },

  // 意见反馈：进反馈页（type=feedback，可提交功能建议/使用问题/投诉等）
  onFeedbackTap() {
    wx.navigateTo({ url: '/pages/feedback/feedback?type=feedback' });
  },

  // 隐私政策（?type=privacy 为默认，可省略）
  onPrivacyTap() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=privacy' });
  },

  // 用户协议
  onTermsTap() {
    wx.navigateTo({ url: '/pages/privacy/privacy?type=terms' });
  },
  onAboutDialogClose() {
    this.setData({ aboutDialogVisible: false });
  },

  // 进入「我的」页：每次进都弹（未绑定手机号时），不记 3 天标记
  async tryShowBindSheet() {
    // always=true：跳过 3 天间隔，只查云端是否已绑定 → 未绑定就每次弹
    const should = await bindPhone.shouldShowBindSheet(true);
    if (should) {
      this.setData({ bindSheetVisible: true });
    }
  },

  // 半屏弹层关闭（点遮罩/暂不绑定）
  onBindSheetClose(e) {
    if (e && e.detail && e.detail.visible) return;
    this.setData({ bindSheetVisible: false });
  },

  // 手机号授权回调（getPhoneNumber）→ 调 getOrCreateUser 绑定并认领老数据
  onGetPhone(e) {
    const code = (e && e.detail && e.detail.code) || '';
    if (!code) {
      // 用户拒绝授权：静默关闭
      this.setData({ bindSheetVisible: false });
      return;
    }
    this.setData({ bindPhoneLoading: true });
    wx.cloud
      .callFunction({ name: 'getOrCreateUser', data: { phoneCode: code }, config: { timeout: 10000 } })
      .then((res) => {
        this.setData({ bindPhoneLoading: false, bindSheetVisible: false });
        const r = res.result || {};
        const matched = Number(r.matched_posts) || 0;
        wx.showToast({
          title: matched > 0 ? `已绑定，认领 ${matched} 条信息` : '绑定成功',
          icon: 'success',
        });
        this.loadUser(); // 刷新用户信息
      })
      .catch(() => {
        this.setData({ bindPhoneLoading: false });
        wx.showToast({ title: '绑定失败，请重试', icon: 'none' });
      });
  },
});