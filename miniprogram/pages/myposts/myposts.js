// pages/myposts/myposts.js
// 包子行业信息平台 · 我的发布（管理自己发布的信息）
// 数据源：managePost(action=list_mine) —— 按 _openid 归属返回本人全部帖子（含待审核）
// 操作：编辑（跳发布页带 id 预填）/ 删除（managePost action=delete）

const TYPE_META = {
  recruit:       { name: '招工',     color: '#597EF7', light: '#F0F5FF' },
  jobseek:       { name: '求职',     color: '#9254DE', light: '#F9F0FF' },
  transfer:      { name: '转让',     color: '#FF7A45', light: '#FFF1E8' },
  want_shop:     { name: '求店',     color: '#36CFC9', light: '#E6FFFB' },
  equip_sell:    { name: '设备出售', color: '#FA8C16', light: '#FFF7E6' },
  equip_buy:     { name: '设备求购', color: '#73D13D', light: '#F6FFED' },
  carpool_car:   { name: '车找人',   color: '#597EF7', light: '#F0F5FF' },
  carpool_person:{ name: '人找车',   color: '#73D13D', light: '#F6FFED' },
  other:         { name: '其他',     color: '#8C8C8C', light: '#F0F0F0' },
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

// 发布类型（与 demo 首页一致；icon 为 TDesign 内置图标名，取代旧 emoji 方案）
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

Page({
  data: {
    list: [],
    loading: true,
    // 底部 TabBar（默认高亮「我的」：myposts 是从"我的"点进来的子页）
    activeBar: 'me',
    tabbar: [
      { id: 'home',    icon: 'home',        label: '首页' },
      { id: 'nearby',  icon: 'location',    label: '附近' },
      { id: 'publish', icon: 'add-circle',  label: '发布' },
      { id: 'message', icon: 'chat',        label: '消息' },
      { id: 'me',      icon: 'user',        label: '我的' },
    ],
    // 发布类型弹层（同 demo 首页）
    publishTypes: PUBLISH_TYPES,
    publishSheetVisible: false,
    // 删除确认弹层
    deleteDialogVisible: false,
    pendingDeleteId: '',
    deleting: false,
    skeletonRows: [
      [{ width: '100%', height: '160rpx', type: 'rect' }],
      [{ width: '100%', height: '160rpx', type: 'rect' }],
      [{ width: '100%', height: '160rpx', type: 'rect' }],
    ],
  },

  onLoad() {
    this.loadList();
  },

  // 发布/编辑返回后刷新
  onShow() {
    this.loadList();
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  loadList() {
    this.setData({ loading: true });
    return wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'list_mine' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const list = (r.success && Array.isArray(r.list) ? r.list : []).map((p) => this.decorate(p));
        this.setData({ list, loading: false });
      })
      .catch((err) => {
        console.error('[myposts] 读取失败:', err && err.errMsg);
        this.setData({ list: [], loading: false });
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  decorate(p) {
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    const loc = [p.province, p.city, p.district].filter(Boolean).join(' ');
    const raw = String(p.raw_text || '').trim();
    const title = raw
      ? (raw.length > 40 ? raw.slice(0, 40) + '…' : raw)
      : `${loc || '全国'}${p.role ? '·' + p.role : meta.name}`;

    // 价格：招工/求职=salary；其余=price
    let priceText = '';
    const isSalary = p.data_type === 'recruit' || p.data_type === 'jobseek';
    if (isSalary) {
      const v = Number(p.data_type === 'jobseek' ? (p.salary_expect || p.salary) : p.salary) || 0;
      priceText = v > 0 ? `${v} 元/月` : '面议';
    } else {
      const v = Number(p.price) || 0;
      priceText = v > 0 ? `${fmtMoney(v)} 元` : '面议';
    }
    if (p.data_type === 'carpool_car' || p.data_type === 'carpool_person') {
      priceText = [p.from_place, p.to_place].filter(Boolean).join(' → ') || '顺风车';
    }

    // 审核状态
    const reviewing = p.needs_review === true || p.needs_review === 'true';
    return {
      id: p._id,
      data_type: p.data_type,
      typeName: meta.name,
      color: meta.color,
      light: meta.light,
      title,
      priceText,
      image: p.image || '',
      meta: `${loc || '未知地区'} · ${fmtAgo(p.published_at)}`,
      reviewing,
      statusText: reviewing ? '审核中' : '已发布',
      statusTheme: reviewing ? 'warning' : 'success',
      status: p.status || '',
    };
  },

  // ---------- 编辑 ----------
  onEdit(e) {
    const { id, type } = e.currentTarget.dataset;
    if (!id) return;
    // 招工走独立发布页 publish_recruit；顺风车两类走独立发布页 publish_carpool；
    // 其余走通用发布页 publish（都带 id 进入编辑态）
    if (type === 'recruit') {
      wx.navigateTo({ url: `/pages/publish_recruit/publish_recruit?id=${id}` });
      return;
    }
    if (type === 'carpool_car' || type === 'carpool_person') {
      wx.navigateTo({ url: `/pages/publish_carpool/publish_carpool?id=${id}` });
      return;
    }
    wx.navigateTo({ url: `/pages/publish/publish?type=${type}&id=${id}` });
  },

  // ---------- 删除 ----------
  onDelete(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.setData({ pendingDeleteId: id, deleteDialogVisible: true });
  },
  onDeleteDialogClose() {
    this.setData({ deleteDialogVisible: false, pendingDeleteId: '' });
  },
  onDeleteConfirm() {
    const id = this.data.pendingDeleteId;
    if (!id || this.data.deleting) return;
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'delete', _id: id }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        this.setData({ deleting: false });
        if (r.success) {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.setData({ deleteDialogVisible: false, pendingDeleteId: '' });
          this.loadList();
        } else {
          wx.showToast({ title: r.message || '删除失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ deleting: false });
        console.error('[myposts] 删除失败:', err && err.errMsg);
        wx.showToast({ title: '删除失败，请重试', icon: 'none' });
      });
  },

  // 点卡片进详情
  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // ---------- 擦亮（刷新，付费 5 毛） ----------
  onRefresh(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.payForPost(id, 'refresh', '擦亮', '0.5');
  },

  // ---------- 置顶（付费 50 元，有效期 1 天） ----------
  onTop(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.payForPost(id, 'top', '置顶', '50');
  },

  // 通用付费流程：服务端建单 → 集成支付下单 → 拉起支付 → verify 履约
  payForPost(postId, bizType, label, priceText) {
    wx.showModal({
      title: `信息${label}`,
      content: `${label}费用 ${priceText} 元，确认支付？`,
      confirmText: '去支付',
      success: (res) => {
        if (!res.confirm) return;
        this.doPay(postId, bizType, label);
      },
    });
  },

  async doPay(postId, bizType, label) {
    const { callPayCommon, pickPayment } = require('../../utils/pay.js');
    wx.showLoading({ title: '下单中…', mask: true });
    try {
      // 1) 服务端建单
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: bizType, post_id: postId },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 0;
      if (!outTradeNo || !amount) throw new Error('下单参数异常');

      // 2) 调集成支付函数下单
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || `信息${label}`,
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
      });
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const payParams = pickPayment(order);
      if (!payParams || !payParams.package) {
        console.error('[myposts] 未取到 package，完整返回：', order);
        throw new Error('下单失败：未获取到支付参数');
      }

      // 3) 拉起微信支付
      wx.hideLoading();
      await new Promise((resolve, reject) => {
        wx.requestPayment({
          timeStamp: String(payParams.timeStamp || ''),
          nonceStr: payParams.nonceStr || '',
          package: payParams.package,
          signType: payParams.signType || 'RSA',
          paySign: payParams.paySign || '',
          success: resolve,
          fail: reject,
        });
      });

      // 4) verify 履约
      wx.showLoading({ title: '处理中…', mask: true });
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      wx.hideLoading();
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || `${label}失败`);

      wx.showToast({ title: `${label}成功`, icon: 'success' });
      this.loadList();
    } catch (err) {
      wx.hideLoading();
      console.error(`[myposts] ${label}失败:`, err && (err.errMsg || err.message));
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },

  // ---------- 下架（免费） ----------
  onOffline(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.showModal({
      title: '下架信息',
      content: '下架后该信息将不在首页展示，可随时重新上架。',
      confirmText: '下架',
      success: (res) => {
        if (!res.confirm) return;
        this.toggleOffline(id, 'offline');
      },
    });
  },

  // ---------- 上架（免费） ----------
  onOnline(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.toggleOffline(id, 'online');
  },

  toggleOffline(id, action) {
    wx.showLoading({ title: '处理中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action, _id: id }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        if (r.success) {
          wx.showToast({ title: action === 'offline' ? '已下架' : '已上架', icon: 'success' });
          this.loadList();
        } else {
          wx.showToast({ title: r.message || '操作失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[myposts] 上下架失败:', err && err.errMsg);
        wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      });
  },

  // 底部 TabBar 切换（myposts 是独立页，跨页用 reLaunch 清栈）
  onTabBar(e) {
    const key = e.detail.value;
    // 发布：在当前页弹类型选择弹层（同 demo 弹层）
    if (key === 'publish') { this.openPublishSheet(); return; }
    if (key === 'nearby') { wx.reLaunch({ url: '/pages/nearby/nearby' }); return; }
    if (key === 'message') { wx.reLaunch({ url: '/pages/message/message' }); return; }
    if (key === 'me') { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/mine/mine' }) }); return; }
    // home：回首页
    if (key === 'home') { wx.reLaunch({ url: '/pages/demo/demo' }); return; }
  },

  // ---------- 发布类型选择弹层（同 demo 首页） ----------
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

  // 去发布（空态点击"去发布"按钮）：在当前页直接弹出发布类型选择弹层
  goPublish() {
    this.openPublishSheet();
  },
});
