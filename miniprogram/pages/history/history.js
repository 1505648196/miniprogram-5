// pages/history/history.js
// 包子行业信息平台 · 浏览历史
// 数据源：本地缓存 detail_pool（列表/详情页浏览时写入的原始帖子快照池，key=_id）
// 纯本地读取，无需云函数。

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
    left: [],
    right: [],
    // 清空历史确认
    clearDialogVisible: false,
  },

  onShow() {
    this.loadHistory();
  },

  // 从 detail_pool 缓存读取，按 published_at 倒序，拆成左右两列
  loadHistory() {
    let pool = {};
    try { pool = wx.getStorageSync('detail_pool') || {}; } catch (e) { pool = {}; }
    const items = Object.keys(pool)
      .map((k) => pool[k])
      .filter((p) => p && p._id)
      .sort((a, b) => (b.published_at || 0) - (a.published_at || 0))
      .map((p) => this.decorate(p));
    const left = [];
    const right = [];
    items.forEach((it, i) => { if (i % 2 === 0) left.push(it); else right.push(it); });
    this.setData({ list: items, left, right });
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
      // 纯展示卡用首字段生成缩略，若无图则无 image 字段
    };
  },

  onTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 清空历史
  onClearTap() {
    this.setData({ clearDialogVisible: true });
  },
  onClearClose() {
    this.setData({ clearDialogVisible: false });
  },
  onClearConfirm() {
    try { wx.removeStorageSync('detail_pool'); } catch (e) {}
    this.setData({ clearDialogVisible: false, list: [], left: [], right: [] });
    wx.showToast({ title: '已清空', icon: 'success' });
  },
});
