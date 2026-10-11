# Trae2api-cn 控制台重写与进程内登录 — 实现计划

> **Status: 全部完成。** 复选框由收尾清理时依据
> `.superpowers/sdd/2026-10-09-console-rewrite/progress.md` 的逐任务记录补勾，
> 并非执行过程中实时更新。验收证据：预加载 `tests.conftest` 后全套 779 用例
> 全绿（0 failures / 0 errors）。
>
> 与计划的偏差点（已实现，仅接口位置不同）：Task 3 计划产出
> `console.tokens.PIXEL_CSS`，实际设计令牌直接写在
> `src/console/assets/console.css`，未单独建 `tokens.py`；`console.icons` 与
> `console.assets_path()` 与计划一致。Task 4 的页面片段也由 `repr()` 字符串
> 改为 `src/console/pages/*.html` 实体文件。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把控制台的账号登录从"下载脚本手动运行"改为"前端点击即启动"，并按 workbuddy-free 的 PIXEL OPS 视觉重做为六页控制台。

**Architecture:** 把 `main.py` 内嵌的 ~3,100 行 UI 拆成 `src/console/` 包（服务端渲染视图片段 + 独立静态 `app.js`/`console.css`），并新增两个子系统：`src/logbuf.py`（日志环形缓冲）与 `src/web_auth.py`（进程内 OAuth 回调监听器，由 FastAPI `lifespan` 启停）。被 `patch("src.main.X")` 覆盖的反代核心函数一律留在 `main.py`。

**Tech Stack:** Python 3.14 / FastAPI / uvicorn / httpx / asyncio；前端为无构建步骤的原生 HTML/CSS/JS（无 npm、无 CDN、无图表库）。

**Spec:** `docs/superpowers/specs/2026-10-09-console-rewrite-inprocess-login-design.md`

## Global Constraints

- 反代核心行为一行不改：dispatch / checkin / usage / `run_*` 等被 `patch("src.main.X")` 的函数必须继续定义在 `src.main` 命名空间下。
- 测试基线（`python -m unittest discover -s tests -t . -q`）：**705 tests，36 failures + 4 errors**，明细见 `docs/superpowers/baseline-tests.txt`。验收口径：重写后失败集合必须是该基线的**子集**。
- 登录监听器固定绑定 `127.0.0.1`，端口 `WEB_LOGIN_LISTENER_PORT`（默认 8765）。不做 Docker/Compose/镜像改动。
- 前端不引入构建步骤、外部 CDN、图表库、内嵌字体。
- 控制台不得再出现任何脚本下载入口（`web_login.py` / `start_auth.bat` / `/web/login/download` 链接）。
- 保留全部既有元素 ID 与 JS 函数名（124 IDs / 84 functions / 32 markup handlers），新增项只增不改。
- 六页导航：概览 / 账号池 / 用量统计 / 运行日志 / 模型与档位 / 配置。

## Review Focus

以下五类输入/失效模式是 spec 隐含但任务测试未直接覆盖、且最可能真正伤到使用者的，各自在其归属任务中钉上测试：

1. **监听器端口被占用**：8765 已被占用时，服务必须继续可用（登录降级但反代不受影响），而不是崩溃或静默失效。
2. **回调 state 不匹配/未登记/过期**：伪造或过期的 state 回调必须被拒绝，不得写入任何凭证（安全边界）。
3. **日志高频写入**：日志洪水下环形缓冲必须有界且不阻塞请求线程，`/api/logs` 仍可及时响应。
4. **JS 语法有效性**：服务出去的 `app.js` 必须能被 JS 引擎解析（无残留 f-string 双花括号或转义损坏）——否则整个控制台白屏。
5. **空/首次运行状态**：无账号、无消费记录、无日志时，六个页面都必须渲染出可读的空态而不是报错。

---

### Task 1: 日志环形缓冲子系统 `src/logbuf.py`

