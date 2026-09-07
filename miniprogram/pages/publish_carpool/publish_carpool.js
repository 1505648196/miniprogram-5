// pages/publish_carpool/publish_carpool.js
// 包子行业信息平台 · 发布顺风车表单（车找人 carpool_car / 人找车 carpool_person）
// 支持新建(publishPost) 与 编辑(managePost action=get + update，带 ?id=)
// 字段（与 carpool 频道页 / detail 展示一致）：from_place/to_place/depart_time/depart_deadline/seats
// 无价格；需选择所在城市(归属地) 供统一 region 展示，另给出发地/目的地两个文本。

const regionData = require('../../utils/regionData.js');

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
  },

  onLoad(options) {
    const editId = (options && options.id) || '';
    if (editId) {
      this.setData({ isEdit: true, editId });
      wx.setNavigationBarTitle({ title: '编辑顺风车' });
      this.loadForEdit(editId);
    }
  },

  // 编辑态：拉本人原帖预填
  loadForEdit(id) {
    wx.showLoading({ title: '加载中…', mask: true });
    wx.cloud
      .callFunction({ name: 'managePost', data: { action: 'get', _id: id }, config: { timeout: 10000 } })
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
        this.setData({
          catIdx: catIdx >= 0 ? catIdx : -1,
          form,
          region,
          regionPick,
          image,
          imageFiles,
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish_carpool] 编辑加载失败:', err && err.errMsg);
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  // 选类别
  onCatTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ catIdx: idx });
  },

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
        console.error('[publish_carpool] 图片上传失败:', err && err.errMsg);
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
    const { form, region, image, catIdx } = this.data;
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
      // 编辑：managePost(action=update)
      wx.showLoading({ title: '保存中…', mask: true });
      wx.cloud
        .callFunction({ name: 'managePost', data: { action: 'update', _id: this.data.editId, form: base }, config: { timeout: 10000 } })
        .then((res) => {
          wx.hideLoading();
          const r = res.result || {};
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
          console.error('[publish_carpool] 保存失败:', err && err.errMsg);
        });
      return;
    }

    // 新建：publishPost
    wx.showLoading({ title: '发布中…', mask: true });
    wx.cloud
      .callFunction({ name: 'publishPost', data: { form: base }, config: { timeout: 10000 } })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
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
        console.error('[publish_carpool] 发布失败:', err && err.errMsg);
      });
  },
});
