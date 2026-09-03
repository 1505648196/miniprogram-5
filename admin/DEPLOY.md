# 包子招聘后台管理系统 — 部署指南

> 后台账号：`admin` / `admin`（部署后建议尽快修改）
> 云环境：`cloud1-9gcxv3wk28637b62`
> 数据集合：`baozi_posts`

## 架构概览

```
浏览器 (admin/)  ──HTTP 调用──▶  adminAuth 云函数  ──admin 上下文──▶  baozi_posts 集合
     │                                                                   ▲
     └── 列表/详情/筛选（直接读，FlexDB READONLY 放行）──────────────────┘
```

- **读操作**（列表、详情、筛选）：Web 前端通过 HTTP 调用 `adminAuth` 云函数（`list`/`get` action）
- **写操作**（新增、编辑、删除、审核）：调用 `adminAuth` 云函数（`create`/`update`/`delete`/`audit` action），云函数内做账号密码二次校验
- 云函数运行在 **admin 上下文**，不受前端 FlexDB 权限限制，可自由读写

## 前提

- 微信开发者工具（用于上传云函数）
- Node.js ≥ 18（本地构建前端，推荐用项目里的 managed node）
- 已登录腾讯云控制台（tcb.cloud.tencent.com）

## 目录结构

```
miniprogram-5/
├── cloudfunctions/
│   └── adminAuth/          # 后台管理云函数（需上传）
│       ├── index.js
│       ├── package.json
│       └── config.json
└── admin/                  # 后台 Web 前端
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── .env.production     # 环境ID、云函数名
    ├── .env.development
    └── src/
        ├── main.js
        ├── App.vue
        ├── router/
        ├── api/cloudbase.js
        ├── stores/auth.js
        ├── utils/constants.js
        ├── components/DataTypeForm.vue
        └── views/
            ├── Login.vue
            ├── PostList.vue
            ├── PostDetail.vue
            ├── PostEdit.vue
            └── PostCreate.vue
```

## 部署步骤

### 第 1 步：上传 adminAuth 云函数

1. 用微信开发者工具打开 `miniprogram-5` 项目
2. 确认已关联云环境 `cloud1-9gcxv3wk28637b62`（工具顶部「云开发」→ 选环境）
3. 在资源管理器找到 `cloudfunctions/adminAuth` 目录
4. **右键 → 上传并部署：云端安装依赖**
5. 等待上传完成（会显示「上传成功」）

### 第 2 步：确认数据库集合

1. 云开发控制台 → 数据库 → 确认 `baozi_posts` 集合存在
2. 权限设置保持默认（**READONLY** 或符合你现有配置均可）—— 因为云函数 admin 上下文不受此限制，前端不走 SDK 直连写

### 第 3 步：本地构建前端

```bash
cd admin
npm install          # 安装依赖
npm run build        # 构建，生成 dist/ 目录
```

> 若 `npm` 不可用，可用 managed node：`C:\Users\user\.workbuddy\binaries\node\versions\22.22.2-2\node.exe C:\Users\user\.workbuddy\binaries\node\versions\22.22.2-2\node_modules\npm\bin\npm-cli.js run build`

### 第 4 步：本地预览（可选）

```bash
npm run dev
```
浏览器打开 `http://localhost:5173`，用 `admin` / `admin` 登录。

### 第 5 步：部署静态托管

**方式 A：控制台网页上传**
1. 云开发控制台 → 静态网站托管 → 点击「上传文件」/「批量上传文件夹」
2. 选择 `admin/dist/` 文件夹整体上传
3. 记下访问域名（形如 `https://xxx.tcloudbaseapp.com`）

**方式 B：CLI（需 SecretId/SecretKey）**
```bash
npx @cloudbase/cli login
npx @cloudbase/cli hosting:deploy dist -e cloud1-9gcxv3wk28637b62
```

### 第 6 步：访问后台

浏览器打开静态托管域名，用 `admin` / `admin` 登录。

## 修改登录账号密码

编辑 `cloudfunctions/adminAuth/index.js` 顶部：

```js
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";
```

改完重新上传云函数（右键 → 上传并部署）。

## 常见问题

### 1. 登录提示「网络错误」
- 确认 `.env.production` 里的 `VITE_TCB_ENV_ID` 是 `cloud1-9gcxv3wk28637b62`
- 确认云函数已部署且名称是 `adminAuth`

