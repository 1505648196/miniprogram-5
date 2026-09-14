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
const { loadAds, openAdLink } = require('../../utils/ad.js');

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
      // 是否管理员（决定「转发」按钮是否显示）—— 调 adminAuth.check_admin 判定
      isAdmin: false,
      // 转发到朋友圈：编辑弹窗（管理员点「转发」先预览/改文案，确认后才下单）
      forwardDialogVisible: false,
      forwardText: '',
      forwarding: false,
      forwardError: '',
    // 删除确认
    deleteDialogVisible: false,
    deleting: false,
    // 当前帖子是否已被我收藏
    isFav: false,
    faving: false,
    contactText: '',   // 供复制/拨打的可复制联系方式文本
    canContact: false,
    // 电话权限：
    //   canCall = 已具备拨打权限（会员免费 或 已付费）
    //   isVip   = 当前是否会员（决定按钮文案与是否免付费）
    // ⚠️ 完整号码只存 this._phone（页面实例），**不 setData 渲染到界面**，
    //    避免被复制/截图/爬虫抓取，降低隐私泄露与骚扰风险。
    canCall: false,
    isVip: false,
    paying: false,
    // 详情页顶部卡片广告（方案 C：ad_slots 里 page=detail, position=top_card）
    detailAds: [],
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

  // 分享给好友：标题用帖子标题，路径带上 id 让好友直达详情页
  onShareAppMessage() {
    const d = this.data.d;
    const id = this._id || '';
    const title = d && d.title ? d.title : '包子行业信息';
    return {
      title,
      path: id ? `/pages/detail/detail?id=${id}` : '/pages/demo/demo',
    };
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ loading: false, loadError: '缺少帖子标识' });
      wx.hideLoading();
      return;
    }
    this._id = id;
    // 判断当前用户是否管理员（决定「转发」按钮是否显示；免口令，只返回布尔值）
    this.checkAdmin();
    // 拉取详情页顶部卡片广告（方案 C，与帖子内容并行，互不阻塞）
    this.loadDetailAds();
    // 1) 先看列表缓存是否命中(零云调用)
    const hit = this.fromCache(id);
    if (hit) {
      this.applyItem(hit);
      return;
    }
    // 2) 缓存未命中 → 兜底查库
    this.fetchRemote(id);
  },

  // 详情页顶部卡片广告：page=detail, position=top_card
  async loadDetailAds() {
    const groups = await loadAds('detail', ['top_card']);
    const list = (groups.top_card || []).map((a) => {
      // 兼容两种图片来源：单图 image 字段 / 轮播多图 images 数组（取第一张）
      let img = a.image || '';
      if (!img && Array.isArray(a.images) && a.images.length) {
        img = a.images[0] || '';
      }
      return {
        id: a._id,
        image: img,
        title: a.title || '',
        link: a.link || '',
        linkType: a.linkType || 'none',
        target: a.target || '',
      };
    });
    this.setData({ detailAds: list });
  },

  // 点击顶部卡片广告
  onDetailAdTap(e) {
    const item = e.currentTarget.dataset.item;
    openAdLink(item);
  },

  // 判断当前登录用户是否管理员（决定「转发」按钮显隐）
  // 用云函数服务端 OPENID 比对白名单，普通用户无法伪造；只拿布尔值，不泄露数据
  checkAdmin() {
    wx.cloud
      .callFunction({ name: 'adminAuth', data: { action: 'check_admin' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        const isAdmin = !!r.isAdmin;
        if (isAdmin !== this.data.isAdmin) this.setData({ isAdmin });
        // 管理员：详情页直接显示完整手机号（不用付费/会员），并解锁直接拨打
        if (isAdmin) this.revealPhoneForAdmin();
      })
      .catch(() => {
        // 失败按非管理员处理，不显示按钮，不影响其他功能
      });
  },

  // 管理员专属：把详情里的脱敏号换成完整号，并把按钮切成可拨打
  // （云函数 adminAuth 的 post_phone 动作，服务端读 baozi_posts.phone，带管理员鉴权）
  async revealPhoneForAdmin() {
    if (!this._id) return;
    const real = await this.fetchRealPhone();
    if (!real) return;
    // 详情数据可能还没到位（缓存未命中时要等云函数返回），最多等 3 秒
    for (let i = 0; i < 30 && !this.data.d; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!this.data.d) return;
    this.setData({ 'd.phonesText': real, 'd.hasPhone': true, canCall: true });
  },

  // ------------------------- 转发到朋友圈（管理员专属） -------------------------
  //
  // 链路：点「转发」→ 弹窗预览/编辑文案 → 确认 → 调云函数 wxTask(action='create')
  //      写任务入库 → 云函数经 relay 推送唤醒本机 Worker → 本机微信发布朋友圈。
  //
  // 注意：下单成功 ≠ 已发出。真正发布依赖电脑上常驻的 WXLauncher
  //      （已注入 + 桥 :8080 + Worker）。本机没开时任务会排队，上线后自动补发。

  // 把详情数据拼成朋友圈文案（与后台 buildMomentText 保持同一套口径）
  buildForwardText(d) {
    if (!d) return '';
    const lines = [];

    // 首行：【类型】地区 角色
    const head = [`【${d.typeName || ''}】`, d.regionText || '', d.role && d.role !== '-' ? d.role : '']
      .filter(Boolean)
      .join(' ');
    if (head) lines.push(head);

    // 标题（详情页主标题，通常是最有信息量的一行）
    if (d.title) lines.push(d.title);

    // 价格/薪资（面议不单列，避免噪音）
    const price = d.isEquip ? d.equipPriceText
      : d.isTransfer || d.isWantShop ? d.shopPriceText
        : d.isOther ? d.otherPriceText
          : d.salaryText;
    if (price && price !== '-' && price !== '面议') {
      const isSalary = !!(d.isRecruit || d.isJobseek || d.isShop);
      lines.push(`${isSalary ? '薪资' : '价格'}：${price}`);
    }

    // 正文（朋友圈纯文本，超长截断）
    const body = (d.body || '').trim();
    if (body) lines.push(body.length > 120 ? `${body.slice(0, 120)}…` : body);

    // 地址
    if (d.address) lines.push(`地址：${d.address}`);

    // 联系方式（详情页已脱敏，发朋友圈用的也是这版）
    // 注意：没有电话时也要把这一行显出来（写「无」），让人一眼知道这条没留电话
    const phone = (d.phonesText || d.contactText || '').trim();
    lines.push(`联系电话：${phone || '无'}`);

    lines.push('感谢包子一哥传媒');
    return lines.join('\n');
  },

  // 点悬浮「转发」按钮：
  //   朋友圈是给潜在客户看的，脱敏号（138****5678）发出去根本没法联系，
  //   所以先找云函数要完整号替换掉，再弹编辑窗让管理员过一眼。
  async onWxForward() {
    let text = this.buildForwardText(this.data.d);
    if (!text) {
      wx.showToast({ title: '帖子内容还没加载完', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '准备文案…', mask: true });
    try {
      const real = await this.fetchRealPhone();
      if (real) text = text.replace(/联系电话：.*$/m, `联系电话：${real}`);
    } catch (e) {
      // 拿不到就沿用脱敏号，不阻断流程（弹窗里还能手动改）
    }
    wx.hideLoading();

    this.setData({ forwardDialogVisible: true, forwardText: text, forwardError: '' });
  },

  // 管理员专属：取该帖完整手机号（云函数 adminAuth 的 post_phone 动作，带管理员鉴权）
  // 注意：不复用 payForPhone 的 reveal —— 那个有付费/会员门槛 + 单日频控
  // 说明：该能力原挂在 wxTask（转发任务中心），职责错配且 openid 取值不稳定，
  //       已统一收敛到 adminAuth（管理员专用，鉴权与 check_admin 同源）。
  fetchRealPhone() {
    if (this._fullPhone) return Promise.resolve(this._fullPhone);
    return wx.cloud
      .callFunction({
        name: 'adminAuth',
        data: { action: 'post_phone', postId: this._id },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = (res && res.result) || {};
        const phone = r.success ? String(r.phone || '').trim() : '';
        if (phone) this._fullPhone = phone;
        return phone;
      })
      .catch(() => '');
  },

  onForwardInput(e) {
    this.setData({ forwardText: e.detail.value });
  },

  onForwardCancel() {
    this.setData({ forwardDialogVisible: false, forwardError: '' });
  },

  // 确认转发：取在线号 → 建任务
  onForwardConfirm() {
    if (this.data.forwarding) return;
    const content = (this.data.forwardText || '').trim();
    if (!content) {
      this.setData({ forwardError: '文案不能为空' });
      return;
    }

    this.setData({ forwarding: true, forwardError: '' });

    // 1) 问云函数当前在线的微信号（本机 Worker 挂着长连就会出现在里面）
    wx.cloud
      .callFunction({ name: 'wxTask', data: { action: 'online' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        const online = ((r.data || {}).online) || [];
        if (!online.length) {
          throw new Error('本机未上线：请确认电脑上的 WXLauncher 已启动并连接');
        }
        return this.createForwardTask(online[0], content);
      })
      .catch((err) => {
        this.setData({
          forwarding: false,
          forwardError: (err && err.message) || '提交失败，请稍后再试',
        });
      });
  },

  // 真正下单
  createForwardTask(wxid, content) {
    return wx.cloud
      .callFunction({
        name: 'wxTask',
        data: { action: 'create', wxid, content },
        config: { timeout: 15000 },
      })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.success) throw new Error(r.message || '提交失败');

        this.setData({ forwarding: false, forwardDialogVisible: false });
        wx.showToast({ title: '已提交，稍后自动发布', icon: 'success', duration: 2200 });

        // 给个明确的"去哪儿看结果"的引导
        setTimeout(() => {
          wx.showModal({
            title: '已提交',
            content: '任务已进入队列，本机微信会自动发布到朋友圈。若本机没开，任务会排队等上线后补发。',
            showCancel: false,
            confirmText: '知道了',
          });
        }, 2400);
      })
      .catch((err) => {
        this.setData({
          forwarding: false,
          forwardError: (err && err.message) || '提交失败，请稍后再试',
        });
      });
  },

  // 页面首次渲染完成后：关闭列表页跳转时展示的 loading
  // （放在 onReady 而非数据就绪回调，保证 loading 稳定持续到详情页真正显示出来，
  //   不会被缓存命中的同步快路径瞬间清掉，用户能看到明确的"加载中"反馈）
  onReady() {
    wx.hideLoading();
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
    // 查会员状态（会员可免费拨打电话）
    this.loadVip();
    // 浏览量 +1（前端节流：同一帖子 10 秒内不重复上报）
    this.reportView(rawItem._id);
  },

  // 查当前是否会员 → 会员免费查看/拨打电话
  loadVip() {
    return wx.cloud
      .callFunction({ name: 'memberService', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        this.setData({ isVip: !!r.isVip });
      })
      .catch(() => {});
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

  // 底部"查看联系方式"按钮：会员免费 / 付费后拨打电话（与"查看电话"同一流程）
  onViewContact() {
    this.payForContact();
  },

  // 顶部"查看电话"按钮：会员免费 / 付费后拨打电话（明文不渲染）
  onRevealPhone() {
    this.payForContact();
  },

  // 统一查看电话流程：
  //   1) reveal 查权限：会员免费 / 已付费 → 服务端返回完整号 + 频控 + 记日志
  //   2) 未付费非会员 → 走支付（create 建单 → wxpay_order → requestPayment → verify）
  //   3) 拿到号后只存 this._phone 并直接拨号，**不渲染明文到界面**
  async payForContact() {
    const postId = this._id;
    if (!postId) return;
    // 已拿到过完整号 → 直接拨号
    if (this._phone) {
      this.callPhone(this._phone);
      return;
    }
    if (this.data.paying) return;
    this.setData({ paying: true });
    // 立即给反馈：发起支付前要串行经过 reveal/create/下单 多次云调用，用 loading 消除"点了没反应"的空白感
    wx.showLoading({ title: '正在发起支付…', mask: true });

    try {
      // 1) 会员免费 / 已付费 → 直接拿到号
      const check = await this.callPay('reveal', postId);
      if (check.success && check.phone) {
        this._phone = check.phone;
        this.setData({ paying: false, canCall: true });
        this.callPhone(check.phone);
        return;
      }

      // 2) 服务端建单：拿 out_trade_no + 权威金额（防伪造订单号 / 防改价）
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: 'phone', post_id: postId },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      // 已付费（重复点击 / 并发）→ 直接取号，不重复扣费
      if (cr.already_paid) {
        const already = await this.callPay('reveal', postId);
        if (already.success && already.phone) {
          this._phone = already.phone;
          this.setData({ paying: false, canCall: true });
          this.callPhone(already.phone);
          return;
        }
      }
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 1; // 单位：分
      if (!outTradeNo) throw new Error('下单参数异常');

      // 3) 调集成支付函数下单（无需传 payer.openid，平台自动注入 x-wx-openid）
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || '查看联系电话',
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
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

      // 4) 拉起支付（先隐藏 loading，避免遮挡系统支付面板）
      wx.hideLoading();
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

      // 5) 支付成功 → 服务端校验订单并履约（幂等，重复核销不重复记录）
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || '支付核销失败');

      // 6) 取完整号并拨号（明文只存实例，不渲染）
      const reveal = await this.callPay('reveal', postId);
      if (!reveal.success || !reveal.phone) {
        throw new Error(reveal.message || '获取电话失败');
      }
      this._phone = reveal.phone;
      this.setData({ paying: false, canCall: true });
      this.callPhone(reveal.phone);
    } catch (err) {
      console.error('[detail] 查看电话失败:', err && (err.errMsg || err.message));
      wx.hideLoading();
      this.setData({ paying: false });
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },

  // 调用 payForPhone 云函数（reveal 取号）
  callPay(action, postId, outTradeNo) {
    return wx.cloud.callFunction({
      name: 'payForPhone',
      data: { action, post_id: postId, out_trade_no: outTradeNo || '' },
      config: { timeout: 10000 },
    }).then((res) => res.result || {});
  },

  // 拨打完整号（号码只存实例，绝不渲染到界面，防复制/截图/抓取）
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

  // ---------- 举报（非本人帖子） ----------
  // 进举报页并带上帖子 id / 类型，便于后台定位；提交由 feedback 云函数校验身份
  onReport() {
    const d = this.data.d;
    const id = this._id;
    if (!id) return;
    const type = (d && d.data_type) || '';
    wx.navigateTo({
      url: `/pages/feedback/feedback?type=report&post_id=${id}&post_type=${type}`,
    });
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
