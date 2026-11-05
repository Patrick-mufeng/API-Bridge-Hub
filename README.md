# BridgeHub — 个人 AI API 中转枢纽

> 一个 OpenAI 兼容端点，直达所有模型服务。
> 基于 [new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0）深度定制，用 **插件** 把各家厂商的订阅账号聚合成统一渠道。

## 它解决什么问题

手头有多个模型订阅（每个都有自己的登录方式、账号池、额度窗口、限制），在客户端里来回切换非常麻烦。BridgeHub 把它们聚合成**一个** OpenAI 兼容接口：

```
                       ┌─ WorkBuddy   (workbuddy-…)
                       ├─ Qoder       (qoder-…)
客户端 ──►  BridgeHub  ├─ Cline       (cline-…)
        /v1/chat/…     ├─ Trae        (trae-…)
                       └─ CmdGo       (cmdgo-…)
```

- **一个密钥、一个 Base URL**，所有渠道的模型全部可达
- 每个渠道的模型带**前缀**（`workbuddy-glm-5.3`），想走哪路上游就指定哪路，不会被负载均衡混着路由
- 同一模型的**裸名**（`glm-5.3`）是一个路由组：多个厂商都提供它时，按优先级尝试，失败自动降级
- 新服务以**插件形式接入**：从社区市场装一个 npm 包，登录账号，点「注册渠道」，不改一行代码
- **账号额度可见**：每个账号的用量窗口、剩余额度、重置时间、签到、失效原因都在「服务」页
- **Token 级数据看板**：按模型、按 API 密钥统计输入/输出 Token 用量（TPM/请求数/趋势/排行）
- 管理员「功能配置」页：顶栏导航、侧边栏模块、注册/签到/绘图/任务/支付等开关随时启停

> ⚠️ **这不是开箱即用的公共服务**。它是一套自部署框架：你需要自己构建、自己部署，并且接入的是**你自己**的订阅账号（多数厂商需要登录你本人的账号才有可用模型）。

## 仓库结构

```
API-Bridge-Hub/
├── new-api-main/          # 主站：new-api fork（BridgeHub），Go + React
│   ├── pkg/pluginhost/        # 插件宿主：Bun 进程 + OpenCode 插件契约
│   ├── service/pluginreg/     # 插件账号 → 渠道/裸名组/健康/续期/签到
│   └── data/plugin-host/      # 插件与登录凭证（不入库，需自行备份）
├── workbuddy-free-main/   # WorkBuddy 反代（可选，独立运行）
├── Qoder-free-main/       # Qoder 反代（Go + Node worker）※未随仓库分发
├── cline-free-main/       # Cline 反代（Node 零依赖）
├── cmdgo-bridge-main/     # CmdGo 反代（Node/TS）
├── trae-free-master/      # Trae 反代（Python/FastAPI）
└── _branding/             # 品牌 logo 源文件与构建脚本
```

> 各 `*-free-*` 目录是**独立的上游实现**，可以单独跑。主站接入厂商推荐走插件（见下），不再需要这些进程。

## 环境要求

| 组件 | 用途 |
|---|---|
| Go ≥ 1.21 | 构建主站 |
| [Bun](https://bun.sh) ≥ 1.4.2 | 构建前端；**运行时**跑插件宿主 |

Node / Python 只在单独运行各 `*-free-*` 反代时才需要。

## 快速开始

**Windows 一键启动**：双击根目录 `start.bat`——缺失时自动补建前端与二进制，启动主站并打开浏览器（Git Bash / Linux 用 `./start.sh`）。

手动方式如下：

```bash
# 1. 构建前端
cd new-api-main/web
bun install --registry https://registry.npmmirror.com
bun run build

# 2. 构建主站（前端 dist 会 embed 进二进制）
cd ..
go build -o new-api-dev.exe .

# 3. 配置
cp .env.example .env      # 至少设置 PORT（默认 4501），建议自设 SESSION_SECRET

# 4. 启动
./new-api-dev.exe
```

首次访问 `http://localhost:4501` 会进入初始化向导，创建 root 账号。登录后：

- **API 密钥**：创建密钥，页面内置完整连接教程
- **插件**：从社区市场安装 provider 插件（首次会下载 Bun 到 `data/plugin-host/cache/`）
- **服务**：登录账号、看额度、签到
- **功能配置**：按需开关产品模块（注册、签到、绘图、任务、支付、排行榜……）

## 接入厂商

```
「插件」页 → 安装 → 「服务」页登录你的账号 → 「注册渠道」→ 模型出现在 /v1/models
```

一个 provider 注册为**一个渠道**，它的账号作为这个渠道的**多 key**：

```
WorkBuddy (provider=workbuddy)
  └── 渠道 #1  models=workbuddy-auto, workbuddy-glm-5.3, …
        key = workbuddy / workbuddy#2apscn / …   ← 多 key，轮询
```

这么做的原因：new-api 对渠道做优先级/权重/冷却，把账号合成一个渠道的多 key 后，
**单账号被限流只影响那个 key**，其余账号继续服务。需要独立计费/独立限流时，
注册时可以传 `per_account: true` 改成一账号一渠道。

### 模型命名与路由组

| 写法 | 含义 |
|---|---|
| `workbuddy-glm-5.3` | 只走 WorkBuddy |
| `glm-5.3` | 裸名 = 路由组，所有提供该模型的厂商都是成员 |

路由组复用 new-api 的 `ability` 表：按 `priority` 分层，层内按 `weight` 随机，
失败时重试到下一层。所以：

> **裸名的故障转移依赖「系统设置 → 请求策略 → 重试次数」> 0。**
> 默认是 2，一次请求最多再试两家；设为 0 时只会尝试优先级最高的那一家，不会降级。

## 数据看板（Token 统计）

`/token-stats` 提供 Token 维度的统计：总/输入/输出 Token、请求数、用量趋势
（输入/输出堆叠）、按模型与按 API 密钥的分布。数据由消费日志按小时聚合落库
（`quota_data` 表，含 `prompt_tokens`/`completion_tokens` 拆分）。

计费默认关闭（`QuotaBillingEnabled=false`），此页**只呈现 Token，不显示金额**。

## 备份与迁移

以下内容**不在 git 仓库内**，换机重建时需手动备份：

| 内容 | 位置 |
|---|---|
| 主站数据库（账号/渠道/配置/统计） | `new-api-main/one-api.db` |
| 主站环境变量 | `new-api-main/.env` |
| 插件本体、**登录凭证**、模型目录缓存 | `new-api-main/data/plugin-host/` |
| 便携 Bun（可重新下载） | `new-api-main/data/plugin-host/cache/bun/` |

`data/plugin-host/plugin-auth.json` 是**唯一**存放登录凭证的地方——不进数据库、
不进日志、已被 `.gitignore` 排除。

## 安全说明

- 敏感文件（数据库、`.env`、cookies、账号凭据）均已被 `.gitignore` 排除，
  `git add .` 不会误提交——但请勿在生产部署中把站点直接暴露公网后放松警惕
- 自部署请务必：修改 root 默认密码、设置独立 `SESSION_SECRET`、按需在「功能配置」页
  关闭不需要对外暴露的模块
- 安装插件等于在这台机器上执行第三方代码。只装你信任的包。

## 许可证

| 项目 | 许可证 |
|---|---|
| new-api-main（BridgeHub fork） | [AGPL-3.0](new-api-main/LICENSE)（继承上游 QuantumNous/new-api） |
| 插件宿主（`pkg/pluginhost/`） | 移植自 [magpie](https://github.com/yetone/magpie)，MIT |
| workbuddy / cline / cmdgo / trae | 各自 MIT License（版权见各目录 LICENSE 文件） |
| Qoder-free-main | 未随仓库分发（上游无 LICENSE 文件） |

## 免责声明

本项目仅供学习与个人研究使用。各插件依赖第三方平台的账号与接口，使用方式请自行确认
并遵守对应平台的服务条款，由此产生的风险与本项目作者无关。

## 致谢

- [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 与 [songquanpeng/one-api](https://github.com/songquanpeng/one-api) —— 主站基础
- [yetone/magpie](https://github.com/yetone/magpie) —— 插件宿主与 OpenCode 插件契约
- [workbuddy-free](workbuddy-free-main) — Sliverkiss · [cline-free](cline-free-main) — luawei1 · [trae-free](trae-free-master) — autumnsentiment
- [cmdgo-bridge](cmdgo-bridge-main) 由本仓库作者维护
