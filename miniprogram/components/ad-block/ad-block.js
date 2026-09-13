// components/ad-block/ad-block.js
// 通用广告区块组件（方案 C 数据驱动，自包含：轮播图 banner + 双卡 card + 全局弹窗 popup）
//
// 用法（页面 json 注册后，wxml 里一行搞定）：
//   <ad-block page="recruit" />
//
// 组件内部：
//   1) loadAds(page, ['banner','card','popup']) 拉取该页三个广告位
//   2) banner → 轮播图；card → 双卡；popup → 居中弹窗（每天一次，可配置 freq）
//   3) 空则不渲染对应区块
const { loadAds, openAdLink } = require('../../utils/ad.js');

// 弹窗频控 storage key（按 page 区分，避免各页共用一个 key 互相干扰）
const KEY_PREFIX = 'adblock_popup_';

Component({
  properties: {
    // 所属页面标识（与 ad_slots 的 page 对齐）
    page: { type: String, value: '' },
  },

  data: {
    ads: [],          // 轮播图
    banners: [],      // 双卡
    popupAd: null,    // 弹窗（单条）
    popupVisible: false,
    swiperNav: { type: 'dots' },
  },

  lifetimes: {
    attached() {
      this.reload();
    },
  },

  pageLifetimes: {
    show() {
      if (this.data.page) this.reload();
    },
  },

  methods: {
    reload() {
      const page = this.data.page;
      if (!page) return;
      loadAds(page, ['banner', 'card', 'popup']).then((groups) => {
        // 轮播图：一条广告可含多图（images 数组），否则回退单 image
        const ads = [];
        (groups.banner || []).forEach((a) => {
          const imgs = (Array.isArray(a.images) && a.images.length)
            ? a.images
            : (a.image ? [a.image] : []);
          imgs.forEach((img) => {
            if (img) {
              ads.push({
                value: img,
                path: a.link || '',
                linkType: a.linkType || 'page',
                target: a.target || '',
              });
            }
          });
        });
        const banners = (groups.card || []).map((a) => ({
          id: a._id,
          icon: a.icon || '',
          emoji: a.emoji || '',
          title: a.title || '',
          sub: a.sub || '',
          bgFrom: a.bgFrom || '#FFF1E8',
          bgTo: a.bgTo || '#FFE0C2',
          path: a.link || '',
          linkType: a.linkType || 'page',
          target: a.target || '',
        }));
        const popupList = groups.popup || [];
        const popupAd = popupList.length ? popupList[0] : null;
        this.setData({ ads, banners, popupAd });
        this.maybeShowPopup(popupAd);
      });
    },

    // 弹窗频控：freq 策略同 demo（daily/once/always/session/every_n + freq_max）
    maybeShowPopup(ad) {
      if (!ad) return;
      const freq = ad.freq || 'daily';
      const today = new Date().toDateString();
      const now = Date.now();
      const key = KEY_PREFIX + this.data.page;
      try {
        const maxShow = Number(ad.freq_max) || 0;
        if (maxShow > 0) {
          const cnt = Number(wx.getStorageSync(key + '_cnt')) || 0;
          if (cnt >= maxShow) return;
        }
        if (freq === 'once') {
          if (wx.getStorageSync(key + '_once')) return;
        } else if (freq === 'session') {
          if (this._shownThisSession) return;
        } else if (freq === 'every_n') {
          const n = Math.max(1, Number(ad.freq_days) || 1);
          const last = Number(wx.getStorageSync(key + '_last')) || 0;
          if (last && (now - last) < n * 86400000) return;
        } else if (freq !== 'always') {
          const shownDate = wx.getStorageSync(key + '_date') || '';
          if (shownDate === today) return;
        }
      } catch (e) { /* 读缓存失败按未弹处理 */ }
      this.setData({ popupVisible: true });
    },

    markPopupShown() {
      const ad = this.data.popupAd || {};
      const freq = ad.freq || 'daily';
      const key = KEY_PREFIX + this.data.page;
      try {
        const cnt = (Number(wx.getStorageSync(key + '_cnt')) || 0) + 1;
        wx.setStorageSync(key + '_cnt', cnt);
        if (freq === 'once') wx.setStorageSync(key + '_once', 1);
        else if (freq === 'every_n') wx.setStorageSync(key + '_last', Date.now());
        else if (freq === 'session') this._shownThisSession = true;
        else if (freq !== 'always') wx.setStorageSync(key + '_date', new Date().toDateString());
      } catch (e) { /* ignore */ }
    },

    onPopupClose(e) {
      if (e && e.detail && e.detail.visible) return;
      this.setData({ popupVisible: false });
      this.markPopupShown();
    },

    onPopupTap() {
      const ad = this.data.popupAd;
      this.setData({ popupVisible: false });
      this.markPopupShown();
      openAdLink(ad);
    },

    onAdTap(e) {
      const ad = this.data.ads[e.detail.index];
      openAdLink(ad);
    },

    onBannerTap(e) {
      const item = e.currentTarget.dataset.item;
      openAdLink(item);
    },
  },
});
