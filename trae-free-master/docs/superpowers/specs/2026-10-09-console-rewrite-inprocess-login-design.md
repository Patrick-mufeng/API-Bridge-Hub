# Trae2api-cn 控制台重写与进程内登录子系统 — 设计文档

日期：2026-10-09
状态：待评审

## 1. 目标

把 Trae2api-cn 的账号登录从「下载脚本手动运行」改为「前端点击即启动、按流程完成登录」，
并把控制台前端按 workbuddy-free 的视觉与信息架构重做，补齐缺失功能页。

### 明确的成功标准

1. 用户在控制台点击「授权登录」后，**全程不需要下载或手动运行任何脚本**即可完成 Trae 授权并把凭证写入 relay。
2. 控制台为六页导航：概览 / 账号池 / 用量统计 / 运行日志 / 模型与档位 / 配置，视觉与 workbuddy-free 的 PIXEL OPS 语言一致，支持明暗切换。
3. 反代核心行为（流式/非流式、工具调用、thinking 分离、思考强度、多账号轮询、签到、积分记录、端点切换、自动路由、Max 模式）**一行不改地保留并继续通过测试**。
4. 测试相较基线**不新增任何失败**。

## 2. 已确认的决策

| 项 | 决定 |
|---|---|
| 部署形态 | 假设 relay 与浏览器**同一台电脑**（本机直跑 / 本机 Docker）。不做 Docker 相关改动。 |
| 登录监听器绑定 | 固定绑定 `127.0.0.1`，端口由 `WEB_LOGIN_LISTENER_PORT` 控制（默认 8765）。不引入 `0.0.0.0` 绑定。 |
| 后端改动深度 | 保留全部反代逻辑，重构结构 + 新增登录与日志子系统。`main.py` 保留所有被 `patch("src.main.X")` 的函数名。 |
| 前端范围 | 全部对齐并新增六页。 |
| 视觉 | 完全照搬 workbuddy-free 的像素风 + 明暗切换。 |
| 代码位置 | 工作目录 `C:\work_file\trae-free`（原项目原样保留在 Downloads）。 |
| DOM 断言测试 | 允许更新（仅改选择器，不改测试意图）。 |

## 3. 现状与硬约束

### 3.1 现状

- `src/main.py` 单文件 **9,618 行**。控制台内嵌其中：CSS 约 348–1443 行，HTML/JS 约 1444–3470 行，合计约 3,100 行。
- 登录流程（要废弃的主路径）：`/web/login` 页面先探测 `127.0.0.1:8765/healthz`；探测不到就让用户**下载** `web_login.py` 或 `start_auth.bat`，手动双击运行；该脚本自行监听回调并把凭证 `POST /api/web-auth` 回服务器。
- `/api/web-auth` 与 `/authorize` **不校验任何 state**，任何能访问该端点者都可注入凭证。

### 3.2 硬约束

**约束 A — 测试补丁目标必须留在 `main.py`。**
现有测试大量使用 `patch("src.main.X")`，覆盖 dispatch、checkin、usage、`run_*` 等核心函数。
因此这些函数**必须继续定义在 `src.main` 模块命名空间下**，否则补丁打不中，测试会成片失败。
只允许迁出：UI 字符串/图标/CSS（无测试 patch 它们）与两个新增子系统。

**约束 B — 测试基线。**
重写前基线（工作区副本，命令 `python -m unittest discover -s tests -t . -q`）：

- **Ran 705 tests，36 failures + 4 errors**（38 个唯一用例名，含 subTest 变体）。
- 性质：CLI 子进程与模型探针的环境性问题，与本次重写无关。
- 明细存档：`docs/superpowers/baseline-tests.txt`。
- 验收口径：重写后失败集合必须是该基线的**子集**。

**约束 C — DOM 断言耦合。**
28 行断言分布在 7 个测试文件，写死了当前 DOM 结构：
`test_main_smoke.py`(10)、`test_issue6_settings.py`(9)、`test_max_mode_settings.py`(3)、
`test_usage_overview.py`(3)、`test_auto_checkin.py`(1)、`test_auto_route.py`(1)、`test_logo.py`(1)。
这些断言必须随新前端更新，但**测试意图必须保留**（例如"设置页有自动签到开关"改的是选择器，不是"要检查的东西"）。

## 4. 架构

### 4.1 模块划分

