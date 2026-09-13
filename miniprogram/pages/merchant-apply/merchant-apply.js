// pages/merchant-apply/merchant-apply.js
// 商家入驻申请（C 端）— 对应云函数 merchantApply(action=payload)
// 提交字段集合：name/category/address/business_hours/phone/intro/avatar/photos/wechat_qr/license_img/invite_code/plan/agreed
// 支付：高级版 2999 元，复用统一支付中心 payForPhone（create → wxpay_order → requestPayment → verify）

const { callPayCommon, pickPayment } = require('../../utils/pay.js');

const MERCHANT_PRO_PRICE_YUAN = 2999; // 高级版定价（元），服务端权威为 299900 分

// 主要城市经纬度（用于「附近」Tab 根据定位算最近城市；与 demo 首页一致）
const CITY_GEO = [
  { name: '北京', lat: 39.9042, lng: 116.4074 },
  { name: '上海', lat: 31.2304, lng: 121.4737 },
  { name: '广州', lat: 23.1291, lng: 113.2644 },
  { name: '深圳', lat: 22.5431, lng: 114.0579 },
  { name: '东莞', lat: 23.0207, lng: 113.7518 },
  { name: '佛山', lat: 23.0215, lng: 113.1214 },
  { name: '珠海', lat: 22.2710, lng: 113.5530 },
  { name: '中山', lat: 22.5176, lng: 113.3926 },
  { name: '惠州', lat: 23.1115, lng: 114.4162 },
  { name: '杭州', lat: 30.2741, lng: 120.1551 },
  { name: '宁波', lat: 29.8683, lng: 121.5440 },
  { name: '苏州', lat: 31.2990, lng: 120.5853 },
  { name: '无锡', lat: 31.4912, lng: 120.3119 },
  { name: '南京', lat: 32.0603, lng: 118.7969 },
  { name: '成都', lat: 30.5728, lng: 104.0668 },
  { name: '武汉', lat: 30.5928, lng: 114.3055 },
  { name: '长沙', lat: 28.2282, lng: 112.9388 },
  { name: '郑州', lat: 34.7466, lng: 113.6254 },
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
  return best && bestDist <= 260 ? { name: best.name } : null;
}

const CATEGORIES = [
  "供应商",
  "技术培训",
  "连锁品牌",
  "面粉辅料",
  "馅料面点",
  "饮品/其他",
  "厨具设备",
  "早餐培训",
];

const HERO_KINDS = [
  { id: 'k1', name: '供应商',   emoji: '🚚' },
  { id: 'k2', name: '技术培训', emoji: '🎓' },
  { id: 'k3', name: '连锁品牌', emoji: '🏬' },
];

