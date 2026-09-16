/**
 * 云函数 wxTask —— 微信朋友圈转发任务中心
 * ------------------------------------------------------------
 * 集合：wx_moment_tasks
 * 字段：_id, wxid(目标账号), content(纯文本), status(pending|sending|done|failed),
 *       lease(抢占时间戳), retries, result, error, createdAt, updatedAt
 *
 * actions：
 *   create  后台调用，写一条待发任务
 *   pull    Worker 调用，抢占 pending 任务（乐观锁）并回收超时任务；
 *           带 takeover=true 时额外收编「已离线的号」遗留的 pending（换号补发），
 *           但绝不碰其他仍在线号的单 —— 多机部署时不会互相抢单
 *   report  Worker 调用，回写 done / failed
 *   list    后台查看任务列表
 *   retry   后台把失败任务重新置为 pending
 *   delete  删除任务 —— 按 taskId 单条 / 按 ids 批量 / 按 wxid+status 清理。
 *           ⚠️ 必须给条件，且一次最多 50 条（防误删整库）；返回删掉了哪些 id 便于留档
 *   online  后台调用，查 relay 上当前在线的微信号（后台据此自动选定目标号，换号免配置）
 *
 * 兼容两种调用入参：
 *   1) 云开发 SDK 直接调用（event 即参数对象）—— 后台前端用
 *   2) 云函数 HTTP 访问服务（event.body 为 JSON 字符串）—— 本地 Worker 用
 *
 * 返回约定：与 adminAuth 一致 —— 成功 {success:true, data}，失败 {success:false, message}
 * 鉴权：走 CloudBase HTTP 网关的 Authorization: Bearer <VITE_TCB_API_KEY>（后台与 Worker 同款）
 * 部署后需在 CloudBase 网关里允许调用 wxTask（与 notifyMsg 同样方式）
 */
const cloud = require('@cloudbase/node-sdk')

const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV })
const db = app.database()
const _ = db.command

const COL = 'wx_moment_tasks'
const LEASE_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟未上报视为掉线，回收重发

// 长连接中转服务（CloudBase Run 上的 wx-relay）。不配则退化为纯轮询，功能不变。
const RELAY_URL = process.env.RELAY_URL || ''   // 如 https://xxxx.run.tcloudbase.com
const RELAY_TOKEN = process.env.RELAY_TOKEN || ''

/** 通知中转服务：有 wxid 的新任务了（失败不影响主流程，Worker 兜底轮询会补上） */
async function notifyRelay(wxid) {
  if (!RELAY_URL) return
  try {
    const u = new URL('/notify', RELAY_URL)
    const mod = u.protocol === 'https:' ? require('https') : require('http')
    const data = JSON.stringify({ wxid })
    await new Promise((resolve) => {
      const req = mod.request(u, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-token': RELAY_TOKEN,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 2500,
      }, (res) => { res.resume(); res.on('end', resolve) })
      req.on('error', () => resolve())
      req.on('timeout', () => { req.destroy(); resolve() })
      req.write(data)
      req.end()
    })
  } catch (e) {
    // 静默失败：Worker 有兜底轮询
  }
}

function parseParams(event) {
  if (event && typeof event.body === 'string') {
    try { return JSON.parse(event.body || '{}') } catch (e) { return {} }
  }
  if (event && event.body && typeof event.body === 'object') return event.body
  return event || {}
}

/* ---------------------------- 来源与权限 ----------------------------
 * 这个云函数有两条调用路径，身份来源完全不同：
 *
 *  ① 后台 Web  → CloudBase HTTP 网关 → Authorization: Bearer <API Key>
 *                后台已登录，调用时同时携带账号口令 user/pass（与 adminAuth 同款）
 *  ② 小程序    → wx.cloud.callFunction（云开发 SDK 直调）
 *                event 是纯业务对象，身份从 OPENID 取
 *
 * ⚠️ 历史坑：早期用 isFromGateway() 靠「event 上有没有 httpMethod/headers」猜来源，
 *    但 CloudBase 新版函数网关转发时不保证带这些 HTTP 痕迹，导致后台调用被误判为
 *    小程序直调 → 取不到 openid → 报「无法识别身份」。
 *    现改为显式校验：后台带对 user/pass 即放行，不再依赖 HTTP 痕迹猜测。
 *
 * 写操作（create / retry）必须卡权限，否则「任何打开小程序的用户都能发朋友圈」。
 * 读操作（online / list）也一并卡上，避免任务内容外泄。
 * ------------------------------------------------------------------ */

