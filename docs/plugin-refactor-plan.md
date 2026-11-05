# 插件化改造计划（R 轮）

> 状态：**R1–R6 全部完成**（2026-11-04）。本文比较两个项目的设计差异，并给出把 magpie 的"丝滑"落到
> 本项目上的完整计划。每一项都注明为什么值得做、怎么做、怎么验收。

## 一、先回答你提出的两个问题

### 问题 1：多个插件的同名模型还没解决 —— 确认，是 bug

现状是我让"命名空间前缀"成为**可选项**，而前端注册时**根本不传前缀**：

```ts
registerPluginProvider({ provider: offer.provider, per_account: perAccount })
//                        ↑ 没有 model_prefix
```

所以两个服务注册后模型名完全相同。实测确实撞车——同一个插件的两个 provider
都在提供 `glm-5.3` / `glm-5.2`：

```
workbuddy     17 个模型：auto, hy4free, …, glm-5.3, glm-5.2, …
workbuddy-ai  16 个模型：default-model, …, gpt-5.5, glm-5.3, glm-5.2, …
```

要命的是**撞名不会报错**。new-api 的 `ability` 表主键是
`(group, model, channel_id)`，两个渠道都声明 `glm-5.3` 就都进表，路由时随机
落到其中一个——等于把请求随机发给两家厂商。

### magpie 怎么解决的

它只有一套命名法，而且**强制**：

| 写法 | 含义 |
|---|---|
| `provider/model` | 永远是那一家的（`b/gpt-6-sol`） |
| 裸 `model` | 是"路由组"的，组里可以有多个厂商的同名模型 |
| `group/<id>` | 显式指定组 |

关键在 `internal/provider/group.go` 的注释：

> 一个模型被多个 provider 以同名提供时，magpie **自动把它们变成一个组**，
> 每次现算、不落库，直到用户改过它。跨厂商合并是默认行为，不是需要配置的事。

所以 magpie 里同名不是冲突，而是**特性**——同名 = 同一件事，它们本来就该互为备份。

### 我的方案

分两步，**先止血，再做对**。

**第一步（止血）**：注册时前缀改为从渠道类型自动推导，不再依赖前端传参。

```
provider id          模型前缀
workbuddy         →  wb:
workbuddy-ai      →  wbai:
claude            →  cl:
```

规则：取 provider id 的字母部分，撞了就加尾缀。同时给已注册的渠道做一次
迁移（更新 `models` 和 `model_mapping`）。

**第二步（做对）**：引入"路由组"，但**不抄 magpie 的全套**，而是复用
new-api 已有的 `ability` 表：

- 裸名 `glm-5.3` → 组，成员是 `wb:glm-5.3` 和 `wbai:glm-5.3`
- new-api 的 `ability` 表天然按 (group, model) 索引多个 channel，
  **它已经会按 priority/weight 在这些渠道间负载均衡**
- 我要做的只是：生成组名、把成员渠道都挂在组名上、在 `/v1/models` 里
  把组名和成员名都列出来

这意味着**不需要动 new-api 的路由核心**，只需要在注册时多写几行 ability。

### 问题 2：没有地方展示插件里的账号和数据 —— 确认，差的很多

现状：`ProviderDetail` 返回的 `AccountView` 只有
`key / label / type / account_id / enterprise / expires`——**没有额度、没有
配额窗口、没有健康状态**。整站的账号数据只有"6 个账号"这个数字。

magpie 的账号行有这些（`renderAccounts` + `windowCapMeter`）：

| 展示项 | magpie 的做法 |
|---|---|
| 账号名 | 有昵称用昵称，否则手机号/uid，企业账号再加团队名 |
| 用量窗口 | 5 小时、7 天、月，各自一根容量条 |
| 窗口上限 | 每个窗口可单独设上限（"用到 80% 就算用完"） |
| 权重 | 多账号按权重分配流量 |
| 套餐 | `accountPlan`：Basic / Pro / Team |
| 签到 | 已签到/可签到，上次签到时间 |
| 模型范围 | 每个账号可限定它能用哪些模型 |
| 状态 | 正常/失效/限流中（带剩余冷却时间） |
| 代理 | 每个账号可单独走代理 |
| 排序 | 手动拖动排序，第一个是默认账号 |