Page({
  data: {
    heroKinds: HERO_KINDS,
    categories: CATEGORIES,
    catVisible: false,
    // 表单默认收起，进来只展示商家列表
    formVisible: false,
    // 商家列表
    list: [],
    listLoading: true,
    // 搜索 & 筛选
    keyword: '',
    activeCategory: '',   // 当前分类筛选（空=全部）
    activeTab: 'recommend', // recommend=推荐 / newest=新入 / nearby=附近
    nearbyCity: '',       // 附近：定位到的城市名
    locating: false,
    form: {
      name: '',
      category: '',
      address: '',
      business_hours: '',
      phone: '',
      intro: '',
      avatar: '',
      photos: [],
      wechat_qr: '',
      license_img: '',
      invite_code: '',
      plan: 'pro',
    },
    agreed: false,
    submitting: false,
  },

  onLoad() {
    // 首次进入：拉取已审核商家列表（onShow 也会触发，这里用 _loaded 标记避免重复请求）
    this._loaded = false;
    this.loadMerchantList();
  },

  onShow() {
    // 首次进入由 onLoad 负责加载，onShow 只处理「返回本页时刷新」
    // （onLoad 与 onShow 首次会先后触发，若两处都拉会请求两遍）
    if (this._loaded) this.loadMerchantList();
  },

  // 加载已审核通过的商家列表（支持 keyword 搜索 + category 筛选 + tab 区分）
  loadMerchantList() {
    this.setData({ listLoading: true });
    const data = { action: 'list', page: 1, pageSize: 50 };
    if (this.data.keyword) data.keyword = this.data.keyword;
    if (this.data.activeCategory) data.category = this.data.activeCategory;
    // tab 区分：附近 → 传当前城市
    if (this.data.activeTab === 'nearby' && this.data.nearbyCity) {
      data.city = this.data.nearbyCity;
    }
    wx.cloud.callFunction({
      name: 'merchantApply',
      data,
      config: { timeout: 10000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      if (r.success) this.setData({ list: r.list || [] });
      else this.setData({ list: [] });
    }).catch(() => {
      this.setData({ list: [] });
    }).finally(() => {
      this.setData({ listLoading: false });
      this._loaded = true; // 标记已加载，之后 onShow 再触发才刷新
    });
  },

  // 搜索输入（防抖 300ms）
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this.loadMerchantList();
    }, 300);
  },

  // 3 宫格分类点击：筛选该分类
  onHeroKind(e) {
    const item = e.currentTarget.dataset.item;
    const cat = item && item.name;
    // 再次点击同一分类 = 取消筛选
    const next = this.data.activeCategory === cat ? '' : cat;
    this.setData({ activeCategory: next });
    this.loadMerchantList();
  },

  // 3 Tab 切换：推荐 / 新入 / 附近
  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.activeTab) return;
    this.setData({ activeTab: key });

    // 「附近」：先定位拿当前城市，再按城市过滤
    if (key === 'nearby') {
      if (this.data.nearbyCity) {
        this.loadMerchantList();
      } else {
        this.locateThenLoad();
      }
      return;
    }
    // 推荐 / 新入：直接加载（均按 created_at 倒序）
    this.loadMerchantList();
  },

  // 定位拿城市后加载附近商家
  locateThenLoad() {
    if (this.data.locating) return;
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success: (loc) => {
        const hit = nearestCity(loc.latitude, loc.longitude);
        if (!hit) {
          // 不在已知主要城市列表内 → 提示并切回「推荐」
          this.setData({ locating: false, nearbyCity: '', activeTab: 'recommend' });
          wx.showToast({ title: '暂不支持你所在城市，已切回推荐', icon: 'none' });
          this.loadMerchantList();
          return;
        }
        this.setData({ locating: false, nearbyCity: hit.name });
        this.loadMerchantList();
      },
      fail: () => {
        this.setData({ locating: false });
        wx.showToast({ title: '需授权定位才能看附近', icon: 'none' });
      },
    });
  },

  // 打开入驻表单弹窗
  onOpenApplyForm() {
    this.setData({ formVisible: true });
  },
  // 弹窗 visible 变化：用户点关闭/遮罩时同步状态
  onFormVisibleChange(e) {
    if (!e.detail.visible) this.setData({ formVisible: false });
  },

  // 点击商家卡片 → 进商家详情页
  onMerchantTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/merchant-detail/merchant-detail?id=${id}` });
  },

  // ---------- 输入事件 ----------
  onNameInput(e)      { this.setData({ 'form.name': e.detail.value }); },
  onHoursInput(e)     { this.setData({ 'form.business_hours': e.detail.value }); },
  onPhoneInput(e)     { this.setData({ 'form.phone': e.detail.value }); },
  onIntroInput(e)     { this.setData({ 'form.intro': e.detail.value }); },
  onInviteInput(e)    { this.setData({ 'form.invite_code': e.detail.value }); },

  // ---------- 分类选择 ----------
  onPickCategory() { this.setData({ catVisible: true }); },
  onCatVisibleChange(e) { if (!e.detail.visible) this.setData({ catVisible: false }); },
  onCatClose() { this.setData({ catVisible: false }); },
  onCatConfirm() { this.setData({ catVisible: false }); },
  onCatPick(e) {
    const item = e.currentTarget.dataset.item;
    this.setData({ 'form.category': item });
  },

  // ---------- 地址定位（chooseLocation 拿真实地址） ----------
  onPickLocation() {
    wx.chooseLocation({
      success: (res) => {
        // chooseLocation 返回：name(地点名) / address(详细地址) / latitude / longitude
        const addr = [res.address, res.name].filter(Boolean).join(' ');
        this.setData({
          'form.address': addr || res.name || res.address || '',
          'form.latitude': res.latitude,
          'form.longitude': res.longitude,
        });
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') >= 0) return; // 用户取消，不提示
        wx.showToast({ title: '需授权定位才能选择地址', icon: 'none' });
      },
    });
  },

  // ---------- 图片上传（头像/相册/微信码/营业执照）共上传到云存储 ----------
  pickAndUploadImage(type, count = 1) {
    // 限制 size 来源，避免选太大图
    const sourceType = ['album', 'camera'];
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType,
        sizeType: ['compressed'],
        success: (res) => {
          const files = (res.tempFiles || []).map(f => f.tempFilePath);
          if (!files.length) return reject(new Error('未选择图片'));
          wx.showLoading({ title: '图片检测中…', mask: true });
          // 逐张上传 + 安全检测，全部通过才返回 fileID 列表
          const tasks = files.map((fp, idx) => {
            const ext = (fp.split('.').pop() || 'jpg').split('?')[0];
            const cloudPath = `merchant/${type}/${Date.now()}_${idx}_${Math.floor(Math.random() * 10000)}.${ext}`;
            return wx.cloud.uploadFile({ cloudPath, filePath: fp })
              .then((r) => {
                const fileID = r.fileID || '';
                if (!fileID) return '';
                return this.checkImageSafe(fileID).then((suggest) => {
                  if (suggest === 'reject' || suggest === 'risky') {
                    const err = new Error('图片内容违规');
                    err.isIllegal = true;
                    throw err;
                  }
                  return fileID;
                });
              });
          });
          Promise.all(tasks)
            .then(results => {
              wx.hideLoading();
              const ids = results.filter(Boolean);
              resolve(ids);
            })
            .catch(err => {
              wx.hideLoading();
              reject(err);
            });
        },
        fail: reject,
      });
    });
  },

  // 图片安全检测：调 imgSecCheck 云函数，返回 suggest
  checkImageSafe(fileID) {
    return wx.cloud.callFunction({
      name: 'imgSecCheck',
      data: { fileID },
      config: { timeout: 15000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      return r.success ? (r.suggest || 'pass') : 'pass';
    }).catch(() => 'pass');
  },

  onPickAvatar() {
    this.pickAndUploadImage('avatar', 1)
      .then(ids => this.setData({ 'form.avatar': ids[0] }))
      .catch(err => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  onPickPhotos() {
    const remain = 50 - this.data.form.photos.length;
    if (remain <= 0) { wx.showToast({ title: '已达 50 张上限', icon: 'none' }); return; }
    this.pickAndUploadImage('photos', Math.min(remain, 9))
      .then(ids => {
        this.setData({ 'form.photos': this.data.form.photos.concat(ids) });
      })
      .catch(err => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  onPreviewPhoto(e) {
    wx.previewImage({ urls: this.data.form.photos, current: e.currentTarget.dataset.item });
  },

  onRemovePhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const photos = this.data.form.photos.slice();
    photos.splice(idx, 1);
    this.setData({ 'form.photos': photos });
  },

  onPickWechat() {
    this.pickAndUploadImage('wechat', 1)
      .then(ids => this.setData({ 'form.wechat_qr': ids[0] }))
      .catch(err => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  onPickLicense() {
    this.pickAndUploadImage('license', 1)
      .then(ids => this.setData({ 'form.license_img': ids[0] }))
      .catch(err => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  // ---------- 套餐 / 协议 ----------
  onPickPlan() {
    // 高级版为唯一套餐（2999 元/1 年），点击仅作提示，不切换
    wx.showToast({ title: `高级版 ¥${MERCHANT_PRO_PRICE_YUAN} / 1 年`, icon: 'none' });
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  // ---------- 提交：先提交申请 → 拿 merchant_id → 微信支付 2999 元 → 履约 ----------
  async onSubmit() {
    if (this.data.submitting) return;
    const f = this.data.form;
    if (!f.name) return wx.showToast({ title: '请填写店铺名称', icon: 'none' });
    if (!f.category) return wx.showToast({ title: '请选择商品分类', icon: 'none' });
    if (!f.address) return wx.showToast({ title: '请填写详细地址', icon: 'none' });
    if (!f.business_hours) return wx.showToast({ title: '请填写营业时间', icon: 'none' });
    if (!/^1\d{10}$/.test(f.phone || '')) return wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
    if (!this.data.agreed) return wx.showToast({ title: '请先同意条款', icon: 'none' });

    this.setData({ submitting: true });

    try {
      // 1) 提交入驻申请，拿到申请 _id
      wx.showLoading({ title: '提交中…', mask: true });
      const applyRes = await wx.cloud.callFunction({
        name: 'merchantApply',
        data: { action: 'submit', payload: f },
        config: { timeout: 15000 },
      });
      wx.hideLoading();
      const ar = (applyRes && applyRes.result) || {};
      if (!ar.success) throw new Error(ar.message || '提交失败');
      const merchantId = ar._id;
      if (!merchantId) throw new Error('提交异常，未返回申请标识');

      // 2) 服务端建单（高级版 2999 元，服务端权威定价）
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: 'merchant', merchant_id: merchantId },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 0;
      if (!outTradeNo || !amount) throw new Error('下单参数异常');

      // 3) 调集成支付函数下单
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || '商家入驻高级版',
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
      });
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const payParams = pickPayment(order);
      if (!payParams || !payParams.package) {
        console.error('[merchant-apply] 未取到 package:', order);
        throw new Error('下单失败：未获取到支付参数');
      }

      // 4) 拉起微信支付
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

      // 5) 服务端校验订单并履约（置入驻申请为已支付高级版）
      wx.showLoading({ title: '开通中…', mask: true });
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      wx.hideLoading();
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || '支付核销失败');

      // 6) 成功
      this.setData({ submitting: false });
      wx.showToast({ title: '支付成功，入驻申请已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      console.error('[merchant-apply] 提交/支付失败:', err && (err.errMsg || err.message));
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },
});
