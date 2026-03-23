# WX AI Bridge

将主流 AI 编程 CLI 工具统一接入微信，通过微信 ClawBot 官方插件（iLink Bot API）实现消息中继。

**支持的 CLI 工具：**

| 工具 | 调用方式 | JSON 输出 | 会话恢复 |
|---|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude -p --output-format json` | ✅ | ✅ `--resume` |
| [Codex CLI](https://github.com/openai/codex) | `codex exec --full-auto` | ✅ | ✅ `exec resume` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini -p --output-format json` | ✅ | ❌ |
| [Aider](https://github.com/Aider-AI/aider) | `aider -m --yes-always` | ❌ | ❌ |

新工具只需实现一个 adapter（约 60 行），即可接入。

---

## 工作原理

```
微信用户 (ClawBot 插件)
    ↕  iLink Bot API — 微信官方消息通道
    ↕  HTTP long-poll (35s) + sendmessage
┌──────────────────────────────────────┐
│          WX AI Bridge                │
│                                      │
│  iLink Client ← 收消息               │
│       ↓                              │
│  Router — 解析 @前缀 / /命令          │
│       ↓                              │
│  CLI Adapter — spawn 子进程           │
│  (claude -p / codex exec / ...)      │
│       ↓                              │
│  iLink Client → 发消息               │
└──────────────────────────────────────┘
```

### 核心流程

1. **收消息** — iLink Client 通过 HTTP 长轮询（35 秒超时）从微信服务器拉取新消息
2. **路由** — Router 解析消息文本，判断是命令（`/help`）、指定工具（`@claude`）还是纯文本
3. **执行** — 对应的 CLI Adapter 通过 `child_process.spawn` 启动工具的非交互模式
4. **回复** — 工具输出经格式化后通过 iLink API 发回微信，自动处理 2000 字分段

### 微信接入：iLink Bot API

本项目使用微信 2026 年 3 月推出的 **ClawBot 插件**（龙虾插件）提供的官方 iLink Bot API。这是腾讯的官方产品，非第三方逆向协议：

- 域名：`ilinkai.weixin.qq.com`（腾讯官方服务器）
- 认证：QR 扫码，Bearer token
- 限制：仅私聊，无群聊；仅实时消息，无历史记录
- 安全：**官方通道，不存在封号风险**

#### 协议要点

| 端点 | 用途 |
|---|---|
| `GET /ilink/bot/get_bot_qrcode?bot_type=3` | 获取登录二维码 |
| `GET /ilink/bot/get_qrcode_status?qrcode=<token>` | 轮询扫码状态 |
| `POST /ilink/bot/getupdates` | 长轮询收消息（35s hold） |
| `POST /ilink/bot/sendmessage` | 发送消息（需 `context_token`） |
| `POST /ilink/bot/getconfig` | 获取 typing ticket |
| `POST /ilink/bot/sendtyping` | 显示"正在输入" |

每条消息都携带 `context_token`，回复时必须原样带回，否则消息无法送达。

---

## 项目结构

```
src/
├── index.ts                 # 入口：启动、QR 登录、信号处理
├── config.ts                # 配置管理 (~/.wx-ai-bridge/)
│
├── utils/
│   ├── logger.ts            # 彩色终端日志
│   └── crypto.ts            # AES-128-ECB 加解密、UIN 生成
│
├── ilink/
│   ├── types.ts             # iLink 协议完整类型定义
│   ├── auth.ts              # QR 扫码登录（获取→轮询→凭据持久化）
│   └── client.ts            # 核心客户端
│       ├── 长轮询消息循环（指数退避重连）
│       ├── context_token 缓存（per user）
│       ├── 消息发送 + 2000 字自动分段
│       └── typing 指示器（5s 刷新）
│
├── adapters/
│   ├── base.ts              # CLIAdapter 接口定义
│   │   ├── execute(prompt, opts) → ExecResult
│   │   ├── AbortSignal 支持（可取消）
│   │   └── AdapterCapabilities 声明
│   ├── claude.ts            # Claude Code 适配器
│   ├── codex.ts             # Codex CLI 适配器
│   ├── gemini.ts            # Gemini CLI 适配器
│   ├── aider.ts             # Aider 适配器
│   └── registry.ts          # 自动检测已安装工具
│
└── bridge/
    ├── session.ts           # 会话管理（per user × per tool）
    ├── formatter.ts         # 响应格式化（工具名、耗时、费用）
    └── router.ts            # 消息路由 + 命令处理 + 并发控制
```

### 各层职责

**ilink/** — 纯粹的 iLink 协议实现，不包含任何业务逻辑。`ILinkClient` 暴露 `onMessage` 回调和 `sendText` 方法。

**adapters/** — 每个 CLI 工具一个 adapter，实现统一的 `CLIAdapter` 接口。通过 `child_process.spawn` 调用工具的非交互模式，解析 JSON 或纯文本输出，返回结构化的 `ExecResult`（文本、session ID、花费、耗时）。

**bridge/** — 胶水层。`Router` 将微信消息路由到对应的 adapter，管理并发（一个用户同时只能有一个任务在跑），处理 `/command` 命令。`SessionManager` 持久化会话 ID 以支持 `--resume` 类工具的上下文续接。

---

## 安装使用

### 前置要求

- Node.js >= 18
- 微信 iOS 8.0.70+ 或同等版本，已启用 ClawBot 插件
- 至少安装一个支持的 CLI 工具（claude / codex / gemini / aider）

### 安装

```bash
git clone https://github.com/sgaofen/wx-ai-bridge.git
cd wx-ai-bridge
npm install
npm run build
```

### 运行

```bash
npm start
# 或开发模式
npm run dev
# 调试日志
npm run dev -- --debug
```

首次运行会在终端显示 QR 码，用微信扫描登录。登录凭据保存在 `~/.wx-ai-bridge/credentials.json`，后续启动自动复用。

---

## 微信内使用

### 发送消息

| 输入 | 行为 |
|---|---|
| 直接发文字 | 发给默认工具（初始为 claude） |
| `@claude 写一个快速排序` | 指定用 Claude Code |
| `@codex fix the auth bug` | 指定用 Codex CLI |
| `@gemini 解释这段代码` | 指定用 Gemini CLI |
| `@aider 加上单元测试` | 指定用 Aider |

### 命令

| 命令 | 作用 |
|---|---|
| `/switch <工具>` | 切换默认工具，如 `/switch gemini` |
| `/tools` | 查看所有工具及其安装状态 |
| `/status` | 查看当前状态（默认工具、活跃会话、是否忙碌） |
| `/new` | 清除当前会话，下次对话不续上下文 |
| `/cancel` | 取消正在运行的 CLI 任务 |
| `/help` | 显示帮助 |

### 回复格式

每条回复末尾附带元信息：

```
这是 Claude Code 的回复内容...

— Claude Code | 3.2s | $0.0123
```

包含：工具名、响应耗时、API 费用（仅 Claude Code 支持费用追踪）。

---

## 配置

配置文件位于 `~/.wx-ai-bridge/config.json`，首次运行自动创建：

```jsonc
{
  "defaultTool": "claude",         // 默认 CLI 工具
  "maxResponseChunkSize": 2000,    // 微信单条消息最大字符数
  "cliTimeout": 300000,            // CLI 执行超时 (ms)，默认 5 分钟
  "typingInterval": 5000,          // typing 指示器刷新间隔 (ms)
  "allowedUsers": [],              // 允许的微信用户 ID，空=不限制
  "workDir": "/path/to/your/repo", // CLI 工具的工作目录
  "tools": {                       // 每个工具的额外参数
    "claude": {
      "args": ["--max-turns", "15", "--allowedTools", "Read,Edit,Bash"]
    },
    "codex": {
      "args": ["--sandbox", "workspace-write"]
    }
  }
}
```

---

## 添加新工具

实现 `CLIAdapter` 接口，约 60 行代码：

```typescript
// src/adapters/my-tool.ts
import { spawn } from 'node:child_process';
import { commandExists, setupAbort, setupTimeout, stripAnsi } from './claude.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities } from './base.js';

export class MyToolAdapter implements CLIAdapter {
  readonly name = 'mytool';
  readonly displayName = 'My Tool';
  readonly command = 'mytool';
  readonly capabilities: AdapterCapabilities = {
    streaming: false,
    jsonOutput: false,
    sessionResume: false,
  };

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }

  execute(prompt: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(this.command, ['--flag', prompt], {
        cwd: opts?.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      setupAbort(proc, opts?.signal);
      const timer = setupTimeout(proc, opts?.timeout);

      let stdout = '';
      proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString(); });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ text: stripAnsi(stdout.trim()), error: code !== 0 });
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ text: err.message, error: true });
      });
    });
  }
}
```

然后在 `registry.ts` 中注册：

```typescript
import { MyToolAdapter } from './my-tool.js';
// 在 constructor 中添加：
this.register(new MyToolAdapter());
```

微信中即可使用 `@mytool <消息>`。

---

## 技术细节

### CLI 工具非交互模式对比

各工具的调用方式经过调研确认：

```bash
# Claude Code — 最完善，JSON + streaming + session resume
claude -p "prompt" --output-format json --bare --max-turns 30

# Codex CLI — NDJSON 事件流 + session resume
codex exec --full-auto --skip-git-repo-check "prompt"

# Gemini CLI — JSON 输出
gemini -p "prompt" --output-format json

# Aider — 纯文本，无 JSON 模式
aider --yes-always --no-pretty --no-stream --no-auto-commits -m "prompt"
```

### 并发控制

每个微信用户同时只能有一个 CLI 任务在运行。如果用户发送新消息时上一个任务还在执行，会收到提示。可通过 `/cancel` 取消当前任务（通过 `AbortSignal` → `SIGTERM` 终止子进程）。

### 会话续接

支持 `--resume` 的工具（Claude Code、Codex CLI）会自动保存 `session_id`。同一用户的后续消息会自动续接上下文，无需手动管理。发送 `/new` 可清除会话，开始全新对话。

### 错误恢复

- **长轮询超时**：正常行为，自动重试
- **网络错误**：指数退避重连（1s → 2s → 4s → ... → 30s 上限）
- **会话过期（errcode -14）**：提示重新登录
- **CLI 执行超时**：默认 5 分钟上限，可配置

---

## License

MIT
