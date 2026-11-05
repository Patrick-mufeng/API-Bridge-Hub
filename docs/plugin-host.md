# 插件宿主（plugin host）

> 本文是**参考文档**：说明插件宿主是什么、数据在哪、接口有哪些、出问题怎么查。
> 计划与历次验收记录见 `plugin-host-plan.md` 与 `plugin-refactor-plan.md`。

## 一、它是什么

本站用**社区插件**接各家厂商的订阅：一个插件负责登录某个厂商、拿到它的模型、
发请求、查额度、按天签到。本站只做中转站该做的事——计费、令牌、渠道、多渠道调度。

```
浏览器 ──► 本站 (new-api) ──stdin/stdout JSON-RPC──► Bun 宿主（一个进程）──► 各家厂商
                │                                        └── 全部插件
                └── 渠道 type=64（Plugin Provider）
```

一个 Bun 进程跑全部插件：进程数 2（本站 + Bun），端口 1。

## 二、装了什么、放在哪

| 路径 | 内容 |
|---|---|
| `data/plugin-host/plugins.json` | 装了哪些插件 |
| `data/plugin-host/plugin-auth.json` | **登录凭证**（OAuth token / API key） |
| `data/plugin-host/plugin-providers.json` | 每个 provider 的选项 |
| `data/plugin-host/plugin-checkin.json` | 签到设置与当天结果 |
| `data/plugin-host/plugins/node_modules/` | 插件包本体 |
| `data/plugin-host/cache/` | Bun、模型目录、市场列表（可再取） |

可用环境变量改写：

```
PLUGIN_HOST_CONFIG_DIR   覆盖凭证与列表所在目录
PLUGIN_HOST_CACHE_DIR    覆盖缓存目录
MAGPIE_BUN               指定已有的 bun.exe，跳过下载
MAGPIE_PLUGIN_MARKET     覆盖插件市场地址（设为 off 则只用内置列表）
```

**凭证永不入库**：`plugin-auth.json` 是唯一存放处，不进数据库、不进日志，
`.gitignore` 已排除。

## 三、渠道是怎么生成的

一个 provider → **一个渠道**（type 64），账号作为该渠道的多 key。

```
WorkBuddy (provider=workbuddy)
  └── 渠道 #1  base_url=workbuddy  models=workbuddy-auto,workbuddy-glm-5.3,…
        key = workbuddy / workbuddy#2apscn / …        ← 多 key，轮询
        channel_info.multi_key_mode = polling
```

为什么不是一账号一渠道：new-api 对渠道做优先级/权重/冷却，把账号合成一个渠道的
多 key 后，**单账号被限流只冷却那个 key**，其余账号继续服务。拆成 N 个渠道就没有
这个粒度。

需要独立计费/独立限流时，注册时传 `per_account: true` 可改成一账号一渠道。

### 模型命名

模型名带前缀，避免两个服务撞名：

```
workbuddy     + glm-5.3  →  workbuddy-glm-5.3
workbuddy-ai  + glm-5.3  →  workbuddy-ai-glm-5.3
```

前缀就是 provider 的完整 id，用连字符接模型名。**不能用「第一个连字符」切分**：
把 `workbuddy-ai-glm-5.3` 切开会得到 `ai-glm-5.3`。所有需要剥前缀的地方都读
渠道记录的 `PluginPrefix`。

注册时**会检测撞名**：若同名模型已存在于别的渠道，直接报错，不静默覆盖。

存量迁移：`POST /api/plugin_provider/migrate-prefixes?dry=1` 先预览，
去掉 `?dry=1` 执行。旧名（`wb:glm-5.3`）会保留为裸名别名，已配置的客户端不断。

### 裸名与优先级

每个带前缀的模型同时以裸名发布（`workbuddy-glm-5.3` → `glm-5.3`），裸名是一个路由名，
指向同一模型的所有 provider：

```
glm-5.3:  WorkBuddy AI (p100) → WorkBuddy (p0)
```

请求裸名走**优先级最高**的那家，失败再降级。这是复用 new-api 的 `ability` 表：
主键是 (group, model, channel)，路由时按 priority 分层、层内按 weight 随机。

