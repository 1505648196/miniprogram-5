// pages/chat/chat.js
// 包子行业信息平台 · 管理员 AI 对话页（后台数据查询与运营反馈）
// 数据源：adminChat 云函数（意图识别 → 查全量数据 → 返回结构化 blocks）
// 前端自定义消息列表渲染（卡片式 KPI / 列表 / 文本）

let uniqueId = 0;
function getUniqueKey() {
  uniqueId += 1;
  return `msg-${Date.now()}-${uniqueId}`;
}

function getCurrentTime() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 管理员鉴权：改走「openid 通道」——不再在小程序端硬编码管理员口令。
// 云函数 adminAuth / adminChat 会取服务端 getWXContext().OPENID，命中
// ADMIN_OPENIDS 白名单 或 baozi_users.role === 'admin' 即视为管理员。
// （原实现硬编码 admin/admin，与 adminAuth 的 admin_accounts 账密体系不一致，
//   导致「AI 能查出来、点按钮却提示未授权」。）


// 快速提问引导（管理员场景）
const QUICK_QUESTIONS = [
  '平台数据概览',
  '有多少待审核帖子',
  '深圳的招工信息',
  '最近支付订单',
];

// 能力标签
const CAPABILITIES = ['数据统计', '帖子查询', '用户管理', '订单流水', '商家入驻', '置顶管理'];

// AI 头像（TDesign 官方 chat 示例图，蓝色圆形，https 已确认可用）
const AI_AVATAR = 'https://tdesign.gtimg.com/site/chat-avatar.png';

