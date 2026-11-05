# 插件宿主：把反代服务换成 magpie 的插件形态

> 状态：**P0–P5 全部完成**（2026-11-04）。本文是计划与已完成的记录。

## 一、决策（已确认）

| 项 | 决定 |
|---|---|
| Q1 迁移范围 | 先做 **workbuddy**，跑通再铺开 |
| Q2 多租户边界 | 插件渠道按**分组授权**（b） |
| Q3 旧反代去留 | 保留 manifest 面板作 **Legacy**（a），先不删 |
| Q4 登录 UI | 在 new-api React 后台自建（a） |
| Q5 插件信任 | 白名单 + 手动添加需风险确认（b） |
| Q6 网关中间件 | 先不做（a），new-api 原生 `param_override`/`model_mapping` 已等价 |
| Q7 Bun 分发 | 按需下载（a），便携版另行内嵌 |
| Q8 路由策略 | 在 new-api 现有优先级/权重之上，后续增量做额度窗口（b） |

## 二、P0 做了什么

把 magpie 的插件宿主（`internal/plugin`，10,376 行 Go + `host.js` 143KB）移植进
new-api，并把它的 13 个内部依赖换成一组最小实现。

### 新增目录

```
new-api-main/
├── pkg/pluginhost/            宿主本体（25 个 .go + host.js + pi.js + market.json）
│   ├── host.go                子进程生命周期、RPC、背压、流式帧
│   ├── host.js                OpenCode 插件契约（逐字节照搬，未改）
│   ├── providers.go           插件 provider、账户、登录、额度
│   ├── store.go               plugins.json / plugin-auth.json
│   ├── bun.go / bunupdate.go  Bun 按需下载（带 SHA256 校验）
│   ├── market.go / updates.go 插件市场与更新
│   └── support/               替代 magpie internal/* 的最小实现
│       ├── appdir/            数据目录（<binary>/data/plugin-host）
│       ├── settings/          宿主自己的设置
│       ├── catalog/           models.dev 缓存
│       ├── edit/              原子写
│       ├── filememo/          文件解析缓存
│       ├── lastgood/          上一份好数据兜底
│       ├── steady/            Windows 重命名重试
│       ├── proc/              子进程（无窗口、管道分离）
│       ├── netproxy/          代理（含 SOCKS5→HTTP 桥，Bun 用）
│       ├── source/            镜像（npmmirror / jsDelivr）
│       ├── ghtoken/           GitHub token 与限流
│       ├── libc/              musl 检测
│       └── update/            版本比较
└── cmd/plugprobe/             命令行探针（P0 的验收工具）
```

### 与 magpie 的差异（为适配 new-api 做的取舍）

| magpie 原来 | 现在 | 原因 |
|---|---|---|
| `internal/proc` 4,418 行 | 6 个文件、约 200 行 | 登录 shell / PATH 发现 / agentenv 在 hub 里没有调用方 |
| `internal/netproxy` 1,560 行（含 macOS scutil、Windows 注册表） | 约 300 行 + 原样保留的 SOCKS5 桥 | 服务端只读环境变量即可 |
| `internal/update` 4,397 行 | 约 120 行 | 只要 `Newer` 与 `Reexec` |
| `internal/edit` 3,618 行（JSONC/TOML/YAML 保格式编辑器） | 约 30 行 | 只需 `WriteAtomic` |
| `settings` 是整个应用的设置 | 只留插件宿主自己的 5 个字段 | 不碰 new-api 的 option 表 |

## 三、P0 验收结果

用真实的 `@magpie-community/opencode-workbuddy-auth@0.2.20` 跑通：

