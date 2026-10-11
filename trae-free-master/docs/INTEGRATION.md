# trae-free 接入说明

> 本文档基于本机实测生成，所有示例均已跑通。
> 服务地址：`http://127.0.0.1:8015`，认证方式 `web-login`，上游端点 `remote`。

## 一、连接信息

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8015/v1` |
| API Key | `your-master-key`（在 .env 的 RELAY_API_KEYS 中，**建议改掉**） |
| 协议 | OpenAI Chat Completions + Responses |
| 流式 | 支持 SSE，带 1 秒心跳注释帧 |
| 鉴权 | `Authorization: Bearer <key>`，推理端点缺失/错误返回 **401** |

> `GET /v1/models` 对内网地址免鉴权，推理端点（`/v1/chat/completions`、`/v1/responses`）强制鉴权。

## 二、可用端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型列表（26 个，见下） |
| POST | `/v1/chat/completions` | 标准 Chat Completions，流式/非流式 |
| POST | `/v1/responses` | OpenAI Responses API，Codex 用这个 |
| POST | `/v1/chat`、`POST /v1` | 兼容别名 |
| GET | `/v1/status` | 运行状态、能力位、当前端点 |
| GET | `/healthz` | 存活探针 |
| GET | `/web/login` | 网页控制台 |

## 三、模型

实测可用（用明确模型名，**不要用 auto**）：

| 用途 | 推荐模型 |
|---|---|
| 通用 / 工具调用 | `glm-5.3`、`glm-5.2`、`glm-5.3-flash` |
| 代码 | `deepseek-v4-pro`、`deepseek-v4.1-flash`、`doubao-seed-code`、`kimi-k2.7-code` |
| 快速 / 便宜 | `deepseek-v4-flash`、`glm-5.3-flashx`、`doubao-seed-2.1-turbo` |
| 其他 | `kimi-k3`、`qwen3.8-max`、`minimax-m3`、`step-5-preview`、`mimo-v2.6-pro`、`longcat-2.0` |

> ⚠️ **`model: "auto"` 会失败**：上游把它分配到 `Doubao-Seed-2.1-Turbo__dev`，对当前账号不可用，
> 返回 502 或流内 error：`Trae selected provider model ... for requested model 'auto'`。
> 完整列表以 `GET /v1/models` 为准。

## 四、接入方式

### 1. OpenAI Codex CLI

`~/.codex/config.toml`：

```toml
model_provider = "trae-relay"
model = "glm-5.3"

[model_providers.trae-relay]
base_url = "http://127.0.0.1:8015/v1"
wire_api = "responses"
requires_openai_auth = true
```

安装：`npm i -g @openai/codex`（本机 Node 已装，Codex 未装）。

### 2. Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8015/v1", api_key="your-master-key")

# 非流式
r = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "只回复两个字：成功"}],
)
print(r.choices[0].message.content)   # -> 成功

# 流式
stream = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### 3. Node / JavaScript

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8015/v1",
  apiKey: "your-master-key",
});

const r = await client.chat.completions.create({
  model: "glm-5.3",
  messages: [{ role: "user", content: "hello" }],
});
console.log(r.choices[0].message.content);
```

### 4. curl

```bash
curl http://127.0.0.1:8015/v1/chat/completions \
  -H "Authorization: Bearer your-master-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","stream":true,
       "messages":[{"role":"user","content":"hello"}]}'
```

### 5. 作为 new-api / one-api 的上游渠道

- 类型：OpenAI
- Base URL：`http://127.0.0.1:8015/v1`
- 密钥：`your-master-key`

> 若前面还挂 new-api，需确认它的 Responses 渠道把 `/v1/responses` 原样透传。

### 6. Claude Code / Gemini CLI 等非 OpenAI 协议

本服务**只实现 OpenAI 协议**，没有 Anthropic 的 `/v1/messages` 路由。
接入这类客户端需要中间加一层协议转换（如 claude-code-router）。

## 五、工具调用（Agent 的核心）

实测通过：`finish_reason=tool_calls`，参数 JSON 正确。

