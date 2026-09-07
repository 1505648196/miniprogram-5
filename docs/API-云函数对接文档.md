# 包子一哥 · 云函数 API 对接文档（供后台管理系统开发）

> 本文档面向「后台管理系统」开发。用于对接云函数 CRUD / 审核 / 推送通知 / 会员等能力。
> 项目：微信小程序 + 腾讯云开发（CloudBase）。环境 `cloud1-9gcxv3wk28637b62`。
> 后台前端为 Vue3 + naive-ui + `@cloudbase/js-sdk`，通过 HTTP 网关调用云函数 `adminAuth`。

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
| `recruit_drafts` | AI 招工草稿（非本后台主流程） | |

> ⚠️ **地区词典不是集合**：省市县级联代码在 `miniprogram/utils/regionData.js`（导出 `PROVINCE_CODES / CITY_CODES / CASCADER_OPTIONS`）及云函数内 `cityCodes.js`，是本地 JS 文件，无 `dicts` 数据库集合。

---

## 2. 后台核心云函数：`adminAuth`

运行于 admin 上下文，可全量读写 `baozi_posts`。登录后所有业务 action 都需带 `user`+`pass` 二次校验。

| action | 用途 | 关键入参 | 返回 |
|---|---|---|---|
| `login` | 账号密码校验（免二次校验） | `user`,`pass` | `{ success, authed, user }` |
| `list` | 分页+筛选查询 | `page`,`pageSize`,`data_type`,`city`,`role`,`needs_review`,`keyword` | `{ success, list[], total, page, pageSize }` |
| `get` | 单条详情 | `_id` | `{ success, item }` |
| `create` | 新增 | `data{...}`（按白名单清洗） | `{ success, _id }` |
| `update` | 编辑 | `_id`, `data{...}` | `{ success, updated }` |
| `delete` | 删除 | `_id` | `{ success }` |
| `audit` | 审核通过 | `_id`, `note` | `{ success }`（置 `needs_review:false, reviewed:true`） |
| `list_tops` | 查询置顶列表 | `page`,`pageSize`,`data_type` | `{ success, list[], total, page, pageSize }` |
| `top` | 设置/取消置顶 | `op`(`set`/`cancel`), `post_id`, `data_type`, `level`, `days`(0=永久), `top_type` | `{ success, _id?, expire_at? }` 或 `{ success, cancelled }` |

**鉴权账号**：`admin / admin`（部署后可改云函数内 `ADMIN_USER / ADMIN_PASS` 并重传）。

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

### ⚠️ 关键坑：adminAuth 用的是「旧版字段白名单」
`adminAuth` 的 `ALLOWED_FIELDS` 仍是**旧版字段**（从早期 AI 抓取数据沿用）：
`data_type, province, city, district, role, salary_low, salary_high, salary_note, rent, transfer_fee, turnover_low, turnover_high, area_m2, is_franchise, brand, budget, shop_type, equip_desc, equip_price, equip_region, equip_budget, phone, phone_masked, raw_text, content, remark, source, needs_review, reviewed, reviewed_at, review_note, published_at`

但**小程序端现在发布的是新版字段**（见 §3），两者字段名不同。**做后台务必把 `adminAuth.ALLOWED_FIELDS` 与后台前端 `admin/src/utils/constants.js` 的 `TYPE_FIELDS` 都升级到新版字段**，否则后台新增/编辑出来的帖子会缺字段、小程序端无法正确展示/筛选。

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