这些数据 `pluginhost` **已经全都能拿到**（`usage` RPC 返回 `windows`、
`plan`、`signIn`、`resets`），我只是没有把它接到界面上。

## 二、两个项目的设计差异（深入）

### 2.1 定位不同，导致骨架不同

| | magpie | 本项目（new-api 分支） |
|---|---|---|
| 是什么 | 桌面应用，给**一个人**用 | Web 服务，给**一个站**用 |
| 多用户 | 无 | 有（分组、令牌、计费、订阅） |
| 存储 | 本地 JSON 文件 | SQLite/MySQL/PostgreSQL |
| 进程 | 单二进制 + 若干 agent | 单二进制 + Bun 插件宿主 |
| 界面 | GTK/WebView2 原生窗口 | React 网页 |

**这个差异不能抹掉**。你是"小型中转站"，多用户/计费/令牌是你的核心，
magpie 完全没有这些。所以要抄的是**插件层的体验**，不是它的整体架构。

### 2.2 核心概念对照

| magpie | 本项目对应物 | 差距 |
|---|---|---|
| Provider（厂商标识） | `Channel.BaseURL` 存 provider id | 语义被塞进一个字符串字段 |
| Provider 的账号 | `Channel.Key`（多 key） | 已对齐 |
| 账号额度/窗口 | 无 | **缺** |
| Model（provider/model） | `Channel.Models` 带前缀 | 前缀可选 → 会撞名 |
| Routing Group | `ability` 表的 (group, model, channel) | 机制存在，没接上 |
| 路由规则（ordered/weight/…） | `Channel.Priority/Weight` | 只有优先级+权重，无 ordered/规则 |
| Gateway 中间件 | `pkg/jsplugin`（moejs，只用于 task） | 未接入 chat 链路 |
| Agents | 无对应 | 不需要 |
| Usage 视图 | Token 统计/数据看板 | 粒度不同，够用 |

### 2.3 magpie 真正"丝滑"的四个点

我读完它的代码，认为丝滑来自这四处，而不是功能多：

**① 一个概念只有一个名字**
`provider/model` 一个写法贯穿到底：配置、日志、路由、界面。不会出现
"这里叫 base_url，那里叫 provider，界面上叫服务"。

**② 缺省即正确**
同名模型自动成组、账号自动轮换、token 自动续期、失效账号自动让开——
用户不用配置，系统自己做得对。本项目现在处处需要手动点"注册渠道"。

**③ 每个数字都能看到出处**
账号用了多少、还剩多少、什么时候重置、为什么被停——全部可见。
本项目现在只有一个"6 个账号"。

**④ 状态永远一致**
`steady` / `lastgood` 保证文件读写不撕裂；前端"边到边画"（`Each part is
drawn as it comes`），一个接口慢不阻塞整页。

## 三、改造计划

分 6 轮，每轮独立可验收。**R1、R2 是你提的两个问题，优先做。**

### R1 · 模型命名（解决撞名）

**目标**：两个插件的同名模型不再互相干扰。

1. `pluginreg.Register` 改为**自动推导前缀**，不再由前端决定
   - 前缀从 provider id 生成，规则写死并加测试
   - 前缀记录在 `Channel.OtherSettings.PluginPrefix`，供后续读取
2. 注册时**检测撞名**：如果本渠道的模型名已存在于别的渠道，返回明确错误
   而不是静默覆盖
3. 存量渠道迁移：给已注册的插件渠道补前缀，更新 `models` 与 `model_mapping`
4. 前端「注册渠道」按钮旁显示将要使用的前缀，可覆盖但给出警告