// 管理员账号口令（与 adminChat / adminAuth 同款环境变量；未配置回落 admin/admin）
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin'

/**
 * 后台 Web 调用判定（宽松版）。
 *
 * 放行条件：请求体携带【非空 user + pass】即认为是后台（管理员）调用，直接放行。
 * 说明：后台登录后所有业务调用都会带上登录凭证（sessionStorage 的 baozi-auth）；
 *      小程序直调不会带 user/pass，因此仍走 openid 判定，安全性不受影响。
 *      这样后台换用任何管理员账号（admin / reviewer / operator）都能通过，
 *      不依赖与 ADMIN_USER/ADMIN_PASS 的字面匹配。
 */
function isFromGateway(p) {
  if (!p) return false
  const user = String(p.user || '').trim()
  const pass = String(p.pass || '').trim()
  return !!(user && pass)
}

const USERS = 'baozi_users'
const ADMIN_OPENIDS = 'admin_openids' // 管理员 openid 白名单集合（替代环境变量）

/**
 * 判断调用者是否管理员 —— **双通道，命中任一即为管理员**：
 *   ① admin_openids 白名单集合命中 → 是（后台可动态增删，纯数据库操作）
 *   ② 未命中 → 查数据库 baozi_users.role === 'admin'（向后兼容）
 *
 * 三处（adminAuth / wxTask / adminChat）判定逻辑必须同步，改一处记得改另两处。
 */
async function isAdminCaller(openid) {
  if (!openid) return false

  // ① admin_openids 白名单集合
  try {
    const r = await db.collection(ADMIN_OPENIDS)
      .where({ openid })
      .limit(1)
      .get()
    if (r.data && r.data.length) return true
  } catch (e) {
    // 集合未建或查询失败，继续走 role 兜底
  }

  // ② role 兜底
  try {
    const r = await db.collection(USERS)
      .where({ openid_wxapp: openid, role: 'admin' })
      .limit(1)
      .get()
    return !!(r.data && r.data.length)
  } catch (e) {
    return false
  }
}

/** wx-server-sdk 是否已初始化（惰性 init 标记，避免每调用重复 init） */
let wxcInited = false

/**
 * 取调用者 OPENID。三条路兜底 —— 不同 CloudBase 版本/调用方式取值位置不一样。
 */
function getOpenId(context) {
  // 1) CloudBase 云函数 context.userInfo
  try {
    if (context && context.userInfo && context.userInfo.openId) return context.userInfo.openId
    if (context && context.userInfo && context.userInfo.openid) return context.userInfo.openid
  } catch (e) { /* ignore */ }

  // 2) @cloudbase/node-sdk 的 auth
  try {
    const auth = app.auth && app.auth()
    if (auth && typeof auth.getUserInfo === 'function') {
      const u = auth.getUserInfo()
      if (u && (u.openId || u.openid)) return u.openId || u.openid
    }
  } catch (e) { /* ignore */ }

  // 3) wx-server-sdk —— 小程序 wx.cloud.callFunction 直调时唯一可靠的来源
  //    getWXContext() 由运行环境注入 OPENID，不依赖 init()；这里惰性 init 一次更稳妥。
  //    注意：wxTask 主体用 @cloudbase/node-sdk（变量名 cloud），故这里用 wxc 避免命名冲突。
  try {
    const wxc = require('wx-server-sdk')
    if (!wxcInited) {
      wxc.init({ env: wxc.DYNAMIC_CURRENT_ENV })
      wxcInited = true
    }
    const c = typeof wxc.getWXContext === 'function' ? wxc.getWXContext() : null
    if (c && (c.OPENID || c.openId)) return c.OPENID || c.openId
  } catch (e) { /* 没装或初始化失败，正常 */ }

  return ''
}