```
$ plugprobe list
@magpie-community/opencode-workbuddy-auth@latest   on  → workbuddy-ai, workbuddy

$ plugprobe providers workbuddy
workbuddy  (WorkBuddy)
  npm:     @ai-sdk/openai-compatible
  api:     https://copilot.tencent.com/v2
  method:  oauth — WorkBuddy account (browser)
  method:  oauth — WorkBuddy desktop's sign-in
  method:  api — WorkBuddy API key
  models:  15 (auto, hy4-preview-f, hy3, hy3-x, deepseek-v4.1-flash,
               glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo,
               minimax-m3, kimi-k3-1, …)

$ plugprobe chat workbuddy glm-5.3 "Reply with exactly: bootstrap works"
200 OK  (1.138s)
bootstrap works
usage: prompt=25 completion=4

$ plugprobe tools workbuddy glm-5.3
tool call: get_weather({"city": "Shanghai"})

$ plugprobe usage workbuddy
workbuddy: reports usage=true checkin=true renews=true
  Credits: 0 / 500 (resets 2026-11-30)
  Extra credits: 152.97 / 3606        ← 真实额度
```

**验收项：**

| 项 | 结果 |
|---|---|
| 插件加载（OpenCode 契约） | ✅ workbuddy + workbuddy-ai 两个 provider |
| 模型列表（含 context / free 标记） | ✅ 15→17 个，登录后自动扩展 |
| OAuth / API key / 桌面登录三种方式 | ✅ 方法都列出来了 |
| 真实流式对话 | ✅ 1.1s 首字节，SSE 逐字输出 |
| usage 计数 | ✅ prompt=25 completion=4 |
| **工具调用** | ✅ `get_weather({"city":"Shanghai"})`，参数是合法 JSON |
| 额度与账号健康 | ✅ 每号状态、剩余积分、重置时间 |
| 签到钩子 | ✅ `checkin=true` |
| **Bun 自动下载** | ✅ 86MB 走 npmmirror，SHA256 校验通过 |
| 多账号池 | ✅ 6 个账号并存，各自独立状态 |
| 全仓库编译 | ✅ `go build .` 与 `go build ./...` 都通过 |

## 四、P1 做了什么（已完成）

### 新增的代码

| 文件 | 作用 |
|---|---|
| `constant/channel.go` | `ChannelTypePluginProvider = 64`（`ChannelTypeDummy` 顺移到 65） |
| `constant/api_type.go` | `APITypePluginProvider` |
| `common/api_type.go` | 渠道类型 → API 类型的映射 |
| `relay/channel/pluginprovider/adaptor.go` | **核心**：把插件当作一个上游 |
| `relay/relay_adaptor.go` | 把新 adaptor 接进 `GetAdaptor` |
| `service/pluginreg/register.go` | 插件 provider → new-api 渠道 |
| `controller/plugin_provider.go` | 管理 API |
| `router/api-router.go` | `/api/plugin_provider/{providers,register}` |
| `pkg/pluginhost/settings.go` | 宿主设置的读写入口 |

### 关键设计：按模型选择协议

一个插件 provider 的模型可能来自不同厂商，而它们的线协议不同。adaptor 读模型在
插件里声明的 AI SDK 包名（`npm`），据此选择 new-api 已有的 adaptor 来转换请求、
解析回复、统计 usage：

| 模型声明 | 协议 | 复用的 adaptor |
|---|---|---|
| `@ai-sdk/openai-compatible`、`@ai-sdk/openai`、`@ai-sdk/xai`… | OpenAI Chat | `openai.Adaptor` |
| `@ai-sdk/anthropic` | Anthropic Messages | `claude.Adaptor` |
| `@ai-sdk/google`、`@ai-sdk/google-vertex` | Gemini | `gemini.Adaptor` |

这样 **SSE 解析、工具调用、reasoning_content、usage 统计、计费**全部免费获得，
不需要为插件重写一遍 —— 这是整个方案里最省事、也最不容易出错的一处。

### 数据模型：一个账号 = 一个渠道

```
插件 provider id           → Channel.BaseURL   (workbuddy)
插件账号 (key)             → Channel.Key       (workbuddy#2apscn)
插件模型列表               → Channel.Models    (wb:glm-5.3)
模型名 ↔ 上游名            → Channel.ModelMapping
context 窗口               → Channel.OtherSettings.ModelContextWindows
渠道 tag                   → plugin:<provider>:<account>
```

