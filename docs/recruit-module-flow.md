# 招工模块流程图（recruitAI + feedPosts）

> 生成时间：2026-08-25
> 代码基准：`cloudfunctions/recruitAI/index.js`（1231 行）、`cloudfunctions/recruitAI/drafts.js`、`cloudfunctions/feedPosts/index.js`、`miniprogram/pages/recruit/*`

---

## 一、模块总览（架构图）

```mermaid
flowchart LR
    subgraph 前端["小程序端 pages/recruit"]
        A1["招聘信息流<br/>loadList()"]
        A2["AI 招工助手弹层<br/>sendAi() / sendAction()"]
        A3["发布成功弹层"]
    end

    subgraph 云端["云函数层"]
        B1["feedPosts<br/>（分页列表·秒开）"]
        B2["recruitAI<br/>（对话路由状态机 1231 行）"]
        B3["drafts.js<br/>（草稿读写工具）"]
    end

    subgraph 数据["云数据库"]
        C1["baozi_posts<br/>（招工帖，data_type=recruit）"]
        C2["recruit_drafts<br/>（每人 1 条草稿，7 天过期）"]
    end

    A1 -->|"wx.cloud.callFunction"| B1
    A2 -->|"question / action"| B2
    B2 --> B3
    B1 --> C1
    B2 --> C1
    B3 --> C2
```

**模块清单表**

| 文件 | 职责 | 关键点 |
|---|---|---|
| `recruitAI/index.js` | 对话路由状态机 + 查询 + 发布 + 分析 | 1231 行，核心 |
| `recruitAI/drafts.js` | 草稿 CRUD | openid 隔离、7 天过期、只存完整 phone |
| `recruitAI/cityCodes.js` | 全国市/省词典 | 490+ 市，逐字精确匹配 |
| `feedPosts/index.js` | 列表分页 | 只查库、无 AI、秒开 |
| `recruit.js` | 前端逻辑 | 列表 + AI 弹层 + 卡片渲染 |
| `recruit.wxml` | 前端模板 | list/analysis/card 三类消息渲染 |

---

## 二、recruitAI 主路由状态机（入口）

```mermaid
flowchart TD
    START["云函数被调用"] --> P0{"event.action 是什么？"}
    P0 -->|"publish"| H1["handlePublish<br/>确认发布入库"]
    P0 -->|"cancel"| H2["handleCancel<br/>取消草稿"]
    P0 -->|"clear"| H3["handleClear<br/>清空对话+草稿"]
    P0 -->|"skip"| H4["handleSkip<br/>删草稿返 success"]
    P0 -->|"peek_draft"| H5["handlePeekDraft<br/>读草稿不删"]
    P0 -->|"无 action"| Q0{"question 为空？"}
    Q0 -->|"是"| GUIDE["buildGuide 引导语"]
    Q0 -->|"否"| D1["getDraft(openid) 查草稿"]

    D1 --> D2{"① 有草稿？"}
    D2 -->|"是"| D3{"①.0 4项必填全缺？<br/>checkMissing==4"}
    D3 -->|"是（空草稿）"| D4["删草稿+日志"]
    D4 --> D5{"含放弃词<br/>取消/不发了…？"}
    D5 -->|"是"| D6["『已取消发布草稿』"]
    D5 -->|"否"| S2
    D3 -->|"否（有内容草稿）"| D7{"isCompletingDraft?<br/>查询词→false / 招工·联系·字段→true"}
    D7 -->|"是（补字段）"| PUB["handlePublishFlow<br/>合并+校验"]
    D7 -->|"否（查询/闲聊）"| D8["draft_pending 提示卡<br/>fields+missing+pendingQuestion"]
    D2 -->|"否"| S2["② isJobseekOnly？<br/>找活/找工作/求职…"]

    S2 -->|"是"| JOB["『求职功能暂未开放』"]
    S2 -->|"否"| S3["③ hasQueryOverride？<br/>有没有/哪里/哪些/推荐…"]
    S3 -->|"是"| Q1["handleQuery(q,false)<br/>→ 精细解析查询"]
    S3 -->|"否"| S4["④ hasPublishSignal？<br/>招/招聘词 | ≥3必填+phone | 留电话式"]
    S4 -->|"是"| PUB2["handlePublishFlow(openid,q,null)<br/>新建草稿"]
    S4 -->|"否"| F1["detectIntent 预解析"]
    F1 --> F2{"type=other/phone？"}
    F2 -->|"是"| Q2["handleQuery(q,true)<br/>引导语 / 手机号直查"]
    F2 -->|"否"| F3["classifyByDeepSeek"]
    F3 -->|"判1 查询"| Q3["handleQuery(q,false,{skipDetect:true})<br/>→ 直通最近10条"]
    F3 -->|"判2 发布"| F4["引导发完整信息<br/>岗位/城市/薪资/电话"]
    F3 -->|"判0 其他"| F5["暂无信息+转人工"]
    F3 -->|"null 无Key/失败"| Q4["handleQuery(q,true)<br/>回落精细解析"]
```

