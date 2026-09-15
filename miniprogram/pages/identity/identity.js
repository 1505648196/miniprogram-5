// pages/identity/identity.js
// 身份认证选择页：显示 3 个身份选择框（店主/师傅/商家），点进去填对应表单
// 商家：跳包友圈商家入驻页；店主/师傅：跳 identity-form 表单页
// 已认证过的显示状态，可重新认证/修改

Page({
  data: {
    loading: true,
    // 各身份状态
    ownerStatus: 'none',      // none/pending/approved/rejected
    masterStatus: 'none',
    merchantStatus: 'none',   // none/pending/approved/rejected
    // 商家信息
    merchantName: '',
    merchantCategory: '',
    // 最近申请记录（用于回填表单）
    lastOwnerApply: null,
    lastMasterApply: null,
    // 身份类型配置
    identityTypes: [
      {
        id: 'owner',
        name: '店主',
        desc: '包子店/早餐店经营者',
        icon: 'store',
        color: '#597EF7',
        bg: '#F0F5FF',
      },
      {
        id: 'master',
        name: '师傅',
        desc: '面点/包子师傅',
        icon: 'user-business',
        color: '#9254DE',
        bg: '#F9F0FF',
      },
      {
        id: 'merchant',
        name: '商家',
        desc: '供应商/培训/设备商家（2999 元/年）',
        icon: 'shop',
        color: '#36CFC9',
        bg: '#E6FFFB',
      },
    ],
  },

  onLoad() {
    this.loadStatus();
  },

  onShow() {
    // 从表单页/入驻页返回时刷新状态
    if (this._loaded) this.loadStatus();
  },

  // 加载各身份认证状态（独立容错：店主/师傅、商家任一接口失败都不阻断另一方展示）
  loadStatus() {
    this.setData({ loading: true });

    // 1) 店主/师傅独立认证状态（userIdentity）
    const loadIdentity = wx.cloud
      .callFunction({ name: 'userIdentity', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.success) {
          console.warn('[identity] userIdentity.status 返回失败:', r.message || r);
          return null;
        }
        return r;
      })
      .catch((err) => {
        console.error('[identity] userIdentity 调用失败:', err && err.errMsg);
        return null;
      });

    // 2) 商家入驻状态（merchantApply）
    const loadMerchant = wx.cloud
      .callFunction({ name: 'merchantApply', data: { action: 'status' }, config: { timeout: 10000 } })
      .then((res) => {
        const r = (res && res.result) || {};
        if (!r.success) {
          console.warn('[identity] merchantApply.status 返回失败:', r.message || r);
          return null;
        }
        return r;
      })
      .catch((err) => {
        console.error('[identity] merchantApply 调用失败:', err && err.errMsg);
        return null;
      });

    return Promise.all([loadIdentity, loadMerchant]).then(([ir, mr]) => {
      const patch = { loading: false };
      let anyOk = false;

      // ---- 独立认证身份（owner/master）----
      if (ir) {
        anyOk = true;
        const identities = Array.isArray(ir.identities) ? ir.identities : [];
        const lastApplies = Array.isArray(ir.lastApplies) ? ir.lastApplies : [];
        patch.ownerStatus = identities.includes('owner') ? 'approved' : (ir.owner_status || 'none');
        patch.masterStatus = identities.includes('master') ? 'approved' : (ir.master_status || 'none');
        patch.lastOwnerApply = lastApplies.find((a) => a.identity === 'owner') || null;
        patch.lastMasterApply = lastApplies.find((a) => a.identity === 'master') || null;
      }

      // ---- 商家身份 ----
      if (mr) {
        anyOk = true;
        let merchantStatus = 'none';
        let merchantName = '';
        let merchantCategory = '';
        if (Array.isArray(mr.list) && mr.list.length) {
          const latest = mr.list[0];
          if (latest.status === 'approved') {
            merchantStatus = 'approved';
            merchantName = latest.name || '';
            merchantCategory = latest.category || '';
          } else if (latest.status === 'pending') {
            merchantStatus = 'pending';
            merchantName = latest.name || '';
          } else if (latest.status === 'rejected') {
            merchantStatus = 'rejected';
          }
        }
        patch.merchantStatus = merchantStatus;
        patch.merchantName = merchantName;
        patch.merchantCategory = merchantCategory;
      }

      this.setData(patch);
      this._loaded = true;

      // 两个接口都失败才提示；单个失败静默降级（对应身份卡片显示「未认证」占位）
      if (!anyOk) {
        wx.showToast({ title: '加载失败，请重试', icon: 'none' });
      }
    });
  },

  // 点身份卡片：跳对应表单页或入驻页
  onIdentityTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    if (id === 'merchant') {
      // 商家：跳包友圈商家入驻页
      wx.navigateTo({ url: '/pages/merchant-apply/merchant-apply' });
      return;
    }

    // 店主/师傅：跳表单页，带身份类型参数
    wx.navigateTo({ url: `/pages/identity-form/identity-form?type=${id}` });
  },

  // 状态文案映射
  statusText(status) {
    const map = {
      none: '未认证',
      pending: '审核中',
      approved: '已认证',
      rejected: '已驳回',
    };
    return map[status] || status;
  },

  statusColor(status) {
    const map = {
      none: '#999999',
      pending: '#FA8C16',
      approved: '#52C41A',
      rejected: '#FF4D4F',
    };
    return map[status] || '#999999';
  },
});
