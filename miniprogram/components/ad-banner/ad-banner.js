// components/ad-banner/ad-banner.js
// 通用广告横幅组件（方案 C：数据驱动，按 page 拉取指定 position 的广告）
//
// 用法（在任意页面 json 的 usingComponents 注册后）：
//   <ad-banner page="recruit" position="top_banner" />
//
// 组件内部调用 utils/ad.js 的 loadAds(page, [position])，拿到非空广告即渲染，
// 空则整块不渲染（不留占位、不留空白）。广告跳转统一走 openAdLink。
const { loadAds, openAdLink } = require('../../utils/ad.js');

Component({
  properties: {
    // 所属页面标识（与 ad_slots 的 page 字段对齐）
    page: { type: String, value: '' },
    // 广告位 position（如 top_banner / feed_card）
    position: { type: String, value: 'top_banner' },
  },

  data: {
    items: [], // 该广告位的线上广告列表
  },

  lifetimes: {
    attached() {
      this.reload();
    },
  },

  pageLifetimes: {
    // 从详情页返回等场景刷新
    show() {
      if (this.data.page) this.reload();
    },
  },

  methods: {
    reload() {
      const page = this.data.page;
      const position = this.data.position;
      if (!page) return;
      loadAds(page, [position]).then((groups) => {
        const items = (groups && groups[position]) || [];
        if (items.length !== this.data.items.length) {
          this.setData({ items });
        }
      });
    },

    onTap(e) {
      const item = e.currentTarget.dataset.item;
      openAdLink(item);
    },
  },
});
