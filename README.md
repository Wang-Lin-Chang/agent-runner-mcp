# agent-runner-mcp

> An MCP server that exposes the three-platform sandboxed runner protocol to **any MCP client** (Claude Code, Codex, and others): run tasks in an evidence-protected sandbox, read the EXIT protocol, and get an autopsy report. Zero dependencies — the MCP layer is hand-rolled. Every claim carries an experiment number.
>
> 一个把三平台沙箱 runner 协议暴露给**任何 MCP 客户端**（Claude Code、Codex 等）的 MCP server：在证据保护的沙箱里跑任务、读 EXIT 协议、拿尸检报告。零依赖——MCP 协议层手写。每个能力声明带实验编号。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![ci](https://github.com/Wang-Lin-Chang/agent-runner-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang-Lin-Chang/agent-runner-mcp/actions/workflows/ci.yml)

## 为什么存在 / Why this exists

Agent 框架各自为政，但"在沙箱里可靠地执行任务并留下证据"是共性刚需。本 server 把 [dsh-witness](https://github.com/Wang-Lin-Chang/dsh-witness) 的 runner 协议（lock=pid:startSec、EXIT:<code>、尸检分类学）包装成 MCP 工具——**Claude Code 实测 ✓ Connected**，Codex 等 MCP 客户端同协议可接。

## 工具 / Tools

| 工具 | 语义 |
|---|---|
| `task_run` | 沙箱执行命令（Windows ACL / Linux bwrap / macOS sandbox-exec 按平台自动选），返回任务目录 |
| `task_wait` | 等终态（EXIT:<code> 写入）|
| `task_output` | 按字节偏移增量读 out.log |
| `task_autopsy` | 生成尸检报告（autopsy-spec 格式：manner/evidence/verdict/D-01~D-09）|
| `task_kill` | 按 lock pid 击杀（崩溃实验）|
| `task_adopt` | 三证据收养判定（lock 解析 + 进程存活 + exit 协议）|

## 快速开始 / Quick start

```sh
# 安装（git 源）
dsh plugin --profile <name> add "github:Wang-Lin-Chang/agent-runner-mcp#v0.1.0"

# 注册到 Claude Code
claude mcp add agent-runner -- node dist/server.js

# 或直接跑测试（15 断言协议实测）
npm test
```

## 验收证据 / Acceptance evidence

- EXP-1：MCP 协议层实测 15/15（握手 / 六工具 / EXIT:0→D-01 / 崩溃→D-08 / EXIT:1→D-02）
- EXP-2：Claude Code 2.1.92 真实客户端 `✓ Connected`（initialize + tools/list 握手）
- EXP-3：Windows ACL 持久性判决（观测产物与证据区分离）
- EXP-4：死亡语义矩阵对齐 autopsy-spec 分类学

## 诚实边界 / Honest boundaries

- Claude Code 会话内工具调用需登录态——本机未登录，协议握手实测、会话调用未实测不声称。
- 本 server 是 **runner 协议层**：完整 registry 级收养/事件溯源/缓存见 dsh-witness。
- Windows CI 管理员环境下 ACL 沙箱失效 → runner fail-closed（EXIT:-998）为协议正确回应；沙箱能力验收在非管理员环境实测。
- 离线适用面：架构无网络依赖（本地进程 + 文件协议）；数天级断网长跑未实测。

## License

Apache-2.0
