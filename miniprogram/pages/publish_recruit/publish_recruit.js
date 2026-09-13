// pages/publish_recruit/publish_recruit.js
// 包子行业信息平台 · 发布招工表单
// 提交走 publishPost 云函数（data_type=recruit 入库）。字段与云函数一一对应。

const regionData = require('../../utils/regionData.js');
const { callPayCommon, pickPayment } = require('../../utils/pay.js');

// 师傅类型（roleId 稳定映射 1-14，与招聘筛选 SUB_CATS 一致）
const SUB_CATS = [
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

Page({
  data: {
    subOptions: SUB_CATS,
    subIdx: -1,          // 选中师傅类型索引(-1=未选)
    // 表单
    form: {
      salary: '',        // 薪资(元/月)，空=面议
      address: '',       // 详细地址
      phone: '',         // 联系电话
      contact: '',       // 联系人
      username: '',      // 发布人昵称(已在表单隐藏，留空)
      desc: '',          // 描述
    },
    // 图片：单图，上传到云存储后存 fileID（云存储 fileID 可直接用于 <image> src）
    image: '',
    // t-upload 受控展示文件列表（用于回显/删除）
    imageFiles: [],
    // t-upload 网格布局（rpx）
    uploadGrid: { column: 3, width: 200, height: 200 },
    // 区域
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',      // 选中省市区文本
    region: null,        // {province,city,district,province_code,city_code,district_code}
    // 提交
    submitting: false,
    // 编辑态
    isEdit: false,
    editId: '',
    isAdmin: false, // 管理员模式（从管理员对话进入，绕过归属校验，走 adminAuth）
    // 发布后推荐弹窗
    recommendVisible: false,
    recommendTitle: '',
    recommendSubtitle: '',
    recommendList: [],
    recommendCalling: false, // 拨打电话进行中（防重复点击）
    // 置顶推广：0=不置顶，1/3/7=置顶天数
    topDays: 0,
    topOptions: [
      { days: 0, label: '不置顶', price: 0, priceText: '' },
      { days: 1, label: '置顶1天', price: 5000, priceText: '50元' },
      { days: 3, label: '置顶3天', price: 15000, priceText: '150元' },
      { days: 7, label: '置顶7天', price: 35000, priceText: '350元' },
    ],
    topPriceText: '', // 当前选中置顶的价格文案
  },

  onLoad(options) {
    const editId = (options && options.id) || '';
    const isAdmin = (options && options.admin) === '1';
    this.setData({ isAdmin });
    if (editId) {
      this.setData({ isEdit: true, editId });
      wx.setNavigationBarTitle({ title: isAdmin ? '编辑(管理员)' : '编辑招工' });
      this.loadForEdit(editId);
    }
  },

  // 编辑态：拉本人原帖预填（管理员模式走 adminAuth.get，绕过归属校验）
  loadForEdit(id) {
    wx.showLoading({ title: '加载中…', mask: true });
    const call = this.data.isAdmin
      ? { name: 'adminAuth', data: { action: 'get', _id: id, user: 'admin', pass: 'admin' } }
      : { name: 'managePost', data: { action: 'get', _id: id } };
    wx.cloud
      .callFunction(Object.assign({ config: { timeout: 10000 } }, call))
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        if (!r.success || !r.item) {
          wx.showToast({ title: r.message || '无权编辑或帖子不存在', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1000);
          return;
        }
        const p = r.item;
        const subIdx = SUB_CATS.findIndex((s) => s.roleId === Number(p.role_id));
        const form = {
          salary: Number(p.salary) > 0 ? String(Number(p.salary)) : '',
          address: p.address || '',
          phone: p.phone || '',
          contact: p.contact || '',
          username: '',
          desc: p.raw_text || '',
        };
        const region = {
          province: p.province || '',
          province_code: p.province_code || '',
          city: p.city || '',
          city_code: p.city_code || '',
          district: p.district || '',
          district_code: p.district_code || '',
        };
        const regionPick = [region.province, region.city, region.district].filter(Boolean).join('/');
        let image = '';
        let imageFiles = [];
        if (p.image) {
          image = p.image;
          imageFiles = [{ url: p.image, status: 'done', type: 'image', name: '封面' }];
        }
        this.setData({ form, subIdx: subIdx >= 0 ? subIdx : -1, region, regionPick, image, imageFiles });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish_recruit] 编辑加载失败:', err && err.errMsg);
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  onSubTap(e) {
    const idx = e.currentTarget.dataset.idx;
    this.setData({ subIdx: Number(idx) });
  },

  // 选择置顶天数
  onTopTap(e) {
    const days = Number(e.currentTarget.dataset.days) || 0;
    const opt = this.data.topOptions.find((o) => o.days === days);
    this.setData({
      topDays: days,
      topPriceText: (opt && opt.priceText) || '',
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  // 打开省市区选择
  openRegion() {
    this.setData({ regionVisible: true });
  },
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
  onRegionClose() {
    this.setData({ regionVisible: false });
  },

  // ---------- 图片上传 ----------
  // t-upload(未配 request-method) 选中后立即触发 success，携带本地临时文件(local temp url)。
  // 这里把最新一张临时文件传到云存储，拿到 fileID 写回 data.image 供提交携带。
  onUploadSuccess(e) {
    const files = (e && e.detail && e.detail.files) || [];
    // 取出本次新加的一张图（本地临时 url），去云存储上传
    const newOne = files
      .slice()
      .reverse()
      .find((f) => f && f.url && !/^cloud:\/\//.test(f.url));
    if (!newOne) {
      // 没有新临时文件（理论上不会），仅同步展示状态
      this.setData({ imageFiles: files });
      return;
    }
    wx.showLoading({ title: '图片检测中…', mask: true });
    this.uploadOne(newOne)
      .then((fileID) => {
        wx.hideLoading();
        this.setData({ image: fileID || '', imageFiles: files });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish_recruit] 图片处理失败:', err && (err.errMsg || err.message));
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '图片上传失败，请重试';
        wx.showToast({ title, icon: 'none' });
        if (err && err.isIllegal) this.setData({ image: '', imageFiles: [] });
      });
  },

  // 上传单张到云存储 + 立即做图片安全检测，返回 fileID（违规则抛错）
  uploadOne(file) {
    const src = file.url || file.name || '';
    const ext = (src.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const cloudPath = `posts/${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: file.url })
      .then((res) => {
        const fileID = res.fileID || '';
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
  },

  // 图片安全检测：调 imgSecCheck 云函数
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

  // t-upload 删除(bind:remove)：e.detail = { index, file }。单图场景删即清空回填的 image，避免仍带旧图提交
  onUploadRemove() {
    this.setData({ image: '', imageFiles: [] });
  },

  // 一键填充测试数据（随机；不含图片，图片手动传）
  onFillTestData() {
    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
    // 1) 师傅类型：随机选一个
    const subIdx = Math.floor(Math.random() * SUB_CATS.length);
    // 2) 薪资：随机 6000~15000，取整到 500
    const salary = String((Math.floor(Math.random() * 19) + 12) * 500);
    // 3) 区域：从 CASCADER_OPTIONS 随机选省 → 市 → 区，构造 region
    const prov = rnd(regionData.CASCADER_OPTIONS);
    let city = null;
    let district = null;
    if (prov && prov.children && prov.children.length) {
      city = rnd(prov.children);
      if (city && city.children && city.children.length) {
        district = rnd(city.children);
      }
    }
    const region = {
      province: prov ? prov.label : '',
      province_code: prov ? String(prov.value) : '',
      city: city ? city.label : (prov ? prov.label : ''),
      city_code: city ? String(city.value) : (prov ? String(prov.value) : ''),
      district: district ? district.label : '',
      district_code: district ? String(district.value) : '',
    };
    const regionPick = [region.province, region.city, region.district].filter(Boolean).join('/');
    // 4) 手机号：1 + 随机第二位3-9 + 9位随机
    const phone = '1' + String(rnd(['3', '5', '7', '8', '9'])) + Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('');
    // 5) 联系人/描述/地址
    const surnames = ['王', '李', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴'];
    const titles = ['老板', '经理', '店长', '师傅'];
    const contact = rnd(surnames) + rnd(titles);
    const districts = ['老街', '城东', '城南', '城西', '城北', '中心区', '工业园区', '美食街'];
    const streets = ['解放路', '建设路', '人民路', '中山路', '文化路', '幸福路'];
    const address = (region.city || '') + rnd(districts) + rnd(streets) + String(Math.floor(Math.random() * 200) + 1) + '号';
    const duties = ['会做小笼包优先', '会做生煎优先', '会做大包优先', '有经验者优先', '生手可教', '能吃苦耐劳'];
    const benefits = ['包吃住', '月休4天', '月休2天', '每天工作8小时', '提供宿舍', '有空调'];
    const desc = '招' + SUB_CATS[subIdx].name + '，' + rnd(duties) + '，' + rnd(benefits) + '，' + rnd(benefits) + '，薪资' + salary + '元/月，有意者电话联系。';

    this.setData({
      subIdx,
      'form.salary': salary,
      'form.address': address,
      'form.phone': phone,
      'form.contact': contact,
      'form.desc': desc,
      region,
      regionPick,
    });
    wx.showToast({ title: '已填充测试数据', icon: 'none' });
  },

  // 校验并提交
  onSubmit() {
    if (this.data.submitting) return;
    const { form, subIdx, region, image } = this.data;
    const sub = subIdx >= 0 ? SUB_CATS[subIdx] : null;
    if (!sub) {
      wx.showToast({ title: '请选择师傅类型', icon: 'none' });
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

    this.setData({ submitting: true });
    const salary = parseInt(String(form.salary || '').replace(/\D/g, ''), 10) || 0;
    const base = {
      role: sub.name,
      role_id: sub.roleId,
      salary: salary > 0 ? salary : 0,
      province: region.province,
      province_code: region.province_code,
      city: region.city,
      city_code: region.city_code,
      district: region.district,
      district_code: region.district_code,
      address: String(form.address || '').trim(),
      phone,
      contact: String(form.contact || '').trim(),
      image: String(image || '').trim(),
    };

    if (this.data.isEdit) {
      // 编辑保存：管理员走 adminAuth.update，普通用户走 managePost.update
      wx.showLoading({ title: '保存中…', mask: true });
      const updateForm = Object.assign({}, base, { raw_text: desc });
      const call = this.data.isAdmin
        ? { name: 'adminAuth', data: { action: 'update', _id: this.data.editId, data: updateForm, user: 'admin', pass: 'admin' } }
        : { name: 'managePost', data: { action: 'update', _id: this.data.editId, form: updateForm } };
      wx.cloud
        .callFunction(Object.assign({ config: { timeout: 10000 } }, call))
        .then((res) => {
          const r = res.result || {};
          wx.hideLoading();
          this.setData({ submitting: false });
          if (r.success) {
            wx.showToast({ title: '保存成功', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 1200);
          } else {
            wx.showToast({ title: r.message || '保存失败', icon: 'none' });
          }
        })
        .catch((err) => {
          wx.hideLoading();
          this.setData({ submitting: false });
          wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          console.error('[publish_recruit] 保存失败:', err && err.errMsg);
        });
      return;
    }

    // 新建：publishPost
    wx.showLoading({ title: '正在发布', mask: true });
    const payload = {
      form: Object.assign({}, base, {
        desc,
        username: String(form.username || '').trim(),
        credit: 1,
        tags: [],
      }),
    };
    wx.cloud
      .callFunction({ name: 'publishPost', data: payload, config: { timeout: 10000 } })
      .then(async (res) => {
        const r = res.result || {};
        wx.hideLoading();
        this.setData({ submitting: false });
        if (r.success) {
          const postId = r._id;
          // 选了置顶 → 发布成功后立即拉起置顶支付
          if (this.data.topDays > 0 && postId) {
            this.payForTop(postId, this.data.topDays)
              .then(() => {
                wx.showToast({ title: `发布成功，已置顶 ${this.data.topDays} 天`, icon: 'success' });
                this.recommendAndShow(base.city_code);
              })
              .catch((err) => {
                // 支付取消/失败：帖子已发布，只是未置顶
                const msg = String((err && (err.errMsg || err.message)) || '');
                wx.showToast({
                  title: msg.indexOf('cancel') >= 0 ? '已取消置顶，可在我的发布中重新置顶' : '发布成功，置顶支付未完成',
                  icon: 'none',
                });
                this.recommendAndShow(base.city_code);
              });
          } else {
            wx.showToast({ title: r.needs_review ? '已提交待审核' : '发布成功', icon: 'success' });
            this.recommendAndShow(base.city_code);
          }
        } else {
          wx.showToast({ title: r.error || '发布失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        console.error('[publish_recruit] 发布失败:', err && err.errMsg);
      });
  },

  // 置顶支付：发布成功后调用，biz_type=top + days（1/3/7）
  // 流程：create 建单（服务端定价）→ wxpay_order → requestPayment → verify 履约
  async payForTop(postId, days) {
    wx.showLoading({ title: '发起置顶支付…', mask: true });
    try {
      // 1) 建单（服务端按 days 定价）
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: 'top', post_id: postId, days },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 0;
      if (!outTradeNo) throw new Error('下单参数异常');

      // 2) 集成支付下单
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || `信息置顶 ${days} 天`,
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
      });
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const p = pickPayment(order);
      if (!p || !p.package) throw new Error('下单失败：未获取到 package');

      // 3) 拉起支付（先隐藏 loading，避免遮挡系统支付面板）
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

      // 4) 核销（履约写入置顶记录）
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || '支付核销失败');
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      throw err;
    }
  },

  // 发布成功后：按类型+城市推荐互补信息并弹窗
  recommendAndShow(cityCode) {
    wx.cloud
      .callFunction({
        name: 'recommendPosts',
        data: { data_type: 'recruit', city_code: cityCode },
        config: { timeout: 10000 },
      })
      .then((res) => {
        const r = res.result || {};
        if (r.success && r.recommend_list && r.recommend_list.length) {
          this.setData({
            recommendTitle: r.recommend_title || '为你匹配到合适的最新信息',
            recommendSubtitle: r.recommend_subtitle || '',
            recommendList: r.recommend_list,
            recommendVisible: true,
          });
        }
        // 无推荐内容则静默（不弹，不报错）
      })
      .catch((err) => {
        console.warn('[publish_recruit] 推荐失败(忽略):', err && err.errMsg);
      });
  },

  // visible-change：只同步状态，不返回（弹窗打开时也会触发该事件，不能在这里 navigateBack）
  onRecommendVisibleChange(e) {
    if (!e.detail.visible) this.setData({ recommendVisible: false });
  },

  // 点关闭图标：关闭弹窗并返回上一页（发布流程结束）
  onRecommendCloseTap() {
    this.setData({ recommendVisible: false });
    wx.navigateBack();
  },

  // 点推荐信息进详情
  onRecommendTap(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ recommendVisible: false });
    if (id) wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  // 点推荐信息的「拨打电话」按钮：会员免费/已付费直接拨，否则 1 分钱支付后自动拨
  onRecommendCall(e) {
    if (this.data.recommendCalling) return;
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ recommendCalling: true });
    this.payForRecommendCall(id)
      .then(() => {})
      .catch(() => {})
      .finally(() => this.setData({ recommendCalling: false }));
  },

  // 复用 detail 的付费取号 + 拨号流程（不做会员状态缓存，直接 reveal 判断）
  async payForRecommendCall(postId) {
    // 立即反馈：发起支付前要串行经过 reveal/create/下单 多次云调用，用 loading 消除"点了没反应"的空白感
    wx.showLoading({ title: '正在发起支付…', mask: true });
    try {
      // 1) reveal：会员免费 / 已付费 → 返回完整号
      const check = await this.callReveal(postId);
      if (check.success && check.phone) {
        wx.hideLoading();
        this.callPhone(check.phone);
        return;
      }

      // 2) 建单（服务端定价，防改价）
      const createRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'create', biz_type: 'phone', post_id: postId },
        config: { timeout: 10000 },
      });
      const cr = (createRes && createRes.result) || {};
      if (!cr.success) throw new Error(cr.message || '下单失败');
      if (cr.already_paid) {
        const already = await this.callReveal(postId);
        if (already.success && already.phone) {
          wx.hideLoading();
          this.callPhone(already.phone);
          return;
        }
      }
      const outTradeNo = cr.out_trade_no;
      const amount = Number(cr.amount) || 1;
      if (!outTradeNo) throw new Error('下单参数异常');

      // 3) 集成支付下单
      const order = await callPayCommon('wxpay_order', {
        description: cr.title || '查看联系电话',
        out_trade_no: outTradeNo,
        amount: { total: amount, currency: 'CNY' },
      });
      if (order && order.code !== undefined && order.code !== null && order.code !== 0) {
        throw new Error(order.msg || '下单失败');
      }
      const p = pickPayment(order);
      if (!p || !p.package) throw new Error('下单失败：未获取到 package');

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

      // 5) 核销
      const verifyRes = await wx.cloud.callFunction({
        name: 'payForPhone',
        data: { action: 'verify', out_trade_no: outTradeNo },
        config: { timeout: 10000 },
      });
      const vr = (verifyRes && verifyRes.result) || {};
      if (!vr.success) throw new Error(vr.message || '支付核销失败');

      // 6) 取号并拨
      const reveal = await this.callReveal(postId);
      if (!reveal.success || !reveal.phone) throw new Error(reveal.message || '获取电话失败');
      wx.hideLoading();
      this.callPhone(reveal.phone);
    } catch (err) {
      wx.hideLoading();
      const msg = String((err && (err.errMsg || err.message)) || '操作失败');
      if (msg.indexOf('cancel') >= 0) {
        wx.showToast({ title: '已取消支付', icon: 'none' });
      } else {
        wx.showToast({ title: msg, icon: 'none' });
      }
    }
  },

  callReveal(postId) {
    return wx.cloud.callFunction({
      name: 'payForPhone',
      data: { action: 'reveal', post_id: postId },
      config: { timeout: 10000 },
    }).then((res) => res.result || {});
  },

  // 拨打完整号（号码只存实例，绝不渲染到界面）
  callPhone(phone) {
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone }).catch(() => {});
  },
});
