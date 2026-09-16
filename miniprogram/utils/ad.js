// miniprogram/utils/ad.js
// 方案 C：通用广告加载器（完全数据驱动）
//
// 任何页面只需调用 loadAds(page, positions)，返回该页面各广告位的广告内容分组对象。
// 广告位由后台 ad_slots 集合动态定义，前端无需为每个新广告位写死逻辑。
//
// 用法：
//   const { loadAds, openAdLink } = require('../../utils/ad');
//   const groups = await loadAds('demo', ['banner', 'card']);
//   // groups = { banner: [广告对象...], card: [广告对象...] }
//
// 广告对象字段：_id, slot, page, position, type, title, image, icon, emoji, sub,
//               bgFrom, bgTo, link, linkType, target, sort

const track = require('./track.js');

const DEFAULT_TIMEOUT = 10000;

/**
 * 把广告分组结果里所有 cloud:// fileID 图片批量换成临时 https URL。
 * 后台上传的图存的是 cloud:// fileID，C 端 <image> 无法直接渲染，必须换临时链接。
 * 同时处理单图 image 字段与轮播多图 images 数组。转换失败/非 cloud:// 保持原值。
 * @param {Object} groups { [position]: [广告对象...] }
 * @returns {Promise<Object>} 原地替换 cloud:// 为临时 URL 后的 groups
 */
function resolveCloudImages(groups) {
  const fileIDs = [];
  const refs = []; // 与 fileIDs 一一对应：{ obj, key } 指向需要回填的字段
  Object.keys(groups || {}).forEach((pos) => {
    (groups[pos] || []).forEach((a) => {
      // 单图 image
      if (typeof a.image === 'string' && a.image.startsWith('cloud://')) {
        fileIDs.push(a.image);
        refs.push({ obj: a, key: 'image' });
      }
      // 轮播多图 images 数组
      if (Array.isArray(a.images)) {
        a.images.forEach((img, i) => {
          if (typeof img === 'string' && img.startsWith('cloud://')) {
            fileIDs.push(img);
            refs.push({ obj: a.images, key: i });
          }
        });
      }
    });
  });

  if (!fileIDs.length) return Promise.resolve(groups);

  return wx.cloud
    .getTempFileURL({ fileList: fileIDs })
    .then((res) => {
      const list = (res && res.fileList) || [];
      list.forEach((item, i) => {
        const url = item && item.tempFileURL;
        const ref = refs[i];
        if (url && ref) ref.obj[ref.key] = url;
      });
      return groups;
    })
    .catch((err) => {
      console.error('[ad] getTempFileURL 失败:', err && err.errMsg);
      return groups; // 换链失败保持 cloud:// 原值，不阻断
    });
}

/**
 * 拉取指定页面、指定广告位的线上广告，按 position 分组返回。
 * @param {string} page      页面标识（如 'demo'、'detail'、'recruit'）
 * @param {string[]} positions 广告位 position 列表（如 ['banner', 'card']）
 * @returns {Promise<Object>} { [position]: [广告对象...] }
 */
function loadAds(page, positions) {
  if (!page || !Array.isArray(positions) || !positions.length) {
    return Promise.resolve({});
  }
  return wx.cloud
    .callFunction({
      name: 'adService',
      data: { page, positions },
      config: { timeout: DEFAULT_TIMEOUT },
    })
    .then((res) => {
      const r = (res && res.result) || {};
      const list = (r && r.success && Array.isArray(r.list)) ? r.list : [];
      // 按 position 分组
      const out = {};
      positions.forEach((p) => { out[p] = []; });
      list.forEach((a) => {
        const key = a.position || a.slot || '';
        if (out[key]) out[key].push(a);
        else out[key] = [a];
      });
      // 把 cloud:// fileID 统一换成临时 https URL（后台可上传 cloud:// 图，C 端 image 无法直接渲染）
      return resolveCloudImages(out);
    })
    .catch((err) => {
      console.error('[ad] loadAds 失败:', page, positions, err && err.errMsg);
      const out = {};
      positions.forEach((p) => { out[p] = []; });
      return out;
    });
}

/**
 * 统一广告跳转（供各页面点击广告时调用）
 * @param {object} item 广告对象（含 linkType / link / target）
 */
function openAdLink(item) {
  if (!item) return;
  // 广告点击埋点（即时上报，覆盖全站所有广告位）
  track.trackNow('ad_click', {
    ad_id: item._id,
    slot: item.slot || item.position,
    page: item.page || '',
    link_type: item.linkType || 'page',
    target: item.target || item.link || '',
  });
  const linkType = item.linkType || 'page';
  const target = item.target || item.link || '';
  if (!target && linkType !== 'none') return;
  switch (linkType) {
    case 'post':
      wx.navigateTo({ url: `/pages/detail/detail?id=${target}` });
      break;
    case 'url':
      // 外链需 webview 页面承载（当前未建，暂提示）
      wx.showToast({ title: '外链跳转待接入', icon: 'none' });
      break;
    case 'none':
      break;
    case 'page':
    default:
      if (target) wx.navigateTo({ url: target });
      break;
  }
}

module.exports = { loadAds, openAdLink };
