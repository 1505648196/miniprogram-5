// utils/pay.js
// 调用集成中心生成的「微信支付」HTTP 云函数（pay-common）
// 官方文档：小程序通过 wx.cloud.callHTTPFunction 调用，平台自动鉴权 + 注入 openid

// 云开发环境 ID
const ENV_ID = 'cloud1-9gcxv3wk28637b62'
// 集成中心生成的云函数名（控制台 → 集成中心 → 对应集成详情查看）
const FN_NAME = 'weixin-i863tz0k-demo-scfweb'

// 调用 pay-common：action 为路由名，如 wxpay_order / wxpay_query_order_by_out_trade_no
function callPayCommon(action, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callHTTPFunction({
      name: FN_NAME,
      config: { env: ENV_ID },
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      path: `/wx-pay/${action}`,
      data: data || {},
      // res.data 为响应体；部分场景是 JSON 字符串，此处统一解析成对象
      success: (res) => {
        let body = res.data
        if (typeof body === 'string') {
          try { body = JSON.parse(body) } catch (e) { /* 保留原字符串 */ }
        }
        resolve(body || {})
      },
      fail: (err) => reject(new Error(err.errMsg || '请求失败')),
    })
  })
}

// 递归查找含 package / prepay_id 的那一层（不论嵌套几层）
function findPaymentLayer(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  if (obj.package) return obj
  if (obj.prepay_id) return Object.assign({}, obj, { package: 'prepay_id=' + obj.prepay_id })
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === 'object') {
      const hit = findPaymentLayer(obj[k], depth + 1)
      if (hit) return hit
    }
  }
  return null
}

// 从下单返回里提取支付参数（timeStamp / nonceStr / package / signType / paySign）
function pickPayment(order) {
  if (!order) return {}
  const hit = findPaymentLayer(order, 0)
  if (hit) return hit
  // 兜底：返回常见层级，便于日志排查
  return (order.data && order.data.data) || order.data || order || {}
}

module.exports = { callPayCommon, pickPayment, findPaymentLayer, ENV_ID, FN_NAME }
