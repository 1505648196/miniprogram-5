// pages/demo/demo.js
// 包子行业信息平台 · 首页(tdesign-miniprogram)
// 数据源：feedPosts 云函数（七大类型各拉 20 条，失败自动回退本地 mock）

// 七大类型（六大板块 + 其他兜底）
// icon：TDesign 内置图标名（tdesign-miniprogram/icon）。统一取代此前 emoji 方案，
//   理由：emoji 在各机型渲染差异大、风格不统一、与平台调性不符；t-icon 是矢量字体图标，
//   颜色可控（取该类型业务色 color），与全站其他图标（tabbar/悬浮按钮等）风格一致。
const PUBLISH_TYPES = [
  { id: 'recruit',    name: '招工',     icon: 'user-search', image: '', bg: '#F0F5FF', color: '#597EF7', light: '#F0F5FF' },
  { id: 'transfer',   name: '转让',     icon: 'store',       image: '', bg: '#FFF1E8', color: '#FF7A45', light: '#FFF1E8' },
  { id: 'equip_sell', name: '设备出售', icon: 'cart',        image: '', bg: '#FFF7E6', color: '#FA8C16', light: '#FFF7E6' },
  { id: 'want_shop',  name: '求店',     icon: 'map-search',  image: '', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'jobseek',    name: '求职',     icon: 'user-vip',    image: '', bg: '#F9F0FF', color: '#9254DE', light: '#F9F0FF' },
  { id: 'equip_buy',  name: '设备求购', icon: 'tools',       image: '', bg: '#F6FFED', color: '#73D13D', light: '#F6FFED' },
  { id: 'carpool',    name: '顺风车',   icon: 'vehicle',     image: '', bg: '#E6FFFB', color: '#36CFC9', light: '#E6FFFB' },
  { id: 'other',      name: '其他',     icon: 'layers',      image: '', bg: '#FAFAFA', color: '#8C8C8C', light: '#FAFAFA' },
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
  { id: 'latest',   label: '最新消息' },
  { id: 'nearby',   label: '附近消息' },
  { id: 'transfer', label: '转让求店' },
  { id: 'recruit',  label: '求职招聘' },
];

const { loadAds, openAdLink } = require('../../utils/ad');

