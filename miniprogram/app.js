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
  },
});
