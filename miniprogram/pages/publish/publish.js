// pages/publish/publish.js
// 包子行业信息平台 · 通用发布表单（一个页面按 ?type= 切不同分类）
// 支持：transfer 转让 / want_shop 求店 / equip_sell 设备出售 / equip_buy 设备求购 /
//       jobseek 求职 / other 其他   （recruit 招工 走独立页 publish_recruit）
// 提交统一走 publishPost 云函数（云端按 data_type 分字段入库）

const regionData = require('../../utils/regionData.js');

// 店铺类型（转让/求店共用，role_id 1-5；与 dicts category='shop_type' 一致）
const SHOP_TYPES = [
  { roleId: 1, name: '品牌店', emoji: '🏬', bg: '#FFF1E8' },
  { roleId: 2, name: '自营店', emoji: '🏪', bg: '#F0F5FF' },
  { roleId: 3, name: '摆摊车', emoji: '🚚', bg: '#FFF7E6' },
  { roleId: 4, name: '学校',   emoji: '🏫', bg: '#E6FFFB' },
  { roleId: 5, name: '工厂',   emoji: '🏭', bg: '#F6FFED' },
];

// 师傅类型（求职 jobseek 用，role_id 1-14；与招聘筛选一致）
const MASTER_TYPES = [
  { roleId: 1,  name: '大师傅' },
  { roleId: 2,  name: '短期顶班' },
  { roleId: 3,  name: '夫妻工' },
  { roleId: 4,  name: '售卖员' },
  { roleId: 5,  name: '学徒工' },
  { roleId: 6,  name: '小笼包师傅' },
  { roleId: 7,  name: '饼类师傅' },
  { roleId: 8,  name: '油炸类师傅' },
  { roleId: 9,  name: '中工' },
  { roleId: 10, name: '生煎类师傅' },
  { roleId: 11, name: '全能面点大师' },
  { roleId: 12, name: '二把手' },
  { roleId: 13, name: '工厂' },
  { roleId: 14, name: '其他类型' },
];

// 到岗方式（求职）
const AVAIL_OPTIONS = ['长期', '短期', '顶班', '随时可到'];

// 每个分类的表单配置
// mainPrice: 主价格字段与文案（number 输入，0=面议）
//   transfer/want_shop/equip_* = price；jobseek = salary_expect(期望薪资)
//   other = price(可空)
const TYPES = {
  transfer: {
    dataType: 'transfer',
    navTitle: '发布转让',
    roleOptions: SHOP_TYPES,
    roleLabel: '店铺类型',
    priceKey: 'price',
    priceLabel: '转让费（元）',
    priceHint: '如 200000，留空=面议',
    mainTag: '转让',
    optional: [
      { key: 'monthly_rent', label: '月租金（元）', ph: '如 5000（可空）', num: 1 },
      { key: 'area_sqm', label: '面积（㎡）', ph: '如 50（可空）', num: 1 },
      { key: 'daily_revenue', label: '日营业额（元）', ph: '如 3000（可空）', num: 1 },
      { key: 'has_equipment', label: '带设备', ph: '如 全带/部分/不带（可空）' },
    ],
    termLabel: '转让条件（顿号分隔）',
    termKey: 'terms',
    termPh: '如：带设备全带、可教技术、铺租续签（可空）',
  },
  want_shop: {
    dataType: 'want_shop',
    navTitle: '发布求店',
    roleOptions: SHOP_TYPES,
    roleLabel: '想要的店铺类型',
    priceKey: 'price',
    priceLabel: '预算（元）',
    priceHint: '如 50000，留空=面议',
    mainTag: '求店',
    optional: [
      { key: 'rent_max', label: '月租金上限（元）', ph: '如 8000（可空）', num: 1 },
      { key: 'area_min', label: '面积下限（㎡）', ph: '如 30（可空）', num: 1 },
    ],
    termLabel: '求店诉求（顿号分隔）',
    termKey: 'want_terms',
    termPh: '如：位置好、可做堂食、手续齐全（可空）',
  },
  equip_sell: {
    dataType: 'equip_sell',
    navTitle: '发布设备出售',
    roleOptions: [],
    priceKey: 'price',
    priceLabel: '售价（元）',
    priceHint: '如 3000，留空=面议',
    mainTag: '设备出售',
    condLabel: '新旧程度',
  },
  equip_buy: {
    dataType: 'equip_buy',
    navTitle: '发布设备求购',
    roleOptions: [],
    priceKey: 'price',
    priceLabel: '预算（元）',
    priceHint: '如 5000，留空=面议',
    mainTag: '设备求购',
    condLabel: '期望成色',
  },
  jobseek: {
    dataType: 'jobseek',
    navTitle: '发布求职',
    roleOptions: MASTER_TYPES,
    roleLabel: '我会的岗位',
    priceKey: 'salary_expect',
    priceLabel: '期望月薪（元）',
    priceHint: '如 8000，留空=面议',
    mainTag: '求职',
    jobseek: true,
    optional: [
      { key: 'salary_note', label: '薪资说明', ph: '如 包吃住/月休4天（可空）' },
      { key: 'service_area', label: '可服务地区', ph: '如 广东省/江西（可空）' },
    ],
    avail: true,
    termLabel: '求职诉求（顿号分隔）',
    termKey: 'want_terms',
    termPh: '如：单间、有空调、月结、包吃住（可空）',
  },
  other: {
    dataType: 'other',
    navTitle: '发布其他信息',
    roleOptions: [],
    noPrice: true, // 其他不发价格
    mainTag: '其他',
  },
};

