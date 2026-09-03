// pages/favorites/favorites.js
// 包子行业信息平台 · 我的收藏
// 数据源：favorite 云函数 list(分页拉我收藏的帖子) / toggle(取消收藏)

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
    list: [], left: [], right: [], page: 1, hasMore: false, loadingMore: false, loading: true, firstLoaded: false,
    skeletonRows: [
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
      [{ width: '48%', height: '220rpx', type: 'rect', marginRight: '4%' }, { width: '48%', height: '180rpx', type: 'rect' }],
    ],
  },
  onShow() { this.loadFirst(); },
  onPullDownRefresh() { this.loadFirst().then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },

  loadFirst() {
    this.setData({ loading: true, loadingMore: false });
    return this.fetchList(1).then((r) => {
      this._all = r.list;
      this.splitCols();
      this.setData({ page: 1, hasMore: r.hasMore, loading: false, firstLoaded: true });
    });
  },
  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const next = this.data.page + 1;
    this.fetchList(next).then((r) => {
      const seen = {};
      this._all.forEach((i) => { seen[i.id] = 1; });
      this._all = this._all.concat(r.list.filter((i) => !seen[i.id]));
      this.splitCols();
      this.setData({ page: next, hasMore: r.hasMore, loadingMore: false });
    });
  },
  fetchList(page) {
    return wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'list', page: page || 1, pageSize: 20 }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (r.success) {
          const items = (r.list || []).map((p) => this.decorate(p));
          return { list: items, hasMore: !!r.hasMore };
        }
        return { list: [], hasMore: false };
      })
      .catch(() => ({ list: [], hasMore: false }));
  },
  splitCols() {
    const left = [];
    const right = [];
    this._all.forEach((it, i) => { if (i % 2 === 0) left.push(it); else right.push(it); });
    this.setData({ list: this._all, left, right });
  },

  decorate(p) {
    const meta = TYPE_META[p.data_type] || TYPE_META.other;
    const loc = [p.province, p.city, p.district].filter(Boolean).join(' ');
    const raw = String(p.raw_text || '').trim();
    const title = raw
      ? (raw.length > 40 ? raw.slice(0, 40) + '…' : raw)
      : `${loc || '全国'}${p.role ? '·' + p.role : meta.name}`;
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
    };
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 取消收藏
  onCancel(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'toggle', post_id: id }, config: { timeout: 10000 } })
      .then(() => {
        wx.showToast({ title: '已取消收藏', icon: 'none' });
        this.loadFirst();
      })
      .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
  },
});
