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
const { callPayCommon, pickPayment } = require('../../utils/pay.js');

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
    // 是否本人帖子(是则底部展示"编辑/删除")
    isMine: false,
    // 删除确认
    deleteDialogVisible: false,
    deleting: false,
    // 当前帖子是否已被我收藏
    isFav: false,
    faving: false,
    contactText: '',   // 供复制/拨打的可复制联系方式文本
    canContact: false,
    // 查看电话付费：revealedPhone=已付费后展示的完整号；paying=支付中防重复
    revealedPhone: '',
    paying: false,
    // 详情加载骨架屏：模拟 徽章+标题 → 封面图 → 关键信息行 → 描述 的垂直布局（纯 TDesign row-col）
    skeletonRows: [
      [{ width: '24%', height: '40rpx', type: 'rect' }],
      [{ width: '92%', height: '48rpx', type: 'text' }],
      [{ width: '100%', height: '300rpx', type: 'rect' }],
      [{ width: '100%', height: '40rpx', type: 'text' }],
      [{ width: '100%', height: '40rpx', type: 'text' }],
      [{ width: '100%', height: '40rpx', type: 'text' }],
      [{ width: '100%', height: '40rpx', type: 'text' }],
      [{ width: '100%', height: '60rpx', type: 'text' }],
      [{ width: '94%', height: '28rpx', type: 'text' }],
      [{ width: '88%', height: '28rpx', type: 'text' }],
    ],
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

  // 把原始帖子对象换算成详情展示对象
  // 兼容七种 data_type：招工 recruit / 求职 jobseek / 转让 transfer / 求店 want_shop / 设备出售 equip_sell / 设备求购 equip_buy / 顺风车 carpool_car|carpool_person
  decorateItem(p) {
    const isJobseek = p.data_type === 'jobseek';
    const isTransfer = p.data_type === 'transfer';
    const isWantShop = p.data_type === 'want_shop';
    const isShop = isTransfer || isWantShop; // 转让/求店(共用 price 主价格)
    const isEquipSell = p.data_type === 'equip_sell';
    const isEquipBuy = p.data_type === 'equip_buy';
    const isEquip = isEquipSell || isEquipBuy; // 二手设备(共用 price/cond)
    const isCarpoolCar = p.data_type === 'carpool_car';
    const isCarpoolPerson = p.data_type === 'carpool_person';
    const isCarpool = isCarpoolCar || isCarpoolPerson; // 顺风车(无价格)
    const isOther = p.data_type === 'other'; // 其他(通用信息流，无薪资/专项)
    const rawRaw = String(p.raw_text || '').trim();      // 未脱敏原文（内部用于识别电话）
    const contactRaw = p.contact ? String(p.contact).trim() : ''; // 未脱敏联系文本
    const addressRaw = p.address ? String(p.address).trim() : ''; // 未脱敏地址
    // 备注来源随类型：求职用 salary_note；其它无独立备注
    const noteRaw = isJobseek ? String(p.salary_note || '').trim() : '';
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
    // 类型视觉：招工蓝 / 求职紫 / 转让橙 / 求店青 / 出售橙 / 求购绿 / 车找人蓝 / 人找车绿 / 其他灰（与各频道页一致）
    const typeMeta = isJobseek
      ? { name: '求职', color: '#9254DE', bg: '#F3E8FB' }
      : isTransfer
        ? { name: '转让', color: '#FF7A45', bg: '#FFF1E8' }
        : isWantShop
          ? { name: '求店', color: '#36CFC9', bg: '#E6FFFB' }
          : isEquipSell
            ? { name: '设备出售', color: '#FA8C16', bg: '#FFF7E6' }
            : isEquipBuy
              ? { name: '设备求购', color: '#73D13D', bg: '#F6FFED' }
              : isCarpoolCar
                ? { name: '车找人', color: '#597EF7', bg: '#EAF0FF' }
                : isCarpoolPerson
                  ? { name: '人找车', color: '#73D13D', bg: '#F6FFED' }
                  : isOther
                    ? { name: '其他', color: '#8C8C8C', bg: '#F0F0F0' }
                    : { name: '招工', color: '#597EF7', bg: '#EAF0FF' };
    const typeName = typeMeta.name;
    const typeColor = typeMeta.color;
    const typeBg = typeMeta.bg;

    // 角色名（岗位/店铺类型；二手设备/顺风车/其他无 role，用空）
    const role = p.role || (isJobseek ? '师傅' : isShop ? '店铺' : isEquip || isCarpool || isOther ? '' : '招师傅');

    // 金额格式化：≥1万 显示"x万/xx.x万"，否则显示数字
    const fmtWan = (n) => {
      const num = Number(n) || 0;
      if (num <= 0) return '';
      if (num >= 10000) {
        const w = num / 10000;
        const rounded = Math.round(w * 10) / 10;
        return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '万';
      }
      return String(num);
    };

    // 成数(0-10) → 中文
    const condLabel = (c) => {
      const n = Number(c) || 0;
      if (n >= 10) return '全新';
      if (n >= 9) return '九成新';
      if (n >= 8) return '八成新';
      if (n >= 7) return '七成新';
      if (n >= 6) return '六成新';
      if (n >= 5) return '五成新';
      if (n >= 4) return '四成新';
      if (n >= 3) return '三成新';
      if (n >= 2) return '二成新';
      if (n >= 1) return '一成新';
      return '需维修/较旧';
    };

    // —— 主价格文本（按类型语义） ——
    let salaryText = '';       // 招聘给价 / 求职期望
    let shopPriceText = '';    // 转让费 / 预算
    let equipPriceText = '';   // 设备售价 / 求购预算
    let otherPriceText = '';   // 其他(有明示价才显示，否则空)
    if (isJobseek) {
      const exp = Number(p.salary_expect) > 0 ? Number(p.salary_expect) : Number(p.salary) || 0;
      salaryText = exp > 0 ? `${exp} 元/月（期望）` : '面议';
    } else if (isTransfer) {
      shopPriceText = Number(p.price) > 0 ? `${fmtWan(p.price)} 元` : '面议';
    } else if (isWantShop) {
      shopPriceText = Number(p.price) > 0 ? `${fmtWan(p.price)} 元` : '面议';
    } else if (isEquip) {
      equipPriceText = Number(p.price) > 0 ? `${fmtWan(p.price)} 元` : '面议';
    } else if (isOther) {
      otherPriceText = Number(p.price) > 0 ? `${fmtWan(p.price)} 元` : '';
    } else {
      salaryText = Number(p.salary) > 0 ? `${Number(p.salary)} 元/月` : '面议';
    }
    // 二手设备几成新（出售=当前成色 / 求购=期望成色）
    const equipCondText = isEquip && Number(p.cond) > 0 ? condLabel(p.cond) : '';
    const salaryNote = noteMasked;

    // 求职专属
    const availability = isJobseek ? (p.availability || '') : '';     // 到岗方式
    const serviceArea = isJobseek ? (p.service_area || '') : '';      // 可服务地区
    const wants = isJobseek && Array.isArray(p.want_terms) ? p.want_terms : []; // 诉求
    // 招聘工作条件 / 通用 tags
    const conds = !isJobseek && !isShop && Array.isArray(p.tags) ? p.tags : [];

    // —— 转让/求店 专属展示 ——
    // 转让：月租/面积/日营业额/带设备/转让条件
    const monthlyRentText = isTransfer && Number(p.monthly_rent) > 0 ? `${Number(p.monthly_rent)} 元/月` : '';
    const areaText = isTransfer && Number(p.area_sqm) > 0 ? `${Number(p.area_sqm)} ㎡` : '';
    const dailyRevText = isTransfer && Number(p.daily_revenue) > 0 ? `${Number(p.daily_revenue)} 元/天` : '';
    const equipText = isTransfer && p.has_equipment ? String(p.has_equipment) : ''; // 带设备：全带/部分/不带
    const shopConds = isTransfer && Array.isArray(p.terms) && p.terms.length ? p.terms : []; // 转让条件
    // 求店：租金上限/面积下限/求店诉求
    const rentMaxText = isWantShop && Number(p.rent_max) > 0 ? `${Number(p.rent_max)} 元/月` : '';
    const areaMinText = isWantShop && Number(p.area_min) > 0 ? `${Number(p.area_min)} ㎡起` : '';
    const wantShopTerms = isWantShop && Array.isArray(p.want_terms) && p.want_terms.length ? p.want_terms : []; // 求店诉求

    // —— 顺风车 专属展示（出发地/目的地/出发时间/最晚/可乘人数，无价格） ——
    const carFrom = isCarpool ? String(p.from_place || '').trim() : '';
    const carTo = isCarpool ? String(p.to_place || '').trim() : '';
    const carDepart = isCarpool ? String(p.depart_time || '').trim() : '';
    const carDeadline = isCarpool ? String(p.depart_deadline || '').trim() : '';
    const carSeats = isCarpool && Number(p.seats) > 0 ? Number(p.seats) : 0;
    const carSeatsLabel = carSeats > 0 ? (isCarpoolCar ? `剩余 ${carSeats} 座` : `${carSeats} 人`) : '';

    // 原文标题(首行)+全文（已脱敏）
    const lines = rawMasked.split('\n').filter((s) => s.trim().length);
    const titleFallback = isJobseek ? (role + '求职')
      : isTransfer ? (role + '转让')
      : isWantShop ? (role + '求租')
      : isEquip ? typeName
      : isCarpool ? ((carFrom || '') + '到' + (carTo || '') + (typeName))
      : isOther ? typeName
      : ('招' + role);
    const title = lines[0] || `${regionText}${titleFallback}`;
    const body = lines.slice(1).join('\n').trim() || rawMasked;

    return {
      id: p._id,
      data_type: p.data_type || '',
      isJobseek,
      isTransfer,
      isWantShop,
      isShop,
      isEquipSell,
      isEquipBuy,
      isEquip,
      isCarpoolCar,
      isCarpoolPerson,
      isCarpool,
      isOther,
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
      // 转让/求店 专属
      shopPriceText,
      priceKeyLabel: isTransfer ? '转让费' : '预算',
      monthlyRentText,
      areaText,
      dailyRevText,
      equipText,
      shopConds,
      rentMaxText,
      areaMinText,
      wantShopTerms,
      // 二手设备 专属
      equipPriceText,
      equipPriceKeyLabel: isEquipSell ? '售价' : '求购预算',
      equipCondText,
      equipCondKeyLabel: isEquipSell ? '新旧程度' : '期望成色',
      // 顺风车 专属
      carFrom,
      carTo,
      carDepart,
      carDeadline,
      carSeats,
      carSeatsLabel,
      // 其他 专属
      otherPriceText,
      // 发布者
      username: p.username || '',
      creditMeta: CREDIT_META[Number(p.credit)] || null,
      // 求职到岗/服务区域
      availability,
      serviceArea,
      // 时间
      agoText: fmtAgo(p.published_at),
      publishedText: fmtDateTime(p.published_at),
      // 浏览点击量
      views: Number(p.views) || 0,
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
    this.setData({ d, isMine: !!rawItem.isMine, loading: false, loadError: '' });
    // 缓存未命中(走了兜底查库)时，顺手把原始对象写回缓存，供下次重复看零请求
    this.backfillCache(rawItem);
    // 判断当前帖子是否已被我收藏
    this.checkFav(rawItem._id);
    // 浏览量 +1（前端节流：同一帖子 10 秒内不重复上报）
    this.reportView(rawItem._id);
  },

  // 浏览量上报：进详情页 +1，10 秒内同一帖子不重复
  reportView(id) {
    if (!id) return;
    const now = Date.now();
    const last = wx.getStorageSync('last_view_ts') || {};
    if (last[id] && now - last[id] < 10000) return; // 10 秒内不重复
    last[id] = now;
    wx.setStorageSync('last_view_ts', last);
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'view', _id: id }, config: { timeout: 10000 } })
      .catch(() => {});
  },

  // 查询当前帖子是否已收藏
  checkFav(id) {
    if (!id) return;
    wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'check', post_ids: [id] }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        const favMap = r.favMap || {};
        this.setData({ isFav: !!favMap[id] });
      })
      .catch(() => {});
  },

  // 收藏 / 取消收藏
  onToggleFav() {
    if (this.data.faving) return;
    const id = this._id;
    if (!id) return;
    this.setData({ faving: true });
    wx.cloud
      .callFunction({ name: 'favorite', data: { action: 'toggle', post_id: id }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        this.setData({ faving: false });
        if (r.success) {
          const isFav = !!r.is_fav;
          this.setData({ isFav });
          wx.showToast({ title: isFav ? '已收藏' : '已取消收藏', icon: 'none' });
        } else {
          wx.showToast({ title: r.message || '操作失败', icon: 'none' });
        }
      })
      .catch((err) => {
        this.setData({ faving: false });
        console.error('[detail] 收藏失败:', err && err.errMsg);
        wx.showToast({ title: '操作失败，请重试', icon: 'none' });
      });
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

  // 底部"查看联系方式"按钮：付费后展示完整联系方式（与"查看电话"同一流程）
  onViewContact() {
    this.payForContact();
  },

  // 顶部"查看电话"按钮：付费 1 分钱查看完整手机号
  onRevealPhone() {
    this.payForContact();
  },

  // 统一付费查看流程（严格按官方文档）：
  //   1) reveal 查是否已付费 → 已付费直接展示，不重复收费
  //   2) wx.cloud.callHTTPFunction 调 pay-common 下单（/wx-pay/wxpay_order）
  //   3) wx.requestPayment 拉起微信支付
  //   4) 支付成功 → markPaid 记录付费
  //   5) reveal 取完整手机号 → 展示并拨号
  async payForContact() {
    const postId = this._id;
    if (!postId) return;
    // 已展示过完整号，直接拨号
    if (this.data.revealedPhone) {
      this.callPhone(this.data.revealedPhone);
      return;
    }
    if (this.data.paying) return;
    this.setData({ paying: true });

    try {
      // 1) 是否已付费
      const check = await this.callPay('reveal', postId);
      if (check.success && check.phone) {
        this.showPhone(check.phone);
        return;
      }

      // 2) 下单（无需传 payer.openid，平台自动注入 x-wx-openid）
      const outTradeNo = `BZ${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const order = await callPayCommon('wxpay_order', {
        description: '查看联系电话',
        out_trade_no: outTradeNo,
        amount: { total: 1, currency: 'CNY' }, // 单位：分（1 分钱）
      });
      console.log('[detail] 下单返回:', JSON.stringify(order));
      // 仅当明确返回了非 0 的 code 才判定失败（不同结构下 code 可能缺位）
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const p = pickPayment(order);
      console.log('[detail] 支付参数:', JSON.stringify(p));
      if (!p || !p.package) {
        console.error('[detail] 未取到 package，完整返回如下:', order);
        throw new Error('下单失败：未获取到 package');
      }

      // 3) 拉起支付
      await new Promise((resolve, reject) => {
        wx.requestPayment({
          timeStamp: String(p.timeStamp || ''),
          nonceStr: p.nonceStr || '',
          package: p.package,
          signType: p.signType || 'RSA',
          paySign: p.paySign || '',
          success: resolve,
          fail: reject,
        });
      });

      // 4) 支付成功 → 记录付费
      await this.callPay('markPaid', postId, outTradeNo);

      // 5) 取完整号
      const reveal = await this.callPay('reveal', postId);
      if (!reveal.success || !reveal.phone) {
        throw new Error(reveal.message || '获取电话失败');
      }
      this.showPhone(reveal.phone);
    } catch (err) {
      console.error('[detail] 付费查看失败:', err && (err.errMsg || err.message));
      this.setData({ paying: false });
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },

  // 调用 payForPhone 云函数（reveal 取号 / markPaid 记付费）
  callPay(action, postId, outTradeNo) {
    return wx.cloud.callFunction({
      name: 'payForPhone',
      data: { action, post_id: postId, out_trade_no: outTradeNo || '' },
      config: { timeout: 10000 },
    }).then((res) => res.result || {});
  },

  // 展示完整号并自动拨号
  showPhone(phone) {
    this.setData({ revealedPhone: phone, paying: false });
    wx.showToast({ title: '已获取电话', icon: 'success' });
    this.callPhone(phone);
  },

  // 拨打完整号
  callPhone(phone) {
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone }).catch(() => {});
  },

  // ---------- 本人帖子：编辑 / 删除 ----------
  // 按 data_type 路由到对应编辑页（招工→publish_recruit；顺风车→publish_carpool；其余→通用 publish?type=）
  onEdit() {
    const d = this.data.d;
    const id = this._id;
    if (!id || !d) return;
    const type = d.data_type;
    if (type === 'recruit') { wx.navigateTo({ url: `/pages/publish_recruit/publish_recruit?id=${id}` }); return; }
    if (type === 'carpool_car' || type === 'carpool_person') { wx.navigateTo({ url: `/pages/publish_carpool/publish_carpool?id=${id}` }); return; }
    wx.navigateTo({ url: `/pages/publish/publish?type=${type}&id=${id}` });
  },

  onDelete() {
    if (!this._id) return;
    this.setData({ deleteDialogVisible: true });
  },
  onDeleteDialogClose() {
    this.setData({ deleteDialogVisible: false });
  },
  onDeleteConfirm() {
    const id = this._id;
    if (!id || this.data.deleting) return;
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'delete', _id: id }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        this.setData({ deleting: false, deleteDialogVisible: false });
        if (r.success) {
          wx.showToast({ title: '已删除', icon: 'success' });
          // 返回上一页(通常是列表)，并提示刷新
          setTimeout(() => wx.navigateBack(), 900);
        } else {
          wx.showToast({ title: r.message || '删除失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ deleting: false });
        console.error('[detail] 删除失败:', err && err.errMsg);
        wx.showToast({ title: '删除失败，请重试', icon: 'none' });
      });
  },
});
