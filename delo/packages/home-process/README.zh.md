---
description: "@delo/home-process 包，供 delorun 与运行时仓库的维护者使用：每个 CLI profile 的 home 进程及其启动顺序，位于 ~/.delo 下的更新通道及其每次启动的令牌，从不在运行中的 chat 下切换运行时的更新握手，向新运行时的交接，中断的更新，监管器的启动及其运行日志。"
---

# @delo/home-process

[English](README.md) | 中文

## 摘要

本包是 [约定 C19](../../docs/contracts/c19-home-process.zh.md) 中的 home 进程（home process）：每个 CLI（命令行界面）profile 一个进程，它持有该 profile 在 `~/.delo` 下的 home 锁，每次启动写入新的启动令牌，在 `run/<profile>/update.sock` 上提供更新通道，启动 Docker 监管器（Docker supervisor，[C9](../../docs/contracts/c09-runtime-supervisor.zh.md)），并在同一进程中运行该 profile 的 Host。更新只能经由更新通道到达它，并且只有在旧运行时上不再有 chat 运行后，profile 才会切换到新运行时，因此 `current` 从不在运行中的 chat 下切换。它将日志写入 [C20](../../docs/contracts/c20-operational-logs.zh.md) 的 `home-<profile>` 入口，写入时经由 [`@delo/logs`](../logs/README.zh.md)。协议的类型与取值来自 [`@delo/contract-home-process`](../contract-home-process/README.zh.md)；锁、令牌与通道的监听器来自 [`@delo/home`](../home/README.zh.md)。`delorun start`、`stop` 与 `status`（[`delo/apps/cli`](../../apps/cli/README.zh.md)）驱动它。

## 目录