```json
{
  "model": "glm-5.3",
  "stream": false,
  "messages": [{"role": "user", "content": "读取 hello.txt"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "读取文件",
      "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"]
      }
    }
  }],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

多轮续写时，把 assistant 的 `tool_calls` 和 `role: "tool"` 结果一起回传：

```json
"messages": [
  {"role": "user", "content": "读取 hello.txt"},
  {"role": "assistant", "content": null, "tool_calls": [
    {"id": "call_1", "type": "function",
     "function": {"name": "read_file", "arguments": "{\"path\":\"hello.txt\"}"}}
  ]},
  {"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "..."}
]
```

**关键**：工具在**客户端执行**，relay 只转发调用和结果，不会替你读写文件。

## 六、思考内容与思考强度

| 请求参数 | Trae 档位 |
|---|---|
| `reasoning_effort: minimal / low` | `light` |
| `reasoning_effort: medium / high` | `high` |
| `reasoning_effort: xhigh / max` | `extra_high` |
| `thinking.budget_tokens` < 4096 / < 16384 / 更大 | `light` / `high` / `extra_high` |

- 要输出思考：请求带 `"thinking": {"type": "enabled"}` 或 `"include_reasoning": true`
- 思考进 `reasoning_content` 字段，**不混入正文**
- 默认压缩为关键结论，`TRAE_VERBOSE_REASONING=1` 恢复完整思考链

## 七、上游端点选择（影响工具能力）

| 端点 | UPSTREAM_MODE | 工具调用 | 思考强度 | 适用 |
|---|---|---|---|---|
| Remote（当前） | `remote` | 6/7，不支持并行 | 生效 | 纯聊天，最稳 |
| IDE Agent | `ide` | **7/7** | 忽略 | **Codex / Agent 类首选** |
| Solo | `solo` | 同 IDE | 忽略 | SOLO 通道 |
| Work Agent | `work-agent` | 6/7 | 生效 | 走 Work 执行器 |

切换方式（**即时生效，不用重启**）：

- 控制台「轮询与设置 → 上游端点」
- 或打开**「自动路由」**：带 `tools` 的请求自动走 IDE Agent，纯聊天走 Remote

当前状态：`upstream_mode=remote`，`auto-route=false`（`tool_endpoint=ide`，`chat_endpoint=remote`）。

> 接 Agent 建议：**打开自动路由**，或直接把 `UPSTREAM_MODE` 固定为 `ide`。

## 八、实测状态

| 测试 | 结果 |
|---|---|
| `GET /v1/status` | 200，`has_token=true` |
| `GET /v1/models` | 200，26 个模型 |
| 非流式 `glm-5.3` | 200，正常返回 + usage |
| 流式 SSE | 200，chunks 正常拼接 |
| 中文往返 | 无乱码 |
| 工具调用 | `finish_reason=tool_calls`，参数正确 |
| 无 key 调推理端点 | 401 ✅ 鉴权生效 |
| `model=auto` | 502 ❌ 上游模型不可用 |

## 九、注意事项

1. **改掉默认密钥**：`RELAY_API_KEYS=your-master-key` 写在 .env
2. **别暴露 8015 到公网**：项目按内网设计，必须公网就加 TLS 反代
3. **.env 和 data 目录是敏感文件**（JWT / 刷新令牌），勿提交勿分享
4. **长上下文**：remote 通道约 500K 字符上游会静默断流，relay 在 480K 处裁剪
5. **并发**：每账号默认 2 个并行会话，多 bot 请开多账号轮询
6. **502 / 空响应**：首个模型事件前会自动重试一次，仍失败则返回 502 并列出各端点失败原因

## 十、控制台

`http://127.0.0.1:8015/web/login`

- **概览**：用量图表、服务状态
- **账号与签到**：授权登录、每日签到、积分
- **消费记录**：每次请求的 tokens / 积分 / 状态 / 工具调用
- **轮询与设置**：端点切换、自动路由、1M Max、多账号轮询
- **模型测试**：批量测模型连通性（可选端点、工具探针、思考强度）
