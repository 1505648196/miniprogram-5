// pages/recruit/recruit.js
// 招工独立页：招聘信息流（feedPosts）+ AI 招工助手（aiChat type=recruit）+ 发布入口
const AI_SUGGESTIONS = [
  "上海有哪些包子店在招工",
  "师傅工资一般多少",
  "招大师傅要注意什么",
];

// 案例卡片折叠：默认只展示前 N 条，点「展开全部」查看完整
const CASES_FOLD_LIMIT = 3;

Page({
  data: {
    // 列表
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    listLoading: false,
    listLoaded: false,
    // AI 助手
    aiOpen: false,
    aiSuggestions: AI_SUGGESTIONS,
    aiMessages: [],
    aiInput: "",
    aiLoading: false,
    aiScrollIntoView: "",
    // 发布成功弹层
    publishDone: false,
    publishInfo: { role: "", city: "", salaryText: "" },
  },

  onLoad() {
    this.loadList(1, true);
  },

  // ================= 列表 =================
  // 拉取招聘信息流（feedPosts 只查库，秒开）
  loadList(page, reset) {
    if (this.data.listLoading) return;
    this.setData({ listLoading: true });
    wx.cloud
      .callFunction({
        name: "feedPosts",
        data: {
          dataType: "recruit",
          page,
          pageSize: this.data.pageSize,
        },
        config: { timeout: 15000 },
      })
      .then((res) => {
        const result = res.result || {};
        if (!result.success) {
          this.setData({ listLoaded: true });
          console.error("feedPosts 失败:", result.error);
          return;
        }
        const items = (result.list || []).map((p) => this.decorate(p));
        this.setData({
          list: reset ? items : this.data.list.concat(items),
          page: result.page,
          hasMore: result.hasMore,
          listLoaded: true,
        });
      })
      .catch((err) => {
        console.error("feedPosts 请求失败:", err);
        this.setData({ listLoaded: true });
      })
      .finally(() => {
        this.setData({ listLoading: false });
      });
  },

  // 记录 → 卡片展示字段
  decorate(p) {
    // 只显示 salary_high 或面议
    const salary = p.salary_high ? `薪资${p.salary_high}元` : "薪资面议";
    // 直辖市/省同名时去重（上海上海 → 上海；广东东莞 → 广东 东莞）
    const province = p.province || "";
    const city = p.city || "";
    const location =
      province && city
        ? province === city
          ? city
          : `${province} ${city}`
        : province || city;
    return {
      ...p,
      salaryText: salary,
      locationText: location,
      contactText: [p.contact, p.phone_masked].filter(Boolean).join(" · "),
      timeText: formatTime(p.published_at),
      tagItems: buildTagItems(p.tags),
    };
  },

  // 触底加载更多
  onListLower() {
    if (this.data.hasMore && !this.data.listLoading) {
      this.loadList(this.data.page + 1, false);
    }
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadList(1, true);
    wx.stopPullDownRefresh();
  },

  // 发布成功返回后刷新列表（由发布页调用）
  onPublished() {
    this.loadList(1, true);
  },

  // 去发布
  goPublish() {
    wx.navigateTo({ url: "/pages/publish/publish" });
  },

  // ================= AI 招工助手 =================
  openAi() {
    if (this.data.aiOpen) return;
    this.setData({ aiOpen: true });
    // 对话为空时主动 peek 草稿，有就立即在弹层里展示提示卡（不等用户发第一条消息）
    if (this.data.aiMessages.length === 0) this.peekDraftOnOpen();
  },

  // 弹层打开时主动 peek 草稿（不删草稿），有就 push 一张 draft_pending 提示卡
  peekDraftOnOpen() {
    wx.cloud.callFunction({
      name: "recruitAI",
      data: { action: "peek_draft" },
      config: { timeout: 10000 },
      success: (res) => {
        const r = res && res.result;
        if (!r || !r.hasDraft) return;
        const id = "a_" + Date.now();
        this.setData({
          aiMessages: [{
            id, role: "ai",
            msgType: "card", cardType: "draft_pending",
            content: "您有一条未发布的招工草稿",
            fields: r.fields || [],
            missing: r.missing || [],
            pendingQuestion: "",
            streaming: false,
          }],
          aiScrollIntoView: id,
        });
      },
      fail: () => { /* 静默失败，不影响正常流程 */ },
    });
  },

  closeAi() {
    this.setData({ aiOpen: false });
  },

  noop() {},

  onAiInput(e) {
    this.setData({ aiInput: e.detail.value });
  },

  onAiSuggest(e) {
    const text = e.currentTarget.dataset.text;
    if (!text || this.data.aiLoading) return;
    this.sendAi(text);
  },

  onAiSend() {
    const content = (this.data.aiInput || "").trim();
    if (!content || this.data.aiLoading) return;
    this.setData({ aiInput: "" });
    this.sendAi(content);
  },

  // 展开/收起案例卡片
  onAiCasesToggle(e) {
    const msgid = e.currentTarget.dataset.msgid;
    const aiMessages = this.data.aiMessages.map((m) => {
      if (m.id !== msgid || m.msgType !== "analysis") return m;
      const casesCollapsed = !m.casesCollapsed;
      return { ...m, casesCollapsed, blocks: applyCasesFold(m.blocks, casesCollapsed) };
    });
    this.setData({ aiMessages });
  },

  // ================= 清空对话 & 草稿 =================
  onAiClear() {
    // 1. 加载中禁用 / 已空都禁掉
    if (this.data.aiLoading || this.data.aiMessages.length === 0) return;

    const _self = this;
    wx.showModal({
      title: "清空对话",
      content: "将清空当前对话记录，并删除云端未发布的招工草稿。该操作不可撤销，确定吗？",
      confirmText: "清空",
      confirmColor: "#e8541e",
      cancelText: "再想想",
      success(res) {
        if (!res.confirm) return;
        // 2. 立即停掉打字机，防止后续回调写空数组
        _self.clearTimer();
        _self._typing = false;
        // 3. 先清空本地（让用户立刻看到反馈），再异步删云端草稿
        _self.setData({
          aiMessages: [],
          aiInput: "",
          aiScrollIntoView: "",
          aiLoading: false,
        });
        wx.cloud.callFunction({
          name: "recruitAI",
          data: { action: "clear" },
          config: { timeout: 15000 },
          success(r) {
            const had = r && r.result && r.result.hadDraft;
            wx.showToast({
              title: had ? "已清空，草稿已删除" : "已清空",
              icon: "success",
              duration: 1800,
            });
          },
          fail(err) {
            // 云端失败时本地草稿最差 7 天过期自清；兜底提示
            wx.showToast({
              title: "本地已清空，草稿将于 7 天后自动失效",
              icon: "none",
              duration: 2500,
            });
            console.warn("[recruit] clear fail:", err);
          },
        });
      },
    });
  },

  // ================= 发布交互卡按钮 =================
  // 确认发布（confirm 卡）
  onCardPublish() {
    this.sendAction("publish", "✅ 确认发布");
  },

  // 取消草稿（confirm 卡的"取消"）
  onCardCancel() {
    this.sendAction("cancel", "取消发布");
  },

  // 草稿卡"需查询？点我查信息"：取消草稿，回到查询模式
  onQuerySwitch() {
    this.sendAction("cancel", "🔍 需查询？点我查信息");
  },

  // 草稿提示卡"继续补充"：提示用户在下方输入框继续输入（不调云函数，等用户输入）
  onCardContinue() {
    wx.showToast({ title: "请继续在下方输入补充信息", icon: "none", duration: 1500 });
  },

  // 草稿提示卡"跳过草稿"：删云端草稿 + 移除本地草稿卡 + 有 pendingQ 时重发（弹层打开时无 pendingQ）
  onCardSkip(e) {
    if (this.data.aiLoading) return;
    const msgid = e.currentTarget.dataset.msgid;
    const target = this.data.aiMessages.find((m) => m.id === msgid);
    const pendingQ = target && target.pendingQuestion;
    wx.cloud.callFunction({
      name: "recruitAI",
      data: { action: "skip" },
      config: { timeout: 15000 },
      success: () => {
        // 移除本地草稿提示卡（草稿已删，不再展示）
        const newMessages = this.data.aiMessages.filter((m) => m.id !== msgid);
        this.setData({ aiMessages: newMessages });
        // 有 pendingQ（之前对话生成的草稿卡）才重发；弹层打开时无 pendingQ，不发
        if (pendingQ) this.sendAi(pendingQ);
      },
      fail: (err) => {
        wx.showToast({
          title: "跳过失败：" + ((err && err.errMsg) || "网络错误"),
          icon: "none",
        });
      },
    });
  },

  // 卡片按钮统一入口：只发 action，不走主状态机
  sendAction(action, label) {
    if (this.data.aiLoading) return;
    const now = Date.now();
    const userMsg = { id: `u_${now}`, role: "user", content: label };
    const aiMsg = { id: `a_${now}`, role: "ai", content: "", streaming: true };
    const newMessages = [...this.data.aiMessages, userMsg, aiMsg];
    const aiIdx = newMessages.length - 1;
    this.setData({
      aiMessages: newMessages,
      aiLoading: true,
      aiScrollIntoView: aiMsg.id,
    });
    wx.cloud.callFunction({
      name: "recruitAI",
      data: { action },
      config: { timeout: 60000 },
      success: (res) => {
        const result = res.result;
        // 发布成功：停止打字机 → 显示成功弹层 + 自动刷新列表
        if (result && result.success) {
          this.clearTimer();
          this._typing = false;
          const s = result.summary || {};
          this.setData({
            [`aiMessages[${aiIdx}].content`]: "✅ 发布成功！招工信息已同步到列表。",
            [`aiMessages[${aiIdx}].streaming`]: false,
            aiLoading: false,
            publishDone: true,
            publishInfo: {
              role: s.role || "-",
              city: s.city || "-",
              salaryText: s.salaryText || "-",
            },
          });
          this.loadList(1, true); // 发布成功自动刷新列表
          return;
        }
        if (typeof result === "string") {
          this.typewriter(aiIdx, aiMsg.id, result);
          return;
        }
        const text = extractContent(result);
        if (text) {
          this.setData({ [`aiMessages[${aiIdx}].tipChip`]: result.tipChip || "" });
          this.typewriter(aiIdx, aiMsg.id, text);
        } else {
          this.finishAi(aiIdx, "（未收到 AI 回复）");
        }
      },
      fail: (err) => {
        this.finishAi(aiIdx, "请求失败：" + ((err && err.errMsg) || "网络错误"));
      },
      complete: () => {
        if (!this._typing) this.finishAiStream(aiIdx);
      },
    });
  },

  // ================= 发布成功弹层 =================
  // 「查看列表」：关闭弹层 + 收起 AI 面板（列表已在发布时刷新）
  onPublishDoneView() {
    this.setData({ publishDone: false, aiOpen: false });
  },

  // 「再发一条」：关闭弹层 + 重置对话回引导态
  onPublishAgain() {
    this.setData({ publishDone: false, aiMessages: [], aiInput: "", aiScrollIntoView: "" });
  },

  // 发消息给 recruitAI（招工专属云函数，无需传 type，函数本身只处理招工）
  sendAi(content) {
    if (this.data.aiLoading) return;
    // 弹层打开时已展示草稿提示卡：根据用户消息意图决定走补字段还是先删草稿
    const pendingIdx = this.data.aiMessages.findIndex((m) => m.cardType === "draft_pending");
    if (pendingIdx >= 0) {
      if (!isCompletingText(content)) {
        // 非补字段（查询/闲聊）：先删云端草稿 + 移除本地草稿卡，避免主流程 ① 重复弹
        wx.cloud.callFunction({
          name: "recruitAI",
          data: { action: "skip" },
          config: { timeout: 8000 },
        });
        const newMessages = this.data.aiMessages.filter((m) => m.cardType !== "draft_pending");
        this.setData({ aiMessages: newMessages });
      }
      // 补字段：保留草稿卡，让主流程 ① 走 handlePublishFlow 合并（后续消息合并时会替换草稿卡为续卡）
    }
    const now = Date.now();
    const userMsg = { id: `u_${now}`, role: "user", content };
    const aiMsg = { id: `a_${now}`, role: "ai", content: "", streaming: true };
    const newMessages = [...this.data.aiMessages, userMsg, aiMsg];
    const aiIdx = newMessages.length - 1;

    const history = newMessages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content }));

    this.setData({
      aiMessages: newMessages,
      aiLoading: true,
      aiOpen: true,
      aiScrollIntoView: aiMsg.id,
    });

    wx.cloud.callFunction({
      name: "recruitAI",
      data: {
        question: content,
        messages: history,
      },
      config: { timeout: 60000 },
      success: (res) => {
        const result = res.result;
        if (typeof result === "string") {
          this.typewriter(aiIdx, aiMsg.id, result);
          return;
        }
        if (!result) {
          this.finishAi(aiIdx, "（未收到 AI 回复，请检查 recruitAI 云函数是否已部署）");
          return;
        }
        const text = extractContent(result);
        const msgType = result.msgType || "text";
        if (msgType === "analysis" && Array.isArray(result.blocks)) {
          // 分析类：KPI + 条形图 + 案例卡片 + 洞察 + 引导芯片，按块渲染（不打字机）
          const cards = (result.data || []).map((p) => this.decorate(p));
          const blocks = result.blocks.map((b) => {
            if (b.type === "cases") return { ...b, cards, visibleCards: cards.slice(0, CASES_FOLD_LIMIT) };
            if (b.type === "bar") {
              // 预计算条形宽度，避免 wxml 内联 style 里做运算
              return {
                ...b,
                items: (b.items || []).map((bar) => ({
                  ...bar,
                  styleStr: "width:" + Math.max(bar.pct || 0, 2) + "%;",
                })),
              };
            }
            return b;
          });
          this.setData({
            [`aiMessages[${aiIdx}].msgType`]: "analysis",
            [`aiMessages[${aiIdx}].content`]: (text || "").split("\n")[0] || "薪资行情分析",
            [`aiMessages[${aiIdx}].blocks`]: blocks,
            [`aiMessages[${aiIdx}].casesCollapsed`]: true,
            [`aiMessages[${aiIdx}].streaming`]: false,
            aiLoading: false,
          });
        } else if (msgType === "list" && Array.isArray(result.data) && result.data.length) {
          // 列表类：转卡片视图模型，秒回不打字
          const cards = result.data.map((p) => this.decorate(p));
          const summary = (text || "").split("\n")[0] || `共${cards.length}条招工信息`;
          this.setData({
            [`aiMessages[${aiIdx}].msgType`]: "list",
            [`aiMessages[${aiIdx}].content`]: summary,
            [`aiMessages[${aiIdx}].cards`]: cards,
            [`aiMessages[${aiIdx}].streaming`]: false,
            aiLoading: false,
          });
      // 招工发布交互卡（cardType: confirm | draft_continue | draft_pending）
        } else if (msgType === "card") {
          // 合并到已有草稿提示卡（避免与弹层打开时那张重复）：找到 aiMsg 之外的 draft_pending 卡，替换它
          const newCard = {
            msgType: "card",
            cardType: result.cardType || "draft_continue",
            content: text || result.reply || "招工信息",
            fields: result.fields || [],
            tags: result.tags || [],
            missing: result.missing || [],
            streaming: false,
          };
          const existingPendingIdx = this.data.aiMessages.findIndex(
            (m) => m.cardType === "draft_pending" && m.id !== aiMsg.id
          );
          if (existingPendingIdx >= 0) {
            // 替换原草稿提示卡 + 删除新 push 的 aiMsg 占位
            const filtered = this.data.aiMessages
              .map((m, i) => (i === existingPendingIdx ? { ...m, ...newCard } : m))
              .filter((m) => m.id !== aiMsg.id);
            this.setData({ aiMessages: filtered, aiLoading: false });
          } else {
            // 正常路径：直接更新到新 push 的 aiMsg 上
            this.setData({
              [`aiMessages[${aiIdx}].msgType`]: "card",
              [`aiMessages[${aiIdx}].content`]: newCard.content,
              [`aiMessages[${aiIdx}].cardType`]: newCard.cardType,
              [`aiMessages[${aiIdx}].fields`]: newCard.fields,
              [`aiMessages[${aiIdx}].tags`]: newCard.tags,
              [`aiMessages[${aiIdx}].missing`]: newCard.missing,
              [`aiMessages[${aiIdx}].streaming`]: false,
              aiLoading: false,
            });
          }
        } else if (text) {
          // 普通文本回复：把 tipChip（"我要发布招工"/"上海有哪些..."切查询）一起挂上
          this.setData({ [`aiMessages[${aiIdx}].tipChip`]: result.tipChip || "" });
          this.typewriter(aiIdx, aiMsg.id, text);
        } else {
          this.finishAi(aiIdx, "（未收到 AI 回复）");
        }
      },
      fail: (err) => {
        this.finishAi(aiIdx, "请求失败：" + ((err && err.errMsg) || "网络错误"));
      },
      complete: () => {
        if (!this._typing) this.finishAiStream(aiIdx);
      },
    });
  },

  // 伪流式打字机
  typewriter(aiIdx, aiMsgId, fullText) {
    this.clearTimer();
    this._typing = true;
    let shown = "";
    let i = 0;
    this._timer = setInterval(() => {
      shown += fullText.slice(i, i + 2);
      i += 2;
      const msg = this.data.aiMessages[aiIdx];
      if (msg) {
        this.setData({
          [`aiMessages[${aiIdx}].content`]: shown,
          aiScrollIntoView: aiMsgId,
        });
      }
      if (i >= fullText.length) {
        this.clearTimer();
        this._typing = false;
        this.finishAiStream(aiIdx);
      }
    }, 30);
  },

  finishAi(aiIdx, text) {
    this.clearTimer();
    this._typing = false;
    this.setData({
      [`aiMessages[${aiIdx}].content`]: text,
      [`aiMessages[${aiIdx}].streaming`]: false,
      aiLoading: false,
    });
  },

  finishAiStream(aiIdx) {
    const msg = this.data.aiMessages[aiIdx];
    if (!msg) {
      this.setData({ aiLoading: false });
      return;
    }
    this.setData({
      [`aiMessages[${aiIdx}].streaming`]: false,
      aiLoading: false,
    });
  },

  clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  onUnload() {
    this.clearTimer();
  },
});

