# 包子一哥 · 云函数 API 对接文档（供后台管理系统开发）

> 本文档面向「后台管理系统」开发。用于对接云函数 CRUD / 审核 / 推送通知 / 会员 / 操作日志等能力。
> 项目：微信小程序 + 腾讯云开发（CloudBase）。环境 `cloud1-9gcxv3wk28637b62`。
> 后台前端位于 `C:\Users\user\Downloads\shadcn-vue-admin\`（Vue3 + TypeScript + Vite + Tailwind + shadcn-vue + TanStack Vue Query + ofetch），通过 HTTP 网关调用云函数 `adminAuth`。
> ⚠️ 仓库内的 `admin/` 目录已废弃（旧 naive-ui 版本），不要使用。

---

## 0. 总体调用方式

- 后台所有云函数调用走 **CloudBase HTTP API**：
  `POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{fnName}`
  请求体为 `{ action, ...payload }`；响应体业务数据在 `json.result`。
- 鉴权分两类：
  - **C 端云函数**：依赖云端 `OPENID`（微信登录态）识别用户，后台**无法直接调用**（无 openid 会返回 `NO_AUTH`）。
  - **后台专用 `adminAuth`**：用 `user` / `pass` 业务校验（当前硬编码 `admin/admin`），且 `notifyMsg.send` **免鉴权**（可后台直接推通知）。
- 约定：业务返回统一 `{ success:boolean, ... }`；失败多为 `{ success:false, code, message }`。

---

## 1. 数据库集合

| 集合 | 用途 | 备注 |
|---|---|---|
| `baozi_posts` | 帖子（多 data_type） | **后台管理核心** |
| `baozi_users` | 用户（openid 建号/会员） | |
| `baozi_messages` | 站内通知（global/review/member） | |
| `baozi_favorites` | 收藏（`_openid`+`post_id` 唯一） | |
| `baozi_post_tops` | 帖子置顶（独立集合） | 见 §2.1 置顶管理 |
| `advertisements` | 广告运营位（轮播图/Banner/信息流/弹窗） | 见 §6 广告系统 |
| `recruit_drafts` | AI 招工草稿（非本后台主流程） | |

> ⚠️ **地区词典不是集合**：省市县级联代码在 `miniprogram/utils/regionData.js`（导出 `PROVINCE_CODES / CITY_CODES / CASCADER_OPTIONS`）及云函数内 `cityCodes.js`，是本地 JS 文件，无 `dicts` 数据库集合。

---

## 2. 后台核心云函数：`adminAuth`

运行于 admin 上下文，可全量读写 `baozi_posts`。登录后所有业务 action 都需带 `user`+`pass` 二次校验。

| action | 用途 | 关键入参 | 返回 |
|---|---|---|---|
| `login` | 账号密码校验（免二次校验） | `user`,`pass` | `{ success, authed, user }` |
| `list` | 分页+筛选查询 | `page`,`pageSize`,`data_type`,`city`,`city_code`,`role`,`role_id`,`needs_review`,`sec_status`,`source`,`keyword`,`salary_min`,`salary_max`,`price_min`,`price_max`,`published_from`,`published_to` | `{ success, list[], total, page, pageSize }` |
| `get` | 单条详情 | `_id` | `{ success, item }` |
| `create` | 新增 | `data{...}`（按白名单清洗） | `{ success, _id }` |
| `update` | 编辑（也用于撤回审核，写 `approved:false`） | `_id`, `data{...}` | `{ success, updated }` |
| `delete` | 删除（物理删除） | `_id` | `{ success }` |
| `audit` | 审核通过 | `_id`, `note` | `{ success, notified }`（置 `approved:true, reviewed:true, reviewed_at, review_note`；`notified`=是否已推站内通知） |
| `reject` | 审核退回 | `_id`, `note` | `{ success, notified }`（置 `approved:false, status:"rejected"`） |
| `offline` | 帖子下架 | `_id` | `{ success, offline:1 }`（写 `status:"offline"`） |
| `online` | 帖子上架 | `_id` | `{ success, online:1 }`（`_.remove()` 删 status） |
| `list_tops` | 查询置顶列表（附帖子摘要） | `page`,`pageSize`,`data_type` | `{ success, list[], total, page, pageSize }` |
| `top` | 设置/取消置顶 | `op`(`set`/`cancel`), `post_id`, `data_type`, `level`, `days`(0=永久), `top_type` | `{ success, _id?, expire_at? }` 或 `{ success, cancelled }` |
| `users` | 用户列表 | `page`,`pageSize`,`keyword`,`membership` | `{ success, list[], total, page, pageSize }` |
| `member` | 会员开通/取消 | `op`(`activate`/`cancel`), `_id`或`openid`, `plan`(month/quarter/year) | `{ success, isVip, expire_at }` |
| `file_url` | fileID → 临时 https URL | `file_ids[]` | `{ success, fileList[] }` |
| `stats` | 统计看板 | 无 | `{ success, posts_total, posts_by_type{}, pending, users_total, users_new_today, top_views[], cities[] }` |
| `user_ban` | 封禁/解封用户 | `_id`, `banned`(bool) | `{ success, banned, status }` |
| `logs` | 操作日志查询 | `page`,`pageSize` | `{ success, list[], total, page, pageSize }` |

**鉴权账号**：`admin / admin`（环境变量 `ADMIN_USER`/`ADMIN_PASS` 优先，未配置回落默认）。

> ⚠️ `reject`/`offline`/`online` 后端已实现、埋日志，**后台前端已接入**（列表行操作菜单 + 详情页「退回/下架/上架」按钮）。审核「通过」用 `audit`，退回用 `reject`；下架/上架用 `offline`/`online`。

### 2.1 置顶管理（`baozi_post_tops` 独立集合）

置顶采用**独立集合**而非在帖子表加字段，避免拖慢普通帖子查询。

**集合结构**：
```
{
  post_id:   帖子ID（指向 baozi_posts._id）
  data_type: 板块（recruit/transfer/...，冗余存便于按板块查置顶）
  level:     优先级（数字，越大越靠前）
  top_type:  "paid"(付费) / "admin"(后台手动)
  expire_at: 到期时间戳(ms)，0=永不过期
  created_at / updated_at
}
```

**`adminAuth.top` 入参**：
- `op:"set"`：`post_id`+`data_type` 必填；`days`=置顶天数（0=永久）；`level`=优先级；`top_type` 默认 `admin`。同帖同板块已存在则更新，否则新增。
- `op:"cancel"`：`post_id` 必填，删除该帖**所有板块**的置顶记录。

**展示端（`feedPosts`）逻辑**：`page=1` 时先查 `baozi_post_tops`（`expire_at=0` 或未过期）→ 回查帖子（须已过审）→ 置顶排前，并从普通列表去重。**置顶只出现在第一页顶部，不分页叠加。**

**后台前端建议**：帖子列表每行加「置顶/取消置顶」按钮；置顶弹窗选板块 + 天数 + 优先级。

### ✅ 字段口径已统一为「新版」（旧坑已修复）
`adminAuth` 的 `ALLOWED_FIELDS` **已升级到新版字段**，与小程序 C 端一致：
- 通用：`data_type, _openid, userid, province, province_code, city, city_code, district, district_code, address, latitude, longitude, raw_text, content, phone, phone_masked, contact, username, image, credit, published_at, source, needs_review, reviewed, reviewed_at, review_note, approved, sec_status, sec_label, sec_checked_at, tags`
- recruit/jobseek：`role, role_id, salary`；jobseek 专项 `salary_expect, salary_note, availability, service_area, want_terms`
- transfer：`price, monthly_rent, area_sqm, daily_revenue, has_equipment, terms`
- want_shop：`rent_max, area_min`；equip：`cond`
- carpool：`from_place, to_place, depart_time, depart_deadline, seats`
- 旧版字段（`salary_low/rent/transfer_fee/...`）**保留在白名单中兼容历史数据**，不影响新写入。

`sanitizeFields` 会自动补齐：`phone_masked`（有 phone 时）、`salary = salary_expect`（jobseek 冗余）、`published_at`（缺省补当前时间）。后台新增/编辑的帖子字段与小程序一致，无需再迁移字段口径。

### 2.2 操作日志（`admin_logs` 集合 + `adminAuth.logs`）

> 后台「操作日志」页（`shadcn-vue-admin/src/pages/logs/index.vue`）对接的审计接口。

**数据模型（`admin_logs` 集合，已建）**：
```js
{
  _id,         // 自动
  operator,    // 操作人（= event.user，即后台登录账号）
  action,      // 动作标识
  target_id,   // 目标对象 _id（帖子 _id / 用户 _id）
  detail,      // 附加说明（审核备注 / 会员套餐到期日 / 置顶天数等）
  created_at,  // 时间戳(ms)
}
```

**查询接口（`adminAuth.logs`）**：
```js
// 请求
{ action: "logs", page: 1, pageSize: 50, user, pass }
// 返回
{ success: true, list: [ { _id, operator, action, target_id, detail, created_at } ], total, page, pageSize }
```
- `pageSize` 上限 50，默认 20；按 `created_at` 降序。

**动作枚举（`action` 字段，`writeLog` 埋点覆盖 13 个）**：
| action | 含义 | 触发 |
|---|---|---|
| `post_create` / `post_update` / `post_delete` | 新增/编辑/删除帖子 | `create`/`update`/`delete` |
| `post_audit` / `post_reject` | 审核通过/退回 | `audit`/`reject` |
| `post_offline` / `post_online` | 下架/上架 | `offline`/`online` |
| `top_set` / `top_cancel` | 设置/取消置顶 | `top` |
| `user_ban` / `user_unban` | 封禁/解封用户 | `user_ban` |
| `member_activate` / `member_cancel` | 开通/取消会员 | `member` |

> ⚠️ `writeLog` 写失败**不阻塞主业务**（catch 内只 `console.error`），日志可能偶发缺失，属可接受的降级行为。

**前端注意**：
- `useLogsQuery` 已设 `staleTime: 0`（覆盖全局默认 5 分钟），**每次进入页面强制拉最新**，避免缓存导致看不到新日志。
- 动作中文名/颜色在 `logs/index.vue` 的 `ACTION_LABELS`/`variantFor` 维护（新增动作需同步补映射）。

---

## 3. `baozi_posts` 字段体系（以小程序 C 端为准 = 新版）

### 通用字段（所有 data_type）
`_id, data_type, _openid, userid, province, province_code, city, city_code, district, district_code, address, latitude, longitude, raw_text(正文/描述), phone, phone_masked, phone_normalized(纯11位，用于归属匹配), contact, username, image(云 fileID), credit(1-4 信用等级), published_at, source, needs_review, sec_status, sec_label, tags`

**附加通用字段（新增，后台需了解）**：
| 字段 | 含义 | 说明 |
|---|---|---|
| `views` | 浏览点击量 | 进详情页 `managePost.view` 原子 `_.inc(1)`；列表/详情均展示 |
| `source` | 来源 | `"user"`(用户发布) / `"import_legacy"`(老数据迁移) |
| `claimed` | 是否已被认领 | 老数据默认 `false`；用户认证手机号后自动归到其名下并置 `true` |
| `claimed_at` | 认领时间戳 | 认领时写 |
| `_ai_enriched` | AI 补的字段名数组 | 标记哪些字段是 DeepSeek 补的（`[]`=无字段可补） |
| `coord_system` | 坐标系 | 老数据标 `"bd09"`（百度），暂未转换 |

> ⚠️ **老数据（`source:"import_legacy"`）特征**：`_openid=""`、`claimed=false`、`coord_system:"bd09"`、`needs_review=false`、`sec_status:"legacy"`。它们由平台代发（无归属用户），用户认证手机号后按 `phone_normalized` 匹配归到其名下。后台对老数据的编辑/删除需注意其 `_openid` 为空。

### 分类枚举（data_type）
`recruit` 招工 / `jobseek` 求职 / `transfer` 店铺转让 / `want_shop` 求店 / `equip_sell` 设备出售 / `equip_buy` 设备求购 / `carpool_car` 车找人 / `carpool_person` 人找车 / `other` 其他

### 分类专项字段（新版，后台表单应对齐）
| data_type | 专项字段 |
|---|---|
| recruit | `role`(岗位), `role_id`(1-14 师傅类型), `salary`(给价, 0=面议) |
| jobseek | `role`, `role_id`, `salary`(=期望), `salary_expect`, `salary_note`, `availability`(到岗), `service_area`, `want_terms`(数组) |
| transfer | `role`(店铺类型), `role_id`(1-5), `price`(转让费), `monthly_rent`(月租), `area_sqm`(面积㎡), `daily_revenue`(日营业额), `has_equipment`(带设备), `terms`(数组) |
| want_shop | `role`(店铺类型), `role_id`, `price`(预算), `rent_max`, `area_min`, `want_terms`(数组) |
| equip_sell / equip_buy | `price`(售价/预算), `cond`(成色 0-10，10=全新) |
| carpool_car / carpool_person | `from_place`, `to_place`, `depart_time`, `depart_deadline`, `seats` |
| other | 无价格字段 |

**统一主价格**：招工/求职存 `salary`(元/月)；转让/求店/设备/其他存 `price`(元)。筛选用 `salary>=X`、`price>=X` 在 `feedPosts` 云端过滤。店铺类型 role_id 1-5、师傅类型 role_id 1-14。

### ⚠️ 薪资字段语义与冗余机制（jobseek 必读）

| 字段 | 归属 | 语义 | 备注 |
|---|---|---|---|
| `salary` | 招工 recruit | 老板给价（元/月），0=面议 | 招工主价格 |
| `salary_expect` | 求职 jobseek | 师傅期望月薪（元/月），0=面议 | **求职主价格** |
| `salary` | 求职 jobseek | = `salary_expect` 的同值冗余 | 供混排筛选统一用 |

**冗余机制**（`publishPost` 中 `case "jobseek"`）：
```js
const exp = int(f.salary_expect || f.salary, 0);
regionBase.salary_expect = exp;  // 真正的期望薪资
regionBase.salary = exp;         // 同名冗余，供统一筛选
```
原因：混排查询（招聘+求职一起）做 `salary >= X` 筛选时只用统一 `salary` 字段，不必对 jobseek 单独 OR 豁免。

**对后台的要求**：
1. 求职表单用 `salary_expect`（语义"期望"），**不要**当成招工的给价。
2. 后台 create/update 求职帖时，**必须同时写 `salary` 冗余**（值 = `salary_expect`），否则该帖在小程序端按工资筛选会被漏掉。
3. 读取展示时取 `salary_expect || salary`（fallback 兼容历史数据）。
4. 后台列表的薪资区间筛选走云函数 `salary_min/salary_max`，作用于统一 `salary` 字段，招工/求职都能命中（依赖上述冗余）。

---

## 4. 其它供后台/运营用的云函数

### `feedPosts`（读列表，C 端鉴权 openid）
入参：`dataType`(单类型) / `dataTypes`(数组 `_.in` 混排) / **`types`(数组「批量模式」，一次云函数调用内部按每个 type 各取一页并合并，首页/附近等全板块混排用)** / `city` / `city_code` / `role` / `role_id` / `salary` / `price` / `cond` / `keyword`(全局模糊，对 raw_text/role/城市/地址/联系人等) / `page` / `pageSize`
返回：`{ success, list[], page, pageSize, hasMore, total }`
- `list` 白名单脱敏（不含完整 phone）；每条附 `isMine`（`_openid===调用者`，供前端显示本人可编辑）。
- ⚠️ **`total` 仅作兼容占位**：`hasMore ? -1 : (page-1)*pageSize+list.length`（不再额外 count，避免一次查询两次读库）；`hasMore` 由 `limit(pageSize+1)` 判定。前端勿依赖 `total` 精确值，只用 `list`/`hasMore`。

### `publishPost`（C 端发布入库，C 端鉴权 openid）
- 入参 `form{...}`；`form.data_type` 决定分类，现支持 **全 9 类**：`recruit/jobseek/transfer/want_shop/equip_sell/equip_buy/carpool_car/carpool_person/other`。
- 顺风车两类入参：`form.from_place/to_place/depart_time/depart_deadline/seats`（无价格）。
- 返回 `{ success, _id, needs_review, sec_status }`；`needs_review=false` 才公开展示（内容安全 `secCheck` 自动过审）。

### `managePost`（C 端用户管理自己的帖子）
`list_mine`(我发布的，含待审核) / `get`(本人完整 phone，编辑预填用) / `detail`(公开已过审兜底，返回 item 含 `isMine`) / `update`(编辑保存，EDITABLE 白名单已含全部分类字段含顺风车 from_place/to_place/depart_time/depart_deadline/seats) / `delete`(物理删除) / `view`(浏览量 `_.inc(1)` 原子自增，任何登录用户浏览详情时调用)
> 后台不需要，仅了解；归属校验用 `_openid === 调用者 openid`。

### `notifyMsg`（站内通知；`send` 免鉴权，适合后台推送）
- `list`：拉当前用户可见通知（`page/pageSize`）→ `{ list, unread, total, hasMore }`
- `read`：标记已读（`_id` 或 `all=1`）
- **`send`（后台/运营用，免登录）**：`type`(`global`/`review`/`member`), `title`, `content`, `to_openid`(空=全局所有人；非空=定向), `post_id`(可选) → `{ success, _id }`
> 入参与返回对调用方无变化；内部已优化：`list` 未读数用 count 差值计算（不再遍历全表）、`read(all=1)` 用批量 update（不再逐条串行写），随消息量不再放大数据库压力。

### `memberService`（会员）
`status`（查 isVip） / `activate`（开通/续期：`plan`=month/quarter/year，模拟支付） / `cancel`
> 会员状态存 `baozi_users.membership` + `membership_expire_at`。当前为模拟支付，接入真实微信支付前不可上线收费。

### `favorite`（收藏）
`toggle`(`post_id`) / `list`(分页我收藏的帖子) / `check`(`post_ids[]`→favMap)

### `getOrCreateUser`（用户登录基座）
无 action；入参可选 `phoneCode` 解手机号。返回用户对象。后台一般不需直接调。
> **手机号认证后自动匹配老数据归属**：绑定手机号成功后，云函数一次性把「`phone_normalized` 命中 + `claimed:false` + `source:"import_legacy"`」的老帖批量归到当前用户（写 `_openid/userid/claimed:true/claimed_at`），返回 `matched_posts`。匹配后 `claimed:true` 天然幂等，同一号码不会重复匹配。

### `sendSubscribeMsg`（微信订阅消息发送）
入参 `templateId/content/result/time/remark/toOpenid`，调 `openapi.subscribeMessage.send`（需权限与模板）。

---

## 5. 给「做后台的 AI」的重要提示（必读）

1. **优先改字段口径**：把 `adminAuth.ALLOWED_FIELDS` 与 `admin/src/utils/constants.js` 的 `TYPE_FIELDS` / `DATA_TYPES` / 展示函数（`formatSalary`/`summarize`）从旧版字段迁移到 §3 新版字段，使后台能正确新增/编辑/展示小程序发布的帖子。
2. **分类下拉补齐**：小程序 C 端现可发布/编辑**全 9 类**（含 `other` 与顺风车 `carpool_car/carpool_person`）。后台 `DATA_TYPES` 目前只 6 类，若需后台也能新增/编辑/筛选顺风车与 other 帖子，请给 `adminAuth.ALLOWED_FIELDS` 补顺风车字段（`from_place/to_place/depart_time/depart_deadline/seats`）并在后台前端 `DATA_TYPES`/`TYPE_FIELDS` 加对应类型与字段。
3. **审核**：小程序端发帖已自动过 `secCheck`（needs_review）；后台 `adminAuth.audit` 用于人工复核通过/通过。审核通过后可调 `notifyMsg.send(type:'review', to_openid:发帖人, post_id)` 推送站内通知。
4. **平台公告**：用 `notifyMsg.send(type:'global')` 全量推送，小程序端"消息"页即见 + 未读红点。
5. **写库注意**：后台 `create/update` 写 `baozi_posts` 时，建议由 C 端 `publishPost` 的逻辑补齐字段（`phone_masked`、`sec_status`、`needs_review`、`published_at`、`_openid` 等），避免脏数据。
6. **删除为物理删除**（`remove`），如需回收站需自行扩展（标记删除 + 过滤）。
7. **账号安全**：`admin/admin` 是硬编码明文，正式环境请改复杂口令或接 JWT/网关鉴权。
8. 后台前端已有页面：`Login / PostList / PostCreate / PostEdit / PostDetail`，接 adminAuth；新增/编辑表单字段由 `TYPE_FIELDS` 驱动，改常量即可全类型生效。

---

## 6. 广告系统（`advertisements` 集合 + `adService` 云函数）

> 广告运营位统一管理。展示端已接首页（demo.js），后台管理端待开发。

### 6.1 数据模型（`advertisements` 集合）

```js
{
  _id,            // 自动生成
  slot,           // 广告位标识（见下方枚举，必填）
  type,           // banner(轮播图/Banner卡) / feed(信息流占位) / popup(全局弹窗)
  title,          // 标题
  image,          // 图片 URL（轮播图/feed 用）
  icon,           // 图标路径（Banner 卡用，如 /static/news-icon.png）
  emoji,          // 无图时兜底 emoji
  sub,            // 副标题（Banner 卡用）
  bgFrom, bgTo,   // Banner 卡渐变背景色（如 '#FFF1E8' → '#FFE0C2'）
  link,           // 跳转地址
  linkType,       // page(页面路径) / post(帖子id) / url(外链) / none(不跳)
  target,         // 跳转参数（post 时=帖子 _id；url 时=完整 URL）
  sort,           // 排序权重（数字越大越靠前）
  status,         // online(上线显示) / offline(下线隐藏)
  start_at,       // 生效开始时间戳(ms)
  end_at,         // 生效结束时间戳(ms)
  pages,          // 出现页面数组（[]=全部页面；如 ['recruit'] 仅招工频道）
  created_at,     // 创建时间戳(ms)

  // ===== 弹窗频控（仅 type=popup 生效，由后台「广告管理」表单配置）=====
  freq,           // 频率策略：daily(每天一次,默认) / once(只一次) / always(每次都弹) / session(每次启动一次) / every_n(每N天)
  freq_days,      // freq=every_n 时的间隔天数（默认1）
  freq_max,       // 最多弹 N 次（0=不限，对所有策略生效）
}
```

### 6.2 广告位 slot 枚举

| slot | 含义 | type |
|---|---|---|
| `home_banner` | 首页轮播图 | banner |
| `home_banner_card` | 首页 Banner 双卡 | banner |
| `recruit_banner` / `transfer_banner` / ... | 各频道轮播图（按频道名扩展） | banner |
| `home_feed` | 首页信息流占位 | feed |
| `recruit_feed` / `transfer_feed` / ... | 各频道信息流占位 | feed |
| `global_popup` | 全局弹窗 | popup |

### 6.3 展示端云函数 `adService`（已部署，免鉴权）

**入参**（三种方式，任选其一）：
```js
// 方式1：按广告位数组精确拉
{ slots: ['home_banner', 'home_banner_card'] }