```
src/
  main.py            反代核心 + 装配。保留所有被 patch 的函数名。
                     _web_login_html() 保留为委托给 console.page 的薄壳（测试兼容）。
  console/
    __init__.py
    tokens.py        PIXEL OPS 设计令牌 CSS（深/浅两套）
    icons.py         内联 SVG 图标集 + 品牌 logo
    views.py         六个视图片段的渲染函数
    page.py          render_console(**state) -> str，组装外壳并注入初始状态
  web_auth.py        进程内浏览器 OAuth 回调监听器（新增）
  logbuf.py          日志环形缓冲 + logging.Handler + 频道分类（新增）

src/console/assets/  前端静态资源（新，随包发布）
  app.js             控制台交互逻辑，经 GET /console/app.js 提供
  console.css        样式，经 GET /console/console.css 提供
```

**关于前端资源的取舍**：外壳与六个视图片段由 **Python 服务端渲染**（保留现有对 `data-page`、
`id="ov-chart"`、`<th>思考强度</th>` 等结构的断言，只改选择器不改意图），而 **JS 与 CSS 是真正的静态资源文件**，
由 `GET /console/app.js`、`GET /console/console.css` 提供，**不再内联进 Python f-string**。

理由：现有 JS 被嵌在 `_web_login_html()` 这个 f-string 里，所有花括号都要写成 `{{` `}}`，
反斜杠还要二次转义——`test_rendered_console_keeps_javascript_newline_escapes` 正是为这个转义陷阱写的回归测试。
把 JS/CSS 移出 f-string 会**整类消灭**该缺陷，而不是绕过它。

### 4.2 登录子系统（核心改动）

`src/web_auth.py` 在 **relay 自身进程内**起一个 asyncio HTTP 监听器，由 FastAPI `lifespan` 启停。

端点（与旧脚本同口径，便于兼容）：

- `GET /healthz` → `{"status":"ok","relay":...,"port":...}`
- `GET /relay-url` → `{"relay": ...}`
- `GET /authorize?...` → 接收 Trae 授权回调

**流程**：

1. 前端点「授权登录」→ `GET /api/web-login/status` 取 `{listener_running, port, auth_url, client_id}`。
2. 前端生成 `state` nonce，调 `POST /api/web-login/state` 在 relay 侧登记；relay 返回组装好的授权 URL。
3. 前端 `window.open` 授权 URL。
4. 用户在 Trae 页完成授权 → 浏览器跳到 `http://127.0.0.1:<port>/authorize?...` → **打到 relay 自己的监听器**。
5. 监听器校验 `state` 与 relay 侧登记一致 → 解析凭证（必要时走 `oauth/ExchangeToken`）→ **进程内直接调用 `auth.add_account()`**（不再跨进程 POST）。
6. 回调页通过 `postMessage` 通知 opener 并自动关闭；前端刷新账号列表。

**复用而非重写**：回调参数解析与 refresh token 兑换直接复用 `main._parse_oauth_params` / `main._exchange_refresh_token` 与 `auth.apply_oauth_callback`，保证与现有 `/authorize` 行为一致。

**保留旧路径**：`/authorize`、`/api/web-auth`、`/web/login/download` 路由保留（远程/脚本场景仍可用），但控制台**不再暴露下载入口**，且不再是主路径。

**安全加固**：新增 `state` nonce 校验。监听器只接受 state 已被 relay 登记且未过期的回调，堵住"任意人 POST 即可注入凭证"的口子。

### 4.3 日志子系统（新增）

`src/logbuf.py`：容量可配（默认 500）的环形缓冲，作为 `logging.Handler` 挂到 `trae-cn-relay` logger。

- 按行首前缀分频道：`chat`（`| #` 开头的每请求表格行）/ `task`（签到、轮询、任务动作）/ `sys`（其余）。
- 时间戳解析、FIFO 淘汰、并发安全，与 workbuddy `ring.go` 语义对齐。
- 新端点 `GET /api/logs?limit=&channel=` 返回 `{entries:[{ts,ch,text}]}`。

### 4.4 前端（PIXEL OPS）

六页导航，视觉照搬 workbuddy-free：