> **降级需要重试次数大于 0。** `RetryTimes` 默认是 **2**（`common/constants.go`），
> 一次请求最多再试两家。设成 0 时裸名只会打优先级最高的那家，失败就是客户端的失败。
> 后台任务的细节见第五节。

### 池子里的账号怎么挑

一个 provider 的账号是**一个渠道的多 key**，挑 key 的规则在 `model/channel.go`
的 `GetNextEnabledKey`，按顺序：

1. **跳过已停用的 key**（`MultiKeyStatusList` 里不是 enabled 的）。
2. **跳过正在休息的 key**（`MultiKeyCooldownUntil` 里还没到点的）。429 休息 60 秒，
   5xx 休息 30 秒；401/403 不休息——那是要重新登录，不是等一会儿就好。
3. **跳过额度快用完的 key**（`MultiKeyUsedShare` ≥ 90，且读数是 5 分钟内的）。
   份额取该账号**最满的那一个**窗口：周窗口还有余量也救不了五小时窗口已经 98%。
4. 剩下按轮询/随机挑一个。

三条兜底，都是刻意的：

- **所有 key 都在休息** → 挑最早回来的那个，而不是报「没有可用 key」。一个账号池
  集体被限流一分钟，比让客户端看到一个空池子好。
- **所有账号都快用完** → 照常轮询，因为这时候没有更好的选择。
- **额度读数是旧的（> 5 分钟）** → 当作不知道。窗口可能已经重置，旧数字比没有更糟。

额度的数字来自健康同步（`service/pluginreg/health.go` 的 `applyHealth`），
每次同步都把每个账号最满的窗口份额写进渠道。

## 四、接口

全部在 `/api/plugin_provider`，需要管理员。

### 宿主

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/host` | 宿主状态、路径、Bun 是否就绪 |
| PUT | `/host` | 开关插件、npm 源、国内镜像 |

### 插件

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugins` | 已安装的插件（含 load_error） |
| POST | `/plugins` | 安装，body: `{spec}` |
| DELETE | `/plugins?spec=` | 卸载 |
| POST | `/plugins/off?spec=&off=` | 停用/启用 |
| POST | `/upgrade` | 更新全部 |
| GET | `/market` | 社区插件列表 + npm 元数据 |
| GET | `/market/search?q=` | 在 npm 上搜 |

### 服务（provider）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/providers` | 所有可注册的服务 |
| GET | `/providers/:id` | 详情（含账号、模型） |
| GET | `/providers/:id/page` | **服务详情页**：账号 + 额度 + 渠道 |
| GET | `/providers/:id/usage` | **用量**：时段内总量、趋势、按模型/账号/渠道拆分；参数 `start_timestamp`、`end_timestamp`、`granularity=hour\|day` |
| GET | `/providers/:id/requests` | 该服务最近的请求（含失败），供「路由」页播放 |
| POST | `/register` | 注册为渠道（可选 `per_account`、`allow_clash`） |
| POST | `/signin/start` `/signin/key` `/signin/poll` | 登录流程 |
| POST | `/signout` | **移除账号**：从所有服务它的渠道里摘掉这个 key，再删掉插件的登录记录；渠道没账号剩下一并删除 |
| POST | `/option` | 设置 provider 选项 |
| POST | `/health/sync` | 检查账号健康，失效的 key 自动停用 |

### 移除账号

一个账号活在**两个地方**：插件的登录记录（`plugin-auth.json`）和它的渠道 key。
只删一处会留下「谁都续不了的 key」或「没渠道能用的登录」——所以 `/signout` 一次做两件事：

1. 从每个服务它的渠道里摘掉这个 key（合并渠道里其它账号照旧服务，
   状态列表按下标重建：原本在休息的账号继续休息，polling 下标越界则归零）
2. 渠道没账号剩下了就把它删掉（面板会回到「还没有渠道」，重新登录后可再注册）
3. 最后才删插件的登录记录 —— 顺序是刻意的：中途失败留下的是「已停用」而不是「删了一半」，
   再执行一次即可收尾