// 方式2：单个广告位
{ slot: 'home_banner' }

// 方式3：按页面拉（pages 字段匹配，[] = 全部页通用）
{ page: 'recruit' }
```

**返回**：
```js
{
  success: true,
  list: [
    // 只含 status=online 且 start_at <= now <= end_at 的广告
    // 按 sort 降序、created_at 降序排列
    { _id, slot, type, title, image, icon, emoji, sub, bgFrom, bgTo,
      link, linkType, target, sort, status, start_at, end_at, pages, created_at },
    ...
  ]
}
```

**过滤规则**（云函数内部）：
```js
where({
  status: "online",
  start_at: _.lte(now),   // 已开始
  end_at: _.gte(now),     // 未结束
  slot: _.in(slots),      // 或 slot / pages 匹配
})
.orderBy("sort", "desc")
.orderBy("created_at", "desc")
```

### 6.4 前端接入方式（已接首页 demo.js）

```js
// 拉广告
wx.cloud.callFunction({
  name: 'adService',
  data: { slots: ['home_banner', 'home_banner_card'] },
}).then((res) => {
  const list = res.result.list || [];
  const ads = list.filter(a => a.slot === 'home_banner').map(...);      // 轮播图
  const banners = list.filter(a => a.slot === 'home_banner_card').map(...); // Banner 卡
});
```

**点击跳转（`openAdLink` 统一处理）**：
| linkType | 行为 |
|---|---|
| `page` | `wx.navigateTo({ url: link })` |
| `post` | `wx.navigateTo({ url: '/pages/detail/detail?id=' + target })` |
| `url` | 外链（需 webview 页承载，当前暂提示"待接入"） |
| `none` | 不跳转 |

### 6.5 后台管理端（shadcn-vue-admin，✅ 已完成）

**「广告管理」页（`/ads`）**，功能：
1. 广告列表：按 `slot`/`status` 筛选。
2. 新增/编辑广告：Dialog 表单含 slot、type、title、image、icon、emoji、sub、bgFrom、bgTo、link、linkType、target、sort、status、start_at、end_at、pages。
3. 上下线：Switch 切换（`ad_toggle`，改 status）。
4. 排序：`sort` 字段（表单内改）。
5. 删除：物理删除。

**对接方式**：复用 `adminAuth` 加 5 个 action（`ad_list`/`ad_create`/`ad_update`/`ad_delete`/`ad_toggle`），均走 `user+pass` 鉴权 + 操作日志埋点。前端 service 层在 `shadcn-vue-admin/src/services/ad.api.ts`。

> `adService` 云函数仍为**只读**（C 端展示拉取），管理端写操作统一走 `adminAuth`。

**仍待做（展示端增强）**：信息流占位（feed）插入列表、全局弹窗（popup）展示逻辑、展示/点击统计（show_count/click_count）。

### 6.6 管理员 AI 对话广告能力（`adminChat`，✅ 已实现）

管理员在小程序「AI 对话」页（开深度思考）可用自然语言管理广告：

| 工具 | 用途 | 入参 | 示例问法 |
|---|---|---|---|
| `ads` | 查询广告列表 | `{slot, status, page}` 都可选 | "有哪些广告"、"首页轮播图有哪些"、"已下线的广告" |
| `adToggle` | 广告上下线 | `{op, adTitle, slot, adId}` | "把包子快讯下线"、"重新上线包友群" |

**`adToggle` 定位优先级**：`adId`（精确）> `adTitle`（标题关键词）> `slot`（广告位）；带兜底（slot 值也按标题匹配），批量上限 10 条。

**返回**：`{ success, title, blocks[], mode:"deepThink", tool:"ads"|"adToggle" }`，`blocks` 为结构化卡片（列表项带"已上线/已下线"标签）。

> AI 对话支持**查询 + 上下线**；广告**新增/编辑/删除**走后台管理端（§6.5）。