**验收**
- 注册 workbuddy 和 workbuddy-ai，模型名零重叠
- 故意注册两个同前缀的 provider，报错而非静默覆盖
- `go test ./service/pluginreg/` 覆盖前缀推导与撞名检测

### R2 · 账号与数据展示（解决看不见）

**目标**：插件页能看到每个账号的全部状态。

1. 扩展 `pluginreg.Detail`：给每个账号补
   - `usage`（`pluginhost.AccountUsage` 已有）
   - `windows`（名称/已用/上限/重置时间）
   - `plan`、`signIn`、`error`
   - 该账号对应的渠道 id 与 key 索引
2. 新增接口 `GET /api/plugin_provider/accounts?provider=` 批量取
   （一次返回所有账号，避免前端 N+1）
3. 新增组件 `AccountList`：每个账号一行，显示
   - 名称、类型（oauth/api）、套餐
   - 每个用量窗口一根容量条 + 重置时间
   - 状态徽标（正常/已失效/限流中）
   - 按钮：重新登录、签到、移除、查看模型
4. 「服务」卡片上加"账号"折叠区，直接展开就看见
5. 定时刷新（30s），失效状态实时变灰

**验收**
- 打开插件页 → 服务 → 展开，6 个账号全部显示额度与状态
- 失效账号明确标红并给出原因
- 接口响应 < 2s（并发拉取）

### R3 · 路由组（同名模型互为备份）

**目标**：`glm-5.3` 一个名字，背后是多家厂商，自动故障转移。

1. `pluginreg` 注册时，为每个模型名生成"裸名组"
   - 渠道 A 有 `wb:glm-5.3` → ability 增加 (group=default, model=glm-5.3, channel=A)
   - 渠道 B 有 `wbai:glm-5.3` → 同上，channel=B
   
   这里利用 new-api 已有的 ability 机制。我读了 `model/ability.go` 的
   `GetChannel` 确认过：

   ```go
   DB.Where("group = ? and model = ? and enabled = ?", group, model, true)
     .Order("priority DESC, weight DESC").Find(&abilities)
   // 先按 priority 分层（retry 时逐层下降），层内按 weight 加权随机
   ```

   **同一个 model 名挂在多个 channel 上，new-api 本来就会在它们之间负载均衡**
   并逐层降级重试。我只需要在注册时多写几行 ability，不需要动路由核心。
2. `/v1/models` 同时列出裸名和带前缀名
3. 新增「路由」页：列出所有组、组内成员、当前优先级
4. 支持 ordered（按顺序）与 weight（按权重）两种模式
   - ordered 用 `Channel.Priority` 实现（已有的机制）
   - weight 用 `Channel.Weight`（已有）

**验收**
- 请求裸名 `glm-5.3`，两家厂商都能收到（看日志）
- 关掉其中一个渠道，请求仍成功
- 请求带前缀名，只走那一家

### R4 · 自动续期与失效处理

**目标**：不用手动点，系统自己维护账号。

1. 把 `SyncHealth` 从"5 分钟一次"改为"按需 + 定时"
   - 请求失败（401/403）时立即触发该账号的健康检查
   - 定时任务只做兜底
2. 消费插件的 `auth.refreshLead` / `auth.keepAlive`
   - 目前 `keepSignedIn` RPC 已存在但我没调用
   - 加一个 worker：距过期 < 5 分钟时主动续期
3. 签到：每日自动调用 `checkin`（可关）
4. 失效账号在账号列表里显示"重新登录"按钮，一键走 OAuth

**验收**
- 手动把 token 改坏，下一次请求后账号自动标记失效
- 距过期 4 分钟的账号被自动续期（看日志）
- 签到后额度数字变化

### R5 · 界面向 magpie 靠拢

**目标**：把散落的信息收拢到"一个概念一个名字"。

1. 插件页的三个页签改名并对齐 magpie：
   - 发现（Discover）/ 已安装（Installed）/ 服务（Providers）
   - 已经是这个结构，但「服务」要成为主入口
