// pages/detail/detail.js
// 帖子详情页(招聘 recruit / 求职 jobseek 共用，卡片展示结构一致、取值参数不同)
//
// 【省资源策略】
//   - 列表页(recruit)拉 feedPosts 时已下发每条的完整展示快照，并写入 storage key='detail_pool'。
//     本页 onLoad 优先按 id 从缓存命中 → 直接渲染，**零二次云调用**。
//   - 缓存未命中(从分享/收藏/其他入口直达) → 调 managePost(action='detail') 按 _id 兜底查库一次。
//   - 完整手机号/ _openid 不下发，发布者本人不可见项不展示。
//
// 【电话脱敏】
//   - 所有展示文本(title/正文/地址/备注/联系方式)都会过 maskText，把正文里藏的电话识别成 138****5678。
//   - 正文/联系方式里识别出的脱敏号会汇总到"联系电话"单独一栏(phones)。

const privacy = require('../../utils/privacy.js');

const CREDIT_META = {
  1: { label: '信用优秀', color: '#FF7A45', bg: '#FFF1E8' },
  2: { label: '信用极好', color: '#36CFC9', bg: '#E6FFFB' },
  3: { label: '信用良好', color: '#597EF7', bg: '#F0F5FF' },
  4: { label: '信用一般', color: '#8C8C8C', bg: '#F5F5F5' },
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

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    loading: true,
    loadError: '',
    // 详情展示对象(decorateDetail 结果)
    d: null,
    // 是否本人帖子(暂无"编辑/删除"入口，保留字段备用)
    isMine: false,
    contactText: '',   // 供复制/拨打的可复制联系方式文本
    canContact: false,
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ loading: false, loadError: '缺少帖子标识' });
      return;
    }
    this._id = id;
    // 1) 先看列表缓存是否命中(零云调用)
    const hit = this.fromCache(id);
    if (hit) {
      this.applyItem(hit);
      return;
    }
    // 2) 缓存未命中 → 兜底查库
    this.fetchRemote(id);
  },

  // 从列表页写入的 detail_pool 缓存取（存的是 feedPosts 原始帖子对象，含 _id/data_type）
  fromCache(id) {
    try {
      const pool = wx.getStorageSync('detail_pool');
      const d = pool && typeof pool === 'object' ? pool[id] : null;
      if (d && d._id && (d.data_type || d.raw_text)) return d;
    } catch (e) {
      // ignore
    }
    return null;
  },

  // 缓存未命中兜底：managePost(action=detail) 单条查库
  fetchRemote(id) {
    this.setData({ loading: true, loadError: '' });
    wx.cloud
      .callFunction({
        name: 'managePost',
        data: { action: 'detail', _id: id },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success && r.item) {
          this.applyItem(r.item);
        } else {
          this.setData({ loading: false, loadError: r.message || '帖子不存在或审核中' });
        }
      })
      .catch((err) => {
        console.error('[detail] 兜底查库失败:', err && err.errMsg);
        this.setData({ loading: false, loadError: '加载失败，请稍后重试' });
      });
  },

  // 把原始帖子对象换算成详情展示对象(招聘/求职语义对齐列表 decorate)
  decorateItem(p) {
    const isJobseek = p.data_type === 'jobseek';
    const rawRaw = String(p.raw_text || '').trim();      // 未脱敏原文（内部用于识别电话）
    const contactRaw = p.contact ? String(p.contact).trim() : ''; // 未脱敏联系文本
    const addressRaw = p.address ? String(p.address).trim() : ''; // 未脱敏地址
    const noteRaw = isJobseek ? String(p.salary_note || '').trim() : ''; // 未脱敏备注
    const maskedField = p.phone_masked ? String(p.phone_masked).trim() : ''; // 已是脱敏号(138****5678)

    // —— 电话脱敏 ——
    // 1) 从原文+联系文本+地址+备注里识别出所有完整号，统一打成脱敏号集合(去重)，供"联系电话"栏
    const phoneSet = {};
    privacy.extractPhones(`${rawRaw}\n${contactRaw}\n${addressRaw}\n${noteRaw}`).forEach((ph) => {
      phoneSet[ph] = true;
    });
    // 已脱敏的 phone_masked 字段也纳入展示(格式形如 138****5678)
    if (maskedField) phoneSet[maskedField] = true;
    const phones = Object.keys(phoneSet);

    // 2) 所有展示文本统一脱敏：正文/标题里藏的电话被替换成 138****5678
    const rawMasked = privacy.maskText(rawRaw);
    const contactMasked = privacy.maskText(contactRaw);
    const addressMasked = privacy.maskText(addressRaw);
    const noteMasked = privacy.maskText(noteRaw);

    const regionText = [p.province, p.city, p.district].filter(Boolean).join('') || '未知地区';
    const typeName = isJobseek ? '求职' : '招工';
    const typeColor = isJobseek ? '#9254DE' : '#597EF7';   // 类型主色(文字)
    const typeBg = isJobseek ? '#F3E8FB' : '#EAF0FF';      // 类型浅色(底色，让标签更醒目)

    // 角色名
    const role = p.role || (isJobseek ? '师傅' : '招师傅');

    // 薪资
    let salaryText;
    if (isJobseek) {
      const exp = Number(p.salary_expect) > 0 ? Number(p.salary_expect) : Number(p.salary) || 0;
      salaryText = exp > 0 ? `${exp} 元/月（期望）` : '面议';
    } else {
      salaryText = Number(p.salary) > 0 ? `${Number(p.salary)} 元/月` : '面议';
    }
    const salaryNote = noteMasked;

    // 求职专属详情
    const availability = isJobseek ? (p.availability || '') : '';     // 到岗方式
    const serviceArea = isJobseek ? (p.service_area || '') : '';      // 可服务地区
    const wants = isJobseek && Array.isArray(p.want_terms) ? p.want_terms : []; // 诉求
    // 招聘工作条件 / 通用 tags
    const conds = !isJobseek && Array.isArray(p.tags) ? p.tags : [];

    // 原文标题(首行)+全文（已脱敏）
    const lines = rawMasked.split('\n').filter((s) => s.trim().length);
    const title = lines[0] || `${regionText}${isJobseek ? (role + '求职') : '招' + role}`;
    const body = lines.slice(1).join('\n').trim() || rawMasked;

    return {
      id: p._id,
      data_type: p.data_type || '',
      isJobseek,
      typeName,
      typeColor,
      typeBg,
      title,
      body,
      role,
      salaryText,
      salaryNote,
      regionText,
      address: addressMasked,
      // 标签（详情展示用全量）
      wants,
      conds,
      // 发布者
      username: p.username || '',
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      // 求职到岗/服务区域
      availability,
      serviceArea,
      // 时间
      agoText: fmtAgo(p.published_at),
      publishedText: fmtDateTime(p.published_at),
      // 图片(可选)
      image: p.image || '',
      // 联系电话栏：汇总的脱敏号（138****5678 形式，仅展示不泄露完整号）
      phones,
      phonesText: phones.join('、'),
      hasPhone: phones.length > 0,
      // 可复制的文字联系方式(如微信号/QQ/说明)：仅当 contact 本身含"非纯号码"的文字才可复制；
      //   contact 若只是完整手机号/座机，对外只剩脱敏号，无可复制内容。
      contactText: contactMasked || '',
      canCopyContact: !!contactMasked && /\D/.test(contactMasked),
    };
  },

  applyItem(rawItem) {
    const d = this.decorateItem(rawItem);
    if (!d) {
      this.setData({ loading: false, loadError: '数据格式异常' });
      return;
    }
    this.setData({ d, loading: false, loadError: '' });
    // 缓存未命中(走了兜底查库)时，顺手把原始对象写回缓存，供下次重复看零请求
    this.backfillCache(rawItem);
  },

  // 把(兜底查库拿到的)原始对象写回 detail_pool(key=_id)，格式与列表页缓存一致
  backfillCache(rawItem) {
    if (!rawItem || !rawItem._id) return;
    try {
      const pool = wx.getStorageSync('detail_pool') || {};
      pool[rawItem._id] = rawItem;
      // 上限控制，防止越积越多
      const keys = Object.keys(pool);
      if (keys.length > 200) {
        keys.slice(0, keys.length - 200).forEach((k) => delete pool[k]);
      }
      wx.setStorageSync('detail_pool', pool);
    } catch (e) {
      // ignore
    }
  },

  // 底部"查看联系方式"按钮：当前占位，提示开发中，不提供复制。
  // 后续接会员/付费逻辑时：校验通过后展示完整联系方式并开放复制/拨号。
  onViewContact() {
    wx.showToast({ title: '查看联系方式功能开发中', icon: 'none' });
  },

  // 顶部"查看电话"按钮：当前占位，提示开发中。
  // 后续接入付费查看完整号时：改成调用支付/会员校验接口，
  // 校验通过后从云端拿完整 phone(目前不下发)并展示/拨号。
  onRevealPhone() {
    wx.showToast({ title: '查看完整电话功能开发中', icon: 'none' });
  },
});