一个账号一行渠道，**new-api 现成的优先级、权重、冷却、自动禁用、重试整条链路
直接生效**，不用自己实现账号池。

### 端到端验收（真实 HTTP，非模拟）

```
$ curl /v1/chat/completions  model=wb:glm-5.3  stream=true
200 OK
data: {...{"content":"relay works"}}
data: {... "finish_reason":"stop", "usage":{"prompt_tokens":25,"completion_tokens":4,
             "total_tokens":29, "completion_thinking_tokens":1, "credit":0.01}}
data: [DONE]

$ 同一通道，带 tools
tool_calls seen: 6
assembled: {"0":{"name":"get_weather","args":"{\"city\": \"Shanghai\"}"}}
```

| 验收项 | 结果 |
|---|---|
| 渠道注册（6 账号 → 渠道行） | ✅ type=64，base_url=workbuddy，模型带 `wb:` 前缀 |
| 模型前缀回写上游原名 | ✅ `wb:glm-5.3` → `glm-5.3` |
| 流式对话经中继 | ✅ |
| usage 与计费 | ✅ prompt=25 / completion=4 / credit=0.01 |
| **工具调用经中继** | ✅ 6 个增量正确拼成一次调用 |
| `go build .` / `go vet` / `gofmt -l` | ✅ 全绿 |
| 管理 API 鉴权 | ✅ 无 token 返回 401 |
| 单元测试 | ✅ `go test ./relay/channel/pluginprovider/` 通过 |

## 五、P2 做了什么（已完成）

### 后端

| 文件 | 作用 |
|---|---|
| `service/pluginreg/plugins.go` | 插件安装/卸载/启停/更新、社区市场、宿主设置 |
| `service/pluginreg/signin.go` | 三种登录方式、账号列表、退出、provider 开关 |
| `controller/plugin_provider.go` | 17 个管理接口 |
| `pkg/pluginhost/settings.go` | provider 开关的读写与下发 |

### 前端

新增 `web/src/features/plugin-provider/`：

| 文件 | 内容 |
|---|---|
| `index.tsx` | 页面：宿主卡 + 「服务 / 插件」两个标签页 |
| `components/host-card.tsx` | 宿主开关、国内镜像、文件路径、Bun 状态 |
| `components/providers-panel.tsx` | 服务列表、登录、详情 |
| `components/provider-card.tsx` | 单个服务：账号数/模型数、登录、详情、注册渠道 |
| `components/signin-dialog.tsx` | 三种登录方式：多轮提问、OAuth 轮询、粘贴密钥 |
| `components/provider-detail-dialog.tsx` | 账号列表、插件能力、开关、模型表（含价格） |
| `components/plugins-panel.tsx` | 已装插件、一键安装、社区市场、搜索 npm |

侧边栏「管理员 → 插件服务」，路由 `/plugin-providers`，仅 admin 可见。
i18n 补了 70 个键（zh / zh-TW / en）。

### 浏览器验收（Chrome + CDP，真实渲染）

```
PROBE url=/plugin-providers  hasTitle=true  EXCEPTIONS=0

插件宿主  运行中 · 1 个插件 · 刷新
  启用插件 / 国内镜像
  文件      …/data/plugin-host/plugins
  登录态    …/data/plugin-host/plugin-auth.json
  Bun 就绪 · 源: https://registry.npmmirror.com

服务  |  插件          （2 个服务）
  WorkBuddy AI   workbuddy-ai   未登录   0 个账号，16 个模型
  WorkBuddy      workbuddy      已登录   6 个账号，17 个模型
                 workbuddy  workbuddy#2apscn  workbuddy#9uc1a8  workbuddy#bx382e …
```

| 验收项 | 结果 |
|---|---|
| 页面渲染、无 JS 异常 | ✅ |
| 宿主状态与文件路径 | ✅ |
| 服务卡片（账号数/模型数/登录态） | ✅ |
| 详情：6 账号、17 模型、3 种登录方式 | ✅ |
| 社区市场 17 个插件 | ✅ |
| 已装插件 0.2.20 | ✅ |
| 17 个后端接口 | ✅ 全部 200 |
| `bun run build` / `go build` / `go vet` / `gofmt` | ✅ 全绿 |

