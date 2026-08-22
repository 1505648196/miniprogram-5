// pages/publish/publish.js
// 招工发布表单：师傅类型(写死) + 工资(数字) + 区域(省市区) + 定位地址 + 描述 + 电话 + 联系人 + 福利标签 + 老板地区 + 工作类型
const ROLE_OPTIONS = [
  "大师傅",
  "夫妻工",
  "短期/顶班",
  "售卖员",
  "学徒工",
  "小笼包师傅",
  "饼类师傅",
  "二把刀",
  "油炸类师傅",
  "中工",
  "生煎类师傅",
  "全能面点大师",
  "工厂",
  "其他类型",
];

// 三组可多选标签
const WELFARE_OPTIONS = ["包吃", "包住", "双休", "高薪", "住宿环境好", "休息长"];
const BOSS_REGION_OPTIONS = ["湖南老板", "山东老板", "福建老板", "湖北老板", "安徽老板"];
const SHOP_TYPE_OPTIONS = ["工厂/食堂", "品牌包子店", "个体包子店"];

Page({
  data: {
    roles: ROLE_OPTIONS,
    visibleRoles: [],   // 折叠时实际展示的师傅类型（含原 index）
    rolesCollapsed: true,
    roleHalf: 7,        // 折叠时展示前 7 个 + 其他类型 + 已选中的
    roleIndex: -1,
    salary: "",
    isFaceTalk: false, // 薪资面议
    region: ["", "", ""],
    regionCode: ["", "", ""], // picker 返回的行政区划 code（省/市/区）
    regionText: "",
    address: "",
    latitude: null,
    longitude: null,
    locating: false,
    desc: "",
    phone: "",
    contact: "",
    // 三组标签（active 存当前选中的值数组，方便 WXML 直接渲染对比）
    welfareOptions: WELFARE_OPTIONS,
    bossRegionOptions: BOSS_REGION_OPTIONS,
    shopTypeOptions: SHOP_TYPE_OPTIONS,
    welfareActive: [],
    welfareActiveMap: {},
    bossRegionActive: [],
    bossRegionActiveMap: {},
    shopTypeActive: [],
    shopTypeActiveMap: {},
    tagsOpen: true, // 标签卡是否展开（默认展开）
    tagCount: 0,     // 已选标签数
    submitting: false,
  },

  onLoad() {
    this.refreshVisibleRoles();
  },

  // 展开/收起标签卡
  toggleTagsOpen() {
    this.setData({ tagsOpen: !this.data.tagsOpen });
  },

  // 计算师傅类型可见项：折叠时 = 前 roleHalf 个 + 最后一个（其他类型）+ 已选中的
  refreshVisibleRoles() {
    const { roles, rolesCollapsed, roleIndex, roleHalf } = this.data;
    if (!rolesCollapsed) {
      this.setData({ visibleRoles: roles.map((name, i) => ({ name, i })) });
      return;
    }
    const keep = new Set();
    for (let i = 0; i < roleHalf && i < roles.length; i++) keep.add(i);
    if (roleIndex >= 0) keep.add(roleIndex); // 已选中的始终可见
    this.setData({
      visibleRoles: roles.map((name, i) => ({ name, i })).filter((o) => keep.has(o.i)),
    });
  },

  // 展开/收起师傅类型
  toggleRoles() {
    this.setData({ rolesCollapsed: !this.data.rolesCollapsed }, () => this.refreshVisibleRoles());
  },

  // 师傅类型选择
  onRoleTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ roleIndex: index }, () => this.refreshVisibleRoles());
  },

  // 工资（单个数字，唯一薪资字段）
  onSalary(e) {
    this.setData({ salary: e.detail.value });
  },

  // 面议开关
  onFaceTalk(e) {
    const checked = e.detail.value;
    this.setData({
      isFaceTalk: checked,
      salary: checked ? "" : this.data.salary,
    });
  },

  // 省市区选择（value=名称数组，code=行政区划代码数组）
  onRegionChange(e) {
    const region = e.detail.value || [];
    const code = e.detail.code || [];
    this.setData({
      region,
      regionCode: code,
      regionText: region.filter(Boolean).join(" "),
    });
  },

  // 定位获取详细地址（wx.chooseLocation：一次返回 位置名+地址+经纬度）
  onLocate() {
    this.setData({ locating: true });
    wx.chooseLocation({
      success: (res) => {
        const addr = res.address || res.name || "";
        this.setData({
          address: addr,
          latitude: res.latitude,
          longitude: res.longitude,
        });
      },
      fail: (err) => {
        // 用户取消 / 未授权：降级为手动输入
        if (err && err.errMsg && err.errMsg.includes("auth")) {
          wx.showModal({
            title: "需要定位授权",
            content: "请在右上角「...」菜单中打开位置权限，或直接手动填写详细地址。",
            showCancel: false,
          });
        }
      },
      complete: () => {
        this.setData({ locating: false });
      },
    });
  },

  // 手动填地址
  onAddress(e) {
    this.setData({ address: e.detail.value });
  },

  onDesc(e) {
    this.setData({ desc: e.detail.value });
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value });
  },

  onContact(e) {
    this.setData({ contact: e.detail.value });
  },

  // 标签 toggle：group=welfare|bossRegion|shopType
  onTagTap(e) {
    const { group, index } = e.currentTarget.dataset;
    const optKey = group + "Options";  // e.g. welfareOptions
    const actKey = group + "Active";   // e.g. welfareActive
    const optList = this.data[optKey] || [];
    const cur = this.data[actKey] || [];
    const value = optList[index];
    if (!value) return;
    let next;
    if (cur.indexOf(value) >= 0) {
      next = cur.filter((v) => v !== value);
    } else {
      next = cur.concat([value]);
    }
    const map = {};
    next.forEach((v) => { map[v] = true; });
    // 计算最新已选总数（当前组用 next，其余组用现有 data）
    const cnt =
      (group === "welfare" ? next : this.data.welfareActive).length +
      (group === "bossRegion" ? next : this.data.bossRegionActive).length +
      (group === "shopType" ? next : this.data.shopTypeActive).length;
    this.setData({ [actKey]: next, [actKey + "Map"]: map, tagCount: cnt });
  },

  // 提交
  onSubmit() {
    const d = this.data;
    if (d.submitting) return;

    // 校验
    if (d.roleIndex === -1) {
      wx.showToast({ title: "请选择师傅类型", icon: "none" });
      return;
    }
    if (!d.regionText) {
      wx.showToast({ title: "请选择区域", icon: "none" });
      return;
    }
    if (!d.phone.trim()) {
      wx.showToast({ title: "请填写联系电话", icon: "none" });
      return;
    }
    if (!/^1\d{10}$/.test(d.phone.trim())) {
      wx.showToast({ title: "请输入 11 位手机号", icon: "none" });
      return;
    }
    // 工资校验：非面议时必填
    if (!d.isFaceTalk && !d.salary.trim()) {
      wx.showToast({ title: "请填写工资或选择面议", icon: "none" });
      return;
    }

    const rc = d.regionCode || [];
    // 直辖市归一化：如"天津市 天津市 和平区"的 code 前两位相同，city_code 取省级码（code[0]）
    const isMunicipality = !!rc[0] && rc[0] === rc[1];
    const form = {
      role: d.roles[d.roleIndex],
      salaryHigh: d.isFaceTalk ? "" : d.salary, // 工资只存 salary_high（面议时为空）
      salaryNote: d.isFaceTalk ? "面议" : "",
      province: d.region[0] || "",
      city: d.region[1] || "",
      district: d.region[2] || "",
      province_code: rc[0] || "",
      city_code: isMunicipality ? rc[0] : rc[1] || "",
      district_code: rc[2] || "",
      address: d.address,
      latitude: d.latitude,
      longitude: d.longitude,
      desc: d.desc,
      phone: d.phone.trim(),
      contact: d.contact.trim(),
      // 三组标签合并（按 group 顺序：福利 → 老板 → 店铺类型）
      tags: [].concat(
        d.welfareActive || [],
        d.bossRegionActive || [],
        d.shopTypeActive || []
      ),
    };

    this.setData({ submitting: true });
    wx.showLoading({ title: "发布中..." });
    wx.cloud
      .callFunction({
        name: "publishPost",
        data: { form },
        config: { timeout: 30000 },
      })
      .then((res) => {
        wx.hideLoading();
        const result = res.result || {};
        if (result.success) {
          wx.showToast({ title: "发布成功", icon: "success" });
          // 返回上一页（招工页），并在返回后触发列表刷新
          const pages = getCurrentPages();
          const prev = pages[pages.length - 2];
          if (prev && prev.onPublished) prev.onPublished();
          setTimeout(() => wx.navigateBack(), 800);
        } else {
          wx.showToast({ title: result.error || "发布失败", icon: "none", duration: 3000 });
        }
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({
          title: "发布失败：" + ((err && err.errMsg) || "网络错误"),
          icon: "none",
          duration: 3000,
        });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  },
});