- [启动 home 进程](#starting-a-home-process)
- [更新通道](#the-update-channel)
- [更新握手](#the-update-handshake)
- [交接](#the-handover)
- [中断的更新](#interrupted-updates)
- [停止](#stopping)
- [监管器](#the-supervisor)
- [运行日志](#the-operational-log)
- [其他包的 seams](#seams-for-other-packages)
- [尚未实现的部分](#not-yet-implemented)
- [测试](#tests)

<a id="starting-a-home-process"></a>
## 启动 home 进程

`HomeProcess.start(options)` 按 C19 的启动顺序依次执行，并在第一个失败处停止；失败时先记录日志，撤销本次启动创建的内容，再抛出该错误。

1. 检查 home、`secrets/` 与 `run/<profile>/` 是否为私有（`HOME_MODE`）；
2. 以调用方的 `startId` 取得 home 锁；若持有者仍然存活，则在 2 秒内通过更新通道向其请求 `status`（`HOME_RUNNING`、`HOME_UNRESPONSIVE`）；
3. 从更新日志（update journal）完成中断的更新（[中断的更新](#interrupted-updates)）；
4. 用 `writeNewStartToken` 写入新的启动令牌，并将其登记到日志的脱敏器；
5. 在更新通道上监听；从此时起，通道以 `starting` 应答 `status`；
6. 当设置了 `options.supervisor` 时启动监管器；
7. 通过 `options.host` 启动 Host；
8. 尚未运行隔离探测（[尚未实现的部分](#not-yet-implemented)）；
9. 进入 `running`。

无论进程以何种方式结束，`exit` 监听器都会删除本次启动的令牌文件与套接字，并释放锁；每一项只有在仍属于本次启动时才会处理。同一 profile 的第二次启动发现锁已被持有，并以 `HOME_RUNNING` 失败；桌面应用的 `profiles/desktop/lock` 是另一个文件，home 进程从不读取或写入它。

<a id="the-update-channel"></a>
## 更新通道

`listenUpdateChannel` 以 C19 的限制提供 `@delo/home` 的令牌通道：每个连接的一行请求至多 16,384 字节，且必须在 5 秒内到达（`REQUEST_TOO_LARGE`、`REQUEST_TIMEOUT`），同时打开的连接至多 8 个（`BUSY`）。在读取该行的其他任何内容之前，先以恒定时间比较令牌；缺失、格式错误、错误或属于上一次启动的令牌，只收到 `UNAUTHENTICATED`，别无其他字段，且被拒绝的请求至多每秒记录一次，日志中不含所提交的值。`checkUpdateRequest` 随后依据封闭模式检查：未知的 `op`、任意深度的未知字段、不为 1 的 `v`，或超出其类型的取值，均以 `SCHEMA_VIOLATION` 拒绝，因此一个请求至多指定一个版本，从不指定路径、归档、URL 或命令。请求在调用方断开连接后仍继续运行，且该调用方的连接不再计入 8 个之中。

在 C1 规则生效之处，受限命令既无法到达通道，也无法读取令牌：`delorun` 启动 CLI profile 时，将上游的本地沙箱提供方设置为保护 home 并拒绝连接通道的套接字（[CLI 的启动](../../apps/cli/README.zh.md#the-home-process)）；在 Landlock 下，受限命令可以连接，但无法读取令牌，因此其请求以 `UNAUTHENTICATED` 失败。`sendHomeRequest` 是 `delorun` 的客户端：发送请求时读取令牌文件，并重试 `BUSY` 应答。`updateChannelProbe` 是锁所用的持有者探测。Host 只能通过启动时收到的 `UpdateChannelAccess` 访问通道，该对象将令牌保存在内存中；studio 的 "Update now" 与回滚都经由它。

<a id="the-update-handshake"></a>
## 更新握手

`UpdateHandshake` 运行 C19 的各阶段，自 `snapshot` 起，在每个阶段开始时将日志 `run/<profile>/update.json` 以模式 0600 写入，其中记录更新前 `previous` 指针所指的版本。同一时间只运行一次更新、准备或回滚（`UPDATE_IN_PROGRESS`）。

- **`update.prepare`** 运行运行时仓库（runtime store）的 `checking`、`installing` 与 `reporting` 阶段，返回 `reportId` 与报告，报告保留 600 秒（超时后或应用后，返回 `REPORT_EXPIRED`）。
- **`update.apply`** 运行 `snapshot`，然后运行 `waiting`：从 `waiting` 开始时起，Host 的 chat 门控以 `UPDATE_PENDING` 拒绝新的轮次。`drain` 最多等待 `drainTimeoutS` 秒，直到运行中的 chat 归零（超时则返回 `DRAIN_TIMEOUT`）；`abort-if-busy` 在有 chat 运行时结束为 `aborted`，原因为 `CHATS_RUNNING`；`cancel` 取消运行中的轮次与任务，并等待它们结束。`update.cancel` 结束尚未开始 `switching` 的更新，`current` 保持不变。
- **`switching`** 只在门控报告无运行中的 chat 且仍拒绝新轮次时运行。home 进程停止其 Host 与监管器，运行时仓库依次写入 `previous` 与 `current`，随后后继进程启动（[交接](#the-handover)）。
- **`health-check`**：后继进程在 120 秒内以 `ready` 或 `failed` 应答。收到 `ready` 时，更新以 `committed` 结束。收到 `failed`，或后继进程退出或沉默时，后继进程被停止，两个指针与 profile 快照被恢复，本进程在旧运行时上重新启动 Host，更新以 `rolled-back` 结束，原因为 `HEALTH_CHECK_FAILED`。
- **`rollback`** 运行相同阶段，回到 `previous` 所指的版本，不安装任何内容（没有 `previous` 时返回 `NO_PREVIOUS`）。

<a id="the-handover"></a>
## 交接

前任进程使用运行时仓库的命令，从目标运行时启动后继进程，并将文件描述符 3 上继承的管道交给它；后继进程位于自己的进程组中，因此发给请求方终端的信号不会到达它。前任进程随后写入一行交接信息：home、profile、两个版本、它为后继进程分配的启动 id，以及报告所指明为停用的插件。令牌不随之传递。`HomeProcess.takeOver` 以 `standby` 启动后继进程的 Host 并进行检查：启动须完成，它不得停用报告未指明的插件，且其 studio 监听器须能应答。它以 `ready` 或 `failed` 应答。收到 `ready` 时，前任进程以后继进程的进程 id 与启动 id 原子地重写锁（`HomeLock.handOver`），向请求方发送最终的 `committed` 行，关闭其通道，删除其令牌文件，并写入 `commit`；随后后继进程接管锁，写入新的启动令牌，开始监听，启动其监管器，进入 `running`，并删除更新日志。若前任进程在 `commit` 之前死亡，后继进程只有在锁已指明它时才接管。

<a id="interrupted-updates"></a>
## 中断的更新

断开连接的请求方从不改变正在运行的更新。每次启动时，第 3 步读取被杀死的 home 进程留下的更新日志：若阶段早于 `switching`，或 `current` 仍指向 `from`，则表示没有任何切换，更新日志被删除。若阶段为 `switching` 或 `health-check`，且 `current` 指向本进程正在运行的 `to`，则本次启动自身的 Host 启动即为对 `to` 的健康检查；该检查失败时，本次启动从更新日志恢复两个指针（`current` 恢复为 `from`，`previous` 恢复为更新日志中的 `previous`，更新日志中没有该字段时则删除 `previous`），恢复 profile 快照，删除更新日志，使用运行时仓库的命令从 `from` 启动 home 进程，并以 `HEALTH_CHECK_FAILED` 失败。

<a id="stopping"></a>
## 停止

`stop` 的 `drain` 拒绝新轮次，并最多等待 1,800 秒让运行中的 chat 结束；`cancel` 则先取消它们。最终行在进程依次关闭 Host、删除令牌文件、关闭通道、停止监管器并释放锁之前发送。运行更新或回滚期间收到的停止请求会被拒绝，并返回 `UPDATE_IN_PROGRESS`。`HomeProcess.shutdown` 在终止信号到达时立即以相同顺序执行。

<a id="the-supervisor"></a>
## 监管器

当机器已为 Docker 设置好时，`launchSupervisor` 使用 `SupervisorSetup` 中的命令启动 `@delo/supervisor` 的入口模块，并通过文件描述符 3 上的管道写入一行启动信息，其中包含本次启动的 home、profile、启动 id 与令牌、已验证 manifest 的 `images`，以及监管器的计时参数（[监管器的启动](../supervisor/README.zh.md#launching-the-supervisor)）。令牌从不出现在其命令行或环境中。关闭管道即停止监管器；下一次启动会以新令牌启动新的监管器，新监管器拒绝上一次启动的令牌。

<a id="the-operational-log"></a>
## 运行日志

`openHomeLog` 使用脱敏器打开 `home-<profile>` 入口，每条记录都带有启动 id。令牌在通道开始监听之前就已登记到脱敏器中；`captureHomeOutput` 将进程的标准输出与标准错误捕获到同一日志中，并在 `delorun start --foreground` 中透传到终端。记录只写明请求的 `op` 与结果，从不写入请求正文。C20 的拒绝测试套件通过 `tests/log-driver.ts` 在此入口上运行。

<a id="seams-for-other-packages"></a>
## 其他包的 seams

`src/seams.ts` 声明 home 进程在本包之外调用的接口。

| 接口 | 实现方 | 落地前 |
| --- | --- | --- |
| `RuntimeStore`：`pointers`、`prepare`（checking、installing、reporting）、`reportRollback`、`switchTo`（C1 的 `previous` 后接 `current` 的顺序）、`restore` 与 `homeCommand`（从某个版本启动 home 进程的命令，用于后继进程或全新启动；其进程必须就是 home 进程本身，因此锁中的进程 id 能指明它） | `delo/packages/runtime-store`（WP3.3） | CLI 的 home 进程没有该实现：`update.prepare` 以 `VERIFY_FAILED` 被拒绝，`update.apply` 以 `REPORT_EXPIRED` 被拒绝，`rollback` 以 `NO_PREVIOUS` 被拒绝，`status` 将运行中的版本报告为 `current` |
| `ProfileSnapshots`：`snapshot` 阶段中的 `save`，健康检查失败后的 `restore` | C3 的 profile 历史 | 同上 |
| `HostRunner` 与 `RunningHost`：启动、停用的插件、studio 健康检查、关闭 | 使用上游 profile runner 的 `delorun start` | — |
| `ChatGate`：运行中的 chat、`hold`（拒绝新轮次并保留已排期的投递）、`idle`、`cancelAll`；`CountingChatGate` 是 Host 供给数据的一种实现 | `@delo/bundle-local` 中 Host 的更新插件 | CLI 的 Host 不统计运行中的 chat |

测试通过 `tests/support.ts` 中的 fixture（测试前置数据）store 驱动握手，该 fixture 保存 C1 的指针文件，并从 `tests/fixtures/home-entry.ts` 启动后继进程。

<a id="not-yet-implemented"></a>
## 尚未实现的部分

- 上表所列的运行时仓库、profile 历史以及 Host 的 chat 门控。在 chat 门控落地之前，`delorun stop` 不会等待运行中的 chat。
- 第 8 步的隔离探测及其结果，以及 `delorun verify` 对无法执行 C1 规则的方言的报告。home 进程自身尚不包装任何受限命令；探测落地后，若 Landlock 的包装因通往 home 的路径上的条目在包装与启动之间发生变化而以退出码 125 被拒绝，会先重试一次再报告。
- 登录时启动（`--at-login`）、`delorun status --follow`、`delorun update` 与 `delorun recover`。
- 采用 C1 DACL 的 Windows 命名管道：通道只在 Unix 套接字上监听。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-process` 运行规范：每个 profile 一个 home 进程，每次启动的令牌及对上一次启动令牌的拒绝，封闭模式与限制，等待运行中 chat 的更新，`abort-if-busy` 与 `update.cancel`，在 `waiting` 与 `health-check` 阶段被杀死的请求方，健康检查失败后的回滚，中断的更新，桌面应用的独立性，Host 访问通道的途径，监管器的启动，以及假时钟下的排空超时。隔离规范经由上游的沙箱提供方运行宿主提供的每种沙箱方言，其配置与 `delorun` 为 CLI profile 所做的配置相同（以 C1 的读取豁免保护 home，拒绝连接通道的套接字）；启动器不可用时，Landlock 规范会跳过并给出原因。另一个规范依约定所述应用 C1 的 bwrap 机制，以证明套接字与令牌文件位于它所隐藏的位置。`delo/apps/cli` 的真实运行器规范在已启动的 CLI profile 下运行同一拒绝检查。
