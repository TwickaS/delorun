---
description: "Delorun 把 Claude Code 作为实时智能体的驱动，面向维护者：修改 Delorun 如何打开、引导、停止和恢复固定版本的 Claude Code 程序、转达它的权限提问并读取它的套餐限额。"
kind: "package-bundle"
---

# @delorun/agent-claude-code

[English](README.md) | 中文

## 概述

`@delorun/agent-claude-code` 是 `@delorun/external-agents` 的 Claude Code 驱动。它随默认安装发布并保持休眠：只有在上游的 `claude-code` 子智能体提供方已注册时它才向门控注册，这发生在本人添加 Claude Code 包时，该提供方离开时它也随之撤销。每次打开或限额检查时，它通过门控的 `locateClaudeSdk` 在该包中找到 Claude Agent SDK，用动态 `import()` 加载，并通过门控交给它的 spawn 启动每一个 Claude Code 进程。Claude Code 原样运行，使用本人自己的登录和自己的 Claude Code 设置；驱动不读取任何凭据，也不添加任何凭据变量。上游的一次性提供方 `@deepseek-ai/dsh-subagent-claude-code` 保持不变。

## 目录

- [契约](#contract)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

## 契约

- **加载。**驱动只接受它测试过的 SDK 版本，即 [`sdk.ts`](src/sdk.ts) 中的 `TESTED_SDK_VERSION`，它等于上游的包所固定的版本。`open` 和 `probe` 在缺少包或 SDK、或版本不同时，以契约的 `ProgramOpenError`（类别 `program`）拒绝，其详细信息告诉本人该怎么做。只有 [`sdk.ts`](src/sdk.ts) 把 SDK 作为值加载；其他每个文件只在 `import type` 中引用它。
- **会话。**`open` 启动一个流式输入的查询；程序进程随第一个输入启动。新会话得到一个全新的程序会话 id；`resume` 按 id 继续 Claude Code 自己的会话，而 Claude Code 已不再保存的会话会让第一个轮次以 `resume-failed` 结束为 `failed`。每个助手内容块变成一个 `text`、`reasoning` 或 `tool-call` 事件；程序消息在下一条消息、一个工具结果或一个权限提问到达时结束（`message-end`，附带其 token）；每个工具结果变成一个 `tool-result`；程序的结果结束该轮次（`turn-end`，附带该轮次的 token）。Claude Code 自己的子智能体的帧保留在启动它们的工具调用之内。
- **输入。**`send(text, 'start')` 开始一个轮次，在已有轮次运行时被拒绝（`turn-running`）。`send(text, 'steer')` 以优先级 `next` 加入正在运行的轮次，因此 Claude Code 在同一轮次内的下一个工具边界接收它；没有轮次运行时被拒绝（`no-turn`）。当引导恰在轮次结束时到达、而 Claude Code 为它又运行一个轮次时，席位仍只看到一个轮次，带有两个轮次的 token。
- **停止。**`interrupt()` 把正在运行的轮次以 `interrupted` 结束，并保持进程可用。`close()` 结束进程；Claude Code 保留该会话以便日后恢复。打开请求的信号会关闭该会话。
- **失败。**失败的轮次带有契约的类别之一：`signed-out`，来自 Claude Code 的认证错误或上游的登录失败文本；`limit`，来自它的速率限制错误，附上最后一次被拒绝的速率限制事件的重置时间；`model-not-offered`，附上 Claude Code 提供的模型；`resume-failed`；或 `program`，附上至多 500 个字符的 Claude Code 自己的话，供本人查看。
- **提问。**Claude Code 的权限提问会变成席位的批准请求，在驱动结束当前打开的程序消息之后，使席位先记录该调用。理由是 Claude Code 自己的提问句子或确切的调用，绝不是程序模型对该调用的描述。允许一次即允许该调用；拒绝则否决它，轮次继续；取消，或席位无法回答，则否决它并把轮次以 `interrupted` 结束。Claude Code 撤回的提问会中止该请求的信号。
- **为此次运行允许。**运行规则只涵盖被询问的确切命令，别无其他。Claude Code 建议的单条 `addRules` 允许项，在它针对提问的工具且其内容等于该命令时被采用；否则，仅对 `Bash`，规则由调用本身构造为 `Bash(<exact command>)`，除非命令含有括号、重定向（`<`、`>`）或管道（`|`）。含有 `*` 或换行的命令，或没有确切建议的其他工具，不得到运行规则，因此本人只看到“拒绝”和“允许一次”。该规则的范围重设为 `session`，其摘要是它以 Claude Code 规则语法写成的文本。Claude Code 只把它匹配到相同的命令：不同的命令、扩展了它的复合命令，或一个已允许复合命令的其中一部分，都会再次被询问。建议的模式更改（`setMode`）或文件夹授权（`addDirectories`）绝不转发。席位在 `open` 上传回的确切规则作为该进程的 `allowedTools` 应用，进程存活期间一直有效；那里的其他任何规则都被丢弃。
- **级别。**门控的打开请求携带同意为 Claude Code 保存的级别，或同意关闭期间保存在同意行上的级别，由 [`levels.ts`](src/levels.ts) 映射它。谨慎：SDK 的命令沙箱（运行文件夹可写、无网络、`failIfUnavailable`），移除 `WebFetch` 和 `WebSearch`，权限模式 `default`；缺少 `bwrap` 或 `socat` 时，打开失败并给出安装命令行。标准：沙箱中运行文件夹和 `/tmp` 可写且网络开放，权限模式 `auto`；缺少这些工具时，席位以 `sandbox: { enabled: false }` 和权限模式 `default` 运行，这是明确的无沙箱状态。自有：不传入任何内容。不受限制：`bypassPermissions` 加 `allowDangerouslySkipPermissions`，沙箱关闭。
- **设置。**席位加载本人自己的 Claude Code 设置（`settingSources` 为 user、project 和 local），并在 `own` 级别不传入权限模式，因此他们自己的规则和默认模式生效。Claude Code 只采用运行文件夹自己的 `.claude/settings.json` 中的拒绝和询问规则；其中的允许规则和提升权限的默认模式在那里不生效。限额检查不加载任何设置。
- **进程。**在 POSIX 上，程序在 [`watcher.mjs`](src/watcher.mjs) 之下启动。子进程所有者把看守者作为自己进程组的组长启动；看守者从不分离程序，因此程序和它运行的每个命令都留在该组中，所有者的信号能到达它们全部。当 Host 的管道关闭，或看守者收到终止信号时，它向自己的组发送 SIGTERM，五秒后发送 SIGKILL。不在自己进程组中启动的看守者拒绝启动程序（退出码 126），而不是向启动它者的组发送信号。看守者退出时，驱动请子进程所有者结束其管理范围内剩下的一切，因此只要 Host 存活，被直接杀死的看守者不会留下任何东西。在 Windows 上程序直接启动：子进程所有者在关闭时终止的 Job 会结束它的进程树。进程获得子进程所有者清理过的环境，加上 SDK 自己的环境，其中 `MCP_TOOL_TIMEOUT` 由配置设定；`NODE_OPTIONS` 和每个 `DELORUN_*` 名称都被移除。它的标准错误被读空，从不记录。
- **Claude Code 自己的状态。**席位运行和限额检查都不改变本人的 Claude Code 设置文件，也不为运行文件夹记录信任或规则；Claude Code 只写入它的启动记录、其备份，以及它用于恢复的会话历史。
- **Harness 工具。**门控的 harness 工具通过一个进程内 MCP 服务器提供，每个会话使用随机名称，格式为 `delorun_` 加 12 个十六进制数字。每个工具的 JSON Schema 必须描述一个对象，其名称只能使用字母、数字、`_` 和 `-`，否则 `open` 失败。驱动只对 `mcp__<that server>__<an offered tool>` 自行回答 Claude Code 的权限提问；其他所有提问，包括另一个服务器上相同的工具名称，都交给席位。当 Claude Code 在 `MCP_TOOL_TIMEOUT` 放弃或会话关闭时，调用的中止信号触发，程序随后读到该调用已停止。
- **限额。**`probe` 在没有消息、没有任务且 `settingSources: []` 的情况下启动 Claude Code，读取 `accountInfo()` 和 SDK 的实验性用量调用，然后关闭进程。运行期间的速率限制事件到达 `onLimits`。两者都报告套餐名称、每个窗口的百分比、重置时间和状态，以及登录状态；电子邮件、组织和令牌来源被丢弃。用量调用失败时，检查报告登录状态而不报告窗口。

## 配置

| Field | Default | Meaning |
| --- | --- | --- |
| `harnessToolTimeoutSeconds` | 900 | Claude Code 等待一次 harness 工具调用多久后放弃，设为 `MCP_TOOL_TIMEOUT`。 |

## 已知限制

- 与 Host 一起被直接杀死的看守者，会把程序留给门控在下次启动时回收。
- 看守者在 SIGTERM 与 SIGKILL 之间的五秒是固定的。

## 测试

- 单元测试驱动一个假的 SDK 模块，harness 工具使用真实 SDK 的进程内 MCP 服务器，且不启动任何进程：`nice -n 10 node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/agent-claude-code --maxWorkers=4`。
- [`watcher.integration.spec.ts`](tests/watcher.integration.spec.ts) 用 harness 的子进程所有者之下的替身进程证明：关闭管道会结束该组，忽略 SIGTERM 的程序在 `terminate()` 之后消失，直接杀死看守者不会留下程序，不在自己进程组中的看守者不启动任何东西。
- [`real-program.integration.spec.ts`](tests/real-program.integration.spec.ts) 在无密钥的情况下，针对本地 Messages 夹具运行固定版本的 SDK 和 Claude Code：一个轮次、一个为此次运行允许并在恢复后重新应用的提问、一次拒绝、一次中断、一次引导、`resume-failed`、限额检查、一次 harness 工具调用以及一次在等待上限被截断的调用，并且本人的设置保持逐字节相同，每项都不留下进程。
- 在本人自己的登录下进行的实时运行，每次一条命令，从不放在 Vitest 通道中：`node_modules/.bin/tsx delorun/packages/agent-claude-code/live/claude.ts task|steer|interrupt|resume|questions|limits|hostkill`。它们经过脱敏的日志存放在 `~/delorun-rc-release/ea1-claude-logs/` 之下。
