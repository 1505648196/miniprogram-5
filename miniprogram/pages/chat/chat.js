// pages/chat/chat.js
// 行业复盘 AI —— 模仿腾讯元宝的问答界面（多轮对话 + 流式打字机效果）

// 流式接入配置：
// 1. 在云开发控制台部署云函数 aiProxy，并开启该函数的「HTTP 访问服务」，
//    获得形如 https://<env-id>.service.tcloudbase.com/aiProxy 的 URL；
// 2. 把该 URL 填入下方常量，即可启用 SSE 流式输出（打字机效果）；
// 3. 留空则回退为 wx.cloud.callFunction({ name: 'aiProxy', data: { messages } }) 一次性返回。
const AI_PROXY_HTTP_URL = "";

// 空状态下的建议问题
const SUGGESTIONS = [
  "包子店招工一般在哪里发布",
  "包子师傅求职要注意什么",
  "包子店转让怎么定价更合理",
  "想接手一家包子店，求店要注意什么",
];

// 从云函数返回的数据中提取 AI 文本（兼容多种返回结构）
function extractContent(payload) {
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      return payload;
    }
  }
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.reply === "string") return payload.reply;
  if (typeof payload.text === "string") return payload.text;
  if (payload.data && typeof payload.data.content === "string") return payload.data.content;
  if (Array.isArray(payload.choices) && payload.choices.length) {
    const choice = payload.choices[0];
    if (choice.delta && typeof choice.delta.content === "string") return choice.delta.content;
    if (choice.message && typeof choice.message.content === "string") return choice.message.content;
    if (typeof choice.text === "string") return choice.text;
  }
  return "";
}