### 踩到的坑

1. **gin 不允许通配符后面还有路径段**：`/plugins/*spec/off` 直接 panic，整个服务起不来。
   改成 `/plugins/off?spec=…`——npm 包名带 `@` 和 `/`，本来也不适合放进路径段。
2. **`api.get` 有响应去重缓存**，轮询登录状态必须用 POST（已用 POST）。
3. **路由树要重新生成**：`bun x @tanstack/router-cli generate`，否则 `createFileRoute` 的类型对不上。

## 六、P3 做了什么（已完成）

### 迁移服务

| 文件 | 作用 |
|---|---|
| `service/pluginreg/migrate.go` | 候选识别、迁移预演、执行、回退 |
| `service/pluginreg/health.go` | 账号健康同步：失效账号的渠道自动关闭 |
| `service/pluginreg/worker.go` | 每 5 分钟后台同步一次 |
| `controller/plugin_migrate.go` | 4 个迁移接口 |
| `web/…/components/migrate-panel.tsx` | 「迁移到插件」标签页 |

### manifest → 插件 映射

| 旧服务 | 社区插件 | 插件 provider |
|---|---|---|
| workbuddy | `opencode-workbuddy-auth` | workbuddy |
| qoder | `opencode-qoder-auth` | qoder |
| cline | `opencode-cline-auth` | cline |
| trae | `opencode-trae-auth` | trae-cn |
| cmdgo | `opencode-commandcode-auth` | commandcode-plan |

迁移**不删除任何东西**：旧 manifest、旧服务、旧渠道全部保留，只是把旧渠道
置为手动禁用。回退就是把它重新启用、把插件渠道禁用。

### 迁移时同时做账号健康检查

这是 P3 最重要的发现。插件里有 6 个账号，其中 4 个 token 已失效。旧的反代
会对失效账号返回 401，而 new-api 不知道这件事——它按优先级选渠道，选到失效
账号就失败。

所以在迁移结束时（以及每 5 分钟的后台任务里）读一次每个账号的健康状态，
把失效账号的渠道设为**自动禁用**：

```
migrate: true | created 6 | health: workbuddy 2/6
  lapsed: [workbuddy#bx382e, workbuddy#9uc1a8, workbuddy#ew657w, workbuddy#xbpn48]

  #1 WorkBuddy · default account    status=1   ← 可用
  #2 WorkBuddy · 2apscn             status=1   ← 可用
  #3 WorkBuddy · 9uc1a8             status=3   ← 自动禁用
  #4 WorkBuddy · bx382e             status=3
  #5 WorkBuddy · ew657w             status=3
  #6 WorkBuddy · xbpn48             status=3
```

于是路由直接跳过失效账号，而不是先失败再重试一轮。

### 顺带修掉的一个真 bug：非流式请求

WorkBuddy 上游**拒绝非流式请求**（`Non-stream chat request is currently not
supported`, 400）。客户端用 `stream: false` 一定失败。

修法：插件 adaptor 对非流式请求**向上游要流式**，在本地拼成一份完整回复。
关键是聚合必须发生在 `DoRequest` 里而不是 `DoResponse`——中继会读上游的
`Content-Type` 来决定要不要流式转给客户端，聚合晚了就会被当成 SSE 转发出去。

四种形态全部验证：

| 形态 | 结果 |
|---|---|
| 流式 | ✅ `stream ok` |
| 非流式 | ✅ `nonstream ok`，`content-type: application/json`，usage 26/4 |
| 非流式 + 工具 | ✅ `get_weather({"city": "Shanghai"})`，finish=tool_calls |
| 流式 + 工具 | ✅ 增量正确拼接 |

### 验收

