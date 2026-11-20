---
description: "Delorun 实时外部智能体的启动门控，面向维护者：修改 Claude Code 或 Codex 如何为席位或限额检查而启动、运行前和运行中检查什么，以及什么会结束一个程序。"
kind: "package-bundle"
---

# @delorun/external-agents

[English](README.md) | 中文

## 概述

`@delorun/external-agents` 提供 `externalAgents` 服务，即实时外部智能体的启动门控。实时智能体是以自己的程序运行的 Claude Code 或 Codex，用于一个席位（由该程序回答各轮次的对话），或用于检查本人套餐的限额。除上游经过评审的一次性路径和 `delorun agents login` 之外，门控是 Delorun 中唯一启动这两个程序的代码；`gates:external-agent-spawns` 检查会拒绝任何其他加载 Claude Code 的 SDK、提到 Codex 包或使用固定版本程序的定位器的源文件。该包还包含各智能体包所实现的驱动契约（`./contract`）、固定版本程序的定位器（`./locate`）、它的各项拒绝所用的固定语句（`./copy`），以及用来停止已死亡 Host 所遗留程序的记录（`src/reap.ts`）。

## 目录

- [契约](#contract)
- [账户与限额](#accounts-and-limits)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

## 契约

- **驱动。**智能体包用 `registerDriver` 注册它的驱动；为同一智能体注册第二个驱动会抛出错误，返回的销毁函数会结束该驱动的各个程序。在驱动注册之前，每次启动都以 `not-installed` 被拒绝。驱动到达时，`onDriverRegistered` 会通知监听者。
- **启动顺序。**`start` 按以下顺序检查，并以 `GateRefusedError` 拒绝，其 `refusal` 指明原因：驱动已注册；席位子智能体没有正在运行的程序；该子智能体、它的创建者及其根对话都是常驻智能体（席位所在的对话如果不在本人看得到的对话之下打开，会被拒绝）；同意已开启并审查该席位，或已关闭；未达到套餐限额；运行中程序的上限还有空位。只有这些都通过，它才打开驱动的会话。
- **同意关闭。**只有当配置文件中存在同意行 `delorun-delegation-consent` 且其保存的配置为 `enabled: false` 时，席位才会不经审查地启动。行缺失、行被禁用、行的服务未注册、行失败，以及没有 `reviewSeat` 的同意服务，每一种都会拒绝。在未经审查的程序运行期间同意出现时，这些程序会被结束。
- **租约。**同意开启时，`reviewSeat` 授予一份租约，记录根对话、工作区、运行文件夹和智能体。它在根对话当前打开的轮次上询问本人，恢复时则在席位子智能体上询问；工作区授权不显示卡片就允许，具有“完全访问”（批准策略 `never` 且沙箱 `danger-full-access`）的根对话在同意的 `fullAccessStartsAgents` 存在且开启（缺失视为关闭）时也是如此，前提是只读、工作区和运行文件夹检查都通过；任何其他 `never` 的根都会被拒绝。`start` 在 `allowedBy`（`lease`、`granted`、`asked`、`full-access` 或 `consent-off`）中返回原因，用于交接行。程序开始的每个轮次都会重新审查：这四个值中任何一个变化、只读被打开、授权被撤销、租约被撤销、同意被关闭、对话或其根被归档、工作区被删除，或者对于“完全访问”所允许的租约，根离开了“完全访问”或该开关被关闭，都会结束租约，而租约结束会结束实时程序。在运行中的轮次内进行的引导不会重新审查。关闭同意会立即结束运行中的程序，即使在轮次中途；只读被打开、授权被撤销或在轮次运行时离开“完全访问”，在下一个轮次的审查时生效。
- **运行规则。**“为此次运行允许”与租约放在一起，以席位子智能体为键，并随每个结束租约的事件一起结束。同意关闭时没有租约，因此提问的运行规则会被移除，卡片只提供拒绝和允许一次。从手机上给出的允许，即使该手机的解锁随后结束，也持续到租约结束。
- **时间限制。**同意开启时，每个席位轮次都有同意的运行时间限制：到达限制时，门控中断该轮次，等待 `graceMs`，如果轮次仍在运行就结束程序，该轮次以失败原因 `time-limit` 以 `failed` 结束。同意关闭时席位轮次没有时间限制，就像一次性运行没有一样。
- **进程。**驱动启动的每个进程都经过门控的 spawn，它通过 `ctx.subprocess` 在运行文件夹中、带着程序的中止信号和 `graceMs` 运行该进程，并在子进程所有者自己的清理之上，从其环境中移除 `NODE_OPTIONS`、每个 `DELORUN_*` 变量以及驱动覆盖项中每个以凭据命名的条目（上游的 `SENSITIVE_ENV_PATTERN` 和清理所用的环境权限名称）。程序结束之后再 spawn 会抛出错误。结束一个程序会关闭驱动的会话、中止信号、终止每个进程，并最多等待 `graceMs` 的两倍让它退出。
- **限额检查。**`probe(provider, signal)` 不接受文件夹、子智能体或输入：门控在系统临时目录下创建一个空文件夹，在同一上限下准入该检查，运行驱动的 probe，然后移除该文件夹。CLI 从不启动检查。
- **限额拒绝。**开启 `limitRefusal` 时，重置时间在将来的已记录限额会拒绝席位启动，`limitRefusal(provider)` 把拒绝一次性运行的语句交给同意（[`limitRefusal`](src/copy.ts)）。重置时间已过的限额从不拒绝。
- **席位注册表。**`seat(child)` 回答一个会话是否是门控启动的席位，并给出它的根和智能体。席位由这个注册表识别，绝不由批准策略的值识别。
- **Host 死亡。**程序运行期间，门控把它每个领导进程组的进程的身份保存在 Delorun home 下的 `secrets/external-agents/programs.json` 中：在 Linux 上是进程 id、内核启动时间、boot id、可执行文件路径和子进程所有者的 systemd scope，它们取自句柄，并在进程进入该 scope 且离开 `systemd-run` 之后读取一次（在 `graceMs` 内没有做到的进程不会被记录）；在 macOS 上是进程 id、启动时间和路径；对任一系统上的 Node 领导进程，还有它运行的脚本，读自它的命令行，因此指名另一个 Node 进程的记录永远不会匹配。下次启动时，它会停止每个身份仍完全匹配、且可执行文件是 Delorun 所定位的（运行 runner 的 Node 二进制、Claude Code 的原生程序或原生 Codex 程序）的已记录程序，对于 Node 二进制，其脚本也必须是 Delorun 所定位的（Codex 启动器或 Claude Code 的 watcher，按真实路径比较，因为伪造的记录可以复制一个存活进程的脚本）；有 scope 时停止该 scope，否则停止该进程组，先 SIGTERM，经过 `graceMs` 后 SIGKILL，并删除所有记录；现在指向另一个进程的进程 id 绝不会收到信号。
- **停止。**销毁插件、该席位子智能体的 `agent/disposed` 事件以及驱动离开，都会结束相关的程序。

## 账户与限额

`ctx.agentAccounts` 把每个智能体的登录、套餐和套餐限额窗口保存在 `secrets/external-agents/accounts.json`（权限 0600）。它只保存 `signedIn`、`plan`、每个窗口的 `kind`、`usedPercent`、`resetsAt`、`status`、`seenAt` 和 `source`、提供的模型，以及一次检查最近何时回答、失败或被请求；每条观测都逐字段重建，因此程序回复中的电子邮件、组织、账户 id 或令牌绝不会进入该文件。无法读取的文件按没有数据处理，不会因此拒绝任何东西。运行通过驱动的 `onLimits` 报告数据。限额检查是门控的 `probe`，只在关于该智能体的、`probeTriggers` 所列出的明确操作上运行：它的包刚被添加（没有已保存的条目）、登录完成（`delorun agents login`，或它为下次启动留下的标记）或“立即检查”；单单 Host 启动不检查任何东西，`probeMinIntervalMinutes` 是两次检查之间的下限，不是定时器。重置时间已过的窗口从不拒绝启动。`GET /api/delorunExternalAgents.accounts` 回答任何已批准的设备，且从不启动检查；`POST /api/delorunExternalAgents.refresh` 需要在电脑上进行，或对恰好该次调用的 Face ID 授权（没有通行密钥的手机用 PIN）；任何解锁、代码或批准宽限都不能代替它。`delorun agents status` 通过更新通道或该文件读取同样的数据。该存储在门控和连接都存在时挂载。

## 配置

| Field | Default | Meaning |
| --- | --- | --- |
| `maxLivePrograms` | 4 | 此 home 中最多可同时运行多少个程序，席位和限额检查合计；至少 1。 |
| `graceMs` | 3000 | 程序被要求停止后在被杀死之前有多长时间退出，单位毫秒；至少 100。 |
| `probeMinIntervalMinutes` | 30 | 同一智能体两次限额检查之间的最短时间，按整分钟计；至少 1。 |
| `probeTriggers` | `pack-added`, `signed-in`, `check-now` | 不显示卡片就运行限额检查的明确操作；未列出的操作不启动检查。 |
| `limitRefusal` | false | C16 开关 `external_agent_limit_refusal`；`@delorun/bundle-local` 会把它打开。 |

`@delorun/bundle-local` 插入行 `delorun-external-agents`。同意开启期间，它的 `plugin_manager` 守卫会拒绝模型按名称安装、启用或配置这个包和各智能体包。

## 已知限制

- `maxLivePrograms` 不计入一次性运行，它们由上游的子智能体运行时启动。
- 限额拒绝可能在套餐升级之后持续到下一次限额检查。
- 在 Windows 上不记录任何用于清理的内容；子进程所有者的关闭即终止 Job 会随 Host 结束这些程序。

## 测试

[`tests/gate.spec.ts`](tests/gate.spec.ts) 针对 agent-loop testkit 的真实智能体和一个脚本化的驱动，证明启动顺序和每一种拒绝：同意关闭的情形、没有 `reviewSeat` 的席位启动、上限、时间限制、运行规则的转达、spawn 的环境，以及每个结束程序的事件。[`tests/reap.spec.ts`](tests/reap.spec.ts) 在一个假的进程表上证明被复用的进程 id 绝不会收到信号。[`tests/contract.spec.ts`](tests/contract.spec.ts) 证明 `probe` 不接受文件夹和子智能体，[`tests/locate.spec.ts`](tests/locate.spec.ts) 则针对夹具包证明定位器。