Page({
  data: {
    messages: [], // { id, role: 'user'|'ai', content, streaming }
    inputValue: "",
    loading: false,
    scrollIntoView: "",
    suggestions: SUGGESTIONS,
  },

  onLoad() {
    this._sseBuffer = "";
    this._typewriterTimer = null;
    this._typewriting = false;
    // 从本地缓存恢复历史对话（多轮）
    const history = wx.getStorageSync("chat_history");
    if (Array.isArray(history) && history.length) {
      // 恢复历史时清除残留的流式光标
      const clean = history.map((m) => ({ ...m, streaming: false }));
      this.setData({ messages: clean });
    }
  },

  onUnload() {
    // 页面退出时清理打字机定时器，避免泄漏
    this.clearTypewriter();
    this._typewriting = false;
    wx.setStorageSync("chat_history", this.data.messages);
  },

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  // 点击空状态建议问题：直接发送
  onSuggestTap(e) {
    const text = e.currentTarget.dataset.text;
    if (!text || this.data.loading) return;
    this.sendMessage(text);
  },

  onSend() {
    const content = (this.data.inputValue || "").trim();
    if (!content || this.data.loading) return;
    this.sendMessage(content);
  },

  // 发送消息：追加用户消息 + AI 占位消息，带上历史调 aiProxy
  sendMessage(content) {
    const now = Date.now();
    const userMsg = { id: `u_${now}`, role: "user", content };
    const aiMsg = { id: `a_${now}`, role: "ai", content: "", streaming: true };
    const newMessages = [...this.data.messages, userMsg, aiMsg];
    const aiIdx = newMessages.length - 1;

    // 组装多轮历史（role 映射为 OpenAI 约定）
    const history = newMessages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content }));

    this.setData({
      messages: newMessages,
      inputValue: "",
      loading: true,
      scrollIntoView: aiMsg.id,
    });

    if (AI_PROXY_HTTP_URL) {
      this.streamRequest(history, aiIdx, aiMsg.id);
    } else {
      this.callFunctionRequest(history, aiIdx, aiMsg.id);
    }
  },

  // ================= 流式：wx.request + enableChunked + arraybuffer =================
  streamRequest(history, aiIdx, aiMsgId) {
    const requestTask = wx.request({
      url: AI_PROXY_HTTP_URL,
      method: "POST",
      data: { messages: history },
      header: { "Content-Type": "application/json" },
      enableChunked: true,
      responseType: "arraybuffer",
      success: (res) => {
        // 个别环境不触发 onChunkReceived 时的兜底（整体返回）
        if (res.statusCode === 200 && res.data) {
          const text = extractContent(this.decodeBytes(res.data));
          if (text) this.appendContent(aiIdx, aiMsgId, text);
        }
      },
      fail: (err) => {
        this.finishWithError(aiIdx, err);
      },
      complete: () => {
        this.finishStreaming(aiIdx);
      },
    });

    if (requestTask && typeof requestTask.onChunkReceived === "function") {
      requestTask.onChunkReceived((res) => {
        if (!res || !res.data) return;
        const chunkText = this.decodeBytes(res.data);
        this.parseSseChunk(chunkText, aiIdx, aiMsgId);
      });
    }
  },

  // ================= 非流式兜底：wx.cloud.callFunction 调 aiChat（意图识别 + 查 baozi_posts） =================
  callFunctionRequest(history, aiIdx, aiMsgId) {
    wx.cloud.callFunction({
      name: "aiChat",
      data: {
        question: history.length ? history[history.length - 1].content : "",
        messages: history,
      },
      config: { timeout: 60000 }, // 客户端 60s 超时，与云函数超时保持一致
      success: (res) => {
        const result = res.result;
        let text = "";
        let errText = "";
        let msgType = "text";
        if (typeof result === "string") {
          text = result;
        } else if (result) {
          text = extractContent(result);
          msgType = result.msgType || "text";
          if (result.error) errText = result.error;
        }
        if (text) {
          this.setData({ [`messages[${aiIdx}].msgType`]: msgType });
          if (msgType === "list" && Array.isArray(result.data) && result.data.length) {
            // 列表类：转卡片视图模型（与招工列表卡片同款），秒回直接显示
            const cards = result.data.map((p) => decorate(p));
            const summary = text.split("\n")[0] || `共${cards.length}条相关数据`;
            this.setData({
              [`messages[${aiIdx}].content`]: summary,
              [`messages[${aiIdx}].cards`]: cards,
              [`messages[${aiIdx}].streaming`]: false,
              loading: false,
            });
          } else {
            // 完整文本到手，用伪流式打字机逐段显示（体验接近元宝）
            this.typewriterAppend(aiIdx, aiMsgId, text);
          }
        } else if (errText) {
          // 云函数返回了错误信息（如 Key 未配置、DeepSeek 报错），直接展示方便排查
          this.finishWithText(aiIdx, "AI 回复失败：" + errText);
        }
      },
      fail: (err) => {
        this.finishWithError(aiIdx, err);
      },
      complete: () => {
        // 打字机进行中由 typewriterAppend 自行收尾；无文本时兜底关闭
        if (!this._typewriting) this.finishStreaming(aiIdx);
      },
    });
  },

  // ArrayBuffer → UTF-8 字符串（增量解码，处理跨 chunk 的多字节字符）
  decodeBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (typeof TextDecoder !== "undefined") {
      if (!this._decoder) this._decoder = new TextDecoder("utf-8");
      return this._decoder.decode(bytes, { stream: true });
    }
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    try {
      return decodeURIComponent(escape(str));
    } catch (e) {
      return str;
    }
  },

  // 解析 SSE 流：按行找 "data: {...}"，累加 delta 内容
  parseSseChunk(text, aiIdx, aiMsgId) {
    this._sseBuffer = (this._sseBuffer || "") + text;
    const lines = this._sseBuffer.split("\n");
    this._sseBuffer = lines.pop(); // 最后一段可能是被切断的不完整行，留到下个 chunk
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = extractContent(JSON.parse(data));
        if (delta) this.appendContent(aiIdx, aiMsgId, delta);
      } catch (e) {
        // 忽略不完整的 JSON（可能被切断）
      }
    }
  },

  // 追加增量文本到指定 AI 消息，并滚动到底部
  appendContent(aiIdx, aiMsgId, delta) {
    const msg = this.data.messages[aiIdx];
    if (!msg) return;
    this.setData({
      [`messages[${aiIdx}].content`]: msg.content + delta,
      scrollIntoView: aiMsgId,
    });
  },

  // ================= 伪流式打字机（非流式兜底用） =================
  // 拿到完整 reply 后，每 30ms 追加一段字符，模拟打字机效果
  typewriterAppend(aiIdx, aiMsgId, fullText) {
    this.clearTypewriter();
    this._typewriting = true;
    let shown = "";
    let i = 0;
    const STEP = 2; // 每 30ms 追加 2 个字符（调整此值可改变打字速度）
    this._typewriterTimer = setInterval(() => {
      shown += fullText.slice(i, i + STEP);
      i += STEP;
      const msg = this.data.messages[aiIdx];
      if (msg) {
        this.setData({
          [`messages[${aiIdx}].content`]: shown,
          scrollIntoView: aiMsgId,
        });
      }
      if (i >= fullText.length) {
        this.clearTypewriter();
        this._typewriting = false;
        this.finishStreaming(aiIdx); // 打字机播完，关闭光标
      }
    }, 30);
  },

  clearTypewriter() {
    if (this._typewriterTimer) {
      clearInterval(this._typewriterTimer);
      this._typewriterTimer = null;
    }
  },

  // 流式结束：关闭光标，处理空回复
  finishStreaming(aiIdx) {
    this._sseBuffer = "";
    const msg = this.data.messages[aiIdx];
    if (!msg) {
      this.setData({ loading: false });
      return;
    }
    const patch = { [`messages[${aiIdx}].streaming`]: false, loading: false };
    if (!msg.content) {
      patch[`messages[${aiIdx}].content`] =
        "（未收到 AI 回复。请检查：1) aiProxy 云函数已上传部署；2) 云函数环境变量 DEEPSEEK_API_KEY 已配置并重新部署；3) DeepSeek 账户余额充足）";
    }
    this.setData(patch);
  },

  // 清空对话：删除本地缓存并重置消息列表
  clearChat() {
    this.clearTypewriter();
    this._typewriting = false;
    wx.showModal({
      title: "清空对话",
      content: "确定清空所有聊天记录吗？清空后无法恢复。",
      confirmText: "清空",
      confirmColor: "#fa5151",
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync("chat_history");
          this.setData({ messages: [], loading: false, scrollIntoView: "" });
        }
      },
    });
  },

  // 直接以指定文本结束当前 AI 消息（用于展示错误信息等）
  finishWithText(aiIdx, text) {
    this.clearTypewriter();
    this._typewriting = false;
    const msg = this.data.messages[aiIdx];
    if (!msg) {
      this.setData({ loading: false });
      return;
    }
    this.setData({
      [`messages[${aiIdx}].content`]: text,
      [`messages[${aiIdx}].streaming`]: false,
      loading: false,
    });
  },

  // 请求失败：显示错误信息
  finishWithError(aiIdx, err) {
    // 出错时立即停掉打字机
    this.clearTypewriter();
    this._typewriting = false;
    const msg = this.data.messages[aiIdx];
    if (!msg) {
      this.setData({ loading: false });
      return;
    }
    this.setData({
      [`messages[${aiIdx}].content`]: "请求失败：" + ((err && err.errMsg) || "未知错误"),
      [`messages[${aiIdx}].streaming`]: false,
      loading: false,
    });
  },
});

// ---------- 工具函数（与招工页共用，post → 卡片视图模型） ----------
function decorate(p) {
  const salary =
    p.salary_note ||
    (p.salary_low && p.salary_high
      ? `${p.salary_low}-${p.salary_high}元`
      : p.salary_low
        ? `${p.salary_low}元以上`
        : "薪资面议");
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
