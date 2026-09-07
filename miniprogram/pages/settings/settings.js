// pages/settings/settings.js
// 包子行业信息平台 · 设置（个人资料）
// 功能：修改头像（云开发直传）/ 修改昵称（过内容安全）/ 绑定微信手机号
// 数据源：
//   - 读取：getOrCreateUser（无参调用，返回当前用户）
//   - 保存：getOrCreateUser({ action: 'updateProfile', username, avatar })
//   - 手机号：getOrCreateUser({ phoneCode })，复用已有的微信授权绑定 + 老帖认领逻辑
//
// 注意：t-input 的 change 事件 detail 结构为 { value, cursor, keyCode }，取值用 e.detail.value

const MAX_NAME = 20;

Page({
  data: {
    loading: true,
    // 编辑中的资料副本
    username: '',
    avatar: '',
    avatarText: '包',
    // 原始值，用于判断是否有改动
    originUsername: '',
    originAvatar: '',
    // 手机号（只读展示，通过微信授权绑定）
    phoneMasked: '',
    phoneVerified: false,
    // 状态
    saving: false,
    uploading: false,
    skeletonRows: [
      [{ width: '100%', height: '180rpx', type: 'rect' }],
      [{ width: '100%', height: '80rpx', type: 'rect' }],
      [{ width: '100%', height: '80rpx', type: 'rect' }],
    ],
  },

  onLoad() {
    this.loadUser();
  },

  // 读取当前用户资料
  loadUser() {
    this.setData({ loading: true });
    return wx.cloud
      .callFunction({ name: 'getOrCreateUser', data: {}, config: { timeout: 10000 } })
      .then((res) => {
        const r = res.result || {};
        if (!r.success || !r.user) {
          this.setData({ loading: false });
          return;
        }
        const u = r.user;
        this.applyUser(u);
        this.setData({ loading: false });
      })
      .catch((err) => {
        console.error('[settings] 读取用户资料失败:', err && err.errMsg);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      });
  },

  // 把用户信息写入编辑副本与原始值
  applyUser(u) {
    const username = String((u && u.username) || '');
    const avatar = String((u && u.avatar) || '');
    this.setData({
      username,
      avatar,
      avatarText: username ? username.slice(0, 1) : '包',
      originUsername: username,
      originAvatar: avatar,
      phoneMasked: String((u && u.phone_masked) || ''),
      phoneVerified: !!(u && u.phone_verified),
    });
  },

  // 昵称输入（t-input change：e.detail = { value, cursor, keyCode }）
  onNameInput(e) {
    const value = e && e.detail ? e.detail.value : '';
    this.setData({ username: value || '' });
  },

  // 是否有未保存的改动
  hasChanged() {
    const d = this.data;
    return d.username !== d.originUsername || d.avatar !== d.originAvatar;
  },

  // 换头像：选图 → 云开发直传 → 得到 cloud:// fileID
  onChooseAvatar() {
    if (this.data.uploading) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        this.uploadAvatar(file.tempFilePath);
      },
      fail: (err) => {
        // 用户取消选择不算错误
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') >= 0) return;
        console.error('[settings] 选择图片失败:', msg);
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      },
    });
  },

  // 上传头像到云存储，路径 avatars/<时间戳>_<随机数>.<后缀>
  uploadAvatar(tempPath) {
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    const ext = String(tempPath).split('.').pop() || 'png';
    const cloudPath = `avatars/${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
    wx.cloud
      .uploadFile({ cloudPath, filePath: tempPath })
      .then((res) => {
        wx.hideLoading();
        this.setData({ uploading: false });
        const fileID = res && res.fileID;
        if (!fileID) {
          wx.showToast({ title: '上传失败，请重试', icon: 'none' });
          return;
        }
        this.setData({ avatar: fileID });
        wx.showToast({ title: '头像已更新，记得保存', icon: 'none' });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ uploading: false });
        console.error('[settings] 头像上传失败:', err && err.errMsg);
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      });
  },

  // 保存资料
  onSave() {
    if (this.data.saving) return;
    const d = this.data;
    const username = String(d.username || '').trim();

    if (!this.hasChanged()) {
      wx.showToast({ title: '没有改动', icon: 'none' });
      return;
    }
    if (username.length > MAX_NAME) {
      wx.showToast({ title: `昵称不能超过 ${MAX_NAME} 个字`, icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    wx.cloud
      .callFunction({
        name: 'getOrCreateUser',
        data: { action: 'updateProfile', username, avatar: d.avatar },
        config: { timeout: 10000 },
      })
      .then((res) => {
        wx.hideLoading();
        this.setData({ saving: false });
        const r = res.result || {};
        if (!r.success) {
          wx.showToast({ title: r.error || '保存失败', icon: 'none' });
          return;
        }
        // 用服务端返回的最终值刷新，保证与数据库一致
        const u = r.user || {};
        this.setData({
          username: String(u.username || username),
          avatar: String(u.avatar || d.avatar),
          avatarText: String(u.username || username) ? String(u.username || username).slice(0, 1) : '包',
          originUsername: String(u.username || username),
          originAvatar: String(u.avatar || d.avatar),
        });
        const synced = Number(r.synced) || 0;
        wx.showToast({
          title: synced > 0 ? `已保存，同步 ${synced} 条信息` : '已保存',
          icon: 'success',
        });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        console.error('[settings] 保存资料失败:', err && err.errMsg);
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      });
  },

  // 绑定微信手机号（t-button open-type="getPhoneNumber" 回调）
  onGetPhone(e) {
    const detail = (e && e.detail) || {};
    const code = detail.code;
    if (!code) {
      // 用户拒绝授权或返回的是旧版数据
      wx.showToast({ title: '已取消绑定', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '绑定中…', mask: true });
    wx.cloud
      .callFunction({
        name: 'getOrCreateUser',
        data: { phoneCode: code },
        config: { timeout: 10000 },
      })
      .then((res) => {
        wx.hideLoading();
        const r = res.result || {};
        if (!r.success) {
          wx.showToast({ title: r.error || '绑定失败', icon: 'none' });
          return;
        }
        this.setData({
          phoneMasked: String((r.user && r.user.phone_masked) || ''),
          phoneVerified: !!(r.user && r.user.phone_verified),
        });
        const matched = Number(r.matched_posts) || 0;
        wx.showToast({
          title: matched > 0 ? `已绑定，认领 ${matched} 条信息` : '绑定成功',
          icon: 'success',
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error('[settings] 手机号绑定失败:', err && err.errMsg);
        wx.showToast({ title: '绑定失败，请重试', icon: 'none' });
      });
  },
});