### 2. 列表加载失败
- 云函数日志定位：控制台 → 云函数 → adminAuth → 日志
- 常见错误：集合不存在 / 云函数未部署 / 环境ID错误

### 3. 写操作报「未授权」
- 确认前端登录态正常（重新登录一次）
- 确认 `adminAuth/index.js` 的账号密码未改乱

### 4. 上传云函数时提示权限不足
- 确认开发者工具已关联到目标环境
- 确认当前微信有该环境的开发权限

## 安全提示

- **密码明文比对**：当前实现是前端把账号密码发给云函数，云函数内比对。适合内网/私有后台。若要更安全，可改为云函数签发短期 JWT。
- **密码存 sessionStorage**：前端密码存在 sessionStorage，浏览器关闭即清除。
- 上线后务必修改默认密码。

---

# 联调与上线操作清单（2026-08-31）

> 用于解决两个联调问题：**静态托管 404**（已修，需重部署）+ **云函数网关 401**（用系统管理员 Key 方案，已打进产物）。

## 一、为什么要重新部署？

当前 `dist/` 已包含两项关键修复，**必须重新上传才能生效**：

1. **资源路径改为相对路径**（`base:"./"`）→ 解决部署在子路径/根路径下资源 404 白屏问题
2. **已把系统管理员 API Key 硬编码进产物** → 解决云函数网关 401 MISSING_CREDENTIALS

## 二、重新部署前端到根路径 `/`

1. **（可选）删除旧部署**：云开发控制台 → 静态网站托管 → 找到旧项目 `baoziadmin` → 删除
2. **打包 dist/**：
   - 进入 `C:\Users\user\WeChatProjects\miniprogram-5\admin\dist` 文件夹
   - `Ctrl+A` 全选 → 右键压缩为 zip
   - ⚠️ 注意：要**进入 dist 内部全选压缩**，不要压缩 dist 文件夹本身（否则会多一层 dist/ 目录）
3. **上传部署**：静态网站托管 → 新建项目 → 上传该 zip → **部署路径填 `/`**（或 `baoziadmin` 均可，因为是相对路径）
4. **访问测试**：打开 `https://cloud1-9gcxv3wk28637b62-1354603568.tcloudbaseapp.com/`
5. 用 **`admin` / `admin`** 登录

## 三、登录联调验证清单

登录成功后依次检查：

- [ ] 列表页能加载真实数据（贵阳招聘帖等 `baozi_posts` 内容）
- [ ] 六大业务类型筛选正常（转店/求店/招聘/求职/二手出售/二手求购）
- [ ] 分页、关键词搜索正常
- [ ] 详情页打开正常
- [ ] 审核操作能提交（改状态 + 备注）
- [ ] 编辑、删除、新增（动态表单按业务类型渲染）均正常

> 若列表空：确认云函数部署名是 `adminAuth`、环境 ID 是 `cloud1-9gcxv3wk28637b62`。看云函数日志：控制台 → 云函数 → adminAuth → 日志。

## 四、⚠️ 联调通过后必做：轮换系统管理员 API Key

**风险说明**：系统管理员 Key（`is_system_admin: true`）已硬编码进前端产物并暴露给所有访问者。任何人在浏览器 DevTools → Network 里都能看到请求头里的 `Authorization: Bearer <key>`，从而**拿到云环境最高权限**。

**轮换步骤**：
1. 云开发控制台 → 密钥管理（或访问管理 CAM）→ 找到当前使用的 API Key
2. **重置 / 重新生成**该 Key（旧的作废）
3. 把新 Key 填入 `C:\Users\user\WeChatProjects\miniprogram-5\admin\.env.production.local` 的 `VITE_TCB_PUBLISHABLE_KEY=`
4. 重新 `npm run build` → 重新部署 dist/
5. 重新登录验证

> 更稳妥的做法：改用 **Publishable Key**（专为浏览器端设计，只允许匿名调用云函数，不授予管理员权限），并把 `cloudbase.js` 里的调用收敛为固定 action。这样即使 Key 暴露，攻击面也小得多。

## 五、前端 Key 配置回顾

| 文件 | 作用 | 是否进 git |
|---|---|---|
| `.env.production` | 环境 ID、云函数名、空 Key | 是 |
| `.env.production.local` | 系统管理员 API Key（敏感） | **否**（已被 .gitignore 忽略） |
| `.env.development` | 本地开发配置 | 是 |

> 改动 `.env.production.local` 后必须重新 `npm run build`，否则产物仍是旧 Key。
