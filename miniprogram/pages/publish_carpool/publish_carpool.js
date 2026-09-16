// pages/publish_carpool/publish_carpool.js
// 包子行业信息平台 · 发布顺风车表单（车找人 carpool_car / 人找车 carpool_person）
// 支持新建(publishPost) 与 编辑(managePost action=get + update，带 ?id=)
// 字段（与 carpool 频道页 / detail 展示一致）：from_place/to_place/depart_time/depart_deadline/seats
// 无价格；需选择所在城市(归属地) 供统一 region 展示，另给出发地/目的地两个文本。

const regionData = require('../../utils/regionData.js');
const { preRequestAuditSubscribe } = require('../../utils/subscribe.js');
// 置顶套餐与支付链路走公共模块（三页共用，避免价格/逻辑三处维护）
const { TOP_OPTIONS, getTopIntro, payForTop } = require('../../utils/topPromotion.js');

// 顺风车类别：车找人 / 人找车（data_type）
const CATEGORIES = [
  { dataType: 'carpool_car',    name: '车找人', emoji: '🚗', desc: '车主有空座' },
  { dataType: 'carpool_person', name: '人找车', emoji: '🧳', desc: '找顺路车' },
];

Page({
  data: {
    categories: CATEGORIES,
    catIdx: -1,        // 选中类别索引(-1=未选)
    // 表单
    form: {
      from_place: '',  // 出发地
      to_place: '',    // 目的地
      depart_time: '', // 出发时间(文本)
      depart_deadline: '', // 最晚出发(文本)
      seats: '',       // 可乘人数/剩余座位
      phone: '',
      contact: '',
      address: '',
      desc: '',
    },
    // 详细地址经纬度（点击地图选点后写入，提交时一并入库）
    latitude: null,
    longitude: null,
    // 图片：单图
    image: '',
    imageFiles: [],
    uploadGrid: { column: 3, width: 200, height: 200 },
    // 区域(所在城市归属地)
    regionOptions: regionData.CASCADER_OPTIONS,
    regionVisible: false,
    regionPick: '',
    region: null,
    // 提交
    submitting: false,
    // 编辑态
    isEdit: false,
    editId: '',
    isAdmin: false, // 管理员模式（从管理员对话进入，绕过归属校验，走 adminAuth）

    // ---------- 置顶推广（付费增值，套餐与支付逻辑见 utils/topPromotion.js） ----------
    // topDays：0=暂不开通（默认，不默认勾选付费项，避免诱导付费）
    topDays: 0,
    topOptions: TOP_OPTIONS,
    topIntro: getTopIntro('carpool_car'), // 默认按"车找人"，选类型后实时更新
    topPriceText: '',
  },

  onLoad(options) {
    const editId = (options && options.id) || '';
    const isAdmin = (options && options.admin) === '1';
    this.setData({ isAdmin });
    if (editId) {
      this.setData({ isEdit: true, editId });
      wx.setNavigationBarTitle({ title: isAdmin ? '编辑顺风车(管理员)' : '编辑顺风车' });
      this.loadForEdit(editId);
    }
  },

  // 编辑态：拉原帖预填（管理员走 adminAuth，普通用户走 managePost）
  loadForEdit(id) {
    wx.showLoading({ title: '加载中…', mask: true });
    // 管理员走 adminAuth.get（鉴权走 openid 通道，不传账密，避免小程序包泄露口令）
    const call = this.data.isAdmin
      ? { name: 'adminAuth', data: { action: 'get', _id: id } }
      : { name: 'managePost', data: { action: 'get', _id: id } };
    wx.cloud
      .callFunction(Object.assign({ config: { timeout: 10000 } }, call))
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        if (!r.success || !r.item) {
          wx.showToast({ title: r.message || '无权编辑或信息不存在', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1000);
          return;
        }
        const p = r.item;
        const catIdx = CATEGORIES.findIndex((c) => c.dataType === p.data_type);
        const form = {
          from_place: p.from_place || '',
          to_place: p.to_place || '',
          depart_time: p.depart_time || '',
          depart_deadline: p.depart_deadline || '',
          seats: Number(p.seats) > 0 ? String(Number(p.seats)) : '',
          phone: p.phone || '',
          contact: p.contact || '',
          address: p.address || '',
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
        const cat = catIdx >= 0 ? CATEGORIES[catIdx] : null;
        this.setData({
          catIdx: catIdx >= 0 ? catIdx : -1,
          // 编辑回填时同步置顶文案（否则编辑"人找车"会显示"车找人"的措辞）
          topIntro: getTopIntro(cat ? cat.dataType : 'carpool_car'),
          form,
          region,
          regionPick,
          image,
          imageFiles,
          // 编辑回填经纬度（老数据可能为空，为空时用户需重新选点）
          latitude: p.latitude != null ? Number(p.latitude) : null,
          longitude: p.longitude != null ? Number(p.longitude) : null,
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish_carpool] 编辑加载失败:', err && err.errMsg);
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  // 选类别（车找人 / 人找车）；同步刷新置顶说明文案（两类措辞不同）
  onCatTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const cat = CATEGORIES[idx];
    this.setData({
      catIdx: idx,
      topIntro: getTopIntro(cat ? cat.dataType : 'carpool_car'),
    });
  },

  // ---------- 置顶推广（与 publish_recruit 同一套交互） ----------
  // 选择置顶套餐：再点已选项 = 取消（回到"暂不开通"）
  onTopTap(e) {
    const days = Number(e.currentTarget.dataset.days) || 0;
    const next = this.data.topDays === days ? 0 : days;
    const opt = this.data.topOptions.find((o) => o.days === next);
    this.setData({
      topDays: next,
      topPriceText: next === 0 ? '' : `${(opt.price / 100) || 0}元`,
    });
  },

  // 「暂不开通，直接免费发布」：显式清空置顶选择
  onTopSkip() {
    this.setData({ topDays: 0, topPriceText: '' });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const isNum = e.currentTarget.dataset.num;
    let v = e.detail.value;
    if (isNum) v = String(v || '').replace(/\D/g, '');
    this.setData({ [`form.${field}`]: v });
  },

  // 详细地址：wx.chooseLocation 打开微信内置地图选点，
  // 回填「详细地址」文本，并保存 latitude/longitude（提交时入库，供「附近」使用）
  onChooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        if (!res || res.latitude == null) return;
        const name = (res.name || '').trim();
        const addr = (res.address || '').trim();
        const text = name ? (addr && addr.indexOf(name) < 0 ? `${addr} ${name}` : addr) : addr;
        this.setData({
          latitude: Number(res.latitude),
          longitude: Number(res.longitude),
          'form.address': text,
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) return; // 用户取消，不提示
        wx.showToast({ title: '需授权定位才能选择地址', icon: 'none' });
      },
    });
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
        console.error('[publish_carpool] 图片上传失败:', err && err.errMsg);
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
      });
  },
  uploadOne(file) {
    return this.compressIfNeed(file.url).then((compressedPath) => {
      const src = compressedPath || file.url || file.name || '';
      const ext = (src.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const cloudPath = `posts/${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}.${ext}`;
      return wx.cloud.uploadFile({ cloudPath, filePath: compressedPath }).then((res) => res.fileID || '');
    });
  },

  // 上传前压缩：限制宽度 1080px + 质量 80，压缩失败用原图兜底（不阻断用户）
  compressIfNeed(filePath) {
    return new Promise((resolve) => {
      wx.compressImage({
        src: filePath,
        quality: 80,
        compressedWidth: 1080,
        success: (res) => resolve(res.tempFilePath),
        fail: () => resolve(filePath),
      });
    });
  },
  onUploadRemove() { this.setData({ image: '', imageFiles: [] }); },

  // 校验并提交
  onSubmit() {
    if (this.data.submitting) return;
    const { form, region, image, catIdx, latitude, longitude } = this.data;
    const cat = catIdx >= 0 ? CATEGORIES[catIdx] : null;
    if (!cat) {
      wx.showToast({ title: '请选择车找人 / 人找车', icon: 'none' });
      return;
    }
    const fromPlace = String(form.from_place || '').trim();
    const toPlace = String(form.to_place || '').trim();
    if (!fromPlace || !toPlace) {
      wx.showToast({ title: '请填写出发地和目的地', icon: 'none' });
      return;
    }
    if (!region || !region.city_code) {
      wx.showToast({ title: '请选择所在城市', icon: 'none' });
      return;
    }
    // 必填：详细地址（须点击地图选点，同时得到经纬度）
    if (!String(form.address || '').trim()) {
      wx.showToast({ title: '请点击「详细地址」在地图上选点', icon: 'none' });
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

    const seats = parseInt(String(form.seats || '').replace(/\D/g, ''), 10) || 0;
    const base = {
      data_type: cat.dataType,
      province: region.province,
      province_code: region.province_code,
      city: region.city,
      city_code: region.city_code,
      district: region.district,
      district_code: region.district_code,
      address: String(form.address || '').trim(),
      latitude: latitude != null ? Number(latitude) : null,
      longitude: longitude != null ? Number(longitude) : null,
      from_place: fromPlace,
      to_place: toPlace,
      depart_time: String(form.depart_time || '').trim(),
      depart_deadline: String(form.depart_deadline || '').trim(),
      seats: seats > 0 ? seats : 0,
      phone,
      contact: String(form.contact || '').trim(),
      image: String(image || '').trim(),
      desc,
    };

    this.setData({ submitting: true });
    if (this.data.isEdit) {
      // 编辑保存：管理员走 adminAuth.update，普通用户走 managePost.update
      wx.showLoading({ title: '保存中…', mask: true });
      // 管理员走 adminAuth.update（鉴权走 openid 通道，不传账密）
      const call = this.data.isAdmin
        ? { name: 'adminAuth', data: { action: 'update', _id: this.data.editId, data: base } }
        : { name: 'managePost', data: { action: 'update', _id: this.data.editId, form: base } };
      wx.cloud
        .callFunction(Object.assign({ config: { timeout: 10000 } }, call))
        .then((res) => {
          wx.hideLoading();
          const r = res.result || {};
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
          console.error('[publish_carpool] 保存失败:', err && err.errMsg);
        });
      return;
    }

    // 新建：publishPost
    // 先请求「审核结果通知」订阅授权（必须在此刻手势栈内调用，不 await、不阻塞发布）
    const subP = preRequestAuditSubscribe();
    void subP;

    wx.showLoading({ title: '发布中…', mask: true });
    wx.cloud
      .callFunction({ name: 'publishPost', data: { form: base }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        this.setData({ submitting: false });
        if (r.success) {
          const postId = r._id;
          const done = () => setTimeout(() => wx.navigateBack(), 1200);
          // 选了置顶 → 发布成功后立即拉起置顶支付（走公共模块，与招聘页同一链路）
          if (this.data.topDays > 0 && postId) {
            payForTop(postId, this.data.topDays)
              .then(() => {
                wx.showToast({ title: `发布成功，已置顶 ${this.data.topDays} 天`, icon: 'success' });
                done();
              })
              .catch((err) => {
                // 支付取消/失败：帖子已发布，只是未置顶
                const msg = String((err && (err.errMsg || err.message)) || '');
                wx.showToast({
                  title: msg.indexOf('cancel') >= 0 ? '已取消置顶，可在我的发布中重新置顶' : '发布成功，置顶支付未完成',
                  icon: 'none',
                });
                done();
              });
          } else {
            wx.showToast({ title: r.needs_review ? '已提交待审核' : '发布成功', icon: 'success' });
            done();
          }
        } else {
          wx.showToast({ title: r.error || '发布失败', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: '网络异常，请重试', icon: 'none' });
        console.error('[publish_carpool] 发布失败:', err && err.errMsg);
      });
  },
});