// 成色选项（0-10 数字）
const COND_OPTIONS = [
  { value: 10, label: '全新' },
  { value: 9, label: '九成新' },
  { value: 8, label: '八成新' },
  { value: 7, label: '七成新' },
  { value: 6, label: '六成新' },
  { value: 5, label: '五成新' },
  { value: 4, label: '四成新' },
  { value: 3, label: '三成新' },
  { value: 2, label: '二成新' },
  { value: 1, label: '一成新' },
  { value: 0, label: '较旧/需维修' },
];

Page({
  data: {
    typeName: '',
    cfg: null,          // 当前分类配置
    roleOptions: [],
    roleIdx: -1,
    condOptions: COND_OPTIONS,
    condIdx: -1,        // 成色选中索引(-1=未选)
    availOptions: AVAIL_OPTIONS,
    availIdx: -1,       // 求职到岗方式
    form: { price: '' },
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',
    region: null,
    image: '',
    imageFiles: [],
    uploadGrid: { column: 3, width: 200, height: 200 },
    submitting: false,
    isEdit: false,
    editId: '',
  },

  onLoad(options) {
    const type = (options && options.type) || '';
    const cfg = TYPES[type] || null;
    const editId = (options && options.id) || '';
    if (!cfg) {
      wx.showToast({ title: '不支持的发布分类', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1000);
      return;
    }
    // 动态初始化：可选字段都放 form 顶层（phone/contact/address/desc 由 wxml onInput 动态补）
    const form = { price: '' };
    (cfg.optional || []).forEach((o) => { form[o.key] = ''; });
    if (cfg.termKey) form[cfg.termKey] = '';
    this._type = cfg.dataType;
    this.setData({
      typeName: cfg.dataType,
      cfg,
      roleOptions: cfg.roleOptions || [],
      form,
      condOptions: COND_OPTIONS,
      isEdit: !!editId,
      editId,
    });
    if (cfg.navTitle) {
      wx.setNavigationBarTitle({ title: editId ? `编辑${cfg.mainTag}` : cfg.navTitle });
    }
    // 编辑态：先拉本人原帖预填
    if (editId) this.loadForEdit(editId, cfg);
  },

  // 编辑态预填：managePost(action=get) 返回本人完整原帖（含完整 phone 等）
  loadForEdit(id, cfg) {
    wx.showLoading({ title: '加载中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'get', _id: id }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        if (!r.success || !r.item) {
          wx.showToast({ title: r.message || '无权编辑或帖子不存在', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1000);
          return;
        }
        this.applyOriginal(r.item, cfg);
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish] 编辑加载失败:', err && err.errMsg);
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  // 把原始帖子映射回表单各字段
  applyOriginal(p, cfg) {
    const form = { price: '' };
    // 主价格：jobseek=期望薪资；其余=price；other(noPrice) 无价格不映射
    if (!cfg.noPrice) {
      if (cfg.dataType === 'jobseek') {
        form.price = Number(p.salary_expect || p.salary) > 0 ? String(Number(p.salary_expect || p.salary)) : '';
      } else {
        form.price = Number(p.price) > 0 ? String(Number(p.price)) : '';
      }
    }
    (cfg.optional || []).forEach((o) => {
      let val = p[o.key];
      if (o.num) val = Number(val) > 0 ? String(Number(val)) : '';
      else val = Array.isArray(val) ? val.join('、') : String(val == null ? '' : val);
      form[o.key] = val;
    });
    if (cfg.termKey) form[cfg.termKey] = Array.isArray(p[cfg.termKey]) ? p[cfg.termKey].join('、') : String(p[cfg.termKey] || '');
    // 联系方式
    form.phone = p.phone || '';
    form.contact = p.contact || '';
    form.address = p.address || '';
    form.desc = p.raw_text || '';

    // 类型/角色
    let roleIdx = -1;
    if (cfg.roleOptions && cfg.roleOptions.length && p.role_id) {
      const idx = cfg.roleOptions.findIndex((x) => x.roleId === Number(p.role_id));
      roleIdx = idx >= 0 ? idx : -1;
    }
    // 成色
    let condIdx = -1;
    if ((cfg.dataType === 'equip_sell' || cfg.dataType === 'equip_buy') && p.cond != null) {
      condIdx = COND_OPTIONS.findIndex((x) => x.value === Number(p.cond));
      if (condIdx < 0) condIdx = 0; // 兜底
    }
    // 求职到岗
    let availIdx = -1;
    if (cfg.jobseek && p.availability) availIdx = AVAIL_OPTIONS.indexOf(p.availability);

    // 区域回填（用已有 code 拼 regionPick 展示）
    const region = {
      province: p.province || '',
      province_code: p.province_code || '',
      city: p.city || '',
      city_code: p.city_code || '',
      district: p.district || '',
      district_code: p.district_code || '',
    };
    const regionPick = [region.province, region.city, region.district].filter(Boolean).join('/');

    // 图片：云 fileID 回显
    let image = '';
    let imageFiles = [];
    if (p.image) {
      image = p.image;
      imageFiles = [{ url: p.image, status: 'done', type: 'image', name: '封面' }];
    }

    this.setData({ form, roleIdx, condIdx, availIdx, region, regionPick, image, imageFiles });
  },

  // 选岗位/店铺类型
  onRoleTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ roleIdx: idx });
  },

  // 成色选择
  onCondTap(e) {
    this.setData({ condIdx: Number(e.currentTarget.dataset.idx) });
  },

  // 求职到岗方式
  onAvailTap(e) {
    this.setData({ availIdx: Number(e.currentTarget.dataset.idx) });
  },

  // 文本/数字输入（数字框内只留数字）
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const isNum = e.currentTarget.dataset.num;
    let v = e.detail.value;
    if (isNum) v = String(v || '').replace(/\D/g, '');
    this.setData({ [`form.${field}`]: v });
  },

  // 省市区
  openRegion() { this.setData({ regionVisible: true }); },
  onRegionChange(e) {
    const opts = e.detail.selectedOptions || [];
    const text = opts.map((o) => o.label).join('/');
    const region = {
      province: (opts[0] && opts[0].label) || '',
      city: (opts[1] && opts[1].label) || (opts[0] && opts[0].label) || '',
      district: (opts[2] && opts[2].label) || '',
      province_code: (opts[0] && opts[0].value != null && String(opts[0].value)) || '',
      city_code: (opts[1] && opts[1].value != null && String(opts[1].value)) || (opts[0] && opts[0].value != null && String(opts[0].value)) || '',
      district_code: (opts[2] && opts[2].value != null && String(opts[2].value)) || '',
    };
    this.setData({ regionVisible: false, regionPick: text, region });
  },
  onRegionClose() { this.setData({ regionVisible: false }); },

  // 图片上传
  onUploadSuccess(e) {
    const files = (e && e.detail && e.detail.files) || [];
    const newOne = files.slice().reverse().find((f) => f && f.url && !/^cloud:\/\//.test(f.url));
    if (!newOne) { this.setData({ imageFiles: files }); return; }
    wx.showLoading({ title: '图片上传中…', mask: true });
    this.uploadOne(newOne)
      .then((fileID) => {
        wx.hideLoading();
        this.setData({ image: fileID || '', imageFiles: files });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish] 图片上传失败:', err && err.errMsg);
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
      });
  },
  uploadOne(file) {
    const src = file.url || file.name || '';
    const ext = (src.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const cloudPath = `posts/${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: file.url }).then((res) => res.fileID || '');
  },
  onUploadRemove() { this.setData({ image: '', imageFiles: [] }); },

  // 校验并提交
  onSubmit() {
    if (this.data.submitting) return;
    const { cfg, form, region, image, roleIdx, condIdx, availIdx } = this.data;
    if (!cfg) return;

    // 必填：有 role 的分类必须选类型
    const role = cfg.roleOptions && cfg.roleOptions.length ? ((roleIdx >= 0) ? cfg.roleOptions[roleIdx] : null) : null;
    if (cfg.roleOptions && cfg.roleOptions.length && !role) {
      wx.showToast({ title: `请选择${cfg.roleLabel}`, icon: 'none' });
      return;
    }
    if (!region || !region.city_code) {
      wx.showToast({ title: '请选择区域(城市)', icon: 'none' });
      return;
    }
    const phone = String(form.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    const desc = String(form.desc || '').trim();
    if (!desc) {
      wx.showToast({ title: '请填写具体描述', icon: 'none' });
      return;
    }
    // 成色类(设备)必选
    const isEquip = cfg.dataType === 'equip_sell' || cfg.dataType === 'equip_buy';
    if (isEquip && condIdx < 0) {
      wx.showToast({ title: `请选择${cfg.condLabel}`, icon: 'none' });
      return;
    }

    const toInt = (s) => parseInt(String(s == null ? '' : s).replace(/\D/g, ''), 10) || 0;

    // 组装提交 form
    const payloadForm = {
      data_type: cfg.dataType,
      province: region.province,
      province_code: region.province_code,
      city: region.city,
      city_code: region.city_code,
      district: region.district,
      district_code: region.district_code,
      address: String(form.address || '').trim(),
      desc,
      phone,
      contact: String(form.contact || '').trim(),
      username: '',
      image: String(image || '').trim(),
      credit: 1,
      tags: [],
    };
    // role / role_id（有 role 的分类）
    if (role) { payloadForm.role = role.name; payloadForm.roleId = role.roleId; }
    // 可选字段
    (cfg.optional || []).forEach((o) => {
      let val = String(form[o.key] == null ? '' : form[o.key]).trim();
      if (o.num) { val = val ? toInt(val) : 0; payloadForm[o.key] = val; }
      else payloadForm[o.key] = val;
    });
    // 主价格：jobseek 存 salary_expect(期望)、其余 price；other(noPrice) 不存价格
    if (cfg.noPrice) {
      // 其他：无价格，不入库 price
    } else {
      const priceVal = toInt(form.price);
      if (cfg.dataType === 'jobseek') {
        payloadForm.salary_expect = priceVal;
      } else {
        payloadForm.price = priceVal;
      }
    }
    // 成色
    if (isEquip) { const c = COND_OPTIONS[condIdx]; payloadForm.cond = c ? c.value : 0; }
    // 求职到岗方式
    if (cfg.jobseek && availIdx >= 0) payloadForm.availability = AVAIL_OPTIONS[availIdx];
    // 诉求/条件（顿号分隔字符串 → 数组）
    const isEdit = this.data.isEdit;
    if (cfg.termKey) {
      const tstr = String(form[cfg.termKey] || '').trim();
      const tarr = tstr
        ? tstr.split(/[、，,;；/|\\\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
        : [];
      payloadForm[cfg.termKey] = isEdit ? tarr : tstr;
    }

    this.setData({ submitting: true });
    if (isEdit) {
      // 编辑：走 managePost(action=update)，字段名对齐其 EDITABLE
      const updateForm = {
        role: payloadForm.role,
        role_id: payloadForm.roleId,
        province: payloadForm.province,
        province_code: payloadForm.province_code,
        city: payloadForm.city,
        city_code: payloadForm.city_code,
        district: payloadForm.district,
        district_code: payloadForm.district_code,
        address: payloadForm.address,
        raw_text: payloadForm.desc,
        phone: payloadForm.phone,
        contact: payloadForm.contact,
        image: payloadForm.image,
        tags: payloadForm.tags,
        price: payloadForm.price,
        salary: payloadForm.salary,
        cond: payloadForm.cond,
        salary_expect: payloadForm.salary_expect,
        salary_note: payloadForm.salary_note,
        availability: payloadForm.availability,
        service_area: payloadForm.service_area,
        monthly_rent: payloadForm.monthly_rent,
        area_sqm: payloadForm.area_sqm,
        daily_revenue: payloadForm.daily_revenue,
        has_equipment: payloadForm.has_equipment,
        terms: payloadForm.terms,
        rent_max: payloadForm.rent_max,
        area_min: payloadForm.area_min,
        want_terms: payloadForm.want_terms,
      };
      // 去掉 undefined
      Object.keys(updateForm).forEach((k) => { if (updateForm[k] === undefined) delete updateForm[k]; });
      this.callUpdate(updateForm);
    } else {
      this.callCreate(payloadForm);
    }
  },

  callCreate(payloadForm) {
    wx.showLoading({ title: '发布中…', mask: true });
    wx.cloud
      .callFunction({ name: 'publishPost', data: { form: payloadForm }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        wx.hideLoading();
        this.setData({ submitting: false });
        if (r.success) {
          wx.showToast({ title: r.needs_review ? '已提交待审核' : '发布成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1200);
        } else {
          wx.showToast({ title: r.error || '发布失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        console.error('[publish] 发布失败:', err && err.errMsg);
      });
  },

  callUpdate(updateForm) {
    wx.showLoading({ title: '保存中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'update', _id: this.data.editId, form: updateForm }, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        wx.hideLoading();
        this.setData({ submitting: false });
        if (r.success) {
          wx.showToast({ title: r.needs_review ? '已保存待审核' : '保存成功', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1200);
        } else {
          wx.showToast({ title: r.message || '保存失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        console.error('[publish] 保存失败:', err && err.errMsg);
      });
  },
});