// 首页全局弹窗广告的「今日已弹」标记（storage key，值为当天日期字符串）
const POPUP_SHOWN_KEY = 'demo_popup_shown_date';       // 每天一次：已弹日期
const POPUP_ONCE_KEY = 'demo_popup_shown_once';         // 只弹一次：是否弹过
const POPUP_LAST_KEY = 'demo_popup_last_ts';            // 每N天：上次弹的时间戳
const POPUP_COUNT_KEY = 'demo_popup_show_count';        // 次数统计
const POPUP_SESSION_KEY = '_popupShownThisSession';     // 每次启动：内存标记（不落库）

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
    isAdmin: false,         // 是否管理员（调 adminAuth.check_admin 判定，决定 AI 入口显隐）
    // 运营位（广告轮播 / Banner 双卡 / 全局弹窗 / 包友圈商家），空数组时对应区块不渲染
    ads: [],
    banners: [],
    popupAd: null,          // 全局弹窗广告（无则不弹）
    popupVisible: false,    // 弹窗显示开关
    partners: [],
    partnersLoading: true,
    partnersScrollLeft: 0,
    swiperNav: { type: 'dots' },
    page: 1,
    pageSize: 20,
    hasMore: false,
    loadingMore: false,
    loading: true,
    firstLoaded: false,
    // 单张帖子卡片的骨架（纵向：图 + 标题两行 + 标签 + 地区 + 价格），
    // 左右两列各复用同一份，还原真实双列卡片流
    skeletonCard: [
      { type: 'rect', height: '220rpx' },
      { type: 'text', width: '100%', height: '26rpx' },
      { type: 'text', width: '70%', height: '26rpx' },
      { type: 'text', width: '52%', height: '22rpx' },
      { type: 'text', width: '60%', height: '22rpx' },
      { type: 'text', width: '40%', height: '28rpx' },
    ],
    // 模块 4b 热门推荐：左大卡「今日头条」文案 + 右上下两小卡右下小标签
    // 回退兜底数据（loadAds 拉不到 card 广告位时仍显示这套硬编码文案，页面不塌）
    card: {
      headline: {
        badge: '今日头条',
        line1: '杭州包子铺凌晨排队',
        strong: '黄牛号炒到',
        price: '50',
        cta: '查看详情',
        image: '/assets/images/baozi.png',
        theme: 'headline',
      },
      mini: {
        vipRights: '6 项特权',
        groupMembers: '2,300+ 包友',
      },
    },
    // 广告系统驱动的三张卡（今日头条大卡 + VIP 小卡 + 包友群小卡）
    // 初始为空对象（而非 null），wxml 里 cardAds.xxx.字段 在空对象上取属性安全返回 undefined，
    // 配合 || 回退到 card 兜底文案；拉取成功后 setData 覆盖为真实广告对象
    cardAds: {
      headline: {},   // layout=headline 的大卡广告
      vip: {},        // layout=mini  且 theme=vip 的小卡广告
      group: {},      // layout=mini  且 theme=group 的小卡广告
    },
  },

  onLoad() {
    this._all = [];
    this._nearbyCode = '';
    // 只拉 feed。会员状态/未读数放 onShow 拉，避免首次进入时
    // onLoad+onShow 先后触发导致 vip/unread 各请求两遍。
    this.loadFeed();
    this.loadAdSlots();
  },

  onShow() {
    // 首次进入紧随 onLoad 触发、从其他页/切 tab 返回也触发：
    // 在此刷新会员状态（底部"我的"图标）+ 未读消息数（消息 tab 红点）+ 管理员身份。
    this.loadVipStatus();
    this.refreshUnread();
    this.checkAdmin();
  },

  // 判断当前登录用户是否为管理员（决定「管理员 AI 入口」金色按钮是否显示）
  // 用云函数服务端 OPENID 比对白名单，用户无法伪造；只拿布尔值，不泄露数据
  checkAdmin() {
    wx.cloud
      .callFunction({ name: 'adminAuth', data: { action: 'check_admin' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        const isAdmin = !!r.isAdmin;
        if (isAdmin !== this.data.isAdmin) this.setData({ isAdmin });
      })
      .catch(() => {
        // 失败按非管理员处理：不显示入口，不影响其他功能
      });
  },

  onHide() {
    this.stopPartnersScroll();
  },

  onUnload() {
    this.stopPartnersScroll();
  },

  // 运营位（广告轮播 / Banner 双卡 / 全局弹窗） + 包友圈商家（真实数据）
  // 方案 C：走通用 loadAds(page, positions)，广告位由后台 ad_slots 动态定义
  async loadAdSlots() {
    const groups = await loadAds('demo', ['banner', 'card', 'popup']);
    // banner 轮播图：一条广告可含多图（images 数组），否则回退单 image
    const ads = [];
    (groups.banner || []).forEach((a) => {
      const imgs = (Array.isArray(a.images) && a.images.length)
        ? a.images
        : (a.image ? [a.image] : []);
      imgs.forEach((img) => {
        if (img) {
          ads.push({
            value: img,
            path: a.link || '',
            linkType: a.linkType || 'page',
            target: a.target || '',
          });
        }
      });
    });
    // card 双卡运营位（旧 banner 风格，保留兼容）
    const banners = (groups.card || []).map((a) => ({
      id: a._id,
      icon: a.icon || '',
      emoji: a.emoji || '',
      title: a.title || '',
      sub: a.sub || '',
      bgFrom: a.bgFrom || '#FFF1E8',
      bgTo: a.bgTo || '#FFE0C2',
      path: a.link || '',
      linkType: a.linkType || 'page',
      target: a.target || '',
    }));
    // popup 全局弹窗广告：只取第一条；「每天最多弹一次」由 storage 记录当天日期控制
    const popupList = groups.popup || [];
    const popupAd = popupList.length ? popupList[0] : null;

    // 模块 4b 热门推荐卡片组（广告系统驱动）：从 card 广告位里按 layout 分类
    //   layout=headline → 今日头条大卡；layout=mini + theme=vip → VIP 小卡；
    //   layout=mini + theme=group → 包友群小卡。拉不到对应广告时 cardAds 对应字段保持空对象（无 _id → 前端不渲染该卡）。
    const cardAds = { headline: {}, vip: {}, group: {} };
    (groups.card || []).forEach((a) => {
      const layout = a.layout || '';
      const theme = a.theme || '';
      if (layout === 'headline' && !cardAds.headline._id) cardAds.headline = a;
      else if (layout === 'mini' && theme === 'vip' && !cardAds.vip._id) cardAds.vip = a;
      else if (layout === 'mini' && theme === 'group' && !cardAds.group._id) cardAds.group = a;
    });

    this.setData({ ads, banners, popupAd, cardAds });
    this.maybeShowPopup(popupAd);
    this.loadPartners();
  },

  // 决定是否弹出全局弹窗广告：按广告配置的 freq 频控策略判断
  // freq 取值：daily(每天一次,默认) / once(只一次) / always(每次都弹) / session(每次启动一次) / every_n(每N天)
  maybeShowPopup(ad) {
    if (!ad) return;
    const freq = ad.freq || 'daily';
    const today = new Date().toDateString();
    const now = Date.now();
    try {
      // 最多弹 N 次限制（freq_max > 0 时生效）
      const maxShow = Number(ad.freq_max) || 0;
      if (maxShow > 0) {
        const cnt = Number(wx.getStorageSync(POPUP_COUNT_KEY)) || 0;
        if (cnt >= maxShow) return;
      }

      if (freq === 'once') {
        // 只弹一次（永久）
        if (wx.getStorageSync(POPUP_ONCE_KEY)) return;
      } else if (freq === 'always') {
        // 每次都弹，不做拦截
      } else if (freq === 'session') {
        // 每次小程序冷启动弹一次：用内存标记（app 未重启就不会清）
        if (this[POPUP_SESSION_KEY]) return;
      } else if (freq === 'every_n') {
        // 每 N 天弹一次
        const n = Math.max(1, Number(ad.freq_days) || 1);
        const last = Number(wx.getStorageSync(POPUP_LAST_KEY)) || 0;
        if (last && (now - last) < n * 86400000) return;
      } else {
        // daily（默认）：今天已弹过则不再弹
        const shownDate = wx.getStorageSync(POPUP_SHOWN_KEY) || '';
        if (shownDate === today) return;
      }
    } catch (e) {
      // 读缓存失败按未弹过处理
    }
    this.setData({ popupVisible: true });
  },

  // 记录"弹窗已展示"（关闭/点击时调用）：按当前 ad 的 freq 写对应标记
  markPopupShown() {
    const ad = this.data.popupAd || {};
    const freq = ad.freq || 'daily';
    const now = Date.now();
    try {
      // 次数统计（所有策略都累加，供 freq_max 使用）
      const cnt = (Number(wx.getStorageSync(POPUP_COUNT_KEY)) || 0) + 1;
      wx.setStorageSync(POPUP_COUNT_KEY, cnt);

      if (freq === 'once') {
        wx.setStorageSync(POPUP_ONCE_KEY, 1);
      } else if (freq === 'every_n') {
        wx.setStorageSync(POPUP_LAST_KEY, now);
      } else if (freq === 'session') {
        this[POPUP_SESSION_KEY] = true;
      } else if (freq !== 'always') {
        // daily（默认）
        wx.setStorageSync(POPUP_SHOWN_KEY, new Date().toDateString());
      }
    } catch (err) {
      // 写缓存失败忽略：下次进入可能再弹一次，不影响功能
    }
  },

  // 关闭弹窗（点遮罩/关闭按钮）→ 记录已弹
  onPopupClose(e) {
    // t-popup 的 visible-change 事件 detail.visible=false 表示关闭
    if (e && e.detail && e.detail.visible) return;
    this.setData({ popupVisible: false });
    this.markPopupShown();
  },

  // 点击弹窗广告内容 → 关闭弹窗 + 统一跳转
  onPopupTap() {
    const ad = this.data.popupAd;
    this.setData({ popupVisible: false });
    this.markPopupShown();
    // popupAd 是后端原始对象，字段为 link/linkType/target；
    // 走 Page 方法 this.openAdLink（已兼容 link 字段）
    this.openAdLink(ad);
  },

  // 包友圈商家：调 merchantApply(list) 拉已审核商家（推荐前 10 条），映射为横滚卡片数据
  loadPartners() {
    wx.cloud.callFunction({
      name: 'merchantApply',
      data: { action: 'list', page: 1, pageSize: 10 },
      config: { timeout: 10000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      if (r.success && Array.isArray(r.list)) {
        const partners = r.list.map((m) => ({
          id: m._id,
          name: m.name || '',
          image: m.avatar || '',
        }));
        this.setData({ partners, partnersLoading: false }, () => {
          // 数据就绪后，稍等一帧启动慢速自动滚动
          setTimeout(() => this.startPartnersScroll(), 300);
        });
      } else {
        this.setData({ partners: [], partnersLoading: false });
      }
    }).catch(() => {
      this.setData({ partners: [], partnersLoading: false });
    });
  },

  // 慢速自动向右滚动，滚到末尾（更多商家）后停止；用户触摸/点击即停止
  startPartnersScroll() {
    if (this._partnersTimer) return;
    if (!this.data.partners.length) return;
    this._partnersTimer = setInterval(() => {
      const left = (this.data.partnersScrollLeft || 0) + 1; // 每步 +1px，慢速
      // 估算内容总宽：卡片数(10+1张更多)×(140rpx+16rpx间距)。超出即停止
      const totalWidth = (this.data.partners.length + 1) * (140 + 16);
      if (left >= totalWidth) {
        this.stopPartnersScroll(); // 到末尾，停止
        return;
      }
      this.setData({ partnersScrollLeft: left });
    }, 50);
  },

  stopPartnersScroll() {
    if (this._partnersTimer) {
      clearInterval(this._partnersTimer);
      this._partnersTimer = null;
    }
  },

  // 手指开始触摸：停止自动滚动（让用户手动拖动）
  onPartnersTouchStart() {
    this.stopPartnersScroll();
  },

  // 手指松开：保持停在当前位置（不再自动续滚）
  onPartnersTouchEnd() {
    // 不重启自动滚动；用户拖动后停在原地
  },

  // 统一广告跳转：支持 page(页面) / post(帖子详情) / url(外链) / none(不跳)
  // 兼容两种字段来源：banner/card 映射后是 path；popup 原始对象是 link
  openAdLink(item) {
    if (!item) return;
    const linkType = item.linkType || 'page';
    const target = item.target || item.path || item.link || '';
    if (!target && linkType !== 'none') return;
    switch (linkType) {
      case 'post':
        wx.navigateTo({ url: `/pages/detail/detail?id=${target}` });
        break;
      case 'url':
        // 外链需 webview 页面承载（当前未建，暂提示）
        wx.showToast({ title: '外链跳转待接入', icon: 'none' });
        break;
      case 'none':
        break;
      case 'page':
      default:
        if (target) wx.navigateTo({ url: target });
        break;
    }
  },

  onAdTap(e) {
    const ad = this.data.ads[e.detail.index];
    this.openAdLink(ad);
  },

  onBannerTap(e) {
    const item = e.currentTarget.dataset.item;
    this.openAdLink(item);
  },

  // 热门推荐卡片组：四个入口跳转（区头查看全部 / 左大新闻 / VIP / 包友群）
  // 广告系统驱动：对应广告位有 link 时走 openAdLink(ad)，否则回退到固定页面跳转
  onCardMoreTap() {
    // 区头「查看全部」：进快讯列表页（区头非广告位，保持固定跳转）
    wx.navigateTo({ url: '/pages/news/news' });
  },
  onCardHeadlineTap() {
    const ad = this.data.cardAds && this.data.cardAds.headline;
    if (ad && (ad.link || ad.target)) { this.openAdLink(ad); return; }
    wx.navigateTo({ url: '/pages/news/news' });
  },
  onCardVipTap() {
    const ad = this.data.cardAds && this.data.cardAds.vip;
    if (ad && (ad.link || ad.target)) { this.openAdLink(ad); return; }
    wx.navigateTo({ url: '/pages/vip/vip' });
  },
  onCardGroupTap() {
    const ad = this.data.cardAds && this.data.cardAds.group;
    if (ad && (ad.link || ad.target)) { this.openAdLink(ad); return; }
    wx.navigateTo({ url: '/pages/group/group' });
  },

  // 管理员长按热门推荐卡片 → 上下线该广告
  // 入口：仅 isAdmin=true 时生效；普通用户长按只触发震动不出菜单
  onCardAdLongPress(e) {
    if (!this.data.isAdmin) return; // 普通用户：无操作（保留长按震动）
    const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.adKey) || '';
    const ad = this.data.cardAds && this.data.cardAds[key];
    if (!ad || !ad._id) {
      wx.showToast({ title: '该卡片不是广告（兜底文案）', icon: 'none' });
      return;
    }
    const online = ad.status === 'online';
    const KEY_LABELS = { headline: '今日头条大卡', vip: 'VIP 会员卡', group: '包友群卡' };
    const itemName = KEY_LABELS[key] || '该卡片';
    wx.showActionSheet({
      itemList: online ? [`下线${itemName}`, `查看广告详情`] : [`重新上线${itemName}`, `查看广告详情`],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.toggleCardAd(key, !online);
        }
        else if (res.tapIndex === 1) {
          wx.showModal({
            title: `${itemName} 广告详情`,
            content: `slot：${ad.slot || '-'}\ntype：${ad.type || '-'}\nlayout：${ad.layout || '-'}\ntheme：${ad.theme || '-'}\ntitle：${ad.title || ad.line1 || '-'}\nlink：${ad.link || ad.target || '（无）'}\n当前状态：${online ? 'online（展示中）' : 'offline（已下线）'}`,
            showCancel: false,
            confirmText: '知道了',
          });
        }
      },
    });
  },

  // 调 adminAuth.ad_toggle 切换广告 status
  // 入参：key=headline/vip/group；nextStatus=true 上线 / false 下线
  async toggleCardAd(key, nextStatus) {
    const ad = this.data.cardAds && this.data.cardAds[key];
    if (!ad || !ad._id) return;
    const KEY_LABELS = { headline: '今日头条大卡', vip: 'VIP 会员卡', group: '包友群卡' };
    const itemName = KEY_LABELS[key] || '该卡片';
    wx.showLoading({ title: nextStatus ? '上线中…' : '下线中…', mask: true });
    try {
      // 鉴权走 openid 通道（adminAuth 会读服务端 getWXContext().OPENID 判定管理员），
      // 不再传账密：小程序包可被反编译，硬编码口令等于公开后台密码。
      const res = await wx.cloud.callFunction({
        name: 'adminAuth',
        data: {
          action: 'ad_toggle',
          _id: ad._id,
          status: nextStatus ? 'online' : 'offline',
        },
        config: { timeout: 10000 },
      });
      const r = (res && res.result) || {};
      if (r.success) {
        wx.showToast({ title: nextStatus ? '已重新上线' : '已下线', icon: 'success' });
        // 立即刷新 cardAds：本地乐观更新 + 后台拉新
        this.loadAdSlots();
      }
      else {
        wx.showModal({ title: `${itemName}操作失败`, content: r.message || '未知错误', showCancel: false });
      }
    }
    catch (err) {
      wx.showToast({ title: (err && err.errMsg) || '调用失败', icon: 'none' });
    }
    finally {
      wx.hideLoading();
    }
  },

  // 包友圈：点击单个商家卡 → 停止滚动 + 进商家详情页
  onPartnerTap(e) {
    this.stopPartnersScroll();
    const item = e.currentTarget.dataset.item;
    if (!item || !item.id) return;
    wx.navigateTo({ url: `/pages/merchant-detail/merchant-detail?id=${item.id}` });
  },

  // 包友圈：点击"更多商家"或"全部" → 停止滚动 + 进入驻页
  onPartnersMore() {
    this.stopPartnersScroll();
    wx.navigateTo({ url: '/pages/merchant-apply/merchant-apply' });
  },
  onPartnersAll() {
    this.onPartnersMore();
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

  // 全量按时间倒序查询：不传 dataType/dataTypes，云端直接对全集合按 published_at 倒序取一页，
  // 首页「最新消息」用（比「按 7 类各取 20 再合并」更直接、更省：1 次查询拿最新 N 条）。
  fetchAll(page, cityCode) {
    const data = { page: page || 1, pageSize: this.data.pageSize || 20 };
    if (cityCode) data.city_code = cityCode;
    return wx.cloud
      .callFunction({ name: 'feedPosts', data, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success) return { list: r.list || [], hasMore: !!r.hasMore };
        console.error('[demo] feedPosts 全量返回失败:', r.error);
        return null;
      })
      .catch((err) => {
        console.error('[demo] feedPosts 全量调用失败:', err && err.errMsg);
        return null;
      });
  },

  async fetchAllTypes(page) {
    const t = this.data.activeTopTab;
    const isRecruit = t === 'recruit';
    const isNearby = t === 'nearby';
    const isTransfer = t === 'transfer';
    const cityCode = isNearby ? this._nearbyCode : '';

    // 首页「最新消息」：直接全集合按时间倒序查（1 次查询拿最新 N 条，不再按类型拆分）
    if (!isRecruit && !isNearby && !isTransfer) {
      return this.fetchAll(page, '');
    }

    // 求职招聘 / 转让求店 / 附近：按类型批量（附近带 cityCode 同城过滤）
    const TYPES = isRecruit
      ? ['recruit', 'jobseek']
      : isTransfer
        ? ['transfer', 'want_shop']
        : ['transfer', 'want_shop', 'recruit', 'jobseek', 'equip_sell', 'equip_buy', 'other'];
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
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
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
    // 发布：直接跳转「我的发布」列表页（临时改动，暂注释掉原发布类型弹层）
    if (key === 'publish') { this.setData({ activeBar: 'home' }); wx.navigateTo({ url: '/pages/myposts/myposts' }); return; }
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
    // 复用顶部 Tab 的统一激活逻辑(含 nearby 定位)
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
    // 进详情：先显示 loading（微延迟一帧再跳转，确保 loading 先渲染出来，不被页面切换瞬间吞掉），
    // 由详情页 onReady 关闭
    wx.showLoading({ title: '加载中…', mask: true });
    setTimeout(() => {
      wx.navigateTo({
        url: `/pages/detail/detail?id=${id}`,
        // 跳转失败时兜底关闭 loading，防止残留
        fail: () => wx.hideLoading(),
      });
    }, 30);
  },

  // ---------- 金色悬浮按钮：进入智能对话页（管理员对话入口） ----------
  onGoldFabTap() {
    wx.navigateTo({ url: '/pages/chat/chat' });
  },

  // ---------- 分享 ----------
  // 分享按钮用 open-type="share"，点击直接触发「转发给好友」（微信原生支持）；
  // 朋友圈分享仍只能通过右上角「···」菜单（微信平台限制，按钮无法触发）。
  // 下面两个回调同时服务「转发按钮」和「右上角菜单」两种入口。

  // 分享给好友（open-type=share 按钮 + 右上角菜单共用）
  onShareAppMessage() {
    return {
      title: '包子一哥传媒 · 招聘求职/店铺转让/二手设备/顺风车',
      path: '/pages/demo/demo',
    };
  },

  // 右上角「···」菜单分享朋友圈
  onShareTimeline() {
    return {
      title: '包子一哥传媒 · 招聘求职/店铺转让/二手设备/顺风车',
      query: '',
    };
  },
});