`removeFromChannel` 里持久化和纯逻辑是分开的（`pruneAccount` 只改内存），
所以账户摘除的语义有单测覆盖，不需要数据库。

### 签到与续期

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/PUT | `/checkin/options` | 自动签到的开关与时间 |
| POST | `/checkin/run` | 立即签到（当天已签的跳过） |
| POST | `/checkin` | 签到单个/全部账号（即时反馈） |
| GET | `/renewals` | 最近的续期结果 |

### 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/routes` | 每个裸名模型、谁在服务、优先级顺序 |
| POST | `/migrate-prefixes` | 把旧前缀（`wb:`）改名为新形式；`?dry=1` 只预览 |

### 用量从哪读

用量不来自插件，来自本站自己的记录，按**该 provider 注册的渠道**取：

| 数据 | 来源 | 为什么 |
|---|---|---|
| 请求数、Token、额度 | `quota_data`（按小时聚合） | 这份表能活过日志清理，用量不会因为清日志而清零 |
| 每个模型的耗时 | `logs` 的 consume 行 | 只有日志行带 `use_time`；日志被清过就报 0，而不是报一个错的均值 |
| 失败数、最近请求 | `logs` 的 error 行 | 错误行记录它试过的渠道，某个账号失效会在这里显形 |

**按账号拆分的边界**：账号 = 渠道时（注册时 `per_account: true`）能细到账号；
账号被并进一个渠道的多 key 时，本站无法知道是哪个 key 应答的，于是不再编造，
池子的用量归在渠道上、账号那栏留空。这是刻意的，不是缺功能。

**一个坑**：渠道的 provider 既写在 `settings.plugin_provider`，也写在
`tag = plugin:<provider>:<account>`。早期注册的渠道只有 tag，所以
`channelProvider()`（`service/pluginreg/account.go`）两处都认，只认一处会让
旧渠道从它自己的用量页里消失。

## 四点五、三个页面各管什么

前端把「插件」这一块拆成三页，因为它们回答三个不同的问题。

| 页面 | 路由 | 回答的问题 |
|---|---|---|
| 插件 | `/plugin-providers` | 装了哪些包、市场里有什么、哪个过期了、宿主开没开 |
| 服务 | `/plugin-services` | 每个订阅：账号与剩余额度、花掉了多少、插件自己的开关 |
| 路由 | `/plugin-routing` | 每个裸名模型谁在服务、按什么顺序尝试、谁挂了 |

**服务页是「原地展开」的**：一行一个订阅，点开就在这一行下方铺开，再点收起
（`provider-service-card.tsx`，`AnimatePresence` 做高度动画，`prefers-reduced-motion`
时直接显示）。展开后是三段，用行内 tab 切换：

- **账号**：每个账号一行，带额度窗口进度条、套餐、重置时间、失效原因
- **用量**：时段切换（24 小时 / 7 天 / 30 天 / 90 天）、总量四项、Token 趋势图、
  按模型拆分（带占比条与平均耗时）、按渠道拆分
- **设置**：插件声明的开关（如「仅免费模型」）+ 该服务提供的模型列表

为什么不跳新页面：运营者打开一个订阅时手上只有一件事——这个账号还剩多少、花在哪，
三段都在回答同一件事，翻页反而要重新加载一遍同样的数据。

**路由页的动效**（`components/routing-map.tsx`）：一个裸名一行，成员按优先级排开，
第一个应答的带一个呼吸点，成员之间是一条线——线上一颗光点从前往后流，表示请求会
先落在这里；停用的成员画成虚线加删除线，表示请求根本到不了它。行按序渐入，
也遵循 `prefers-reduced-motion`。

## 五、三个后台任务，外加一个即时的

| 任务 | 周期 | 做什么 |
|---|---|---|
| **续期** | 2 分钟（15s 首跑） | 到期前 10 分钟内的账号，让插件刷新 token |
| **健康同步** | 5 分钟（60s 首跑） | 读每个账号状态，失效的 key 自动停用，**并把额度份额写给选路** |
| **自动签到** | 30 分钟（90s 首跑） | 每天 `at` 点后，为当天未签的账号签到 |

### 失败请求会立刻触发一次健康检查

