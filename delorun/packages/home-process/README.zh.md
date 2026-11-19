---
description: "@delorun/home-process 包，供 delorun 与运行时仓库的维护者使用：每个 CLI profile 的 home 进程及其启动顺序，位于 ~/.delorun 下的更新通道及其每次启动的令牌，从不在运行中的对话下切换运行时的更新握手，向新运行时的交接，中断的更新，监管器的启动及其运行日志。"
---

# @delorun/home-process

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包是 [约定 C19](../../docs/contracts/c19-home-process.zh.md) 中的 home 进程（home process）：每个 CLI（命令行界面）profile 一个进程，它持有该 profile 在 `~/.delorun` 下的 home 锁，每次启动写入新的启动令牌，在 `run/<profile>/update.sock` 上提供更新通道，在调用方传入监管器设置时启动 Docker 监管器（Docker supervisor，[C9](../../docs/contracts/c09-runtime-supervisor.zh.md)），并在同一进程中运行该 profile 的 Host。`delorun start` 不传入监管器设置，因此没有监管器运行（[监管器](#the-supervisor)）。更新只能经由更新通道到达它，并且只有在旧运行时上不再有对话运行后，profile 才会切换到新运行时，因此 `current` 从不在运行中的对话下切换。它将日志写入 [C20](../../docs/contracts/c20-operational-logs.zh.md) 的 `home-<profile>` 入口，写入时经由 [`@delorun/logs`](../logs/README.zh.md)。协议的类型与取值来自 [`@delorun/contract-home-process`](../contract-home-process/README.zh.md)；锁、令牌与通道的监听器来自 [`@delorun/home`](../home/README.zh.md)。`delorun start`、`stop` 与 `status`（[`delorun/apps/cli`](../../apps/cli/README.zh.md)）驱动它。

## 目录

- [启动 home 进程](#starting-a-home-process)
- [更新通道](#the-update-channel)
- [更新握手](#the-update-handshake)
- [交接](#the-handover)
- [重启](#the-restart)
- [中断的更新](#interrupted-updates)
- [停止](#stopping)
- [监管器](#the-supervisor)
- [运行日志](#the-operational-log)
- [其他包的 seams](#seams-for-other-packages)
- [尚未实现的部分](#not-implemented)
- [测试](#tests)

<a id="starting-a-home-process"></a>
## 启动 home 进程

`HomeProcess.start(options)` 按 C19 的启动顺序依次执行，并在第一个失败处停止；失败时先记录日志，撤销本次启动创建的内容，再抛出该错误：

1. 检查 home、`secrets/` 与 `run/<profile>/` 是否为私有（`HOME_MODE`）；
2. 以调用方的 `startId` 取得 home 锁；若持有者仍然存活，则在 2 秒内通过更新通道向其请求 `status`（`HOME_RUNNING`、`HOME_UNRESPONSIVE`）；
3. 从更新日志（update journal）完成中断的更新（[中断的更新](#interrupted-updates)）；
4. 用 `writeNewStartToken` 写入新的启动令牌，并将其登记到日志的脱敏器；
5. 在更新通道上监听；从此时起，通道以 `starting` 应答 `status`；
6. 当设置了 `options.supervisor` 时启动监管器；
7. 通过 `options.host` 启动 Host；
8. 尚未运行隔离探测（[尚未实现的部分](#not-implemented)）；
9. 进入 `running`。

无论进程以何种方式结束，`exit` 监听器都会删除本次启动的令牌文件与套接字，并释放锁；每一项只有在仍属于本次启动时才会处理。一旦持有锁，进程就通过 `options.onSignal`（在真实进程中为 `listenProcessSignals`）注册它唯一的 `SIGTERM` 与 `SIGINT` 监听器：第一个信号以代码 0（`SIGTERM`）或 130（`SIGINT`）运行 `HomeProcess.shutdown`，在该停止运行期间收到第二个信号时立即调用 `options.exit`。该监听器在进程启动的每个 Host 之间保持不变，因此 Host 的 profile 运行器启动时不带它自己的信号处理器。在其 Host 已启动之后失败的启动，会先通过 `RunningHost.suspend`（不结束任何进程）停止该 Host，最多等待 `REFUSED_HOST_STOP_S`（5 秒），再进行其余的失败处理；`refuseBootedHost` 给在 `HostRunner.boot` 内被检查拒绝的 Host 同样的等待。失败或耗时更长的拆除会把该失败变为 `HostNotStoppedError`，其 `cause` 为原始失败：Host 可能仍在使用数据，因此启动不回滚任何内容、不重新启动任何内容，移除其信号监听器，并保留锁直到进程结束。同一 profile 的第二次启动发现锁已被持有，并以 `HOME_RUNNING` 失败；桌面应用的 `profiles/desktop/lock` 是另一个文件，home 进程从不读取或写入它。

<a id="the-update-channel"></a>
## 更新通道

`listenUpdateChannel` 以 C19 的限制提供 `@delorun/home` 的令牌通道：每个连接的一行请求至多 16,384 字节，且必须在 5 秒内到达（`REQUEST_TOO_LARGE`、`REQUEST_TIMEOUT`），同时打开的连接至多 8 个（`BUSY`）。在读取该行的其他任何内容之前，先以恒定时间比较令牌；缺失、格式错误、错误或属于上一次启动的令牌，只收到 `UNAUTHENTICATED`，别无其他字段，且被拒绝的请求至多每秒记录一次，日志中不含所提交的值。`checkUpdateRequest` 随后依据封闭模式检查：未知的 `op`、任意深度的未知字段、不为 1 的 `v`，或超出其类型的取值，均以 `SCHEMA_VIOLATION` 拒绝，因此一个请求至多指定一个版本，从不指定路径、归档、URL 或命令。请求在调用方断开连接后仍继续运行，且该调用方的连接不再计入 8 个之中。

在 C1 规则生效之处，受限命令既无法到达通道，也无法读取令牌：`delorun` 启动 CLI profile 时，将上游的本地沙箱提供方设置为保护 home 并拒绝连接通道的套接字（[CLI 的启动](../../apps/cli/README.zh.md#the-home-process)）；在 Landlock 下，受限命令可以连接，但无法读取令牌，因此其请求以 `UNAUTHENTICATED` 失败。Windows 运行器既不限制对令牌的读取，也不限制对套接字的连接，而 `delorun headless` 运行上游的 profile，其沙箱不保护任何 home，因此在那里受限的命令可以读取令牌并使用通道。`sendHomeRequest` 是 `delorun` 的客户端：发送请求时读取令牌文件，并重试 `BUSY` 应答。`updateChannelProbe` 是锁所用的持有者探测。Host 只能通过启动时收到的 `UpdateChannelAccess` 访问通道，该对象把 Host 的通道令牌保存在内存中：这是每次启动创建、从不写入文件的第二个令牌，通道对 `studio.open-token`、`devices.*`、`pin.*`、`mcp.accept`、`mcp.decline`、`mcp.revoke`、`reach.*` 与 `changes.reload` 拒绝它，对其他操作接受它。`delorun start` 启动的 Host 把更新操作作为其 `updateChannel` 服务提供，`@delorun/plugin-update` 的 studio 路由用它在 Changes 门的访问表之后发送更新、回滚与停止请求；`delorun update` 与 `delorun recover` 依然保留。`studio.open-token`（[studio link](src/studio-link.ts)）向 Host 的 `RunningHost.studioLink` 请求一个 studio 登录链接，且只接受令牌文件中的启动令牌，因此以 Host 的通道令牌发送的请求（例如 Host 为 studio 会话转发的请求）无法获得链接；应答行不写入日志。这一区分并不限制 Host 代码：Host 插件在本进程中不受限地运行，可以自己调用上游的 `authenticatedUrl` 或读取令牌文件。

`devices.approve`（`src/devices-approve.ts`）是 C5 的本地批准：不带参数时，它通过 `RunningHost.devices` 打开 `@delorun/home-auth` 的批准窗口，并在有请求待处理或窗口关闭时应答一次；带 `requestId` 与 `typedCode` 时，它批准该请求；只带 `cancelRequestId` 时，它取消该待处理请求。它只接受令牌文件中的令牌，Host 的令牌在任何内容打开之前就以 `LOOPBACK_REQUIRED` 被拒绝（`the channel token cannot call devices.approve` 规范）。

同意操作（`src/consents.ts`）通过 `RunningHost.consents` 访问 Host 的同意：`permission.reload` 让 Host 在 `delorun workspace full-access` 写入按工作区权限存储之后重新读取它，并返回它现在持有的条目的摘要；`mcp.list` 返回添加时同意让其保持停止的 stdio MCP 服务器，每个都带有其启动自该服务器的接受以来变化的部分（`change`，以及变化的变量）和本人是否拒绝或撤销了它（`state`），以及已接受的启动，每个服务器名称一项（`accepted`）；`mcp.accept` 与 `mcp.decline` 以 `mcp.list` 显示的审查 id 答复其中一个服务器，`mcp.revoke` 以 `mcp.list` 显示的接受 id 撤回一个服务器的接受，并停止该服务器。这三种操作只接受令牌文件中的令牌，Host 的令牌在读取任何同意之前就以 `LOOPBACK_REQUIRED` 被拒绝（`the channel token cannot answer an MCP server` 规范）；服务器已不再持有的审查或存储已不再持有的接受以 `STALE_REVIEW` 被拒绝，没有该同意的 profile 以 `CONSENT_UNAVAILABLE` 被拒绝。

`changes.reload` 不携带任何内容：当进程处于 `running` 且没有更新或回滚在运行时（否则返回 `UPDATE_IN_PROGRESS`），它要求 Host 加载 profile 的文件现在所指名的内容，并回答 `{"reload":{"ok":true}}` 或 `{"reload":{"ok":false,"error":"…"}}`。`delorun changes` 在改动了 profile 的文件之后发送它（[C21](../../docs/contracts/c21-changes.zh.md#commands)）；它自身不改动任何文件。

<a id="the-update-handshake"></a>
## 更新握手

`UpdateHandshake` 运行 C19 的各阶段，自 `snapshot` 起，在每个阶段开始时以模式 0600 写入更新记录 `run/<profile>/update.json`，其中记录更新前 `previous` 指针所指的版本、数据是否不同、是否保存副本、`targetStarted`、profile 历史版本的 id（`snapshot`）以及报告的健康预期（`health`）。后继进程把记录标记为 `committed`。每次回滚在回滚表的第一步之前都以阶段 `rolling-back` 重写该记录，只有在回滚到的运行时通过健康检查后，记录才会删除。在一次更新写入其第一条记录之前，上一次更新的 `committed` 记录会移到暂存文件 `run/<profile>/update.previous.json`；更新未提交而结束时它会移回，更新提交时它会删除。同一时间只运行一次更新、准备或回滚（`UPDATE_IN_PROGRESS`）。

- **`update.prepare`** 运行运行时仓库（runtime store）的 `checking`、`installing` 与 `reporting` 阶段，返回 `reportId` 与报告，报告保留 600 秒（超时后或应用后，返回 `REPORT_EXPIRED`）。
- **`update.apply`** 运行 `snapshot`，然后运行 `waiting`：从其开始时起，Host 的对话闸门以 `UPDATE_PENDING` 拒绝新回合。`drain` 最多等待 `drainTimeoutS`，直到运行中的对话归零（`DRAIN_TIMEOUT`）；`abort-if-busy` 在有对话运行时结束为 `aborted`，原因为 `CHATS_RUNNING`；`cancel` 取消运行中的回合与任务，并等待它们结束。`update.cancel` 结束尚未开始 `switching` 的更新，`current` 保持不变。
- **`switching`** 只在闸门报告无运行中的对话且仍拒绝新回合时运行。`SessionDataCopies.confirmSoleUser` 再次检查没有其他进程在使用对话数据（`plan` 在记录存在之前已检查过）；若有其他进程，更新以 `CHATS_RUNNING` 被拒绝，不改变任何内容，并删除记录。随后 home 进程停止其 Host 与监管器，在 `dataCopy` 要求时写入会话数据副本（在 `snapshot` 之前已检查空间是否足够，否则为 `DATA_COPY_NO_SPACE`），运行时仓库依次写入 `previous` 与 `current`，写入记录的 `targetStarted`，随后后继进程启动（[交接](#the-handover)）。
- **`health-check`**：后继进程在 120 秒内以 `ready` 或 `failed` 应答。收到 `ready` 时，更新以 `committed` 结束。收到 `failed`，或后继进程退出或沉默时，后继进程被停止，`SessionDataCopies.rollback` 应用 C3 的回滚表并恢复两个指针；本进程在旧运行时上重新启动 Host，更新以 `rolled-back` 结束，原因为 `HEALTH_CHECK_FAILED`。回滚表拒绝时，不恢复任何内容，记录加上 `refused`，更新以 `failed` 结束，原因为 `ROLLBACK_NEEDS_DATA_COPY`，进程在发送最终行后停止。回滚开始后某一步失败时，更新以 `failed` 结束，记录保持 `rolling-back`，进程停止而不再运行其 Host。
- **`rollback`** 读取更新记录，需要一次到正在运行版本的 `committed` 更新（`NO_UPDATE_RECORD`），等待运行中的对话，停止 Host，并通过 `SessionDataCopies.rollback` 应用 C3 的回滚表；随后它把回滚到的版本作为后继进程启动，后者在健康检查通过后删除记录；带 `profileOnly` 时，则重新运行本 Host 并删除记录。拒绝（`ROLLBACK_NEEDS_DATA_COPY`、`ROLLBACK_TARGET_UNUSABLE`）让一切保持原样，Host 重新运行。第一步之后的失败，或健康检查失败的后继进程，会让回滚以 `failed` 结束：Host 不再运行，进程停止，下一次启动完成该回滚。
- **结果记录** `run/<profile>/update-result.json`（[`src/update-result.ts`](src/update-result.ts)）在更新或本人发起的回滚的每次结束时（`committed`、带有未通过健康判据的 `rolled-back`、`aborted`、`failed`）于最后一行响应之前写入，并在下一次尝试开始时删除。切换之后运行的 Host 把它提供给 studio，而 studio 的页面无法读取最后一行；缺失或无法读取的记录视为没有记录（[C19](../../docs/contracts/c19-home-process.zh.md#the-outcome-record)）。

<a id="the-handover"></a>
## 交接

前任进程使用运行时仓库的命令，从目标运行时启动后继进程，并将文件描述符 3 上继承的管道交给它；后继进程位于自己的进程组中，因此发给请求方终端的信号不会到达它。前任进程随后写入一行交接信息：home、profile、两个版本、它为后继进程分配的启动 id，以及报告所指明为停用的插件。令牌不随之传递。`HomeProcess.takeOver` 以 `standby` 启动后继进程的 Host，并按交接行的预期运行其 C3 健康检查：报告指明的插件与行、它预测的组合包列表、前任进程的 Host 无法加载的行，以及该 Host 在启动时拥有的每一行（在该 Host 停止之前读取）。它以 `ready` 或 `failed` 应答。收到 `ready` 时，前任进程以后继进程的进程 id 与启动 id 原子地重写锁（`HomeLock.handOver`），向请求方发送最终的 `committed` 行，关闭其通道，删除其令牌文件，并写入 `commit`；随后后继进程接管锁，写入新的启动令牌，开始监听，启动其监管器，进入 `running`，并处理记录：更新的记录被标记为 `committed`，只保留其副本（`SessionDataCopies.commit`），暂存文件删除；回滚的记录删除，暂存的记录移回。若前任进程在 `commit` 之前死亡，后继进程只有在锁已指明它时才接管。

<a id="the-restart"></a>
## 重启

`Restart`（[`src/restart.ts`](src/restart.ts)）就是 C19 的重启（[C19](../../docs/contracts/c19-home-process.zh.md#the-restart)）：本进程所启动的 Host 以 `HomeControls.restart` 接收它，CLI 再把它作为 `changesRestart` 交给 studio。它会以 `RESTART_IN_PROGRESS`、`UPDATE_IN_PROGRESS`（更新或回滚正在运行、进程不处于 `running`，或存在不是 `committed` 的更新记录）或 `NO_RUNTIME_STORE`（没有 `RestartSupport`）拒绝；重启运行期间，每个更新与回滚都以 `RESTART_IN_PROGRESS` 被拒绝；`stop` 或 `update.cancel` 会结束仍在等待对话的重启，而一旦它开始启动新的 Host，`stop` 就被拒绝。它持有对话闸门并等待运行中的对话，或用 `stopChats` 取消它们，最多等待请求的 `drainTimeoutS`；然后停止 Host，并在同一版本上启动后继进程，交接行的 `type` 为 `restart`，其健康检查预期不会有超出运行中 Host 所停用的插件。接管的后继进程不结算任何更新记录。失败的后继进程被停止，`RestartSupport.leaveOut` 把最新的 harness 更改排除在外，本进程重新启动其 Host；此后 `view()` 给出 `failed` 及其原因和被排除的更改，直到 `clearFailure`。

<a id="interrupted-updates"></a>
## 中断的更新

断开连接的请求方从不改变正在运行的更新。在第 3 步之前，启动运行 `HomeProcessOptions.preStart`，即 CLI 有序的启动前步骤，它们在任何 Host 启动之前完成被中断的副本恢复。没有运行时仓库时（`options.updates` 为 `undefined`），第 3 步保留暂存文件与 `committed` 记录；对于任何其他记录，它以 `NO_RUNTIME_STORE` 让启动失败，保留记录且不启动任何 Host。有运行时仓库时，第 3 步按 C19 的“中断的更新”所列，处理被杀死的 home 进程留下的记录：没有记录的暂存文件移回；`refused` 记录以 `ROLLBACK_NEEDS_DATA_COPY` 让启动失败；`committed` 记录在 `current` 指向其目标时保留（旁边的暂存文件删除），在 `current` 指向其来源时删除；早于 `switching` 的阶段，或 `current` 仍指向 `from`，表示没有任何切换，因此丢弃该更新的副本，删除记录，暂存文件移回。若阶段为 `switching` 或 `health-check`，且 `current` 指向本进程正在运行的 `to`，则本次启动记录 `targetStarted`，其自身的 Host 启动即为对 `to` 的健康检查，按记录的 `health` 执行 H1 到 H5；该检查失败时，本次启动停止其 Host 并关闭其他部分，在仍持有锁时应用 C3 的回滚表，并从记录恢复两个指针（`current` 恢复为 `from`，`previous` 恢复为记录中的 `previous`，记录中没有该字段时则删除 `previous`），释放锁，使用运行时仓库的命令从 `from` 启动 home 进程，并以 `HEALTH_CHECK_FAILED` 失败；记录保持 `rolling-back`，直到该次启动的 Host 启动。回滚表拒绝时，记录加上 `refused`。`current` 指向 `to` 的 `rolling-back` 记录会在任何 Host 启动之前通过回滚表完成，启动失败并在 `from` 上重新启动；`current` 指向 `from` 时，本次启动的 Host 启动即为其检查，之后记录删除。

<a id="stopping"></a>
## 停止

`stop` 的 `drain` 拒绝新回合，并最多等待 1,800 秒让运行中的对话结束；`cancel` 则先取消它们。另一个停止正在等待时发送的停止会加入它并返回同一最终行，加入的 `cancel` 会先取消运行中的对话，因此 `delorun stop --now` 会结束正在排空的停止。最终行在进程依次关闭 Host、删除令牌文件、关闭通道、停止监管器并释放锁之前发送。被接受的停止总会应答并结束进程：取消失败会被记录，停止继续进行；无法读取的状态不写入最终行。运行更新或回滚期间收到的停止请求会被拒绝，并返回 `UPDATE_IN_PROGRESS`。`HomeProcess.shutdown` 在终止信号到达时立即以相同顺序执行；关闭失败的 Host 会被记录，后续步骤仍然运行。

<a id="the-supervisor"></a>
## 监管器

`delorun start` 不传入 `SupervisorSetup`，也没有任何 setup 步骤写入它，因此没有任何已发布的命令启动监管器，也没有任何 Docker 工作区运行。调用方传入它时，`launchSupervisor` 使用 `SupervisorSetup` 中的命令启动 `@delorun/supervisor` 的入口模块，并通过文件描述符 3 上的管道写入一行启动信息，其中包含本次启动的 home、profile、启动 id 与令牌、已验证 manifest 的镜像，以及监管器的计时参数（[监管器的启动](../supervisor/README.zh.md#launching-the-supervisor)）。令牌从不出现在其命令行或环境中。关闭管道即停止监管器；下一次启动会以新令牌启动新的监管器，新监管器拒绝上一次启动的令牌。

<a id="the-operational-log"></a>
## 运行日志

`openHomeLog` 使用脱敏器打开 `home-<profile>` 入口，每条记录都带有启动 id。启动令牌在通道开始监听之前就已登记到脱敏器中；`captureHomeOutput` 将进程的标准输出与标准错误捕获到同一日志中，并在 `delorun start --foreground` 中透传到终端。记录只写明请求的 `op` 与结果，从不写入请求正文。`openedHomeLog()` 返回本进程打开的日志及其 profile；`delorun` 的最后兜底报告把致命失败的完整细节写入其中，并用该日志的脱敏器对其终端拒绝进行脱敏。C20 的拒绝测试套件通过 `tests/log-driver.ts` 在此入口上运行。

<a id="seams-for-other-packages"></a>
## 其他包的 seams

`src/seams.ts` 声明 home 进程在本包之外调用的接口：

| 接口 | 实现方 | 落地前 |
| --- | --- | --- |
| `RuntimeStore`：`pointers`、`prepare`（checking、installing、reporting）、`reportRollback`、`switchTo`（C1 的 `previous` 后接 `current` 的顺序）、`restore` 与 `homeCommand`（从某个版本启动 home 进程的命令，用于后继进程或全新启动；其进程必须就是 home 进程本身，因此锁中的进程 id 能指明它） | `delorun/packages/runtime-store` | 不从运行时仓库运行的 home 进程（例如从源码检出启动的）没有该实现：`update.prepare` 以 `VERIFY_FAILED` 被拒绝，`update.apply` 以 `REPORT_EXPIRED` 被拒绝，`rollback` 以 `NO_PREVIOUS` 被拒绝，`status` 将运行中的版本报告为 `current` |
| `ProfileSnapshots`：`snapshot` 阶段中带报告的 `save`，返回记录保存的历史版本 id | C3 的 profile 历史，即基于 `@delorun/profile-safety` 的 `delorun/apps/cli/src/update/support.ts` | 同上 |
| `SessionDataCopies`：记录之前的 `plan`，以及 Host 停止之前的 `confirmSoleUser`，用于在其他进程使用对话数据时拒绝；用于副本的 `plan` 与 `save`；用于在切换之前结束的更新的 `discard`；更新提交后的 `commit`；用于每种返回方式的 `rollback` | 基于 `@delorun/update` 的副本及其唯一回滚函数的 `delorun/apps/cli/src/update/support.ts` | 同上 |
| `HostRunner` 与 `RunningHost`：启动、启动时的每一行与未加载的行、C3 的健康检查、用于 `studio.open-token` 的 studio 链接、关闭 | 使用上游 profile runner 的 `delorun start` | — |
| `ChatGate`：运行中的对话、`hold`（拒绝新回合并保留已排期的投递）、`idle`、`cancelAll`；`CountingChatGate` 是 Host 以 `track` 供给数据的一种实现 | `delorun start`，来自上游的 `agent/status` 与任务注册表的事件；`@delorun/bundle-local` 的 `delorunTurnGate` 服务读取 `held` 以拒绝新回合（`delorun/apps/cli/src/update/host.ts`） | — |

测试通过 `tests/support.ts` 中的 fixture（测试前置数据）store 驱动握手，该 fixture 保存 C1 的指针文件，并从 `tests/fixtures/home-entry.ts` 启动后继进程。

<a id="not-implemented"></a>
## 尚未实现的部分

- CLI 的 Host 不保持定时投递：闸门保持期间到期的投递被记录为已投递，其回合以 `UPDATE_PENDING` 被拒绝。在 Host 报告之前就已开始的工作不计入。
- 第 8 步的隔离探测及其结果，以及 `delorun verify` 对无法执行 C1 规则的方言的报告。home 进程自身尚不包装任何受限命令；探测落地后，若 Landlock 的包装因通往 home 的路径上的条目在包装与启动之间发生变化而以退出码 125 被拒绝，会先重试一次再报告。
- 由 `delorun start` 启动的监管器，以及写入监管器根文件的 setup 步骤。
- 在 home 进程运行期间重试 `unchecked` 的发布日志检查（[C18](../../docs/contracts/c18-release-log.zh.md)）。
- 登录时启动（`--at-login`）与 `delorun status --follow`。
- 采用 C1 DACL 的 Windows 命名管道：通道只在 Unix 套接字上监听。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/home-process` 运行规范：每个 profile 一个 home 进程，每次启动的令牌及对上一次启动令牌的拒绝，封闭模式与限制，等待运行中对话的更新，`abort-if-busy` 与 `update.cancel`，在 `waiting` 与 `health-check` 阶段被杀死的请求方，健康检查失败后的回滚，中断的更新，桌面应用的独立性，Host 访问通道的途径，监管器的启动，以及假时钟下的排空超时。隔离规范经由上游的沙箱提供方运行宿主提供的每种沙箱方言，其配置与 `delorun` 为 CLI profile 所做的配置相同（以 C1 的读取豁免保护 home，拒绝连接通道的套接字）；启动器不可用时，Landlock 规范会跳过并给出原因。另一个规范依约定所述应用 C1 的 bwrap 机制，以证明套接字与令牌文件位于它所隐藏的位置。`delorun/apps/cli` 的真实运行器规范在已启动的 CLI profile 下运行同一拒绝检查。
