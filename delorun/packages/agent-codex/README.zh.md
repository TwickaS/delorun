---
description: "Delorun 把 Codex 作为实时智能体的驱动，面向维护者：修改 Delorun 如何打开、引导、停止和恢复固定版本的 Codex app-server、转达它的批准提问并读取它的套餐限额。"
kind: "package-bundle"
---

# @delorun/agent-codex

[English](README.md) | 中文

## 概述

`@delorun/agent-codex` 是 `@delorun/external-agents` 的 Codex 驱动。它随默认安装发布并保持休眠：只有在上游的 `codex` 子智能体提供方已注册时它才向门控注册，这发生在本人添加 Codex 包时。随后它通过门控交给它的 spawn，把该包固定版本的启动器作为 `node <launcher> app-server --stdio` 运行，并通过管道使用 Codex 稳定的 app-server 协议。Codex 原样运行，使用本人自己的登录、Codex home 和 MCP 服务器；驱动不读取任何凭据，也不添加任何环境变量。上游的一次性提供方 `@deepseek-ai/dsh-subagent-codex` 保持不变。

## 目录

- [契约](#contract)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

## 契约

- **加载。**每次打开和限额检查时，驱动都用门控的 `locateCodex` 从 profile 的目录找到启动器。它只接受它测试过的 Codex 版本，即 [`protocol.ts`](src/protocol.ts) 中的 `TESTED_CODEX_VERSION`，它等于上游的包所固定的版本；启动器缺失或版本不同，会在任何东西启动之前以 `ProgramOpenError`（类别 `program`）使打开失败。
- **线路。**[`rpc.ts`](src/rpc.ts) 是一个以换行分隔的 JSON-RPC 客户端，用于驱动所使用的稳定方法（`experimentalApi: false`）。它读取的每个结果、通知和服务器请求都在 [`protocol.ts`](src/protocol.ts) 中用 zod 验证。它不认识的方法的服务器请求以 `-32601` 拒绝，会话继续；它已知但无法读取的帧会把正在运行的轮次以 `failed` 结束并关闭进程，因为该帧可能隐藏着一个调用或一个提问。
- **会话。**`open` 初始化 app-server，用 `account/read` 检查登录，然后启动一个持久线程（`ephemeral: false`）或按 id 恢复一个线程。Codex 已不再保存的线程会以 `resume-failed` 使打开失败；没有登录则在线程打开之前以 `signed-out` 使其失败。每个完成的 Codex 条目变成事件：完整的智能体消息变成一个 `text`，推理条目的摘要变成一个 `reasoning`；命令、文件更改、MCP 调用和网页搜索变成一个 `tool-call`（命名为 `shell`、`apply_patch`、`mcp__<server>__<tool>` 和 `web_search`）及其 `tool-result`。程序消息在其调用的结果之前结束（`message-end`），Codex 在消息结束之后报告的用量记入下一个 `message-end` 或 `turn-end`，因此把每个 `usage` 相加，每个请求只计一次。
- **级别。**席位以一个级别运行，即 `careful`、`standard`、`own` 或 `unrestricted`，来自门控的打开请求，该请求携带同意为 Codex 保存的级别，或同意关闭期间保存在同意行上的级别，只在 [`levels.ts`](src/levels.ts) 中映射为 Codex 设置。`careful` 是批准策略 `on-request`，运行文件夹是唯一可写的根，且没有网络。`standard` 为默认，加上 Codex 的自动审查器（`approvalsReviewer: auto_review`）、`/tmp`、`$TMPDIR` 和网络，与本人终端中的 Codex 相同。`own` 用 `config/read` 读取本人生效的 `approval_policy`，它是 `on-request` 时就使用它，否则使用 `on-request`（Codex 0.153.4 拒绝 `config.toml` 中的 `untrusted`），沙箱设置使用本人自己的。`unrestricted` 以 `dangerFullAccess` 运行每个轮次。除 `own` 之外的每个级别都启动一个 `read-only` 线程，并在每次 `turn/start` 上设置它的沙箱：以沙箱 `workspace-write` 或 `danger-full-access` 启动的线程会使 Codex 把该文件夹的 `trust_level = "trusted"` 写入本人自己的 `config.toml`，而轮次的沙箱策略不会在那里写入任何内容。当 Codex 报告已启动或已恢复的线程使用了与该级别不同的批准策略、审查器或线程沙箱时，打开以 `program` 失败。
- **进程。**app-server 获得子进程所有者清理过的环境，并移除 `NODE_OPTIONS` 和每个 `DELORUN_*` 名称。Codex 的沙箱会在每个可写根中创建空的 `.git`、`.agents` 和 `.codex` 文件夹，用来在其上挂载。驱动在进程启动之前记录运行文件夹缺少这三者中的哪几个，并在进程结束之后，移除其中仍是空文件夹的那些，不动其他任何东西，也从不递归；它从不移除 `/tmp` 或 `$TMPDIR` 中的任何东西。在用户可读取的任何挂载命名空间中是挂载点的文件夹会保留，因为在 Linux 上 `rmdir` 会卸掉另一个正在运行的沙箱的挂载并暴露它的 `.git`；而且只要任何智能体的另一个存活程序在相同、外层或嵌套的运行文件夹中运行，就什么都不移除，驱动在清理运行时通过门控的 `sharesFolder()` 询问这一点。被直接杀死的 Host 会把它们留下。
- **模型。**本人选择的模型在 `thread/start` 和 `thread/resume` 上传入。没有选择时，线程报告的模型必须是 `model/list` 向该账户提供的模型；否则在任何轮次之前，打开以 `model-not-offered` 失败，附上配置的名称和提供的列表。驱动从不替本人选择模型。
- **输入。**`send(text, 'start')` 开始一个轮次，在已有轮次运行时被拒绝（`CodexTurnRunningError`）。`send(text, 'steer')` 通过 `turn/steer` 加入正在运行的轮次；恰在轮次结束时到达的引导转而开始下一个轮次。
- **停止。**`interrupt()` 发送 `turn/interrupt` 并等待轮次结束。当轮次结束时仍有命令在运行，驱动会关闭 app-server，命令随之结束，`interrupt()` 返回 `closed`；席位在下一条消息时在新进程中恢复该线程。仍在等待回答的命令尚未启动，不计入。Codex 在请求超时内未结束轮次，同样会关闭进程。否则 `interrupt()` 返回 `interrupted`，进程保留。`close()` 结束输入，等待 `closeWaitSeconds`，然后终止进程；Codex 保留该线程以便日后恢复。打开请求的信号会关闭该会话。
- **失败。**失败的轮次带有契约的类别之一：`signed-out`，来自 Codex 的 `unauthorized` 错误、401 或它的登录文本；`limit`，来自 `usageLimitExceeded` 或 `rateLimitExceeded`，附上最后一次速率限制快照中已达到的窗口里最晚的重置时间；或 `program`，附上 Codex 自己的话，供本人查看。进程在轮次期间结束，则该轮次以 `failed` 结束。
- **提问。**命令或文件更改的批准请求会变成席位的批准请求，在驱动结束当前打开的程序消息并公布该调用之后，使席位先记录该调用。理由是 Codex 自己的理由或确切的命令，绝不是模型的描述。允许一次回答 `accept`；拒绝回答 `decline`，轮次继续；取消回答 `cancel` 并把轮次以 `interrupted` 结束。Codex 自行解决的提问、结束的轮次和关闭的会话，都会撤回该提问并中止它的信号。被拒绝的 `onApproval` promise 回答 `decline`。请求批准调用本人自己某个 MCP 服务器的 Codex MCP 征询，以同样方式询问；其他每个征询都被拒绝。权限请求什么也不授予，且只对该轮次有效。
- **为此次运行允许。**它只对普通的命令提问提供：不对运行中终端的输入、子命令回调、带理由的升级或网络提问提供。运行规则保存线程、命令的 argv（按 shell 拆分 Codex 带引号命令的方式拆分）、文件夹和环境；它的摘要是 Codex 报告的命令。Codex 得到一次性的 `accept`，绝不是 `acceptForSession` 或执行策略修订。只有当本次运行中的某条规则（保存在会话中或在 `open` 上传回）具有相同的线程、逐元素相同的 argv、相同的文件夹和环境，且该提问不带这些字段时，驱动才自行以一次性的 `accept` 回答之后的提问。文件更改、MCP 调用和其他任何东西每次都询问；对它们的“为此次运行允许”按允许一次回答。在 `on-request` 下，Codex 只在命令需要的超出沙箱所给予的范围时才询问，而这种升级带有理由，因此在那里“为此次运行允许”同样按允许一次回答。
- **Harness 工具。**当席位提供 harness 工具时，驱动在回环 streamable-HTTP MCP 服务器上为该线程提供它们：绑定到 127.0.0.1 和内核选择的端口，使用随机服务器名称（`delorun_<12 hex>`），只回答带有该线程的 bearer 令牌和回环 `Host` 的请求。服务器、它的令牌和 `tool_timeout_sec` 只在 `thread/start` 和 `thread/resume` 上的线程配置中命名；Codex home 之下不写入任何内容，Codex 也不把令牌保存在它的任何文件中。服务器在进程结束时关闭，这会撤销令牌。该条目设置 `default_tools_approval_mode = "approve"`，因此 Codex 不经批准就运行该服务器的工具，其自动审查器也从不评判它们。如果 Codex 仍然询问，只有当提问的类型是 `mcp_tool_call`、指明本线程的服务器和线程，且打开调用的工具是所提供的之一时，驱动才回答；其他任何提问都交给本人。一次调用最多运行 `harnessToolTimeoutSeconds`，如同告知 Codex 的那样；之后驱动中止它，稍后到达的结果被丢弃并记录。
- **限额。**`probe` 初始化 app-server，读取 `account/read`、`account/rateLimits/read` 和 `model/list`，不打开线程，不发送模型请求，然后关闭进程。运行期间的速率限制快照到达 `onLimits`，线程打开后所提供的模型也到达它。窗口的命名为：300 分钟是 `five_hour`，10080 分钟是 `seven_day`，其他是 `window_<minutes>m`；达到 100 % 或更多的窗口为 `reached`。套餐名称和登录状态被保留；电子邮件和账户 id 被丢弃。没有套餐限额的登录报告无窗口。

## 配置

| Field | Default | Meaning |
| --- | --- | --- |
| `requestTimeoutSeconds` | 300 | 一次请求最多等待 Codex 回答多久；新线程可能需要 30 秒，在负载较高的机器上超过 120 秒。 |
| `closeWaitSeconds` | 5 | app-server 在输入结束后有多长时间退出，超时则被终止。 |
| `harnessToolTimeoutSeconds` | 900 | Codex 等待一次 harness 工具调用多久后使该调用失败，设为服务器的 `tool_timeout_sec`。 |

## 已知限制

- Codex 在每次启动时都会更新本人 Codex home 中它自己的状态数据库、日志和模型缓存，与在他们的终端中一样。
- 沙箱清理看不到在同一运行文件夹中、在 Delorun 之外启动的 Codex：如果它的沙箱在挂载检查与 `rmdir` 之间启动，那里正在运行的命令会失去对 `.git` 的保护。

## 测试

- 单元测试用内存管道和录制的帧驱动一个假的 app-server，且不启动任何进程：`nice -n 10 node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/agent-codex --maxWorkers=4`。
- [`real-codex.integration.spec.ts`](tests/real-codex.integration.spec.ts) 在无密钥的情况下，在临时 Codex home 中针对本地 Responses 夹具运行固定版本的 app-server：一个轮次、被允许和被拒绝的提问、在新进程中的恢复、`resume-failed`、模型规则、命令运行期间的停止且沙箱的文件夹被移除、一个在轮次、提问和恢复过程中保持不变的 `config.toml`、一次通过回环服务器调用的 harness 工具且其令牌不在任何 Codex 文件中，以及一次限额检查，每项都不留下进程。
- 在本人自己的登录下进行的实时运行，每次一条命令，从不放在 Vitest 通道中：`node_modules/.bin/tsx delorun/packages/agent-codex/live/run.ts task|steer|interrupt|resume|questions|model|limits|hostkill`。它们经过脱敏的日志存放在 `~/delorun-rc-release/ea1-codex-logs/` 之下。[`trust-write.ts`](live/trust-write.ts) 仅在临时 Codex home 中展示哪些线程设置会使 Codex 写入信任条目。
