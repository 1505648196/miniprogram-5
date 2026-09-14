// pages/feedback/feedback.js
// 举报 / 意见反馈（同一页面，按 ?type=report|feedback 切换）
//
// 入口：
//   - 帖子详情页点「举报」→ /pages/feedback/feedback?type=report&post_id=xxx&post_type=recruit
//   - 我的页点「意见反馈」 → /pages/feedback/feedback?type=feedback
//
// 提交走 feedback 云函数 action=submit，写入 baozi_feedback 集合，后台可查看处理。
// 图片上传复用项目统一做法：wx.chooseMedia → wx.cloud.uploadFile → imgSecCheck 内容安全

// 举报理由（与云函数 REPORT_REASONS 白名单一致，顺序展示）
const REPORT_REASONS = [
  '虚假信息',
  '电话骚扰',
  '垃圾广告',
  '涉嫌诈骗',
  '内容违规',
  '已成交/失效',
  '其他',
];
// 反馈分类（与云函数 FEEDBACK_REASONS 一致）
const FEEDBACK_REASONS = [
  '功能建议',
  '使用问题',
  '举报投诉',
  '内容错误',
  '其他',
];

const MAX_CONTENT = 500;
const MAX_IMAGES = 3;

Page({
  data: {
    type: 'feedback',       // report | feedback
    isReport: false,
    title: '意见反馈',
    reasons: [],
    // 表单
    reason: '',             // 选中的理由/分类
    content: '',
    contact: '',
    images: [],             // 本地临时路径（提交前上传）
    imageFiles: [],         // t-upload 受控列表
    maxContent: MAX_CONTENT,
    contentLen: 0,
    // 举报对象（快照，仅提交用，不展示）
    postId: '',
    postType: '',
    // 提交
    submitting: false,
    // 图上传网格
    uploadGrid: { column: 3, width: 200, height: 200 },
    maxImages: MAX_IMAGES,
  },

  onLoad(options) {
    const type = (options && options.type) === 'report' ? 'report' : 'feedback';
    const isReport = type === 'report';
    const postId = (options && options.post_id) || '';
    const postType = (options && options.post_type) || '';
    this.setData({
      type,
      isReport,
      title: isReport ? '举报信息' : '意见反馈',
      reasons: isReport ? REPORT_REASONS : FEEDBACK_REASONS,
      postId,
      postType,
    });
    wx.setNavigationBarTitle({ title: isReport ? '举报信息' : '意见反馈' });
  },

  // 选择理由/分类（单选，再点取消）
  onReasonTap(e) {
    const v = (e.currentTarget.dataset || {}).value || '';
    this.setData({ reason: this.data.reason === v ? '' : v });
  },

  onContentInput(e) {
    const v = String((e.detail && e.detail.value) || '');
    this.setData({ content: v, contentLen: v.length });
  },

  onContactInput(e) {
    this.setData({ contact: String((e.detail && e.detail.value) || '') });
  },

  // t-upload 新增：e.detail 直接是本次选择的文件数组（MediaContext[]），url=本地临时路径
  onUploadChange(e) {
    const added = Array.isArray(e.detail) ? e.detail : ((e.detail && e.detail.files) || []);
    const paths = added.map((f) => f && f.url).filter(Boolean);
    const merged = this.data.images.concat(paths).slice(0, MAX_IMAGES);
    this.setData({
      images: merged,
      imageFiles: merged.map((url) => ({ url, type: 'image', status: 'done' })),
    });
  },
  // t-upload 移除：e.detail = { index, file }
  onUploadRemove(e) {
    const index = e && e.detail && e.detail.index != null ? e.detail.index : -1;
    if (index < 0) return;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({
      images,
      imageFiles: images.map((url) => ({ url, type: 'image', status: 'done' })),
    });
  },

  // 图片上传：本地临时路径 → 云存储 fileID（逐张 + 内容安全检测）
  uploadImages(localPaths) {
    if (!localPaths || !localPaths.length) return Promise.resolve([]);
    wx.showLoading({ title: '图片检测中…', mask: true });
    const tasks = localPaths.map((fp, idx) => {
      const ext = (String(fp).split('.').pop() || 'jpg').split('?')[0];
      const cloudPath = `feedback/${Date.now()}_${idx}_${Math.floor(Math.random() * 10000)}.${ext}`;
      return wx.cloud
        .uploadFile({ cloudPath, filePath: fp })
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
    return Promise.all(tasks).then((ids) => {
      wx.hideLoading();
      return ids.filter(Boolean);
    });
  },

  // 图片内容安全检测（复用项目统一云函数 imgSecCheck）
  checkImageSafe(fileID) {
    return wx.cloud
      .callFunction({ name: 'imgSecCheck', data: { fileID }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        return r.suggest || 'pass';
      })
      .catch(() => 'pass'); // 检测服务异常时不阻断用户（可后续人工复核）
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const { type, reason, content, contact, postId, postType } = this.data;

    // 校验
    if (type === 'report') {
      if (!postId) { wx.showToast({ title: '举报目标丢失，请重新进入', icon: 'none' }); return; }
      if (!reason) { wx.showToast({ title: '请选择举报理由', icon: 'none' }); return; }
    } else {
      if (!reason && !String(content || '').trim()) {
        wx.showToast({ title: '请填写反馈内容或选择分类', icon: 'none' });
        return;
      }
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中…', mask: true });

    try {
      // 先上传图片（有则传，失败不阻断文字提交）
      let images = [];
      if (this.data.images.length) {
        try {
          images = await this.uploadImages(this.data.images);
        } catch (e) {
          wx.hideLoading();
          // 图片违规：直接拦下并提示（不提交）
          if (e && e.isIllegal) {
            this.setData({ submitting: false });
            wx.showToast({ title: '图片含违规内容，请更换', icon: 'none' });
            return;
          }
          console.warn('[feedback] 图片上传失败（忽略，继续提交文字）:', e && e.errMsg);
          wx.showLoading({ title: '提交中…', mask: true });
        }
      }

      const res = await wx.cloud.callFunction({
        name: 'feedback',
        data: {
          action: 'submit',
          kind: type,
          reason,
          content,
          contact,
          post_id: postId,
          post_type: postType,
          images,
        },
        config: { timeout: 10000 },
      });
      wx.hideLoading();
      this.setData({ submitting: false });
      const r = (res && res.result) || {};
      if (r.success) {
        wx.showToast({ title: '提交成功，感谢反馈', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 1200);
      } else {
        wx.showToast({ title: r.message || '提交失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      console.error('[feedback] 提交失败:', err && err.errMsg);
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },
});
