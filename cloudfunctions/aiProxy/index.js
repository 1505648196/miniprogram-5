// cloudfunctions/aiProxy/index.js
// 转发请求到 DeepSeek 聊天接口（MVP 非流式版：等完整回复返回 { reply } 给前端）
//
// 环境变量（云函数控制台/开发者工具中配置，切勿写死在代码里）：
//   DEEPSEEK_API_KEY   DeepSeek 平台申请的 API Key
const cloud = require("wx-server-sdk");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";

// 固定 system prompt：限定分析领域
const SYSTEM_PROMPT =
  "你是包子行业AI顾问，专注服务包子行业从业者，覆盖四大板块：1) 招工：包子店招聘岗位、发布渠道、薪资行情；2) 求职：包子行业找工作、包子师傅求职建议；3) 转让：包子店转让定价、转让流程与避坑；4) 求店：找店接手、选址评估与接手注意事项。同时回答开包子店、经营数据、成本、盈亏平衡等经营问题。只回答包子行业相关问题，无依据就说未覆盖";

// 解析 SSE 文本：DeepSeek stream 模式下每行是 data: {choices:[{delta:{content}}]}
// 逐条累加 delta.content，得到完整回复
function parseSSEText(text) {
  let content = "";
  const lines = String(text).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      if (json.choices && json.choices.length) {
        const delta = json.choices[0].delta;
        if (delta && typeof delta.content === "string") {
          content += delta.content;
        }
      }
    } catch (e) {
      // 忽略被切断的残缺 JSON
    }
  }
  return content;
}

// 云函数入口
exports.main = async (event) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("缺少环境变量 DEEPSEEK_API_KEY");
    return {
      reply: "",
      error: "服务端未配置 DEEPSEEK_API_KEY 环境变量，请在云函数配置中设置",
    };
  }

  const userMessages = Array.isArray(event.messages) ? event.messages : [];
  if (!userMessages.length) {
    return { reply: "", error: "messages 不能为空" };
  }

  // 前置注入 system prompt，保留用户多轮历史
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...userMessages];

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: MODEL,
        messages,
        stream: true, // MVP 阶段也走 stream 通道取流，前端暂时拿完整文本模拟打字机
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        responseType: "text", // stream 返回 text/event-stream，避免 axios 按 JSON 解析报错
        timeout: 60000, // 60s 超时，与 config.json 保持一致
      }
    );

    const reply = parseSSEText(response.data).trim();
    if (!reply) {
      console.error("DeepSeek 返回内容为空，原始响应:", String(response.data).slice(0, 500));
      return { reply: "", error: "DeepSeek 返回内容为空" };
    }

    return { reply };
  } catch (err) {
    console.error("aiProxy 调用 DeepSeek 失败:", err);
    const msg =
      (err.response && err.response.data && JSON.stringify(err.response.data)) ||
      err.message ||
      "请求 DeepSeek 失败";
    return { reply: "", error: msg };
  }
};