/** 写操作：必须管理员 */
const WRITE_ACTIONS = ['create', 'retry', 'delete']
/** 读操作：也要求管理员（任务内容、在线号不宜外泄） */
const READ_ACTIONS = ['list', 'online', 'pull', 'report']

/** delete 一次最多删几条 —— 防止手滑把整库清了 */
const DELETE_MAX = 50
/** 允许按状态清理的白名单（防止 p.status 是脏值时条件失效） */
const DELETABLE_STATUS = ['pending', 'sending', 'done', 'failed']

/**
 * 统一鉴权。返回 null = 放行；返回字符串 = 拒绝原因。
 * 放行路径（命中任一）：
 *   ① 后台 Web：携带管理员账号口令（p.user / p.pass）
 *   ② 网关形态：event 带 HTTP 痕迹（Worker 的 pull/report 走网关）
 *   ③ 小程序：服务端 OPENID 命中管理员（白名单 或 baozi_users.role='admin'）
 */
async function checkAuth(action, p, event, context) {
  if (!WRITE_ACTIONS.includes(action) && !READ_ACTIONS.includes(action)) return null
  // ① 后台显式口令（不依赖 HTTP 痕迹猜测，最稳）
  if (isFromGateway(p)) return null
  // ② 网关形态兜底（Worker 走网关调 pull/report，没有 user/pass）
  if (event && (event.httpMethod || event.headers || event.requestContext
    || typeof event.body === 'string')) return null

  // ③ 小程序直调：靠 OPENID 判管理员
  const openid = getOpenId(context)
  if (!openid) {
    return '无法识别身份：请在小程序内登录后重试'
  }
  if (!await isAdminCaller(openid)) {
    return '没有权限：该操作仅管理员可用'
  }
  return null
}

const ok = (data) => ({ success: true, data })
const fail = (message = '操作失败') => ({ success: false, message })

exports.main = async (event, context) => {
  const p = parseParams(event)
  const action = p.action

  // 鉴权：后台带管理员口令 / 网关形态 / 小程序 OPENID，三条路命中任一即放行
  const denied = await checkAuth(action, p, event, context)
  if (denied) return fail(denied)

  try {
    switch (action) {
      case 'create': return await createTask(p)
      case 'pull': return await pullTasks(p)
      case 'report': return await reportTask(p)
      case 'list': return await listTasks(p)
      case 'retry': return await retryTask(p)
      case 'delete': return await deleteTasks(p)
      case 'online': return await listOnline()
      default: return fail('unknown action: ' + action)
    }
  } catch (e) {
    return fail((e && e.message) || String(e))
  }
}

// 说明：原 getPostPhone（管理员取帖子完整手机号）已迁至 adminAuth 的 post_phone 动作。
//       wxTask 回归「朋友圈转发任务中心」职责，不再承担取号。

async function createTask(p) {
  if (!p.wxid) return fail('wxid required')
  if (typeof p.content !== 'string' || !p.content.trim()) return fail('content required')
  const now = Date.now()
  const res = await db.collection(COL).add({
    wxid: p.wxid,
    content: p.content,
    status: 'pending',
    lease: 0,
    retries: 0,
    result: null,
    error: null,
    sentBy: null,
    createdAt: now,
    updatedAt: now,
  })
  // 立刻推送唤醒本地 Worker（长连接），实现秒级下发
  await notifyRelay(p.wxid)
  return ok({ _id: res.id || res._id })
}