Page({
  data: {
    chatList: [],           // 消息列表（新的在前，用 unshift 插入）
    value: '',              // 输入框值
    loading: false,         // AI 回复中
    disabled: false,
    renderPresets: [{ name: 'send', type: 'icon' }],
    quickQuestions: QUICK_QUESTIONS,
    capabilities: CAPABILITIES,
    scrollIntoView: '',
    auditing: false,        // 审核操作进行中（防重复点击）
    deepThinkActive: false, // 深度思考开关：开启后 AI 全面接管（跳过规则识别）
    contextActive: false,   // 上下文开关：开启后多轮追问继承上一轮筛选条件（仅深度思考模式）
    keyboardHeight: 0,      // 键盘弹起高度（px），用于让输入框跟随键盘上移
    // 输入框紧凑配置：minHeight 调小，输入框默认高度更小（不占空间）
    textareaProps: { autosize: { maxHeight: 200, minHeight: 32 } },
  },

  // 上一轮的查询上下文（tool + args），非 data（避免 setData 开销）
  chatContext: null,

  // 切换「深度思考」开关（AI 全面接管模式）
  onDeepThinkTap() {
    const next = !this.data.deepThinkActive;
    // 关闭深度思考时，同步关闭上下文开关（按钮只在深度思考开启时出现）
    this.setData({ deepThinkActive: next, contextActive: next ? this.data.contextActive : false });
    wx.showToast({
      title: next ? '已进入 AI 全面接管模式' : '已退出 AI 全面接管模式',
      icon: 'none',
    });
    // 退出深度思考时清空上下文
    if (!next) this.chatContext = null;
  },

  // 切换「上下文」开关（仅深度思考模式下可见）
  onContextTap() {
    if (!this.data.deepThinkActive) return;
    const next = !this.data.contextActive;
    this.setData({ contextActive: next });
    wx.showToast({
      title: next ? '已开启上下文记忆' : '已关闭上下文记忆',
      icon: 'none',
    });
    // 关闭时清空上下文
    if (!next) this.chatContext = null;
  },

  onQuickTap(e) {
    const q = e.currentTarget.dataset.q;
    if (!q) return;
    this.sendMessage(q);
  },

  onSend(e) {
    const value = (e && e.detail && e.detail.value) || '';
    const text = String(value || '').trim();
    if (!text) return;
    this.sendMessage(text);
  },

  async sendMessage(text) {
    if (this.data.loading) return;

    // 1) 追加用户消息（右侧蓝气泡）
    const userMsg = {
      id: getUniqueKey(),
      role: 'user',
      text,
      time: getCurrentTime(),
    };
    // 2) 追加"思考中"的助手占位消息
    const assistantMsg = {
      id: getUniqueKey(),
      role: 'assistant',
      avatar: AI_AVATAR,
      name: '管理员 AI 助手',
      time: getCurrentTime(),
      loading: true,
      title: '',
      blocks: [],
      question: text, // 记录原问题，翻页时复用
      // 思考过程（配合 t-chat-thinking 展示）
      thinking: this.data.deepThinkActive, // 是否展示思考过程（仅深度思考模式）
      thinkingStatus: 'pending',           // pending / complete
      thinkingContent: { title: '正在深度思考…', text: '' },
    };
    this.setData({
      chatList: [...this.data.chatList, userMsg, assistantMsg],
      value: '',
      loading: true,
    });
    this.scrollToBottom();

    // 3) 调 adminChat 云函数（带管理员口令；deepThink 控制是否 AI 全面接管）
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminChat',
        data: {
          question: text,
          deepThink: this.data.deepThinkActive,
          // 上下文：仅深度思考 + 开启上下文开关时，才传"结构化上下文"和"对话历史"
          // 否则传空，确保不开启开关时每次都是独立查询，不会自动继承上一轮
          context: this.data.deepThinkActive && this.data.contextActive && this.chatContext
            ? this.chatContext
            : null,
          history: this.data.deepThinkActive && this.data.contextActive
            ? this.data.chatList.slice(-6).map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.role === 'user' ? m.text : (m.title || ''),
              }))
            : [],
        },
        config: { timeout: 30000 },
      });
      const r = (res && res.result) || {};
      this.applyAssistant(assistantMsg, r);
    } catch (err) {
      console.error('[chat] adminChat 调用失败:', err && err.errMsg);
      this.applyAssistant(assistantMsg, {
        success: false,
        message: '服务暂时不可用，请稍后再试',
      });
    } finally {
      this.setData({ loading: false });
      this.scrollToBottom();
    }
  },

  // 把云函数结果应用到助手消息
  applyAssistant(assistantMsg, r) {
    let title = '查询结果';
    let blocks = [];
    if (r && r.success === false) {
      title = '出错了';
      blocks = [{ type: 'text', text: '⚠️ ' + (r.message || '未授权，请检查管理员口令') }];
    } else if (r && r.blocks) {
      title = r.title || '查询结果';
      blocks = r.blocks;
    } else if (r && r.reply) {
      // 兜底：旧版纯文本
      title = r.title || '查询结果';
      blocks = [{ type: 'text', text: r.reply }];
    } else {
      blocks = [{ type: 'empty', text: '没有找到相关信息，换个问法试试？' }];
    }

    // 更新上下文：深度思考模式下，记录本次的 tool + toolArgs，供下一轮追问继承
    if (this.data.deepThinkActive && r && r.mode === 'deepThink' && r.tool) {
      this.chatContext = { tool: r.tool, args: (r.toolArgs || {}) };
    }

    const list = this.data.chatList.map((m) => {
      if (m !== assistantMsg) return m;
      return Object.assign({}, m, {
        loading: false,
        title,
        blocks,
        // 记录本次的工具选择（深度思考翻页时复用，避免重新做意图识别）
        tool: (r && r.tool) || null,
        toolArgs: (r && r.toolArgs) || {},
        // 思考完成：深度思考模式下，把思考状态收敛为 complete
        thinkingStatus: m.thinking ? 'complete' : 'pending',
        thinkingContent: m.thinking ? {
          title: '已完成思考',
          text: r && r.mode === 'deepThink' && r.tool
            ? `已理解问题，自动选择「${r.tool}」工具查询真实数据。`
            : '已理解问题并完成查询。',
        } : m.thinkingContent,
      });
    });
    this.setData({ chatList: list });
  },

  // 翻页：重新调 adminChat 带 page 参数，更新该列表块
  async onPageChange(e) {
    const { msgId, blkIndex, page } = e.currentTarget.dataset;
    const msg = this.data.chatList.find((m) => m.id === msgId);
    if (!msg || !msg.question) return;

    const targetPage = Number(page) || 1;
    // 给该列表块加 loading 态
    this.setBlockLoading(msgId, blkIndex, true);
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminChat',
        data: {
          question: msg.question,
          page: targetPage,
          deepThink: !!msg.tool,
          tool: msg.tool || undefined,
          toolArgs: msg.toolArgs || {},
        },
        config: { timeout: 30000 },
      });
      const r = (res && res.result) || {};
      this.setBlockLoading(msgId, blkIndex, false);
      if (r && r.success !== false && r.blocks) {
        // 找到 list 块，替换其 items + pagination
        const newListBlk = r.blocks.find((blk) => blk.type === 'list');
        if (newListBlk) {
          this.updateBlock(msgId, blkIndex, newListBlk);
        }
      } else {
        wx.showToast({ title: (r && r.message) || '翻页失败', icon: 'none' });
      }
    } catch (err) {
      this.setBlockLoading(msgId, blkIndex, false);
      console.error('[chat] 翻页失败:', err && err.errMsg);
      wx.showToast({ title: '翻页失败，请重试', icon: 'none' });
    }
  },

  // 设置列表块 loading 态
  setBlockLoading(msgId, blkIndex, loading) {
    const list = this.data.chatList.map((m) => {
      if (m.id !== msgId) return m;
      const blocks = m.blocks.map((blk, i) => {
        if (i !== Number(blkIndex)) return blk;
        return Object.assign({}, blk, { loading });
      });
      return Object.assign({}, m, { blocks });
    });
    this.setData({ chatList: list });
  },

  // 更新列表块的 items + pagination
  updateBlock(msgId, blkIndex, newBlk) {
    const list = this.data.chatList.map((m) => {
      if (m.id !== msgId) return m;
      const blocks = m.blocks.map((blk, i) => {
        if (i !== Number(blkIndex)) return blk;
        return Object.assign({}, blk, { items: newBlk.items, pagination: newBlk.pagination, loading: false });
      });
      return Object.assign({}, m, { blocks });
    });
    this.setData({ chatList: list });
  },

  // 复制帖子完整信息
  onCopyDetail(e) {
    const detail = e.currentTarget.dataset.detail;
    if (!detail) return;
    wx.setClipboardData({
      data: detail,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  // 审核通过
  onAuditPass(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.doAudit(id);
  },

  // 调 adminAuth 审核通过，成功后本地更新列表项状态（标记已处理）
  async doAudit(postId) {
    if (this.data.auditing) return;
    this.setData({ auditing: true });
    wx.showLoading({ title: '审核通过中…', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminAuth',
        data: { action: 'audit', _id: postId },
        config: { timeout: 10000 },
      });
      const r = (res && res.result) || {};
      wx.hideLoading();
      if (r.success) {
        wx.showToast({ title: '已通过', icon: 'success' });
        this.markAudited(postId);
      } else {
        wx.showToast({ title: r.message || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[chat] 审核失败:', err && err.errMsg);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ auditing: false });
    }
  },

  // 本地把该帖标记为已通过（去掉审核按钮，更新 tag）
  markAudited(postId) {
    const list = this.data.chatList.map((m) => {
      if (!m.blocks) return m;
      const blocks = m.blocks.map((blk) => {
        if (blk.type !== 'list' || !blk.items) return blk;
        const items = blk.items.map((li) => {
          if (li.id !== postId) return li;
          return Object.assign({}, li, {
            pending: false,
            tag: '已过审',
            tagColor: 'success',
          });
        });
        return Object.assign({}, blk, { items });
      });
      return Object.assign({}, m, { blocks });
    });
    this.setData({ chatList: list });
  },

  // 编辑帖子：跳转到对应编辑页（带 admin=1 标记，管理员模式绕过归属校验）
  onEditPost(e) {
    const { id, type } = e.currentTarget.dataset;
    if (!id) return;
    if (type === 'recruit') { wx.navigateTo({ url: `/pages/publish_recruit/publish_recruit?id=${id}&admin=1` }); return; }
    if (type === 'carpool_car' || type === 'carpool_person') { wx.navigateTo({ url: `/pages/publish_carpool/publish_carpool?id=${id}&admin=1` }); return; }
    wx.navigateTo({ url: `/pages/publish/publish?type=${type}&id=${id}&admin=1` });
  },

  // 下架帖子：调 adminAuth offline（status=offline）
  onOfflinePost(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.showModal({
      title: '下架信息',
      content: '下架后该信息将不再公开展示，确定下架？',
      confirmText: '下架',
      confirmColor: '#E34D59',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '下架中…', mask: true });
        try {
          const r = await wx.cloud.callFunction({
            name: 'adminAuth',
            data: { action: 'offline', _id: id },
            config: { timeout: 10000 },
          });
          wx.hideLoading();
          const rr = (r && r.result) || {};
          if (rr.success) {
            wx.showToast({ title: '已下架', icon: 'success' });
            this.removePostFromList(id);
          } else {
            wx.showToast({ title: rr.message || '下架失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[chat] 下架失败:', err && err.errMsg);
          wx.showToast({ title: '下架失败，请重试', icon: 'none' });
        }
      },
    });
  },

  // 置顶帖子：弹 action-sheet 选时长（1/3/7/30 天 + 取消置顶）
  onTopPost(e) {
    const { id, type } = e.currentTarget.dataset;
    if (!id) return;
    wx.showActionSheet({
      itemList: ['置顶 1 天', '置顶 3 天', '置顶 7 天', '置顶 30 天', '取消置顶'],
      success: async (res) => {
        const idx = res.tapIndex;
        // 4 = 取消置顶
        if (idx === 4) {
          this.doCancelTop(id);
          return;
        }
        const days = [1, 3, 7, 30][idx];
        if (!days) return;
        wx.showLoading({ title: '置顶中…', mask: true });
        try {
          const r = await wx.cloud.callFunction({
            name: 'adminAuth',
            data: { action: 'top', op: 'set', post_id: id, data_type: type, days },
            config: { timeout: 10000 },
          });
          wx.hideLoading();
          const rr = (r && r.result) || {};
          if (rr.success) {
            wx.showToast({ title: `已置顶 ${days} 天`, icon: 'success' });
          } else {
            wx.showToast({ title: rr.message || '置顶失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[chat] 置顶失败:', err && err.errMsg);
          wx.showToast({ title: '置顶失败，请重试', icon: 'none' });
        }
      },
    });
  },

  // 取消置顶（置顶列表条目上的按钮）
  onCancelTop(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.doCancelTop(id);
  },

  // 执行取消置顶：调 adminAuth top(op=cancel)
  doCancelTop(postId) {
    wx.showLoading({ title: '取消置顶…', mask: true });
    wx.cloud.callFunction({
      name: 'adminAuth',
      data: { action: 'top', op: 'cancel', post_id: postId },
      config: { timeout: 10000 },
    }).then((res) => {
      wx.hideLoading();
      const rr = (res && res.result) || {};
      if (rr.success) {
        wx.showToast({ title: '已取消置顶', icon: 'success' });
        this.removeTopFromList(postId);
      } else {
        wx.showToast({ title: rr.message || '操作失败', icon: 'none' });
      }
    }).catch((err) => {
      wx.hideLoading();
      console.error('[chat] 取消置顶失败:', err && err.errMsg);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    });
  },

  // 本地从置顶列表移除已取消的置顶项（按帖子 id 匹配 topId 字段）
  removeTopFromList(postId) {
    const list = this.data.chatList.map((m) => {
      if (!m.blocks) return m;
      const blocks = m.blocks.map((blk) => {
        if (blk.type !== 'list' || !blk.items) return blk;
        const items = blk.items.filter((li) => li.id !== postId || !li.topId);
        const pagination = blk.pagination ? Object.assign({}, blk.pagination, { total: Math.max(0, blk.pagination.total - 1) }) : blk.pagination;
        return Object.assign({}, blk, { items, pagination });
      });
      return Object.assign({}, m, { blocks });
    });
    this.setData({ chatList: list });
  },

  // 删除帖子：调 adminAuth delete
  onDeletePost(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.showModal({
      title: '删除信息',
      content: '删除后不可恢复，确定删除这条信息？',
      confirmText: '删除',
      confirmColor: '#E34D59',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中…', mask: true });
        try {
          const r = await wx.cloud.callFunction({
            name: 'adminAuth',
            data: { action: 'delete', _id: id },
            config: { timeout: 10000 },
          });
          wx.hideLoading();
          const rr = (r && r.result) || {};
          if (rr.success) {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.removePostFromList(id);
          } else {
            wx.showToast({ title: rr.message || '删除失败', icon: 'none' });
          }
        } catch (err) {
          wx.hideLoading();
          console.error('[chat] 删除失败:', err && err.errMsg);
          wx.showToast({ title: '删除失败，请重试', icon: 'none' });
        }
      },
    });
  },

  // 本地从列表移除已删除的帖子
  removePostFromList(postId) {
    const list = this.data.chatList.map((m) => {
      if (!m.blocks) return m;
      const blocks = m.blocks.map((blk) => {
        if (blk.type !== 'list' || !blk.items) return blk;
        const items = blk.items.filter((li) => li.id !== postId);
        const pagination = blk.pagination ? Object.assign({}, blk.pagination, { total: Math.max(0, blk.pagination.total - 1) }) : blk.pagination;
        return Object.assign({}, blk, { items, pagination });
      });
      return Object.assign({}, m, { blocks });
    });
    this.setData({ chatList: list });
  },

  // 清除对话
  onClearChat() {
    wx.showModal({
      title: '清除对话',
      content: '确定清除当前所有对话记录？',
      confirmText: '清除',
      confirmColor: '#E34D59',
      success: (res) => {
        if (res.confirm) {
          this.setData({ chatList: [], value: '', loading: false });
          wx.showToast({ title: '已清除', icon: 'success' });
        }
      },
    });
  },

  onStop() {
    this.setData({ loading: false });
  },

  onFocus() {},
  // 键盘高度变化：弹起时撑起输入区，收起时归零（让输入框跟随键盘上移）
  onKeyboardHeightChange(e) {
    const height = (e && e.detail && e.detail.height) || 0;
    if (height !== this.data.keyboardHeight) {
      this.setData({ keyboardHeight: height });
    }
  },
  onChange(e) {
    this.setData({ value: (e && e.detail && e.detail.value) || '' });
  },

  // 语音识别完成：把识别文字填入输入框（管理员可编辑后再发送）
  onRecognize(e) {
    const detail = (e && e.detail) || {};
    const text = String(detail.voiceText || '').trim();
    if (!text) {
      wx.showToast({ title: '未识别到语音内容', icon: 'none' });
      return;
    }
    this.setData({ value: text });
  },

  scrollToBottom() {
    wx.nextTick(() => {
      this.setData({ scrollIntoView: 'chat-bottom' });
    });
  },
});