**Files:**
- Create: `src/logbuf.py`
- Test: `tests/test_logbuf.py`

**Interfaces:**
- Consumes: 无（全新模块）。
- Produces:
  - `CHAT = "chat"`、`TASK = "task"`、`SYS = "sys"`
  - `classify_line(line: str) -> str`
  - `class LogEntry`（dataclass：ts: float、ch: str、text: str）
  - `class LogRing(capacity: int = 500)`：write(line) / snapshot() / clear()；线程安全
  - `class RingLogHandler(logging.Handler)`：构造接收 (ring, level=NOTSET)，emit 写入 self.format(record)
  - `install_ring_handler(logger, capacity=500) -> LogRing`：挂载并返回 ring，幂等

- [x] **Step 1: 写失败测试** `tests/test_logbuf.py`

覆盖：频道分类（`"| #"` → chat；`"checkin ..."` → task；其余 → sys）、容量 FIFO 淘汰（容量 3 写 5 条只剩后 3 条）、时间戳前缀剥离、并发多线程写后总数有界、RingLogHandler 经 logging.Logger 真的写入 ring、install_ring_handler 幂等。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_logbuf -v` — Expected: FAIL，ModuleNotFoundError: No module named 'src.logbuf'

- [x] **Step 3: 实现 `src/logbuf.py`

单 threading.Lock 保护 collections.deque(maxlen=capacity)。频道前缀表对齐 workbuddy ring.go 的 taskPrefixes 口径。install_ring_handler 用实例属性标记避免重复挂载。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_logbuf -v` — Expected: PASS

- [x] **Step 5: 提交**

    git add src/logbuf.py tests/test_logbuf.py
    git commit -m "feat(logbuf): add bounded in-process log ring with channel classification"

---

### Task 2: 进程内 OAuth 回调监听器 `src/web_auth.py`

**Files:**
- Create: `src/web_auth.py`
- Test: `tests/test_web_auth.py`

**Interfaces:**
- Consumes: `src.main._parse_oauth_params(query: dict) -> dict`（async）、`src.auth.add_account(creds, label="") -> str`
- Produces:
  - `class LoginRegistry`：register(state)、consume(state) -> bool（一次性）、prune(now=None) -> int
  - `build_auth_url(state, *, client_id, auth_url, listener_port) -> str`
  - `class AuthCallbackServer`：async start() -> bool、async stop()、running、port、last_error
  - `get_registry() -> LoginRegistry`

- [x] **Step 1: 写失败测试** `tests/test_web_auth.py`

覆盖：build_auth_url 用 urllib.parse 解析断言 auth_callback_url=http://127.0.0.1:<port>/authorize、client_id、login_trace_id=<state>；LoginRegistry.consume 一次性语义与 prune 过期回收；**安全边界**：未登记 / 重复 / 过期 state 一律拒绝且不调用 add_account；端口被占用时 start() 返回 False、last_error 非空、不抛异常。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_web_auth -v` — Expected: FAIL，ModuleNotFoundError

- [x] **Step 3: 实现 `src/web_auth.py`