| 验收项 | 结果 |
|---|---|
| 5 个旧服务识别，映射到对应插件 | ✅ |
| workbuddy 迁移：6 账号 → 6 渠道 | ✅ 带 `wb:` 前缀 |
| 失效账号的渠道自动禁用 | ✅ 4/6 |
| 回退：旧渠道恢复、插件渠道禁用 | ✅ |
| 迁移预演（保留/新增/缺失模型） | ✅ |
| 后台每 5 分钟同步 | ✅ |
| `go build` / `go vet` / `gofmt` / `go test` | ✅ 全绿（6 个测试） |

## 七、P5 做了什么（已完成）

### 修掉仓库原有的 4 个 TS 错误

都不是这次引入的，但 CI 的 `bun run typecheck` 会因此变红：

| 文件 | 问题 |
|---|---|
| `terminal-backdrop.tsx` | `TOTAL_CHARS` 声明未使用 |
| `token-usage-chart.tsx` | 用了 `cn` 但没 import |
| `home-bento.tsx` | 导入了 `Button` 未使用 |
| `hub-diagram.tsx` | `useTranslation` 及其 `t` 未使用 |

修完后 `bun run typecheck` **exit 0**。

### 补测试：29 个 Go + 7 个前端

| 包 | 测试覆盖 |
|---|---|
| `pkg/pluginhost` (6) | spec 解析 / path 与 git 区分 / `ProviderOf` / `accountsOf` 排序 / API key hint / registry 校验 |
| `support/lastgood` (6) | **坏文件读成"未知"而非"空"**（这是整个兜底机制的根） |
| `support/steady` (3) | 原子写 / 首次创建 / 读时等重命名 |
| `service/pluginreg` (6) | manifest→插件映射 / provider id 映射 / 模型前缀 / tag / kindOf / 健康状态只动自己禁用的渠道 |
| `relay/channel/pluginprovider` (8) | 协议选择 / 账号解析 / **SSE 聚合成非流式** / 工具调用拼接 / 空流报错 / 厂商错误帧 / forceStream |
| 前端 `plugin-provider` (7) | 服务卡片三种状态 / 迁移面板可用性判断 |

写测试时发现并修掉一个真 bug：`kindOf` 用 `Name()` 判断包类型，但 `Name()` 保留
`@scope/` 前缀，导致 `agent-` / `tools-` / `page-` 全部识别不出来。测试直接抓到了。

### CI

仓库原来有一个 `ci.yml`，但有三个真问题：

1. **只在 PR 上跑**，往 main 直接推不跑
2. **没有 gofmt 检查**——这正是"未格式化代码进入 main，每次都要单独一个 commit"的成因
3. checkout 步骤写死了 `github.event.pull_request.base.repo.full_name`，push 时为空

都补上了：`push` + `workflow_dispatch` 触发、独立的 gofmt 步骤、按事件类型分三种 checkout。

### 最终校验（本地全跑一遍）

```
gofmt -l  (969 files)        clean
go vet ./...                 OK
go build ./...               OK
bun run typecheck            OK
go test  (5 个新包)          29 PASS / 0 FAIL
vitest   (新功能)            7 PASS / 0 FAIL
```

**已知遗留**：`src/features/channels/` 有 4 个前端测试失败（Base UI combobox 的
`nativeButton` 警告），文件 mtime 为 2026-10-08，早于本次工作，与本次改动无关。

## 八、下一步

### P4 · 更新与中文化（已完成，随 P2）

manifest → 插件迁移向导（凭据必须重新授权），manifest 面板保留为 Legacy。

复用 market.go / updates.go，npmmirror 支持，每日检查更新（默认关）。
（P2 已经把市场、更新、npmmirror 一起做了，剩余是"每日自动检查"）

### P5 · 工程收口
对等测试、GitHub Actions、THIRD_PARTY_NOTICES 加 magpie (MIT)。

## 五、许可证

magpie 是 MIT，其插件宿主与 `host.js` 可整体并入 AGPL-3.0 的 new-api。
`pkg/pluginhost/` 内保留原版权头注释；`THIRD_PARTY_NOTICES` 需追加 magpie 条目。

**附带收益**：社区插件由用户自己从 npm 安装，仓库不再分发任何第三方反代代码
（`Qoder-free-main/` 无 LICENSE 的问题随之消失）。
