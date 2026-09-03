// pages/publish_recruit/publish_recruit.js
// 包子行业信息平台 · 发布招工表单
// 提交走 publishPost 云函数（data_type=recruit 入库）。字段与云函数一一对应。

const regionData = require('../../utils/regionData.js');

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
  },

  onLoad(options) {
    const editId = (options && options.id) || '';
    if (editId) {
      this.setData({ isEdit: true, editId });
      wx.setNavigationBarTitle({ title: '编辑招工' });
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
    wx.showLoading({ title: '图片上传中…', mask: true });
    this.uploadOne(newOne)
      .then((fileID) => {
        wx.hideLoading();
        this.setData({ image: fileID || '', imageFiles: files });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[publish_recruit] 图片上传失败:', err && err.errMsg);
        wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
      });
  },

  // 上传单张到云存储，返回 fileID（云 fileID 可直接作 <image> src）
  uploadOne(file) {
    const src = file.url || file.name || '';
    const ext = (src.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const cloudPath = `posts/${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}.${ext}`;
    return wx.cloud.uploadFile({ cloudPath, filePath: file.url }).then((res) => res.fileID || '');
  },

  // t-upload 删除(bind:remove)：e.detail = { index, file }。单图场景删即清空回填的 image，避免仍带旧图提交
  onUploadRemove() {
    this.setData({ image: '', imageFiles: [] });
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
      // 编辑：managePost(action=update)
      wx.showLoading({ title: '保存中…', mask: true });
      const updateForm = Object.assign({}, base, { raw_text: desc });
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
          console.error('[publish_recruit] 保存失败:', err && err.errMsg);
        });
      return;
    }

    // 新建：publishPost
    wx.showLoading({ title: '发布中…', mask: true });
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
        console.error('[publish_recruit] 发布失败:', err && err.errMsg);
      });
  },
});