**主路由四道关卡当前词表（已确认非空）**

| 关卡 | 常量 | 当前实际内容 | 命中后果 |
|---|---|---|---|
| ① 草稿 | — | `getDraft` 按 openid | 空草稿自动删 / 有内容草稿分流 |
| ② 求职 | `JOBSEEK_KEYWORDS` | 找活/找工作/求职/我是师傅/待业… | "求职功能暂未开放" |
| ③ 查询 override | `QUERY_OVERRIDE_KEYWORDS` | 有没有/哪里有/谁家/推荐/附近/查一下/搜一下/哪些/在哪/哪里（9 词） | 走 `handleQuery` 精细解析 |
| ④ 发布信号 | `PUBLISH_KEYWORDS`+`RECRUIT_KEYWORDS` | 招/招聘/招工/招人/请人/雇/招师傅/招阿姨/招学徒 + 我要发/帮我发/我要招/发布/发个/发一条/发个招工 | 走发布流 |

---

## 三、查询流 `handleQuery` 内部（L445-543）

```mermaid
flowchart TD
    IN["handleQuery(question, withPublishTip, options)"] --> A{"options.skipDetect<br/>= true？"}
    A -->|"是（DeepSeek 判1）"| B["直通分支<br/>where {data_type,needs_review}<br/>orderBy published_at desc limit 10"]
    B --> B1{"有数据？"}
    B1 -->|"无"| B2["『暂时还没有招工信息』"]
    B1 -->|"有"| B3["list 消息<br/>【最新招工·共10条】<br/>格式化 10 条"]
    A -->|"否"| C["detectIntent 二次解析"]
    C --> C1{"type=other？"}
    C1 -->|"是"| C2["buildGuide 引导语"]
    C1 -->|"否"| C3{"type=phone？"}
    C3 -->|"是"| C4["按完整手机号精确查 limit 1"]
    C3 -->|"否"| D["queryPosts(intent) 查库"]

    D --> E{"intent.type?"}
    E -->|"list"| E1{"posts 空？"}
    E1 -->|"是"| E2["『暂无XX招工信息』<br/>+ buildListEmptyAdvice 智能建议"]
    E1 -->|"否"| E3["list 消息<br/>【城市招工·共N条】"]
    E -->|"analysis"| F["buildStats 统计<br/>中位数/最高/岗位条形图"]
    F --> F1["有 DEEPSEEK_API_KEY？"]
    F1 -->|"是"| F2["callDeepSeekInsight 写洞察"]
    F1 -->|"否"| F3["templateTip 模板提示"]
    F2 --> F4["analysis 消息<br/>head+kpi+bar+cases+insight+chips"]
    F3 --> F4
    E -->|"其他"| G["buildGuide"]
```

**detectIntent 解析出的字段（查询条件）**

| 字段 | 来源 | 示例 |
|---|---|---|
| `type` | analysisKw 命中 → analysis，否则 list | "工资多少" → analysis |
| `city/cityCode` | CITIES 词典先市后省 | "上海" → 上海 |
| `role` | ROLE_OPTIONS 14 项精确 | "大师傅/夫妻工/售卖员…" |
| `salaryMin/Max` | parseSalary 7 级解析 | "6000以上" → min=6000 |
| `wantPhone` | 电话/联系/找老板 | 列表电话置顶 |
| `limit` | "N条" | 默认 10，上限 20 |
| `timeRange` | 今天/近N天/本周/最近 | published_at ≥ 下限 |
| `keyword` | extractKeyword 模糊词 | "包吃住" |

**queryPosts 的 where 组装（L883-940）**

| 条件 | 写法 | 备注 |
|---|---|---|
| 类型 | `data_type: "recruit"` | 固定 |
| 审核 | `needs_review: neq(true)` | 不展示待审 |
| 岗位 | `role = intent.role` | 仅 14 项命中才加 |
| 薪资 | `salary_high = and(gte, lte)` | 区间必须 and 合并 |
| 时间 | `published_at ≥ startMs` | 数字时间戳 |
| 区域 | `or(city_code, district_code, city正则)` | 省级用 province_code |
| 模糊 | `or(raw_text/tags/address 正则)` | keyword 2-12 字 |

---

## 四、发布模式 `handlePublishFlow`（⑤⑥⑦⑧⑨，L171-207）

