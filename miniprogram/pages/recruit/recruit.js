// pages/recruit/recruit.js
// 招工独立页：招聘信息流（feedPosts）+ AI 招工助手（aiChat type=recruit）+ 发布入口
const AI_SUGGESTIONS = [
  "上海有哪些包子店在招工",
  "师傅工资一般多少",
  "招大师傅要注意什么",
];

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
    const salary =
      p.salary_note ||
      (p.salary_low && p.salary_high
        ? `${p.salary_low}-${p.salary_high}元`
        : p.salary_low
          ? `${p.salary_low}元以上`
          : "薪资面议");
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
    this.setData({ aiOpen: true });
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

  // 发消息给 aiChat（固定 type=recruit，agent 模式）
  sendAi(content) {
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
      name: "aiChat",
      data: {
        question: content,
        messages: history,
        type: "recruit", // agent 模式：领域固定为招工
      },
      config: { timeout: 60000 },
      success: (res) => {
        const result = res.result;
        if (typeof result === "string") {
          this.typewriter(aiIdx, aiMsg.id, result);
          return;
        }
        if (!result) {
          this.finishAi(aiIdx, "（未收到 AI 回复，请检查 aiChat 云函数是否已部署）");
          return;
        }
        const text = extractContent(result);
        const msgType = result.msgType || "text";
        if (msgType === "list" && Array.isArray(result.data) && result.data.length) {
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
        } else if (text) {
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