五分钟太慢。一个凌晨失效的 token，会让接下来五分钟里落到它上面的每个请求都失败一次。
所以 `ProcessChannelError` 遇到 **401 / 403 / 402 / 429** 时，会通过
`service.ChannelFailureHook` 叫一次 `pluginreg.SyncChannelHealthAfterFailure`：

```go
// main.go 里接线，方向是 service ← pluginreg，不是反过来
service.ChannelFailureHook = pluginreg.SyncChannelHealthAfterFailure
```

用 hook 而不是直接调用，是因为 `service` 不能 import `pluginreg`（会成环）。

三点行为值得记住：

- **在后台跑**（`gopool.Go`），不拖慢这次请求，也不因为插件异常把已经发出去的回复
  变成错误。
- **同一个 provider 30 秒内只问一次**（`syncCooldown`）。一个 401 很少单独出现——
  同一秒还有别的请求在飞，不挡一下就是几十次并发询问。
- **只对插件渠道有效**：`channelProvider(ch)` 为空就跳过，普通渠道没账号可问。

### 续期为什么排在健康同步之前

插件的 loader **在被询问时会顺手刷新 token**。所以：

```
pluginhost.Providers()   → 启动插件、跑 loader → token 已刷新
AccountUsage()           → 也走 loader      → 同样刷新
```

如果先做健康同步（它会调 `AccountUsage`），等续期任务再检查时永远「不用续」。
同理，续期判断必须**先从 `plugin-auth.json` 读到期时间**，不能先问插件：

```go
// 对：先读文件，判断谁该续
for _, p := range pluginhost.ProvidersWithAccounts() { … }
// 错：Providers() 已经把 token 续了
```

## 六、出问题怎么查

### 插件装上去没反应

```
GET /api/plugin_provider/plugins     → 看 load_error 字段
```

常见原因：包不是 OpenCode 插件（`package.json` 没有 `main` / `exports`）。

### Bun 下载失败

```
PUT /api/plugin_provider/host  {"china_mirror": true}
```

或设 `MAGPIE_BUN` 指向已有的 `bun.exe`。

### 账号显示「需要重新登录」

厂商把 refresh token 作废了，只能重新登录。插件消息会说明原因。

### 模型名冲突

```
these model names are already served by another channel…
```

说明另一个渠道已经用了同样的模型名。改前缀，或显式传 `allow_clash: true`。

### 渠道列表里看不到账号

new-api 的接口不返回 `key` 字段（安全考虑）。账号在
**「服务」标签 → 某个服务 → 详情** 页看，那里有 `key_on` 表示每个 key 是否在用。

### 一个账号一直 429，其他账号在闲着

选路会跳过额度 ≥ 90% 的账号，但那只在**健康同步读到过份额**时有效。
先看这个账号的窗口数字是不是空的：

```
GET /api/plugin_provider/providers/:id/page
```

`windows` 为空说明插件没报额度，于是选路无从判断，只能按轮询走。
另一种可能是份额读数是旧的（超过 5 分钟），同样会被忽略。

## 七、测试

```bash
# Go 单元测试（含用量聚合与渠道归属）
go test ./service/pluginreg/ ./pkg/pluginhost/ ./relay/channel/pluginprovider/ ./model/ ./router/

# 前端：类型 / lint / 格式 / 组件测试
cd web && bun run typecheck && bun run lint && bun run format:check \
  && bunx vitest run src/features/plugin-provider

# 端到端冒烟（起二进制，走全部接口）
node scripts/smoke-plugin-host.mjs ./new-api-dev.exe

# 带安装阶段的冒烟（需要 npm，可指定已下载的 Bun）
SMOKE_INSTALL_PLUGIN=@magpie-community/opencode-workbuddy-auth \
SMOKE_BUN=/path/to/bun.exe \
node scripts/smoke-plugin-host.mjs ./new-api-dev.exe
```

冒烟测试用临时目录和自己的配置，不碰 `data/plugin-host/`。

## 八、第三方

插件宿主移植自 [magpie](https://github.com/yetone/magpie)（MIT）。
`host.js` 逐字节未改。声明见 `THIRD-PARTY-LICENSES.md`。
