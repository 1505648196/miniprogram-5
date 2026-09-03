// 公共底部 TabBar：用于"首页/附近/消息/我的"等根页及频道页
// 点击非当前 tab 时 reLaunch 到对应根页（清栈）
// 附带："消息" tab 未读数红点（调 notifyMsg 拿 unread，页面每次显示时刷新）
Component({
  properties: {
    // 当前高亮的 tab id：home/nearby/publish/message/me
    current: { type: String, value: 'home' },
    // 是否会员（仅影响"我的"图标显示 VIP）
    isVip: { type: Boolean, value: false },
  },
  data: {
    list: [
      { id: 'home',    icon: 'home',        label: '首页' },
      { id: 'nearby',  icon: 'location',    label: '附近' },
      { id: 'publish', icon: 'add-circle',  label: '发布' },
      { id: 'message', icon: 'chat',        label: '消息' },
      { id: 'me',      icon: 'user',        label: '我的' },
    ],
    // 未读消息数（>0 时给"消息"加红点/数字）
    unread: 0,
  },
  pageLifetimes: {
    // 页面每次显示时刷新未读数（从消息页读完回来红点消失）
    show() {
      this.refreshUnread();
    },
  },
  methods: {
    // 查未读站内通知数
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

    onTabChange(e) {
      const key = e.detail.value;
      const cur = this.properties.current;
      if (key === cur) return; // 已在当前页
      const urlMap = {
        home: '/pages/demo/demo',
        nearby: '/pages/nearby/nearby',
        message: '/pages/message/message',
        me: '/pages/mine/mine',
      };
      // 发布：非首页页无发布弹层，回首页由用户点发布
      if (key === 'publish') {
        wx.reLaunch({ url: '/pages/demo/demo' });
        return;
      }
      const url = urlMap[key];
      if (url) wx.reLaunch({ url });
    },
  },
});