用 asyncio.start_server 手写最小 HTTP/1.1 响应（不新增依赖）。路由 /healthz、/relay-url、/authorize。回调先 registry.consume(state) 校验，再 await _parse_oauth_params(...)，然后 auth.add_account(...)；成功与否都返回可读 HTML 并 postMessage 给 opener。端口占用捕获 OSError 记 last_error 返回 False。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_web_auth -v` — Expected: PASS

- [x] **Step 5: 提交**

    git add src/web_auth.py tests/test_web_auth.py
    git commit -m "feat(web-auth): in-process OAuth callback listener with state nonce"

---

### Task 3: console 包骨架 — 设计令牌、图标、静态资源路由

**Files:**
- Create: `src/console/__init__.py`、`src/console/tokens.py`、`src/console/icons.py`、`src/console/assets/console.css`、`src/console/assets/app.js`
- Modify: `src/main.py`（新增 GET /console/console.css、GET /console/app.js；_icon 委托 console.icons）
- Test: `tests/test_console_assets.py`

**Interfaces:**
- Produces: `console.tokens.PIXEL_CSS: str`（含 [data-theme="light"] 覆盖）；`console.icons.icon(name) -> str`、`console.icons.ICONS`、`console.icons.LOGO_SVG`；`console.assets_path() -> Path`

- [x] **Step 1: 写失败测试** `tests/test_console_assets.py`

覆盖：两个静态路由均 200 且 content-type 正确；CSS 含 --accent、[data-theme="light"]、--shadow、网格/扫描线规则；**JS 语法有效性（Review Focus 4）**：写到临时文件跑 node --check，非 0 退出即失败（node 缺失则 skipTest）；main._icon("users") 与 console.icons.icon("users") 一致。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_console_assets -v` — Expected: FAIL（路由 404）

- [x] **Step 3: 实现**

icons.py 从 main.py 的 _LUCIDE_ICONS 原样搬移（值不变；test_logo.py 依赖 main.LOGO_SVG，故 main 保留转发）。tokens.py 写 PIXEL OPS 令牌。app.js 本步先放最小占位（Task 5 填充）。main.py 用 FileResponse 提供静态资源。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_console_assets -v` — Expected: PASS

- [x] **Step 5: 提交**

    git add src/console src/main.py tests/test_console_assets.py
    git commit -m "feat(console): add design tokens, icons, and static asset routes"

---

### Task 4: console 外壳与六个视图片段

**Files:**
- Create: `src/console/views.py`、`src/console/page.py`
- Modify: `src/main.py`（_web_login_html() 委托 console.page.render_console）
- Test: `tests/test_console_page.py`

**Interfaces:**
- Consumes: Task 3 的 tokens.PIXEL_CSS、icons.*。
- Produces: `console.page.render_console(**state) -> str`，state 键与现 _web_login_html 局部变量同名同义。

- [x] **Step 1: 写失败测试** `tests/test_console_page.py`

覆盖：六页 data-page 全存在且顺序 overview/accounts/usage/logs/models/settings；data-tab="overview" 在 data-tab="accounts" 之前；124 个既有 ID 全在；**空态（Review Focus 5）**：accounts=[] 且无记录无日志时渲染成功、六页均有可读空态；**无下载入口**断言。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_console_page -v` — Expected: FAIL（render_console 未定义）

- [x] **Step 3: 实现 views.py + page.py**

把原 _web_login_html 的 HTML 按页拆函数；外壳换成 workbuddy 的 shell/nav/main 结构；保留全部 ID 与 onclick/onchange 函数名。page.py 注入 window.__CONSOLE__（listener_port、client_id、auth_url、version）替代原 f-string 插值。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_console_page -v` — Expected: PASS

- [x] **Step 5: 提交**

    git add src/console/views.py src/console/page.py src/main.py tests/test_console_page.py
    git commit -m "feat(console): server-rendered six-page shell preserving legacy DOM contract"

---

### Task 5: 前端 app.js — 迁移逻辑、去 f-string 转义、新增日志与登录

**Files:**
- Modify: `src/console/assets/app.js`
- Test: `tests/test_console_assets.py`（扩展）

**Interfaces:**
- Consumes: Task 4 注入的 window.__CONSOLE__。
- Produces: 84 个既有全局函数名保持；新增 loadLogs()、setLogChannel()、toggleLogFollow()、startWebLogin()、pollWebLoginStatus()。

- [x] **Step 1: 写失败测试**

扩展 test_console_assets.py：app.js 含 requestJSON、usageRecordsFromPayload、raw.split(/[\n,]+/)、refreshModels、saveAutoRoute、markPollingDirty；含新增 loadLogs、startWebLogin；**不含** 双花括号 `{{"` 或 `"}}`（残留 f-string 转义）；node --check 通过。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_console_assets -v` — Expected: FAIL