2. 渠道页对插件渠道**隐藏无关字段**
   - 不显示 Key（凭证不在库里）
   - BaseURL 显示为 provider 名而非 id
   - 加一行说明"这个渠道由插件 XXX 服务"
3. 新增「用量」子页：按服务/账号看用量（复用 `usage` RPC）
4. 空状态、加载态、错误态统一（已有组件，逐个替换）

**验收**
- 插件渠道在渠道页看起来不像坏数据
- 界面上不再出现"base_url 是 workbuddy"这种困惑

### R6 · 工程收口

1. 补测试：R1–R5 每项都要有
2. 更新 `docs/plugin-host.md`
3. CI 加前端 e2e 冒烟（起服务 → 注册 → 调用）
4. 性能：`/api/plugin_provider/accounts` 并发拉取，加缓存

**验收**
- `gofmt / vet / test / typecheck` 全绿
- CI 跑通

## 三之二、服务详情页（已交付）

原项目每个订阅有单独的管理页，能看到积分、签到、用量。本项目已加：

| 位置 | 内容 |
|---|---|
| 「服务」标签 → 某张卡的「详情」 | 进入该服务自己的页面 |
| 页面头部 | 名称、provider id、登录/未登录、自动续期、可用账号数 |
| 按钮 | **全部签到**（一键所有账号）、**检查账号** |
| 渠道区 | 该服务注册的渠道：前缀、模型数、pooling 的 key 数、优先级/权重、开关 |
| 账号区 | 每个账号一行：昵称、类型、套餐、配额窗口（含重置时间）、本账号 key 是否在用 |
| 每账号操作 | **签到**、重新登录、移除 |
| 签到结果 | 逐条显示 outcome、获得积分、连续天数 |

实测签到：`claimed=2, failed=4`，两个有效账号各 +100 积分，
四个失效账号如实返回 `Unauthorized`，不静默成功。

## 三之三、R4 自动续期与自动签到（已交付）

### 自动签到

| 项 | 实现 |
|---|---|
| 默认 | **开**（你选的） |
| 时间 | 每天 `at` 点之后（默认 9 点），每 30 分钟检查一次 |
| 去重 | 按「本地日期」记录，同一天已签过就跳过 |
| 状态 | 存在 `data/plugin-host/plugin-checkin.json` |
| 界面 | 「服务」标签顶部一张卡片：开关、时间、上次结果、立即执行 |

实测：第一次 `claimed=2, failed=4`，第二次 `claimed=0`（今天的已经签过）。

### 自动续期

| 项 | 实现 |
|---|---|
| 频率 | 每 2 分钟 |
| 触发 | 只在到期前 10 分钟内才询问插件 |
| 兼容 | 插件声明 `auth.refresh` 时用 `keepSignedIn`；不声明时（WorkBuddy）
  靠 loader 内部刷新，以「到期时间是否前移」判定 |
| 顺序 | 续期 worker（15s 首跑）**先于**健康同步（60s 首跑） |

实测：把 token 改成已过期 → worker 跑一次 → `plugin renewal: workbuddy renewed,
until 2026-12-04`，`/renewals` 记录 1 条。

### 一个非直觉的坑（值得记下）

插件的 loader 在**被询问时**就会顺手刷新 token。所以：

1. `pluginhost.Providers()` 会启动插件、跑 loader → 已续期
2. 健康同步调 `AccountUsage` → 也会续期

结果：如果先查「谁该续期」再决定续不续，读到的永远是「不用续」。
修法是**先从 `plugin-auth.json` 读到期时间再问插件**（`ProvidersWithAccounts`）。
这也是为什么续期必须排在健康同步之前。

## 三之四、R6 工程收口（已交付）

### 端到端冒烟测试

`new-api-main/scripts/smoke-plugin-host.mjs`：起一个真实二进制，走全部 25 个
插件接口，按运营者会用的顺序：看宿主 → 列已装 → 读市场 → 读服务 → 读服务详情页
→ 读路由 → 签一次到 → 读续期 → 切换宿主开关 → 确认旧反代路由已 404。