// ---------- 工具 ----------
// 按折叠状态为 analysis 消息的 cases 块计算 visibleCards
function applyCasesFold(blocks, collapsed) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (b.type !== "cases") return b;
    const cards = Array.isArray(b.cards) ? b.cards : [];
    return { ...b, visibleCards: collapsed ? cards.slice(0, CASES_FOLD_LIMIT) : cards };
  });
}

// 前端简化版"用户在补字段"判定（与 recruitAI/index.js isCompletingDraft 对齐）
// 命中 true → sendAi 保留草稿卡让主流程 ① 走 handlePublishFlow
// 命中 false → sendAi 先调 skip 删草稿 + 移除草稿卡再发问（避免主流程 ① 重复弹）
function isCompletingText(t) {
  if (!t) return false;
  const s = String(t);
  // 反向：查询 override 词（与 recruitAI QUERY_OVERRIDE_KEYWORDS 一致）
  if (/(有没有|哪里有|谁家|推荐|附近|查一下|搜一下|哪些|在哪|哪里)/.test(s)) return false;
  // 正向：招工词（与 recruitAI RECRUIT_KEYWORDS 一致）
  if (/(招|招聘|招工|招人|请人|雇|招师傅|招阿姨|招学徒)/.test(s)) return true;
  // 正向：联系词（与 recruitAI CONTACT_KEYWORDS 一致）
  if (/(联系|联系电话|联系我|致电|打电话|欢迎联系|有意者联系|随时联系|方便联系)/.test(s)) return true;
  // 正向：4-6 位薪资数字（3000-999999）
  const m = s.match(/\b(\d{4,6})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 3000 && n <= 999999) return true;
  }
  return false;
}

function extractContent(payload) {
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      return payload;
    }
  }
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.reply === "string") return payload.reply;
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  return "";
}

function formatTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diff < min) return "刚刚";
  if (diff < hour) return Math.floor(diff / min) + "分钟前";
  if (diff < day) return Math.floor(diff / hour) + "小时前";
  if (diff < day * 7) return Math.floor(diff / day) + "天前";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 把 baozi_posts.tags 数组转换成 { name, cls }，按文本识别分组（同发布页 3 组配色）
const BOSS_TAG_SET = new Set(["湖南老板", "山东老板", "福建老板", "湖北老板", "安徽老板"]);
const SHOP_TAG_SET = new Set(["工厂/食堂", "品牌包子店", "个体包子店"]);
function buildTagItems(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => typeof t === "string" && t)
    .slice(0, 12)
    .map((name) => {
      let cls = "tag-welfare";
      if (BOSS_TAG_SET.has(name)) cls = "tag-boss";
      else if (SHOP_TAG_SET.has(name)) cls = "tag-shop";
      return { name, cls };
    });
}
