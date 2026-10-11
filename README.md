# BridgeHub — 个人 AI API 中转枢纽

> 一个 OpenAI 兼容端点，直达所有模型服务。
> 基于 [new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0）深度定制，把多个免费/自建反代服务以**热插拔 manifest** 的形式聚合为统一渠道。

## 它解决什么问题

手头有多个免费模型反代服务（每个都有自己的端口、协议、密钥、账号池），在客户端里来回切换非常麻烦。BridgeHub 把它们聚合成**一个** OpenAI 兼容接口：

```
                       ┌─ WorkBuddy   (wb: …)
                       ├─ Qoder       (qd: …)
客户端 ──►  BridgeHub  ├─ Cline       (cl: …)
        /v1/chat/…     ├─ OpenCodeZ   (ocz: …)
                       ├─ Trae        (tr: …)
                       └─ CmdGo       (cg: …)
```

- **一个密钥、一个 Base URL**，所有渠道的模型全部可达
- 每个渠道的模型带**前缀**（`wb:`、`qd:` …），想走哪路上游就指定哪路，不会被负载均衡混着路由
- 新服务以**插件形式接入**：往 `data/reverse-proxy/services/` 丢一份 manifest JSON，管理页点一下「重新加载清单 → 注册渠道」即可，不改一行代码
- 内嵌**反代管理面板**：同源反向代理 + iframe 集成，密钥自动注入，启动/停止/日志/账号登录全在主站里完成
- **Token 级数据看板**：按模型、按 API 密钥统计输入/输出 Token 用量（TPM/请求数/趋势/排行）
- 管理员「功能配置」页：顶栏导航、侧边栏模块、注册/签到/绘图/任务/支付等开关随时启停

> ⚠️ **这不是开箱即用的公共服务**。它是一套自部署框架：你需要自己构建、自己部署，并且接入的是**你自己**的反代服务与账号（多数免费反代需要登录你本人的上游账号才有可用模型）。

## 仓库结构

```
API-Bridge-Hub/
├── new-api-main/          # 主站：new-api fork（BridgeHub），Go + React
│   └── data/reverse-proxy/    # manifest 与运行日志（不入库，需自行备份）
├── workbuddy-free-main/   # WorkBuddy 反代（Go，账号池 + 签到）
├── Qoder-free-main/       # Qoder 反代（Go + Node worker）※未随仓库分发，见下文
├── cline-free-main/       # Cline 反代（Node 零依赖）
├── cmdgo-bridge-main/     # CmdGo 反代（Node/TS）
├── opencodez-free-main/   # OpenCodeZ 反代（Node 原生 TS，免账号）
├── trae-free-master/      # Trae 反代（Python/FastAPI）
└── _branding/             # 品牌 logo 源文件与构建脚本
```

## 环境要求

| 组件 | 用途 |
|---|---|
| Go ≥ 1.21 | 构建 new-api 主站与 workbuddy/qoder 反代 |
| [Bun](https://bun.sh) | 构建主站前端 |
| Node ≥ 20 | cline / cmdgo / opencodez 反代 |
| Python ≥ 3.10 | trae 反代 |

## 快速开始（主站）

**Windows 一键启动**：双击根目录 `start.bat`——缺失时自动补建前端与二进制，启动主站并打开浏览器，已启用的反代服务随主站自动拉起（Git Bash / Linux 用 `./start.sh`）。

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
cp .env.example .env      # 至少设置 PORT（默认 3000），建议自设 SESSION_SECRET

# 4. 启动
./new-api-dev.exe
```

首次访问 `http://localhost:3000` 会进入初始化向导，创建 root 账号。登录后：

- **渠道管理**：接入各反代渠道（或由反代服务面板一键注册）
- **反代服务**：manifest 热插拔管理（加载清单 / 启停 / 注册渠道 / 打开面板 / 日志）
- **功能配置**：按需开关产品模块（注册、签到、绘图、任务、支付、排行榜……）
- **API 密钥**：创建密钥，页面内置完整连接教程

## 接入反代服务

各服务需按其自身 README 完成首次构建与账号登录：

| 服务 | 语言 | 构建 | 账号 |
|---|---|---|---|
| workbuddy | Go | manifest 自动构建（`go build ./cmd/server`） | 面板内登录 |
| cline | Node | 无需构建（`node local-server.js`） | 面板内登录 |
| opencodez | Node | 无需构建（`node src/index.ts`） | **免账号** |
| cmdgo | Node/TS | `npm install && npm run build` | 面板内 OAuth |
| trae | Python | `pip install -r requirements.txt` | Web 页面登录 |
| Qoder | Go+Node | `npm ci --prefix worker && go build` | 面板内登录 |

> ※ **Qoder-free-main 未随本仓库分发**：上游未附带 LICENSE 文件。如需使用请自行获取源码，放入本目录即可。

服务跑起来后，在「反代服务」面板点「注册渠道」，主站会自动读取其 `/v1/models` 并以渠道前缀注册（需该服务已有可用模型——多数免费反代要先登录账号）。

manifest 中 `enabled: true` 的服务会在**主站启动时自动拉起**（首次会按 manifest 的 `build` 段自动编译），也可随时在面板手动启停；不想自动启动的服务把 `enabled` 改为 `false` 即可。

## Manifest 格式（热插拔的核心）

每个服务一份 JSON，放入 `new-api-main/data/reverse-proxy/services/`，完整字段示例：

```jsonc
{
  "id": "cline",                       // 唯一 ID
  "name": "Cline Free",                // 显示名
  "description": "…",                  // 描述
  "enabled": true,
  "workdir": "cline-free-main",        // 相对 new-api-main 的工作目录
  "build": {                           // 可选：启动前自动构建
    "command": "go",
    "args": ["build", "-o", "wb2api.exe", "./cmd/server"],
    "skip_if_exists": "wb2api.exe"
  },
  "start": { "command": "node", "args": ["local-server.js"] },
  "port": 8972,                        // 本地监听端口
  "health_path": "/v1/health",         // 健康检查路径（各服务不同）
  "panel": {                           // 内嵌面板（同源反向代理 + iframe）
    "path": "/",                       // 面板根路径
    "rewrite_prefixes": ["/v1/"],      // 根路径面板需显式声明要代理的前缀
    "strip_frame_headers": true,       // 去除 X-Frame-Options 等以便 iframe
    "inject_key": true,                // 向面板注入 API 密钥
    "inject_key_script": true,
    "key_script_global": "__CLINE2API__"
  },
  "key_source": {                      // 渠道密钥从哪读
    "type": "env",                     // env | json | file
    "path": ".env.local",
    "field": "API_KEY"
  },
  "channel": {                         // 注册为 new-api 渠道的参数
    "name": "Cline（反代）",
    "tag": "reverse-proxy:cline",
    "group": "default",
    "model_prefix": "cl:",             // 模型前缀：消费时自动回写为上游原名
    "priority": 6
  },
  "env": { "PORT": "8972", "HOST": "127.0.0.1" }   // 注入子进程的环境变量
}
```

面板形态兼容三种：子目录面板（`/panel/`）、根路径面板（用 `rewrite_prefixes` 声明前缀）、具名路由面板（如 trae 的 `/web/login`）。

## 数据看板（Token 统计）

`/dashboard/models` 提供 Token 维度的完整统计：总/输入/输出 Token、平均 TPM、请求数、Token 用量趋势（输入/输出堆叠）、按模型与按 API 密钥的分布排行。数据由消费日志按小时聚合落库（`quota_data` 表，含 `prompt_tokens`/`completion_tokens` 拆分）。

## 备份与迁移

以下内容**不在 git 仓库内**，换机重建时需手动备份：

| 内容 | 位置 |
|---|---|
| 主站数据库（账号/渠道/配置/统计） | `new-api-main/one-api.db` |
| 主站环境变量 | `new-api-main/.env` |
| 渠道 manifest | `new-api-main/data/reverse-proxy/services/` |
| 各反代账号凭据与状态 | `workbuddy-free-main/{auths,data}`、`~/.cline-free-state.local.json`、`~/.cmdgo-bridge/`、`~/.opencodez-free/` 等 |

## 安全说明

- 敏感文件（数据库、`.env`、cookies、账号凭据、渠道 manifest）均已被 `.gitignore` 排除，`git add .` 不会误提交——但请勿在生产部署中把站点直接暴露公网后放松警惕
- 自部署请务必：修改 root 默认密码、设置独立 `SESSION_SECRET`、按需在「功能配置」页关闭不需要对外暴露的模块
- 各 `.env.example` / `config.example.json` 是模板，真实配置文件不入库

## 许可证

| 项目 | 许可证 |
|---|---|
| new-api-main（BridgeHub fork） | [AGPL-3.0](new-api-main/LICENSE)（继承上游 QuantumNous/new-api） |
| workbuddy / cline / cmdgo / opencodez / trae | 各自 MIT License（版权见各目录 LICENSE 文件） |
| Qoder-free-main | 未随仓库分发（上游无 LICENSE 文件） |

## 免责声明

本项目仅供学习与个人研究使用。各反代服务依赖第三方平台的账号与接口，使用方式请自行确认并遵守对应平台的服务条款，由此产生的风险与本项目作者无关。

## 致谢

- [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 与 [songquanpeng/one-api](https://github.com/songquanpeng/one-api) —— 主站基础
- [workbuddy-free](workbuddy-free-main) — Sliverkiss · [cline-free](cline-free-main) — luawei1 · [trae-free](trae-free-master) — autumnsentiment
- [cmdgo-bridge](cmdgo-bridge-main) 与 [opencodez-free](opencodez-free-main) 由本仓库作者维护