特点：

* 用**临时目录和自己的配置**，不碰 `data/plugin-host/`
* 不需要厂商账号：因缺账号而被拒算通过，500/404 算失败
* 可选用 `SMOKE_INSTALL_PLUGIN` 加一段「真装一个插件」的验证
* 本地实测 **24 项通过**（干净安装）/ **31 项通过**（含安装阶段）

写这个测试时抓到两个真问题：

1. 脚本原先放在仓库根 `scripts/`，但 CI 在 `new-api-main/` 里跑 —— 找不到文件
2. `spawn("./smoke-server")` 在 Windows 上不解析相对路径 —— `ENOENT`

### CI

`.github/workflows/ci.yml` 现在有三个 job：

| job | 内容 |
|---|---|
| `backend` | gofmt + vet + build + test（三个 module） |
| `plugin-smoke` | **新**：build 二进制 → 跑冒烟测试 |
| `frontend` | typecheck + test + **build**（build 是新加的） |

前端加 `bun run build` 是因为 typecheck 漏得过「能过类型检查但构建失败」的页面。

### 文档

`docs/plugin-host.md`（217 行）：它是什么、数据在哪、渠道怎么生成、25 个接口、
三个后台任务、**续期为何排在健康同步之前**、五个常见故障的查法、测试怎么跑。

## 四、不做什么（重要）

明确划掉，避免范围失控：

| 不做 | 原因 |
|---|---|
| 抄 magpie 的 Agents（72 个） | 你是中转站，不需要本地 agent |
| 抄 magpie 的桌面壳（GTK/WebView2） | 你是 Web 服务 |
| 抄 magpie 的四层插件体系 | 只保留 provider 插件 |
| 抄 magpie 的 SDK 自动安装 | 与中转站无关 |
| 重写 new-api 的路由核心 | 复用 `ability` 即可 |
| 引入 magpie 的 `provider.Entry` 数据模型 | 与 new-api 的 Channel 冲突 |

## 五、顺序与工期

```
R1 模型命名      ← 你提的问题 1，先止血
R2 账号展示      ← 你提的问题 2
R3 路由组        ← 让同名成为特性而非 bug
R4 自动续期      ← 减少手动操作
R5 界面对齐      ← 体验收口
R6 工程收口
```

R1 + R2 是必须马上做的，R3 是设计上的关键一步，R4–R6 是打磨。

## 六、需要你确认的三个选择

1. **R1 的前缀规则**：我建议 `workbuddy → wb:`、`workbuddy-ai → wbai:`
   （沿用你现在 `wb:` 的习惯）。还是你想改成别的形式？

2. **R3 的默认行为**：裸名 `glm-5.3` 默认是"跨厂商互为备份"，还是"只走优先级
   最高的那家"？magpie 是前者。前者更丝滑，但如果两家计费差很多，可能不想要。

3. **R4 的自动签到**：默认开还是默认关？签到能拿额度，但会让插件在你不知情时
   访问厂商接口。

---

## 附：我读过的关键文件

| 文件 | 我从中确认了什么 |
|---|---|
| `internal/provider/group.go` | 同名模型自动成组的设计 |
| `internal/gateway/bare_test.go` | `provider/model` vs 裸名的语义 |
| `internal/gui/assets/app.js` `renderAccounts` | 账号行展示的全部信息 |
| `internal/gui/assets/app.js` `windowCapMeter` | 配额窗口与上限的交互 |
| `internal/gui/assets/plugins.js` | 插件页（发现/已安装）的布局 |
| `pkg/pluginhost/host.js` `accountKey` | 账号选择由调用方决定 |
| `pkg/pluginhost/host.go` `FetchRequest` | `Account` 字段与"默认第一个"语义 |
| `new-api/model/ability.go` | ability 表是 (group, model, channel) |
| `new-api/service/pluginreg/register.go` | 前缀是可选的 → 撞名根因 |
