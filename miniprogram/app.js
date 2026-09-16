// app.js
const track = require('./utils/track.js');

App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-9gcxv3wk28637b62",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
    // 埋点：启动补发上次没发完的缓存队列 + 前台每 30 秒兜底定时 flush
    track.recover();
    track.startTimer();
    // 小程序切后台：先落缓存再尝试发（同步落盘保证下次能补发）
    wx.onAppHide && wx.onAppHide(() => track.onHide());

    // 埋点：全局路由监听，任意页面切页自动产生 page_view / page_leave
    // res.path 为英文路由（如 pages/demo/demo），后台 pageLabel 会转中文名展示
    wx.onAppRoute && wx.onAppRoute((res) => {
      if (!res || !res.path) return;
      // 只记录前进/跳转，navigateBack 返回不重复记（pageEnter 内部会记 page_leave）
      if (res.openType === 'navigateBack') return;
      track.pageEnter(res.path);
    });

    // 冷启动恢复：拨打电话期间小程序可能被系统回收，拨完再点进来会走 onLaunch。
    // 若本地存了「拨号前的详情页上下文」，则 reLaunch 回到那个详情页，避免用户迷路。
    try {
      const state = wx.getStorageSync('call_back_state');
      if (state && state.path && state.ts) {
        // 超过 10 分钟视为过期，不再恢复（避免陈旧状态反复跳转）
        if (Date.now() - state.ts < 10 * 60 * 1000) {
          const q = state.query || {};
          const qs = Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&');
          wx.reLaunch({ url: state.path + (qs ? '?' + qs : '') });
          wx.removeStorageSync('call_back_state');
        } else {
          wx.removeStorageSync('call_back_state');
        }
      }
    } catch (e) {
      // ignore
    }
  },

  onShow() {
    // 拨完电话回到前台：若本地有「拨号前状态」，且不是冷启动（页面栈还在），
    // 说明用户是正常拨完返回，详情页自身的 onShow 会刷新；这里无需额外处理，
    // 仅在必要时清理过期状态。冷启动恢复已在 onLaunch 处理。
    try {
      const state = wx.getStorageSync('call_back_state');
      if (state && state.ts && Date.now() - state.ts >= 10 * 60 * 1000) {
        wx.removeStorageSync('call_back_state');
      }
    } catch (e) {
      // ignore
    }
  },
});