```mermaid
flowchart TD
    IN["handlePublishFlow(openid, question, existingDraft)"] --> A{"含放弃词？<br/>取消/不发了/算了/放弃…"}
    A -->|"是"| B["删草稿 → 『已取消发布草稿』"]
    A -->|"否"| C["⑤ matchRequiredFields 提取<br/>phone正则/城市词典/岗位14项/薪资解析/标签"]
    C --> D["⑥ mergeDraft 与草稿合并<br/>新值覆盖旧值；面议优先"]
    D --> E["⑥.5 desc 追加原文<br/>merged.desc += question"]
    E --> F["⑦ checkMissing 校验<br/>role/city/salary/phone 4项"]
    F --> G{"4项全齐？"}
    G -->|"是"| H["⑧ saveDraft + confirm 确认卡<br/>fields+tags+draftId"]
    G -->|"否"| I["⑨ saveDraft 续草稿<br/>draft_continue 卡<br/>『还差 岗位、城市、薪资、电话』"]
```

**发布全流程状态机（含前端按钮）**

| 阶段 | 卡片 | 前端按钮 | 触发 action |
|---|---|---|---|
| 建/续草稿 | `draft_continue`（还差 N 项） | 需查询？点我查信息 | `cancel`（删草稿回查询） |
| 草稿提示 | `draft_pending`（有草稿拦截） | 继续补充 / 跳过草稿 | `skip`（删草稿） |
| 信息齐 | `confirm`（确认招工信息） | ✅确认发布 / 取消 | `publish` / `cancel` |
| 发布成功 | 前端弹层 publishDone | 再发一条 / 查看列表 | — |

**handlePublish 入库字段（publishToBaoziPosts）**

```javascript
{
  data_type: "recruit", role, city, province, district,
  province_code, city_code, district_code, address,
  raw_text: d.desc,          // 用户全部原文
  phone, phone_masked,       // 完整号 + 脱敏号并存
  published_at: Date.now(),
  source: "user", needs_review: false,
  tags, salary_low/high 或 salary_note: "面议"
}
```

---

## 五、action 路由表（前端按钮专用通道）

| action | 云函数处理 | 返回 | 前端触发点 |
|---|---|---|---|
| `publish` | handlePublish：校验→入库→删草稿 | `{success, postId, summary}` | confirm 卡"确认发布" |
| `cancel` | handleCancel：删草稿 | `已取消发布草稿` | confirm 卡"取消" / 续卡"需查询" |
| `clear` | handleClear：删草稿+清空 | `{cleared, hadDraft}` | 顶部"清空"按钮 |
| `skip` | handleSkip：删草稿 | `{success, hidden}` | draft_pending 卡"跳过草稿" |
| `peek_draft` | handlePeekDraft：只读不删 | `{hasDraft, fields, missing}` | 弹层打开时主动查询 |

---

## 六、前端消息渲染映射（msgType → wxml）

| msgType / cardType | 数据 | 渲染方式 | 交互 |
|---|---|---|---|
| `text` | reply + tipChip | 打字机逐字 | tipChip 可点击重发 |
| `list` | reply + data[] | 卡片列表（秒开不打字） | 触底无 |
| `analysis` | reply + blocks[] | KPI/条形图/案例/洞察/芯片 | 案例默认折叠前 3 条，可展开 |
| `card: confirm` | fields + tags | 确认卡 + 已填字段 | 确认发布/取消 |
| `card: draft_continue` | fields + missing | 续草稿卡 | 需查询按钮 |
| `card: draft_pending` | fields + missing + pendingQuestion | 草稿提示卡 | 继续补充/跳过草稿 |

---

## 七、数据库集合与关键常量

**集合**

| 集合 | 用途 | 隔离键 | 过期 |
|---|---|---|---|
| `baozi_posts` | 招工帖（data_type=recruit） | — | 永久 |
| `recruit_drafts` | 发布草稿（openid 1 条） | `_openid` | 7 天（expires_at） |

**常量**

| 常量 | 内容 | 作用 |
|---|---|---|
| `DRAFT_TTL_DAYS = 7` | 草稿有效期 | 过期自动视为无草稿 |
| `MAX_SALARY = 100000` | 薪资解析上限 | 超出视为噪音置空 |
| `ROLE_OPTIONS` | 14 种岗位 | 识别+卡片 emoji |
| `CONTACT_KEYWORDS` | 联系/致电/打电话… | 留电话式发布 |
| `ABANDON_KEYWORDS` | 取消/不发了/算了… | 放弃草稿 |

---

## 八、一句话总结

> 前端**列表流**走 `feedPosts`（只查库秒开）；**AI 弹层**走 `recruitAI`。recruitAI 是一个 5 层路由状态机：**草稿(①) → 求职(②) → 查询override(③) → 发布信号(④) → DeepSeek 兜底**，每层都有精确词表；查询结果分 list/analysis/text 三种，发布过程用"草稿→确认→入库"三段卡片 + 5 个 action 按钮闭环。