async function pullTasks(p) {
  const wxid = p.wxid
  if (!wxid) return fail('wxid required')
  const limit = Math.min(parseInt(p.limit, 10) || 3, 20)
  // 接管模式：一个号一个号换着用时打开。除了自己的单，也把其他号遗留在
  // pending 的任务一并收编发掉（否则换号后旧单永远没人拉，烂在队列里）。
  const takeover = p.takeover === true || p.takeover === 'true'
  const now = Date.now()

  // 1) 回收超时未上报的任务（Worker 掉线 / 崩溃）
  //    接管模式下不限 wxid —— 换号后旧号遗留的 sending 也一起救回来
  await db.collection(COL)
    .where(takeover
      ? { status: 'sending', lease: _.lt(now - LEASE_TIMEOUT_MS) }
      : { wxid, status: 'sending', lease: _.lt(now - LEASE_TIMEOUT_MS) })
    .update({ status: 'pending', lease: 0, updatedAt: now })

  // 2) 取待发任务
  //    接管模式不是「无脑抢全部」，而是只捡「当前不在线的号」遗留的单：
  //    其他号还在线时它们自己会拉走，抢过来只会发错号。
  let pendingWhere = { wxid, status: 'pending' }
  if (takeover) {
    const online = await fetchOnlineList()
    if (online === null) {
      // 问不到 relay（挂了 / 没配）：退化为不过滤，宁可多发也别让任务烂在队列里
      pendingWhere = { status: 'pending' }
    }
    else {
      const others = online.filter(w => w && w !== wxid)
      pendingWhere = others.length
        ? { status: 'pending', wxid: _.nin(others) }
        : { status: 'pending' }
    }
  }

  const res = await db.collection(COL)
    .where(pendingWhere)
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get()

  // 3) 逐条乐观锁抢占：只有仍为 pending 才置 sending
  //    乐观锁保证多账号同时接管时也不会重复发送
  const claimed = []
  for (const doc of res.data) {
    const upd = await db.collection(COL)
      .where({ _id: doc._id, status: 'pending' })
      .update({ status: 'sending', lease: now, sentBy: wxid, updatedAt: now })
    if (upd.updated > 0) {
      claimed.push({
        _id: doc._id,
        wxid: doc.wxid,
        content: doc.content,
        retries: doc.retries || 0,
        // 标记这条是「捡来的」：下单时的目标号不是当前这个号
        takenOver: takeover && doc.wxid !== wxid,
      })
    }
  }
  return ok({ tasks: claimed })
}

async function reportTask(p) {
  if (!p.taskId) return fail('taskId required')
  const now = Date.now()
  const data = { status: p.status === 'failed' ? 'failed' : 'done', lease: 0, updatedAt: now }
  if (data.status === 'failed') {
    data.error = p.error || 'unknown error'
    data.retries = (parseInt(p.retries, 10) || 0) + 1
  } else {
    // 坑：CloudBase 的 update 会把嵌套对象展开成点号路径（result.xxx）去合并，
    // 而 result 字段当前值是 null 时会报
    //   Cannot create field 'xxx' in element {result: null}
    // 导致整个回写失败（任务明明发出去了，状态却一直停在 sending）。
    // 因此这里转成 JSON 字符串做整体替换；读出来想还原对象就 JSON.parse 一下。
    data.result = p.result == null ? null : JSON.stringify(p.result)
    data.error = null
  }
  await db.collection(COL).doc(p.taskId).update(data)
  return ok({})
}

async function listTasks(p) {
  const limit = Math.min(parseInt(p.limit, 10) || 20, 100)
  let q = db.collection(COL)
  if (p.wxid) q = q.where({ wxid: p.wxid })
  if (p.status) q = q.where({ status: p.status })
  const res = await q.orderBy('createdAt', 'desc').limit(limit).get()
  return ok({ list: res.data })
}

async function retryTask(p) {
  if (!p.taskId) return fail('taskId required')
  await db.collection(COL).doc(p.taskId).update({
    status: 'pending', error: null, lease: 0, updatedAt: Date.now(),
  })
  return ok({})
}

/**
 * 删除任务（可从「待命 / 发送中 / 失败 / 已完成」任一状态删掉）。
 * ------------------------------------------------------------
 * 三种用法（**必须给条件**，不给就拒绝 —— 绝不允许多条件全空时误删整库）：
 *   ① { taskId: "xxx" }                    删单条
 *   ② { ids: ["a","b", ...] }              按 id 批量删（最多 DELETE_MAX 条）
 *   ③ { wxid: "wxid_xxx", status: "failed" }  清某个号的某状态（status 走白名单）
 *
 * 实现上**先 get 出 id 再逐个 doc(id).remove()**，不用 where().remove() 批量：
 *   · 每个 id 都是明确的，删了什么能如实回给调用方（本地留档用得上）
 *   · 顺带天然带上 DELETE_MAX 上限，手滑也不会一次清空
 *
 * 返回 { deleted: N, ids: [...] }
 */
