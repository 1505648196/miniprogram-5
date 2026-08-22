// index.js
Page({
  data: {
    showTip: false,
    powerList: [
      {
        title: "招工",
        tip: "包子店招聘岗位、渠道与薪资行情",
        showItem: false,
        item: [],
      },
      {
        title: "求职",
        tip: "包子行业找工作、包子师傅求职建议",
        showItem: false,
        item: [],
      },
      {
        title: "店铺转让",
        tip: "包子店转让定价、流程与避坑",
        showItem: false,
        item: [],
      },
      {
        title: "求店",
        tip: "找店接手、选址评估与注意事项",
        showItem: false,
        item: [],
      },
      {
        title: "二手设备出售",
        tip: "包子设备转让/出售，看描述、价格与所在地区",
        showItem: false,
        item: [],
      },
      {
        title: "二手设备求购",
        tip: "包子铺二手设备求购，覆盖多省收购范围",
        showItem: false,
        item: [],
      },
    ],
    haveCreateCollection: false,
    title: "",
    content: "",
  },
  goChat() {
    wx.navigateTo({
      url: "/pages/chat/chat",
    });
  },

  onClickPowerInfo(e) {
    const app = getApp();
    const index = e.currentTarget.dataset.index;
    const powerList = this.data.powerList;
    const selectedItem = powerList[index];
    
    // 检查是否跳过环境配置检测
    if (!selectedItem.skipEnvCheck && !app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请在 `miniprogram/app.js` 中正确配置 `env` 参数",
      });
      return;
    }
    if (selectedItem.link) {
      wx.navigateTo({
        url: `../web/index?url=${selectedItem.link}&title=${selectedItem.title}`,
      });
    } else if (selectedItem.type) {
      wx.navigateTo({
        url: `/pages/example/index?envId=${this.data.selectedEnv?.envId}&type=${selectedItem.type}`,
      });
    } else if (selectedItem.page) {
      wx.navigateTo({
        url: `/pages/${selectedItem.page}/index`,
      });
    } else if (
      selectedItem.title === "数据库" &&
      !this.data.haveCreateCollection
    ) {
      this.onClickDatabase(powerList, selectedItem);
    } else if (selectedItem.title === "招工") {
      // 招工：进入独立定制页（信息流 + AI 招工助手 + 发布）
      wx.navigateTo({ url: "/pages/recruit/recruit" });
    } else if (["求职", "店铺转让", "求店", "二手设备出售", "二手设备求购"].includes(selectedItem.title)) {
      // 其余板块暂走 AI 顾问咨询（后续逐个独立定制）
      this.goChat();
    } else {
      selectedItem.showItem = !selectedItem.showItem;
      this.setData({
        powerList,
      });
    }
  },

  jumpPage(e) {
    const { type, page } = e.currentTarget.dataset;
    console.log("jump page", type, page);
    if (type) {
      wx.navigateTo({
        url: `/pages/example/index?envId=${this.data.selectedEnv?.envId}&type=${type}`,
      });
    } else {
      wx.navigateTo({
        url: `/pages/${page}/index?envId=${this.data.selectedEnv?.envId}`,
      });
    }
  },

  onClickDatabase(powerList, selectedItem) {
    wx.showLoading({
      title: "",
    });
    wx.cloud
      .callFunction({
        name: "quickstartFunctions",
        data: {
          type: "createCollection",
        },
      })
      .then((resp) => {
        if (resp.result.success) {
          this.setData({
            haveCreateCollection: true,
          });
        }
        selectedItem.showItem = !selectedItem.showItem;
        this.setData({
          powerList,
        });
        wx.hideLoading();
      })
      .catch((e) => {
        wx.hideLoading();
        const { errCode, errMsg } = e;
        if (errMsg.includes("Environment not found")) {
          this.setData({
            showTip: true,
            title: "云开发环境未找到",
            content:
              "如果已经开通云开发，请检查环境ID与 `miniprogram/app.js` 中的 `env` 参数是否一致。",
          });
          return;
        }
        if (errMsg.includes("FunctionName parameter could not be found")) {
          this.setData({
            showTip: true,
            title: "请上传云函数",
            content:
              "在'cloudfunctions/quickstartFunctions'目录右键，选择【上传并部署-云端安装依赖】，等待云函数上传完成后重试。",
          });
          return;
        }
      });
  },
});
