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
    // 埋点：启动补发上次没发完的缓存队列 + 前台每 5 秒定时 flush
    track.recover();
    track.startTimer();
    // 小程序切后台：先落缓存再尝试发（同步落盘保证下次能补发）
    wx.onAppHide && wx.onAppHide(() => track.onHide());
  },
});