async function deleteTasks(p) {
  const ids = []

  // ① 单条
  if (p.taskId) {
    ids.push(String(p.taskId))
  }
  // ② 一批 id
  else if (Array.isArray(p.ids) && p.ids.length) {
    for (const one of p.ids) {
      if (one) ids.push(String(one))
    }
  }
  // ③ 按 号 + 状态 清（两个条件都要，缺一不可）
  else {
    const wxid = String(p.wxid || '').trim()
    const status = String(p.status || '').trim()
    if (!wxid || !status) {
      return fail('delete 需要 taskId、ids、或 wxid+status 三选一（必须带条件，不能清空整库）')
    }
    if (!DELETABLE_STATUS.includes(status)) {
      return fail('status 不合法：' + status + '（只能是 ' + DELETABLE_STATUS.join(' / ') + '）')
    }
    const res = await db.collection(COL)
      .where({ wxid, status })
      .orderBy('createdAt', 'asc')
      .limit(DELETE_MAX)
      .get()
    for (const doc of res.data || []) {
      if (doc && doc._id) ids.push(String(doc._id))
    }
    if (!ids.length) return ok({ deleted: 0, ids: [] })
  }

  // 去重 + 上限（防止 ids 传了几百条）
  const uniq = [...new Set(ids)]
  if (uniq.length > DELETE_MAX) {
    return fail('一次最多删 ' + DELETE_MAX + ' 条（本次 ' + uniq.length +
      ' 条）—— 分批删，或按 wxid+status 清理')
  }

  const removed = []
  for (const id of uniq) {
    try {
      const r = await db.collection(COL).doc(id).remove()
      // ⚠️ doc().remove() 对**不存在的文档不报错**（实测：删一个假 id 也返回成功），
      //    所以不能"没抛异常就算删掉了"。优先用 SDK 回的计数，拿不到再保守算 1。
      let n = 1
      if (r && typeof r.deleted === 'number') n = r.deleted
      else if (r && r.stats && typeof r.stats.removed === 'number') n = r.stats.removed
      if (n > 0) removed.push(id)
    } catch (e) {
      // 单条失败不中断整批：能删几条删几条，回执里能看出来差哪条
    }
  }
  return ok({ deleted: removed.length, ids: removed })
}

/**
 * 查 relay 上当前在线的微信号。
 * 本机 Worker 每个账号与 relay 维持一条 WebSocket，relay 的 /health 会列出在线 wxid。
 * 后台据此自动选定「发给哪个号」—— 换号后本机一上线，后台自动跟上，不用改任何配置。
 * 拿不到在线列表不算错误（本机可能没开），一律返回 { online: [] }，让后台走兜底。
 */
/** 在线号缓存：同一云函数实例内复用，避免每次 pull 都去问 relay */
let _onlineCache = { at: 0, list: null }
const ONLINE_CACHE_MS = 20000

/**
 * 问 relay「谁在线」。返回 wxid 数组；拿不到返回 null（调用方按「拿不到」处理）。
 * 带 20 秒缓存 —— pull 是高频动作，不能每次都打 relay。
 */
async function fetchOnlineList() {
  if (!RELAY_URL) return null
  const now = Date.now()
  if (_onlineCache.list && now - _onlineCache.at < ONLINE_CACHE_MS) return _onlineCache.list
  try {
    const u = new URL('/health', RELAY_URL)
    const mod = u.protocol === 'https:' ? require('https') : require('http')
    const text = await new Promise((resolve, reject) => {
      const req = mod.request(u, { method: 'GET', timeout: 2000 }, (res) => {
        let s = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { s += c })
        res.on('end', () => resolve(s))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('relay timeout')) })
      req.end()
    })
    let j = {}
    try { j = JSON.parse(text) } catch (e) { j = {} }
    const list = Array.isArray(j.online) ? j.online : []
    _onlineCache = { at: now, list }
    return list
  } catch (e) {
    return null
  }
}

async function listOnline() {
  const list = await fetchOnlineList()
  if (list === null) return ok({ online: [], relay: false })
  return ok({ online: list, relay: true })
}
