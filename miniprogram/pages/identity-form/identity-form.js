// pages/identity-form/identity-form.js
// 身份认证表单页：按身份类型（owner/master）显示不同表单
// 师傅(master)：名字、身份证、地址、电话号码
// 店主(owner)：营业执照、电话号码、地址、身份证

Page({
  data: {
    loading: true,
    // 当前身份类型
    identityType: '',       // owner / master
    identityName: '',       // 店主 / 师傅
    // 表单
    form: {
      real_name: '',        // 姓名（师傅必填，店主选填）
      id_card: '',          // 身份证号
      phone: '',            // 电话号码
      address: '',          // 地址
      license_img: '',      // 营业执照（店主）
      photos: [],           // 其他证明材料
    },
    // 审核状态
    applyStatus: 'none',    // none/pending/approved/rejected
    rejectReason: '',
    // 提交状态
    submitting: false,
    // 撤销确认弹窗
    cancelDialogVisible: false,
    // 各身份字段配置
    fieldConfig: {
      master: {
        name: '师傅',
        icon: 'user-business',
        color: '#9254DE',
        fields: ['real_name', 'id_card', 'phone', 'address'],
      },
      owner: {
        name: '店主',
        icon: 'store',
        color: '#597EF7',
        fields: ['real_name', 'license_img', 'id_card', 'phone', 'address'],
      },
    },
  },

  onLoad(options) {
    const type = String(options.type || '').trim();
    if (!type || !['owner', 'master'].includes(type)) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    const config = this.data.fieldConfig[type];
    this.setData({
      identityType: type,
      identityName: config.name,
    });
    this.loadStatus();
  },

  // 加载当前身份的认证状态
  // 容错策略：userIdentity 未部署/调用失败时，降级为「全新空白表单」让用户可正常填写，
  // 而不是卡死在骨架屏。回填仅在有最近申请记录时进行；无记录则保持空白。
  loadStatus() {
    this.setData({ loading: true });
    return wx.cloud.callFunction({
      name: 'userIdentity',
      data: { action: 'status', identity: this.data.identityType },
      config: { timeout: 10000 },
    }).then((res) => {
      const r = (res && res.result) || {};
      if (!r.success) {
        // 云函数返回失败（如集合未建/参数问题）：降级为空白表单，不阻断填写
        console.warn('[identity-form] userIdentity.status 返回失败:', r.message || r);
        this.setData({ loading: false, applyStatus: 'none' });
        return;
      }

      const identities = Array.isArray(r.identities) ? r.identities : [];
      const lastApplies = Array.isArray(r.lastApplies) ? r.lastApplies : [];
      const lastApply = lastApplies.find((a) => a.identity === this.data.identityType) || null;

      // 状态判定：已认证 > 最近申请状态
      let applyStatus = 'none';
      let rejectReason = '';
      if (identities.includes(this.data.identityType)) {
        applyStatus = 'approved';
      } else if (lastApply) {
        applyStatus = lastApply.status || 'none';
        rejectReason = lastApply.reject_reason || '';
      }

      // 回填表单：有最近申请记录就回填（approved/pending/rejected 都可编辑重新提交）
      if (lastApply) {
        this.setData({
          'form.real_name': lastApply.real_name || '',
          'form.id_card': lastApply.id_card || '',
          'form.phone': lastApply.phone || '',
          'form.address': lastApply.address || '',
          'form.license_img': lastApply.license_img || '',
          'form.photos': Array.isArray(lastApply.photos) ? [...lastApply.photos] : [],
        });
      }

      this.setData({
        loading: false,
        applyStatus,
        rejectReason,
      });
    }).catch((err) => {
      // 云函数未部署/网络异常等抛错：降级为空白表单，仅控制台告警，不弹窗阻断
      console.error('[identity-form] userIdentity 调用失败:', err && err.errMsg);
      this.setData({ loading: false, applyStatus: 'none' });
    });
  },

  // ---------- 输入 ----------
  onNameInput(e) { this.setData({ 'form.real_name': e.detail.value }); },
  onIdCardInput(e) { this.setData({ 'form.id_card': e.detail.value }); },
  onPhoneInput(e) { this.setData({ 'form.phone': e.detail.value }); },
  onAddressInput(e) { this.setData({ 'form.address': e.detail.value }); },

  // ---------- 图片上传 ----------
  pickAndUploadImage(count = 1, type = 'photo') {
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: (res) => {
          const files = (res.tempFiles || []).map((f) => f.tempFilePath);
          if (!files.length) return reject(new Error('未选择图片'));
          wx.showLoading({ title: '图片检测中…', mask: true });
          const tasks = files.map((fp, idx) => {
            const ext = (fp.split('.').pop() || 'jpg').split('?')[0];
            const cloudPath = `identity/${type}/${Date.now()}_${idx}_${Math.floor(Math.random() * 10000)}.${ext}`;
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
            .then((results) => {
              wx.hideLoading();
              resolve(results.filter(Boolean));
            })
            .catch((err) => {
              wx.hideLoading();
              reject(err);
            });
        },
        fail: reject,
      });
    });
  },

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

  onPickLicense() {
    this.pickAndUploadImage(1, 'license')
      .then((ids) => this.setData({ 'form.license_img': ids[0] }))
      .catch((err) => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  onPickPhotos() {
    const remain = 6 - this.data.form.photos.length;
    if (remain <= 0) { wx.showToast({ title: '已达 6 张上限', icon: 'none' }); return; }
    this.pickAndUploadImage(Math.min(remain, 6), 'photo')
      .then((ids) => {
        this.setData({ 'form.photos': this.data.form.photos.concat(ids) });
      })
      .catch((err) => {
        if (err && /cancel/.test(err.errMsg || '')) return;
        const title = (err && err.isIllegal) ? '图片内容违规，请更换' : '上传失败';
        wx.showToast({ title, icon: 'none' });
      });
  },

  onPreviewPhoto(e) {
    const urls = this.data.identityType === 'owner' && this.data.form.license_img
      ? [this.data.form.license_img, ...this.data.form.photos]
      : this.data.form.photos;
    wx.previewImage({ urls, current: e.currentTarget.dataset.item });
  },

  onRemovePhoto(e) {
    const idx = e.currentTarget.dataset.index;
    const photos = this.data.form.photos.slice();
    photos.splice(idx, 1);
    this.setData({ 'form.photos': photos });
  },

  onRemoveLicense() {
    this.setData({ 'form.license_img': '' });
  },

  // ---------- 提交认证申请 ----------
  async onSubmit() {
    if (this.data.submitting) return;
    const f = this.data.form;
    const type = this.data.identityType;

    // 按身份类型校验必填
    if (type === 'master') {
      if (!f.real_name.trim()) {
        wx.showToast({ title: '请填写姓名', icon: 'none' });
        return;
      }
      if (!f.id_card.trim()) {
        wx.showToast({ title: '请填写身份证号', icon: 'none' });
        return;
      }
      if (!f.phone.trim()) {
        wx.showToast({ title: '请填写电话号码', icon: 'none' });
        return;
      }
      if (!f.address.trim()) {
        wx.showToast({ title: '请填写地址', icon: 'none' });
        return;
      }
    } else if (type === 'owner') {
      if (!f.real_name.trim()) {
        wx.showToast({ title: '请填写姓名', icon: 'none' });
        return;
      }
      if (!f.license_img) {
        wx.showToast({ title: '请上传营业执照', icon: 'none' });
        return;
      }
      if (!f.id_card.trim()) {
        wx.showToast({ title: '请填写身份证号', icon: 'none' });
        return;
      }
      if (!f.phone.trim()) {
        wx.showToast({ title: '请填写电话号码', icon: 'none' });
        return;
      }
      if (!f.address.trim()) {
        wx.showToast({ title: '请填写地址', icon: 'none' });
        return;
      }
    }

    // 通用校验
    if (f.phone && !/^1\d{10}$/.test(f.phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    if (f.id_card && !/(^\d{15}$)|(^\d{18}$)|(^\d{17}(\d|X|x)$)/.test(f.id_card)) {
      wx.showToast({ title: '身份证号格式不正确', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中…', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'userIdentity',
        data: {
          action: 'submit',
          payload: {
            identity: type,
            real_name: f.real_name.trim(),
            id_card: f.id_card.trim(),
            phone: f.phone.trim(),
            address: f.address.trim(),
            license_img: f.license_img,
            photos: f.photos,
          },
        },
        config: { timeout: 15000 },
      });
      wx.hideLoading();
      this.setData({ submitting: false });

      const r = (res && res.result) || {};
      if (!r.success) {
        wx.showToast({ title: r.message || '提交失败', icon: 'none' });
        return;
      }

      wx.showToast({ title: '已提交，等待审核', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      console.error('[identity-form] 提交失败:', err && err.errMsg);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
    }
  },

  // ---------- 撤销申请 ----------
  onCancelTap() {
    this.setData({ cancelDialogVisible: true });
  },
  onCancelDialogClose() {
    this.setData({ cancelDialogVisible: false });
  },
  async onCancelConfirm() {
    this.setData({ cancelDialogVisible: false });
    wx.showLoading({ title: '撤销中…', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'userIdentity',
        data: { action: 'cancel', identity: this.data.identityType },
        config: { timeout: 10000 },
      });
      wx.hideLoading();
      const r = (res && res.result) || {};
      if (!r.success) {
        wx.showToast({ title: r.message || '撤销失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已撤销申请', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      wx.hideLoading();
      console.error('[identity-form] 撤销失败:', err && err.errMsg);
      wx.showToast({ title: '撤销失败，请重试', icon: 'none' });
    }
  },
});