- [x] **Step 3: 迁移与新增**

把 main.py 内嵌 JS 移入 app.js：把 {{ / }} 还原为 { / }，把 Python 插值改为读 window.__CONSOLE__。保留全部 84 个函数名。新增运行日志页逻辑（频道筛选、自动跟随、暂停）与 startWebLogin（POST /api/web-login/state → window.open → 轮询 status）。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_console_assets -v` — Expected: PASS

- [x] **Step 5: 提交**

    git add src/console/assets/app.js tests/test_console_assets.py
    git commit -m "feat(console): port console JS to static asset and add logs + web-login UI"

---

### Task 6: 装配 — lifespan 启停监听器、/api/logs、/api/web-login/*

**Files:**
- Modify: `src/main.py`
- Test: `tests/test_main_smoke.py`（扩展）

**Interfaces:**
- Consumes: Task 1 logbuf.install_ring_handler、Task 2 web_auth.*。
- Produces: GET /api/logs?limit=&channel= → {entries:[{ts,ch,text}]}；GET /api/web-login/status → {listener_running,port,last_error}；POST /api/web-login/state → {state,url}。

- [x] **Step 1: 写失败测试**

覆盖：/api/logs 契约与 channel/limit 过滤；**Review Focus 1**：监听器未启动时 /api/web-login/status 仍 200 且 listener_running=false；POST /api/web-login/state 返回 URL 含 127.0.0.1。三个新路径加入 PUBLIC_PATHS。

- [x] **Step 2: 运行测试确认失败**

Run: `python -m unittest tests.test_main_smoke -v` — Expected: FAIL（404）

- [x] **Step 3: 实现**

lifespan 中 await web_auth_server.start()，finally 中 await stop()；启动失败只记 warning 不抛出。init_app 里 install_ring_handler(logger)。新增三个路由。

- [x] **Step 4: 运行测试确认通过**

Run: `python -m unittest tests.test_main_smoke -v` — Expected: 与基线相比无新增失败

- [x] **Step 5: 提交**

    git add src/main.py tests/test_main_smoke.py
    git commit -m "feat(console): wire log ring and in-process login into app lifespan"

---

### Task 7: 更新 7 个测试文件的 DOM 断言

**Files:**
- Modify: tests/test_main_smoke.py、tests/test_issue6_settings.py、tests/test_max_mode_settings.py、tests/test_usage_overview.py、tests/test_auto_checkin.py、tests/test_auto_route.py、tests/test_logo.py

- [x] **Step 1: 逐文件更新选择器**

只改选择器/结构匹配，**保留每条断言的原检查意图**。test_rendered_console_keeps_javascript_newline_escapes 是唯一意图变更：改为 ① /console/app.js 含原有关键构造，② node --check 通过（spec 已记录）。

- [x] **Step 2: 运行这 7 个文件**

Run: `python -m unittest tests.test_main_smoke tests.test_issue6_settings tests.test_max_mode_settings tests.test_usage_overview tests.test_auto_checkin tests.test_auto_route tests.test_logo -v` — Expected: 无新增失败

- [x] **Step 3: 提交**

    git add tests/
    git commit -m "test: align console DOM assertions with the rebuilt six-page shell"

---

### Task 8: 端到端验证与基线对比

- [x] **Step 1: 全量测试**

Run: `python -m unittest discover -s tests -t . -q` — Expected: 失败集合 ⊆ 基线

- [x] **Step 2: 起服务实测登录链路**

起 uvicorn → GET /web/login 200 → GET /api/web-login/status 显示 listener_running=true → POST /api/web-login/state 取 state 与 URL → 带该 state 请求 http://127.0.0.1:8765/authorize?... → 断言账号写入 data/accounts.json；再用未登记 state 重放，断言被拒绝且库未变。

- [x] **Step 3: 提交**

    git add -A
    git commit -m "test: end-to-end verification of in-process login flow"
