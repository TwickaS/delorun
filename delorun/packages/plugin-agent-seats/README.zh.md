---
description: "Delorun 的实时外部智能体，面向维护者：Claude Code 和 Codex 作为交付工作的对话的子对话，位于预览开关 externalAgents.liveAgents 之后。"
kind: "package-library"
---

# @delorun/plugin-agent-seats

[English](README.md) | 中文

## 概述

这个包让 Claude Code 和 Codex 成为实时智能体：交付工作的对话的一个子对话（席位），它的模型是外部程序，本人可以观看、发送消息和停止它。除了预览开关 `externalAgents.liveAgents` 的声明之外，所有内容只在该开关开启时才注册。开关关闭时，对话的工具、模型路由、预设和路由与没有这个包时相同，上游的一次性 `subagent_claude_code` 和 `subagent_codex` 工具保持不变。启动门控（`@delorun/external-agents`）是唯一启动这两个程序的代码；这个包向它提出请求。

## 目录

- [配置](#configuration)
- [契约](#contract)
- [程序的提问](#questions-from-the-program)
- [测试](#tests)

## 配置

Host 行 `delorun-agent-seats` 保存 `seats`，它是 `{ provider, route, preset, toolName, maxDepth, contextWindow }` 的列表。默认为 Claude Code（`claude_code`）和 Codex（`codex`）各一个席位。 The row also holds `enabled`, the C16 switch `live_agents`: off by default, which is the parity value, the row declares its preview flag and registers nothing else; every row Delorun ships sets it on, and the preview flag then decides whether live agents run. A patch that restates the row replaces its whole configuration, so it keeps `enabled: true` beside `seats`; without it the row mounts nothing. No Delorun command, setting or setup step writes such a patch.

| Field | Meaning |
| --- | --- |
| `provider` | 门控运行的智能体：`claude-code` 或 `codex`。任何其他值都会使该行停止。 |
| `route` | 席位子对话的各轮次所使用的隐藏模型路由。 |
| `preset` | 组成席位子对话的智能体预设。 |
| `toolName` | 主导对话的模型看到的交接工具；它的点号形式（`claude_code.`）是席位所记录的工具名称的前缀。 |
| `maxDepth` | 可以继续交接工作的席位子对话的最深链条；1 表示席位子对话不能再次交接。 |
| `contextWindow` | 程序的上下文窗口，单位为词元，令牌计量器用它做除数。 |

两个席位不能共用同一个 provider、路由或工具名称。该行在加载时读取一次预览开关，因此开关改变后需要重新加载该行。它需要服务 `previewFlags`、`llm`、`sessions`、`sessionProjections`、`externalAgents`、`subagents`、`tools`、`agentPresets`、`connection` 和 `profileContext`；模型选择保存在配置档文件夹中的 `agent-seat-models.json`。

## 契约

- **开关关闭。**该行声明开关，不注册其他任何东西。
- **开关开启。**该行为每个席位注册一个名为 `<provider>-seat` 的子智能体提供方、交接工具、一条模型路由、预设和 `agentSeat` 会话投影。它提供 `seatPrograms` 服务和两条 Host 路由。每项注册都是 effect，因此停止该行会撤回所有这些注册。
- **交接。**工具在席位的提供方、路由和预设上启动主导对话的一个可继续的子对话，任务原文照传。门控的各项拒绝以固定语句到达模型。在有实时智能体的对话中，上游针对同一智能体的一次性工具会用 `ctx.tools.restrict` 对该智能体隐藏。
- **模型路由。**`listModels()` 为空，因此没有选择器显示该路由，适配器会拒绝每个不是席位子对话自己轮次的请求。每个 harness 步骤流式传输一条程序消息。
- **记录。**预设挂载席位工具执行器，它把程序的工具调用写成以席位前缀命名的记录（`claude_code.Bash`），因此原生执行器永远不会运行其中任何一个。程序输出在固定上限处被截断，完整文本作为溢出内容保留。
- **已记录的状态。**席位子对话自己的日志保存程序的会话和输入游标（`external-agent/state`）、它的状态（`external-agent/status`）以及它的记录中显示的通知（`external-agent/notice`），因此重启和归档恢复都会带上它们；分叉会继承这些事件，但不显示席位。它们是必需事件：不认识它们的构建会拒绝该日志。`agentSeat` 投影折叠它们，并忽略早期预览版写入的、可忽略的 `plugin:delorun/agent-seat/*` 记录。
- **Host 路由。**`POST /api/agentSeat.resume` 在已达到的套餐限额解除后开始新的轮次，`POST /api/agentSeat.chooseModel` 保存本人对套餐所提供的模型的选择，每个工作区一次。没有任何东西会自行恢复。两条路由对电脑开放，并且在 home 挂载之后，对任何已批准的手机也不显示提示即可开放（类别 `free`）：Resume 只切换席位的状态，选择模型不改变任何权限。
- **租约结束。**当同意结束席位的租约（对话被归档、权限被撤销、同意被关闭）时，门控停止程序，该行丢弃它的运行，对话会显示它的智能体为何停止。
- **尚未读取。**告知本人程序自己的会话在对话关闭期间已前进的检查，只有在条目提供 `tail` 读取器时才运行；对话中程序的版本和设置名称，只有在它提供 `info` 时才显示。两者都没有提供。
- **转达接缝。**`mountSeats(ctx, config, { relay })` 以挂载状态和确切的席位提供方名称的函数形式接收提问转达器。没有它，程序的每个提问都被拒绝。

## 程序的提问

席位的权限提问通过席位子对话上的批准服务交给本人，带有 `external-agent` 授权标记：电脑可以允许；手机只有在持有恰好针对该提问和该回答的回答授权时才可以允许（针对 `allowed-once` 的授权从不准入 `allowed-for-run`，反之亦然；回答它的设备持有的有效 Face ID 通行期则两者都准入，就像它准入允许一次一样），PIN 或代码解锁、批准宽限或危险模式都不能代替它；任何手机都可以拒绝。工作室的卡片在电脑上和已批准的手机上显示授予权限的回答，在手机上每个回答都先通过 reach 服务的 `confirm` 要求 Face ID（没有通行密钥的手机则用 PIN 键盘），由它签发该授权；没有调用 id 的提问无法确认，卡片会显示“未确认”。没有 reach 服务的页面只提供拒绝。在“完全访问”的对话中，提问不显示卡片就被允许，并记录为已允许。“为此次运行允许”以原始回答 `allowed-for-run` 到达 host，`approval/request` 上的监听者会把它变成允许一次加一个标记；门控在内存中保存程序的规则，直到席位的租约结束。一旦同意服务持有该规则，席位子对话的日志中就会出现一个 `external-agent/run-allowed` 事件，它指明该提问的 `approval/asked` 事件；当门控退回到允许一次时，不记录任何东西。

提问会等到席位写下它的调用记录之后，因此日志按调用、询问、决定、结果的顺序读取。只有当该记录带有席位给该调用的名称（`claude_code.Bash`）时，转达器才会询问；否则它拒绝该提问并记录一条警告。卡片把程序的理由显示为智能体的话（“Claude Code says: ...”）。停止会在轮次结束之前结束一个待处理的提问。

## 测试

- [`tests/wiring.spec.ts`](tests/wiring.spec.ts) 证明条目在开关关闭时只注册该开关，开启时注册工具、提供方、路由、预设和 Host 路由，该行停止时撤回它们，并告诉席位的对话它的租约为何结束。
- [`tests/provider/provider.spec.ts`](tests/provider/provider.spec.ts) 在真实的子智能体运行时和工具流水线上证明子智能体提供方、交接工具、深度规则和门控的每一种拒绝。
- [`tests/adapter`](tests/adapter) 在脚本化的门控和程序上证明模型路由，包括它的各项拒绝。
- [`tests/executor`](tests/executor) 在生产的 agent loop 上证明席位执行器、预设和输出上限。
- [`tests/state`](tests/state) 在真实的会话存储上证明 `agentSeat` 投影、模型选择、Host 路由和席位的各个轮次。
