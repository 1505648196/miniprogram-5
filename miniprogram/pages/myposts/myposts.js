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

Page({
  data: {
    list: [],
    loading: true,
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
    };
  },

  // ---------- 编辑 ----------
  onEdit(e) {
    const { id, type } = e.currentTarget.dataset;
    if (!id) return;
    // 招工走独立发布页；其余走通用发布页（都带 id 进入编辑态）
    if (type === 'recruit') {
      wx.navigateTo({ url: `/pages/publish_recruit/publish_recruit?id=${id}` });
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

  // 去发布
  goPublish() {
    wx.navigateBack();
  },
});
