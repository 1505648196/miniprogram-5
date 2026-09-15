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

// 帖子类型中文名（批量插入预览用）
const TYPE_NAME_MAP = {
  recruit: '招工', jobseek: '求职', transfer: '转让', want_shop: '求店',
  equip_sell: '设备出售', equip_buy: '设备求购', carpool_car: '车找人',
  carpool_person: '人找车', other: '其他',
};

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
    freeChatActive: false,  // 自由闲聊开关：开启后不注入能力文档，直接与 DeepSeek 闲聊（测试用）
    contextActive: false,   // 上下文开关：开启后多轮追问继承上一轮筛选条件（仅深度思考模式）
    keyboardHeight: 0,      // 键盘弹起高度（px），用于让输入框跟随键盘上移
    // 输入框紧凑配置：minHeight 调小，输入框默认高度更小（不占空间）
    textareaProps: { autosize: { maxHeight: 200, minHeight: 32 } },

    // ===== 操作二次确认框（AI 只定位，执行需管理员确认） =====
    opVisible: false,       // 确认框显隐
    opTitle: '',            // 标题（如「下架确认」）
    opConfirmText: '确认',   // 确认按钮文案
    opAction: '',           // audit / offline / top / forward
    opActionLabel: '',      // 操作中文名
    opTarget: {},           // { id, type, title, sub, content }
    opDays: 7,              // 置顶天数
    opDayOptions: [
      { label: '1 天', value: 1 },
      { label: '3 天', value: 3 },
      { label: '7 天', value: 7 },
      { label: '30 天', value: 30 },
    ],
    opTargets: [],          // 转发可选发送账号
    opWxid: '',             // 转发选中的账号
    opLoadingTargets: false,
    opSubmitting: false,    // 执行中（防重复点击）

    // ===== 批量插入帖子（「＋」悬浮按钮） =====
    insertPopupVisible: false,  // 插入弹窗显隐
    insertText: '',             // 粘贴的原始文本
    insertAnalyzing: false,     // AI 分析中
    insertItems: [],            // AI 识别出的帖子预览列表
    insertConfirming: false,    // 确认插入中
    // 插入输入框高度：初始就占约半屏（autosize 单位 px，320≈40% 屏幕，随内容长高，上限 640）
    // 注意：这里直接就是 {minHeight,maxHeight}，wxml 里 autosize="{{insertTextareaProps}}" 直传
    insertTextareaProps: { minHeight: 320, maxHeight: 640 },
  },

  // 上一轮的查询上下文（tool + args），非 data（避免 setData 开销）
  chatContext: null,

  // 本页面会话中产生的「结果集 id」列表，真正关闭页面时统一清理（避免云端堆积）
  producedResultSets: null,

  // 本次页面会话的 sessionId（会话记忆用）。页面打开时生成，关闭时清理。
  sessionId: null,

  // 页面加载：生成一个本次会话的 sessionId（内存态，不持久化）。
  // 关闭页面后 sessionId 销毁，再进入即全新对话。
  onLoad() {
    this.sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  },

  // ===== 只在「真正关闭页面」时清理本页产生的会话与结果集 =====
  // 说明：onHide（切后台/跳转/锁屏）【不清理】，这样切出去看消息再回来，
  //       连续对话（含结果集链）仍然可用。
  // 仅 onUnload（返回上一页/页面销毁）才清 → 再打开即新对话。
  onUnload() {
    this.cleanupSession();
    this.cleanupResultSets();
  },

  // 清理本次会话（再打开即新对话）。失败不阻断（云端 TTL/超量兜底）。
  cleanupSession() {
    const sid = this.sessionId;
    if (!sid) return;
    this.sessionId = null;
    try {
      wx.cloud.callFunction({
        name: 'adminChat',
        data: { action: 'cleanupSession', sessionId: sid },
      }).catch(() => {});
    } catch (e) {
      // 忽略
    }
  },

  // 清理本页产生的所有结果集：调 adminChat action=cleanupResultSets 批量删除。
  // 注意：onUnload 时页面正在销毁，请求可能发不出去（不可靠），故不依赖其返回值；
  //       云端另有 pruneResultSets（写入时清理 + 最多保留 20 条）与 24h TTL 兜底。
  cleanupResultSets() {
    const ids = this.producedResultSets;
    if (!ids || !ids.length) return;
    const toDelete = ids.slice();
    // 立即清空本地记录，避免重复触发重复请求
    this.producedResultSets = [];
    this.chatContext = null;
    try {
      wx.cloud.callFunction({
        name: 'adminChat',
        data: { action: 'cleanupResultSets', resultSetIds: toDelete },
        // fire-and-forget：不等待结果，不阻断页面销毁
      }).catch(() => {});
    } catch (e) {
      // 忽略：清理失败不影响使用，云端兜底
    }
  },

  // 切换「深度思考」开关（AI 全面接管模式）
  onDeepThinkTap() {
    const next = !this.data.deepThinkActive;
    this.setData({
      deepThinkActive: next,
      // 开启深度思考时【默认同时开启上下文】（多轮追问继承条件/结果集），
      // 关闭深度思考时同步关闭上下文（上下文按钮只在深度思考开启时可见）
      contextActive: next,
      // 开启深度思考时关闭自由闲聊，避免两模式叠加
      freeChatActive: next ? false : this.data.freeChatActive,
    });
    wx.showToast({
      title: next ? '已进入 AI 全面接管模式（已开启上下文）' : '已退出 AI 全面接管模式',
      icon: 'none',
    });
    // 退出深度思考时清空上下文
    if (!next) this.chatContext = null;
  },

  // 切换「自由闲聊」开关（与深度思考互斥，开启后直接与 DeepSeek 闲聊，不注入能力文档）
  onFreeChatTap() {
    const next = !this.data.freeChatActive;
    this.setData({
      freeChatActive: next,
      // 开启闲聊时关闭深度思考，避免两个模式叠加
      deepThinkActive: next ? false : this.data.deepThinkActive,
      contextActive: false,
    });
    if (!next) this.chatContext = null;
    wx.showToast({
      title: next ? '已进入自由闲聊模式' : '已退出自由闲聊模式',
      icon: 'none',
    });
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
          // 自由闲聊模式：不注入能力文档，直接与 DeepSeek 闲聊（测试用）
          freeChat: this.data.freeChatActive,
          deepThink: this.data.deepThinkActive,
          // 会话记忆：深度思考 + 开启上下文时，带上 sessionId。
          // 云端据此维护「条件累积 + 结果集链 + 最近轮次」，实现真正的连续对话。
          sessionId: (this.data.deepThinkActive && this.data.contextActive) ? this.sessionId : null,
          // 上下文：保留兼容（云端优先用 sessionId 的会话记忆；无会话时回退到此）
          context: this.data.deepThinkActive && this.data.contextActive && this.chatContext
            ? this.chatContext
            : null,
          // 对话历史：闲聊模式与深度思考上下文模式都携带（供多轮记忆）
          history: (this.data.freeChatActive || (this.data.deepThinkActive && this.data.contextActive))
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

    // 更新上下文：深度思考模式下，记录本次的 tool + toolArgs + 结果集引用，
    // 供下一轮追问继承条件、以及支持「这里面/这些」对上一轮结果做二次统计。
    if (this.data.deepThinkActive && r && r.mode === 'deepThink' && r.tool) {
      const prevCtx = this.chatContext || {};
      this.chatContext = {
        tool: r.tool,
        args: (r.toolArgs || {}),
        // 结果集：有新 id 用新的，没有则【保留旧 id】（避免被 null 覆盖导致断链）
        resultSetId: r.resultSetId || prevCtx.resultSetId || null,
        resultCount: r.resultCount || prevCtx.resultCount || 0,
      };
      // 记录本页面产生的全部结果集 id，供离开页面时一次性清理（避免云端堆积）
      if (r.resultSetId) {
        if (!this.producedResultSets) this.producedResultSets = [];
        if (this.producedResultSets.indexOf(r.resultSetId) === -1) {
          this.producedResultSets.push(r.resultSetId);
        }
      }
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

    // 操作类结果：云函数已定位到唯一目标并返回 needConfirm → 弹二次确认框
    if (r && r.needConfirm && r.action && r.target) {
      this.openOpConfirm(r);
    }
  },

  // 打开操作确认框（由云函数返回的待确认结构驱动）
  openOpConfirm(r) {
    const action = r.action;
    const target = r.target || {};
    this.setData({
      opVisible: true,
      opAction: action,
      opActionLabel: r.actionLabel || '操作',
      opTitle: `${r.actionLabel || '操作'}确认`,
      opConfirmText: `确认${r.actionLabel || ''}`,
      opTarget: target,
      opDays: r.days || 7,
      opTargets: [],
      opWxid: '',
      opLoadingTargets: false,
    });
    // 转发需要拉取在线发送账号
    if (action === 'forward') {
      this.loadOpTargets();
    }
  },

  // 拉取在线发送账号（与详情页同源：wxTask action=online）
  loadOpTargets() {
    this.setData({ opLoadingTargets: true });
    wx.cloud.callFunction({
      name: 'wxTask',
      data: { action: 'online' },
      config: { timeout: 10000 },
    })
      .then((res) => {
        const r = (res && res.result) || {};
        const online = Array.isArray(r.online) ? r.online : (Array.isArray(r.list) ? r.list : []);
        this.setData({
          opLoadingTargets: false,
          opTargets: online,
          opWxid: online.length ? online[0] : '',
        });
      })
      .catch(() => {
        this.setData({ opLoadingTargets: false, opTargets: [], opWxid: '' });
      });
  },

  onOpDaysChange(e) {
    this.setData({ opDays: e.detail.value });
  },

  onOpWxidChange(e) {
    this.setData({ opWxid: e.detail.value });
  },

  onOpCancel() {
    if (this.data.opSubmitting) return;
    this.setData({ opVisible: false });
  },

  // 确认执行：按 action 分发到 adminAuth / wxTask（真正改库在这里）
  async onOpConfirm() {
    if (this.data.opSubmitting) return;
    const { opAction, opTarget, opDays, opWxid } = this.data;

    if (opAction === 'forward') {
      if (!opWxid) {
        wx.showToast({ title: '请先选择发送账号', icon: 'none' });
        return;
      }
    }

    this.setData({ opSubmitting: true });
    wx.showLoading({ title: '执行中…', mask: true });
    try {
      let okMsg = '';
      if (opAction === 'audit') {
        const r = await wx.cloud.callFunction({
          name: 'adminAuth',
          data: { action: 'audit', _id: opTarget.id },
          config: { timeout: 10000 },
        });
        const rr = (r && r.result) || {};
        if (!rr.success) throw new Error(rr.message || '操作失败');
        okMsg = '已通过审核';
      } else if (opAction === 'offline') {
        const r = await wx.cloud.callFunction({
          name: 'adminAuth',
          data: { action: 'offline', _id: opTarget.id },
          config: { timeout: 10000 },
        });
        const rr = (r && r.result) || {};
        if (!rr.success) throw new Error(rr.message || '操作失败');
        okMsg = '已下架';
      } else if (opAction === 'top') {
        const r = await wx.cloud.callFunction({
          name: 'adminAuth',
          data: { action: 'top', op: 'set', post_id: opTarget.id, data_type: opTarget.type, days: opDays },
          config: { timeout: 10000 },
        });
        const rr = (r && r.result) || {};
        if (!rr.success) throw new Error(rr.message || '操作失败');
        okMsg = `已置顶 ${opDays} 天`;
      } else if (opAction === 'forward') {
        const r = await wx.cloud.callFunction({
          name: 'wxTask',
          data: { action: 'create', wxid: opWxid, content: opTarget.content || '' },
          config: { timeout: 15000 },
        });
        const rr = (r && r.result) || {};
        if (!rr.success) throw new Error(rr.message || '提交失败');
        okMsg = '已提交，稍后自动发布';
      } else {
        throw new Error('不支持的操作');
      }

      wx.hideLoading();
      wx.showToast({ title: okMsg, icon: 'success' });
      this.setData({ opVisible: false, opSubmitting: false });

      // 在对话里补一条成功提示，形成闭环
      this.appendSystemTip(`✅ ${this.data.opActionLabel}成功：${opTarget.title}`);
    } catch (err) {
      wx.hideLoading();
      this.setData({ opSubmitting: false });
      wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' });
    }
  },

  // 往对话列表追加一条系统提示（AI 头像）
  appendSystemTip(text) {
    const msg = {
      id: getUniqueKey(),
      role: 'assistant',
      avatar: AI_AVATAR,
      name: '管理员 AI 助手',
      time: getCurrentTime(),
      loading: false,
      title: '操作结果',
      blocks: [{ type: 'text', text }],
    };
    this.setData({ chatList: [...this.data.chatList, msg] });
    this.scrollToBottom();
  },

  // ===== 批量插入帖子 =====
  // 打开插入弹窗
  onInsertTap() {
    this.setData({
      insertPopupVisible: true,
      insertText: '',
      insertItems: [],
    });
  },
  // 关闭插入弹窗
  onInsertClose() {
    if (this.data.insertAnalyzing || this.data.insertConfirming) return;
    this.setData({ insertPopupVisible: false, insertText: '', insertItems: [] });
  },
  // 弹窗 visible 变化（点遮罩关闭）
  onInsertPopupVisibleChange(e) {
    if (!e.detail.visible && !this.data.insertAnalyzing && !this.data.insertConfirming) {
      this.setData({ insertPopupVisible: false, insertText: '', insertItems: [] });
    }
  },
  // 输入框内容变化
  onInsertTextChange(e) {
    this.setData({ insertText: e.detail.value || '' });
  },
  // 第一步：AI 分析（切分 + 识别字段，返回预览，不落库）
  async onInsertAnalyze() {
    const text = (this.data.insertText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴要插入的内容', icon: 'none' });
      return;
    }
    if (this.data.insertAnalyzing) return;
    this.setData({ insertAnalyzing: true, insertItems: [] });
    wx.showLoading({ title: 'AI 识别中…', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminChat',
        data: { action: 'analyzeInsert', text },
        config: { timeout: 30000 },
      });
      const r = (res && res.result) || {};
      if (!r.success) throw new Error(r.message || '识别失败');
      const MISSING_NAME = { phone: '手机号', city: '城市', role: '岗位' };
      const items = (r.items || []).map((it) => ({
        ...it,
        // 供预览展示的中文标签
        _typeName: TYPE_NAME_MAP[it.data_type] || it.data_type || '其他',
        _salaryText: it.salary ? `${it.salary}元` : (it.price ? `${it.price}元` : ''),
        _missingTags: (it._missing || []).map((k) => MISSING_NAME[k] || k),
      }));
      this.setData({ insertItems: items });
      wx.hideLoading();
      if (!items.length) {
        wx.showToast({ title: '没有识别到有效帖子', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '识别失败，请重试', icon: 'none' });
    } finally {
      this.setData({ insertAnalyzing: false });
    }
  },
  // 第二步：确认插入
  async onInsertConfirm() {
    const items = this.data.insertItems;
    if (!items.length) {
      wx.showToast({ title: '没有可插入的数据', icon: 'none' });
      return;
    }
    if (this.data.insertConfirming) return;
    this.setData({ insertConfirming: true });
    wx.showLoading({ title: '插入中…', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminChat',
        data: { action: 'confirmInsert', items },
        config: { timeout: 30000 },
      });
      const r = (res && res.result) || {};
      if (!r.success) throw new Error(r.message || '插入失败');
      wx.hideLoading();
      const successCount = r.successCount || 0;
      const failedCount = r.failedCount || 0;
      wx.showToast({ title: `成功 ${successCount} 条${failedCount ? `，失败 ${failedCount} 条` : ''}`, icon: successCount ? 'success' : 'none' });
      this.setData({ insertPopupVisible: false, insertText: '', insertItems: [] });
      // 在对话里补一条结果提示，形成闭环
      this.appendSystemTip(`✅ 已插入 ${successCount} 条帖子${failedCount ? `，失败 ${failedCount} 条` : ''}`);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: (err && err.message) || '插入失败，请重试', icon: 'none' });
    } finally {
      this.setData({ insertConfirming: false });
    }
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

  // 一键复制某条消息里某个列表块的全部信息（按 detail 字段拼接，每条用空行分隔）
  onCopyAll(e) {
    const { msgId, blkIndex } = e.currentTarget.dataset;
    const msg = this.data.chatList.find((m) => m.id === msgId);
    if (!msg || !msg.blocks) return;
    const blk = msg.blocks[Number(blkIndex)];
    if (!blk || !Array.isArray(blk.items) || !blk.items.length) return;

    // 收集所有条目的 detail（已排好版的完整信息），过滤空值
    const parts = blk.items
      .map((li) => (li && typeof li.detail === 'string' ? li.detail.trim() : ''))
      .filter(Boolean);
    if (!parts.length) {
      wx.showToast({ title: '暂无可复制的信息', icon: 'none' });
      return;
    }

    const text = parts.join('\n\n');
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: `已复制 ${parts.length} 条`, icon: 'success' }),
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
          // 对话已清空，本页产生的结果集也一并清掉（追问已无上下文可指代）
          this.cleanupResultSets();
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
