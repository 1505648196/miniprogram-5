// utils/track.js
// 行为埋点：三档保障（服务端权威 / 即时上报 / 攒批 + 缓存兜底）
//
// 档位说明：
//   🟢 服务端权威：pay_success（payForPhone.verify）、post_detail_view（managePost.view）
//      直接在对应云函数里写库，前端杀进程/断网也不丢，100% 拿到。
//   🟡 即时上报：ad_click / pay_intent / pay_cancel 等低频高价值事件，
//      用 trackNow 单条立即发（点击当下小程序必在前台，到达率 ~99%）。
//   🔵 攒批上报：page_view / page_leave 等高频事件，用 track 攒批，
//      满 6 条立即发；30 秒兜底定时或切后台时也发，失败保留队列下次重试。
//
// 关键：track() 只做纯同步 push，绝不 await、绝不发网络请求（不阻塞 onShow）。
// 缓存兜底只解决「进程被杀/切后台冻结」这一层丢失，不解决网络失败。

const BATCH_SIZE = 6;           // 满 6 条合并上传
const MAX_PENDING = 200;        // 队列上限，防无限积压
const STORAGE_KEY = '__track_pending__'; // 缓存镜像 key
const FN_NAME = 'trackEvent';

let queue = [];                 // 待上报事件数组（纯内存）
let flushing = false;           // 防止并发 flush
let sessionId = '';             // 单次启动唯一
let lastPage = null;            // 记录上个页面（算停留时长）

function genSessionId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function ensureSession() {
  if (!sessionId) sessionId = genSessionId();
  return sessionId;
}
function currentRoute() {
  const pages = getCurrentPages();
  return pages.length ? pages[pages.length - 1].route : '';
}

// 组装事件对象
function buildEvent(event, params) {
  return {
    event,
    ts: Date.now(),
    session_id: ensureSession(),
    page: currentRoute() || (params && params.page) || '',
    params: params || {},
  };
}

// 同步镜像到缓存（只在关键时刻调用，不在每次 push 里写，避免高频 IO 卡顿）
function syncToStorage() {
  try { wx.setStorageSync(STORAGE_KEY, queue); } catch (e) { /* 缓存写失败不影响主流程 */ }
}

// ============ 🟡 即时上报：低频高价值事件，点击当下单条发 ============
function trackNow(event, params) {
  const ev = buildEvent(event, params);
  wx.cloud.callFunction({ name: FN_NAME, data: { events: [ev] }, config: { timeout: 8000 } })
    .catch(() => { /* 失败静默丢弃 */ });
}

// ============ 🔵 攒批上报：高频事件，满 6 / 定时 / 切后台合并发 ============
// 通用事件：顶层 page 用当前路由 currentRoute()（适用于非页面切换事件）
function track(event, params) {
  trackEvent(event, null, params);
}

function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.slice(0, BATCH_SIZE); // 取前 6 条（原数组不动）
  wx.cloud.callFunction({
    name: FN_NAME,
    data: { events: batch },
    config: { timeout: 8000 },
    success: () => {
      queue = queue.slice(batch.length); // 成功的出队
      syncToStorage();
      flushing = false;
      if (queue.length >= BATCH_SIZE) flush(); // 还有满批继续发
    },
    fail: () => {
      // 网络失败：保留队列（已镜像缓存），等下次 flush / 定时 / recover 重试
      flushing = false;
    },
  });
}

// 兜底定时 flush：30 秒清一次，防止长时间停留某页且操作太少导致数据憋在内存
function startTimer() {
  setInterval(() => { if (queue.length) { syncToStorage(); flush(); } }, 30000);
}

// 启动时：读缓存补发上次没发完的
function recover() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    if (Array.isArray(saved) && saved.length) {
      queue = saved.concat(queue);
      if (queue.length >= BATCH_SIZE) flush();
    }
  } catch (e) { /* ignore */ }
}

// ============ 页面路径：page_view + page_leave ============
// route 为显式传入的页面路由（顶层 page 字段用 route，不用 currentRoute，
// 因为 wx.onAppRoute 触发时 getCurrentPages 可能还没切到新页面）
function pageEnter(route, extra) {
  const now = Date.now();
  if (lastPage && lastPage._route) {
    trackEvent('page_leave', lastPage._route, { duration_ms: now - (lastPage._enterTs || now) });
  }
  lastPage = { _route: route, _enterTs: now };
  trackEvent('page_view', route, extra || {});
}

// 内部：显式指定顶层 page 字段，避免依赖 currentRoute() 时序问题
function trackEvent(event, page, params) {
  queue.push({
    event,
    ts: Date.now(),
    session_id: ensureSession(),
    page: page || currentRoute(),
    params: params || {},
  });
  if (queue.length > MAX_PENDING) queue = queue.slice(-MAX_PENDING);
  if (queue.length >= BATCH_SIZE) {
    syncToStorage();
    flush();
  }
}

// 切后台：先落缓存再尝试发（同步落盘保证下次能补发）
function onHide() {
  if (lastPage && lastPage._route) {
    const now = Date.now();
    trackEvent('page_leave', lastPage._route, { duration_ms: now - (lastPage._enterTs || now) });
    lastPage = null;
  }
  syncToStorage();
  if (queue.length) flush();
}

module.exports = { track, trackNow, pageEnter, onHide, recover, startTimer, flush };