- 深色 `--bg:#0b0e14` + 青色 `--accent:#2ad4e8`、2px 描边、**硬投影**（位移块非模糊）、网格底纹 + CRT 扫描线、全等宽字体、`tabular-nums`。
- 明暗切换：`[data-theme]` + localStorage，首访跟随系统；浅色下关闭扫描线。
- 状态用**色块**而非圆点；账号池 = 统计条 + 表格（积分量条、成功/失败、在途、单号操作、批量操作）。
- 概览：柱状趋势图（纯 CSS/DOM 绘制，**不引入图表库**）+ 按日期汇总表。
- 保留现有全部功能入口与 ID/函数契约（`markPollingDirty()`、`saveAutoRoute()`、`conn-mode-tool`、`refreshModels()`、`getElementById('ov-chart')` 等），把测试改动压到最小。
- 新增：运行日志页（频道筛选 chips + 自动跟随 + 暂停）、登录状态实时探测。

## 5. 数据流

```
账号登录：
  控制台 → POST /api/web-login/state → relay 登记 state，返回授权 URL
        → window.open(authUrl) → 用户在 Trae 授权
        → 浏览器回调 127.0.0.1:8765/authorize → web_auth 监听器
        → 校验 state → _parse_oauth_params → auth.add_account() → 落 data/accounts.json
        → 回调页 postMessage → 控制台刷新账号列表

日志：
  logging → logbuf.Handler → 环形缓冲 → GET /api/logs → 控制台日志页（频道筛选）
```

## 6. 错误处理

- 监听器端口被占用：记录警告并继续运行服务，`/api/web-login/status` 返回 `listener_running:false` 与原因，前端给出可读提示（而非静默失败）。
- 回调 state 不匹配/过期：拒绝写入，回调页显示明确错误。
- 凭证解析失败（无 token）：与现有 `/authorize` 一致，返回错误页，不写库。
- 上游 `ExchangeToken` 失败：记录 warning 并返回失败页。
- 日志缓冲：永不阻塞请求线程（丢弃而非阻塞）。

## 7. 测试策略

1. **基线保护**：重写前存档基线；每阶段跑全量测试，失败集合必须是基线子集。
2. **更新 DOM 断言**：7 个文件约 28 行，只改选择器/结构匹配，保留原检查意图。
   唯一的**意图变更**：`test_rendered_console_keeps_javascript_newline_escapes` 原本断言"内联 JS 没被 f-string 转义破坏"。
   JS 移出 f-string 后该风险不复存在，因此该测试改为：
   (a) `GET /console/app.js` 能取到且包含原有的关键构造（`requestJSON`、`usageRecordsFromPayload`、
   `raw.split(/[\n,]+/)` 等）；(b) 新增更强的检查——用 `node --check` 验证服务出去的 JS **能通过语法解析**
   （node 缺失时 `skipTest`）。这是加强而非削弱。
3. **新增测试**：
   - `web_auth` 监听器启停、端口、`state` 校验（含拒绝未登记 state）。
   - OAuth 回调参数解析（复用 `_parse_oauth_params`）。
   - `logbuf` 频道分类、容量淘汰、并发写入、`/api/logs` 契约。
   - **回归断言：控制台 HTML 不含任何脚本下载入口**（`web_login.py` / `start_auth.bat` / `/web/login/download` 链接）。
4. **端到端手工验证**：起服务 → `GET /web/login` 200 → `/api/web-login/status` 显示监听器在跑 → 模拟 Trae 回调打 `127.0.0.1:8765/authorize`（带合法 state）→ 断言账号落库。

## 8. 非目标

- 不做 Docker/Compose/镜像相关改动。
- 不改反代协议、上游端点、工具调用、thinking、思考强度等核心行为。
- 不修基线里已有的 36F+4E（CLI 子进程与模型探针环境问题）。
- 不引入前端构建步骤（无 npm/vite）。
- 不引入外部 CDN 或图表库（内网可用）。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 拆分 `main.py` 时误移被 patch 的函数 → 测试成片失败 | 用基线对比逐阶段验证；被 patch 的函数一律留在 main.py |
| 端口 8765 被占用 | 明确降级路径与前端提示，不使服务崩溃 |
| 监听器绑定 127.0.0.1 在"浏览器与 relay 不同机"时不可用 | 已确认目标部署为同机；旧脚本路径保留作为回退 |
| 前端重写导致大量 DOM 断言失败 | 刻意保留现有 ID/函数契约；测试改动限定在选择器层 |
