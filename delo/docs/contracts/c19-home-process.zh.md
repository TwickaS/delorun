---
description: "约定 C19：持有 CLI profile 锁并运行其 Host 的 home 进程，delorun start、stop 与 status，登录时启动，带每次启动令牌的更新通道协议，运行时切换前如何排空运行中的 chat，交接与健康检查，被中断的更新，回滚，以及桌面应用的独立更新。"
---

# C19 Home 进程与更新握手

[English](c19-home-process.md) | 中文

## 摘要

本约定定义让本人的 CLI home 保持运行的后台进程，以及更新抵达它所经过的握手。每个 CLI profile 有一个 home 进程，它在 `~/.delo` 下持有该 profile 的锁，运行其 Host，并在每次启动时写入一个新的启动令牌。`delorun update` 与 studio 的「Update now」通过更新通道抵达它；更新通道是 `~/.delo` 下的一个套接字，只接受携带当前令牌的请求。更新会等到旧运行时上没有 chat 运行，再把 profile 交给运行在新运行时上的进程，检查其是否健康，不健康时回滚，因此被中断的更新始终让一个完整版本处于当前状态。桌面应用保留上游自己的 Host 与 profile，并独立更新。类型包 [`@delo/contract-home-process`](../../packages/contract-home-process/README.zh.md) 提供协议、状态与限额。

## 目录

- [home 进程](#the-home-process)
- [命令](#commands)
- [登录时启动](#start-at-login)
- [更新通道](#the-update-channel)
- [请求与响应](#requests-and-responses)
- [更新握手](#the-update-handshake)
- [被中断的更新](#interrupted-updates)
- [回滚](#rollback)
- [桌面应用](#the-desktop-app)
- [限额](#limits)
- [错误](#errors)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [各平台与方言的强制执行情况](#enforcement-per-platform-and-dialect)

<a id="the-home-process"></a>

## home 进程

home 进程是每个 CLI profile 一个的操作系统进程。它在同一进程中运行该 profile 的 Host，所用运行时由 [C1](c01-home-layout.zh.md) 的 `current` 指针指定；它与 Docker 监管器（[C9](c09-runtime-supervisor.zh.md)）是不同的进程。

- **所有权。** 它在整个生命周期内持有 `run/<profile>/home.lock`（[C1](c01-home-layout.zh.md)），因此同一 profile 的第二次启动会发现锁已被持有，不会启动第二个 Host。
- **脱离终端。** `delorun start` 以脱离终端的方式启动它，关闭标准输入，并把标准输出与标准错误导入其运行日志（[C20](c20-operational-logs.zh.md)）。
- **状态。** `starting`、`running`、`waiting`（更新在等待运行中的 chat）、`switching`（正在交接到新运行时）、`stopping`。由交接启动的后继进程在交接完成前处于 `standby`。
- **启动顺序。** 启动按下列顺序执行各步，在第一次失败时停止，并把失败写入日志和发起启动的终端：
  1. 检查 home、`secrets/` 与 `run/<profile>/` 的权限模式（[C1](c01-home-layout.zh.md)）；
  2. 获取 home 锁，否则以 `HOME_RUNNING` 或 `HOME_UNRESPONSIVE` 停止；
  3. 根据更新日志文件完成被中断的更新（[被中断的更新](#interrupted-updates)）；
  4. 写入新的启动令牌（[C1](c01-home-layout.zh.md)）；
  5. 在更新通道上监听，从这一步起它对 `status` 回答 `starting`；
  6. 机器已设置 Docker 时启动 Docker 监管器（[C9](c09-runtime-supervisor.zh.md)）；
  7. 启动 Host；
  8. 运行 [C1](c01-home-layout.zh.md) 的限制探测并记录结果；
  9. 进入 `running`。
- **正常停止。** 进程关闭 Host，删除令牌文件，关闭更新通道，停止它启动的监管器，删除锁并退出。

<a id="commands"></a>

## 命令

- **`delorun start`** 为该 profile 启动 home 进程，并等待它报告 `running`，最多 120 秒；未进入 `running` 的启动会打印失败原因与日志位置。若已有存活的 home 进程回答 `status`，该命令打印其状态并以 0 退出。`--foreground` 在终端中运行该进程，同时写入其日志。`--at-login` 先安装登录项（[登录时启动](#start-at-login)）。
- **不带参数的 `delorun`** 在没有 CLI profile 的 home 上运行 setup；否则它像 `delorun start` 一样启动 home 进程并打开 studio。
- **`delorun stop`** 以 `drain` 模式发送 `stop`：home 进程拒绝新的轮次，等待运行中的 chat 最多 1,800 秒，然后停止。`--now` 发送 `cancel` 模式，通过上游的取消机制取消运行中的轮次与后台作业，然后停止。`--at-login` 同时移除登录项。没有 home 进程运行时，该命令打印这一情况并以 0 退出。
- **`delorun status`** 打印状态、进程 id、`startId`，`current`、`previous` 与正在运行的运行时版本，启动器版本，正在进行的更新的阶段，运行中的 chat 数量，以及登录项是否已安装。`--json` 打印 `status` 响应。home 进程运行时以 0 退出，没有运行时以 3 退出，出错时以 1 退出。

<a id="start-at-login"></a>

## 登录时启动

登录时启动默认关闭。本人通过 `delorun start --at-login` 或 setup 中的问题开启它，通过 `delorun stop --at-login` 关闭它。

| 平台 | 登录项 |
| --- | --- |
| Linux | systemd 用户单元 `~/.config/systemd/user/delorun-<profile>.service` |
| macOS | 启动代理 `~/Library/LaunchAgents/com.delorun.home.<profile>.plist` |
| Windows | 在登录时触发的按用户计划任务 `delorun-home-<profile>` |

- 每个登录项都从 [C1](c01-home-layout.zh.md) 的启动器副本运行 `<home>/bin/delorun start --foreground --profile <profile>`，因此既不需要 npm，也不需要网络。
- 失败后，登录项在 300 秒内最多重启该进程 3 次，之后保持停止，直到下次登录或手动启动。

<a id="the-update-channel"></a>

## 更新通道

更新通道是 [C1](c01-home-layout.zh.md) 放在 `run/<profile>/update.sock` 的套接字，在 Windows 上则是 [C1](c01-home-layout.zh.md) 命名的命名管道。它承载读取或改变 home 进程状态的每个请求。

- **调用方。** 它服务两个调用方：读取令牌文件的本人的 `delorun` 命令，以及 Host 的更新插件；后者代表已由 studio 自身认证（上游的回环认证，或远程访问监听器上 C4 的准入）放行的 studio 会话，并附上它在内存中持有的令牌。studio 的「Update now」只通过这个通道抵达 home 进程。
- **令牌检查。** 每个连接的第一行是带有 `token` 字段的请求。home 进程以恒定时间把它与当前启动的令牌比较。缺失、格式错误、错误或属于之前某次启动的令牌收到 `UNAUTHENTICATED`，连接随即关闭；该响应不携带其他任何信息。
- **帧格式。** 每个连接承载一个请求，编码为一行最多 16,384 字节的 UTF-8 JSON，以及回答它的若干响应行，每行一个 JSON 对象后跟换行符。home 进程在最后一个响应行之后关闭连接。
- **时限。** 连接建立 5 秒后仍未收到请求行时，以 `REQUEST_TIMEOUT` 关闭连接。同一时间最多打开 8 个连接；更多的连接立即以 `BUSY` 关闭。
- **日志。** 被拒绝的认证会记录到日志，但不记录所提交的值，每秒最多一行；该秒内更多的拒绝计入下一行。

<a id="requests-and-responses"></a>

## 请求与响应

每个请求都有字段 `v`（协议版本，1）、`token`、`op`，以及操作需要时的 `args`。操作未定义的字段以 `SCHEMA_VIOLATION` 被拒绝。没有任何操作接受文件路径、归档、URL 或命令：更新只指定一个版本，由 home 进程自行获取并校验该版本（[C1](c01-home-layout.zh.md)、[C2](c02-release-manifest.zh.md)、[C18](c18-release-log.zh.md)）。

| `op` | `args` | 响应 |
| --- | --- | --- |
| `status` | 无 | 一行：`state`、`pid`、`startId`、`runtime`（`current`、`previous`、`running`）、`chats`（运行中的数量）、`update`（有更新进行时的阶段与目标） |
| `update.prepare` | `target`：一个版本，省略时为本人渠道上的最新发布 | 获取与校验该版本期间的进度行，然后是一行 `reportId` 与更新报告（[C3](c03-update-report.zh.md)） |
| `update.apply` | `reportId`；`wait`：`drain`、`abort-if-busy` 或 `cancel`；`drainTimeoutS`：60 至 86,400，默认 1,800 | 每个阶段的进度行，然后是带 `outcome`（`committed`、`rolled-back` 或 `aborted`）与原因代码的最后一行 |
| `update.cancel` | 无 | 一行；仍处于 `waiting` 的更新回到 `running`，运行时不变 |
| `rollback` | `wait` 与 `drainTimeoutS`，同 `update.apply` | 同 `update.apply`，目标为 `previous` |
| `stop` | `mode`：`drain` 或 `cancel` | 进度行，然后是进程退出前的最后一行 |

- **响应行。** 每行都有 `ok`（布尔值）；失败行带有 `error`，即[错误](#errors)中的代码；进度行带有 `phase`。报告在 `update.prepare` 返回后 600 秒过期；以过期或未知的 `reportId` 调用 `update.apply` 会以 `REPORT_EXPIRED` 失败。
- **一次一个。** 同一时间只运行一个更新或回滚；第二个以 `UPDATE_IN_PROGRESS` 失败。
- **断开的请求方。** 请求方断开连接不会改变正在运行的更新。`delorun status --follow` 显示正在进行的更新的阶段。

<a id="the-update-handshake"></a>

## 更新握手

更新把一个 profile 从正在运行的版本 `from` 移到目标版本 `to`。各阶段按以下顺序运行：

1. **`checking`。** 获取并检查 `to` 的发布元数据（[C2](c02-release-manifest.zh.md)）与日志条目（[C18](c18-release-log.zh.md)）。
2. **`installing`。** 按 [C1](c01-home-layout.zh.md) 的校验把 `to` 安装到运行时仓库，除非它已安装且其文件与其 manifest 一致。
3. **`reporting`。** 针对 `to` 计算更新报告（[C3](c03-update-report.zh.md)），并由 `update.prepare` 返回。在 `update.apply` 指定该报告之前，此阶段之后的步骤都不运行。
4. **`snapshot`。** 保存一个以该更新命名的 profile 历史版本，包括 home patch（[C3](c03-update-report.zh.md)）。
5. **`waiting`。** 运行中的 chat 是指本 Host 中有活动轮次或运行中后台作业的会话。从本阶段开始，新的轮次以 `UPDATE_PENDING` 被拒绝，studio 会连同取消操作一起显示它；计划投递被暂缓到更新结束。使用 `drain` 时，本阶段等待运行中的 chat 数量降为零，最多 `drainTimeoutS`，之后更新以 `DRAIN_TIMEOUT` 结束为 `aborted`。使用 `abort-if-busy` 时，若本阶段开始时有任何 chat 在运行，更新以 `CHATS_RUNNING` 结束为 `aborted`。使用 `cancel` 时，通过上游的取消机制取消运行中的轮次与作业，待它们结束后本阶段继续。
6. **`switching`。** 在没有 chat 运行且新轮次被拒绝的情况下，前任进程停止其 Host 与它启动的监管器，写入 [C1](c01-home-layout.zh.md) 的 `previous` 与 `current` 指针，写入日志文件，并从 `to` 以 `standby` 启动后继进程。前任通过作为文件描述符 3 继承的管道传递交接，从不通过命令行或环境变量传递。
7. **`health-check`。** 后继进程启动其 Host。满足以下条件即通过：Host 在 120 秒内完成启动，它在启动时禁用的插件是报告所列插件的子集，且 studio 监听器回答其健康请求。
8. **`committed`。** 后继进程通过管道报告 `ready`。前任以原子方式把锁改写为后继的进程 id 与 `startId`，然后关闭其更新通道。后继写入新的启动令牌，在更新通道上监听，启动监管器，进入 `running` 并删除日志文件。前任退出。

**`switching` 或 `health-check` 中的失败。** 后继进程退出、发送 `failed`，或未在 120 秒内报告 `ready` 时，前任停止它，把两个指针恢复为更新前的值，在 `from` 上重新启动自己的 Host，并回到 `running`。更新以带原因的 `rolled-back` 结束，[C3](c03-update-report.zh.md) 的回滚步骤恢复 profile 快照。

**由此保证的规则。** 只有在等待阶段确认运行中的 chat 为零且新轮次被拒绝之后，`current` 才切换，因此运行时从不在运行中的 chat 之下切换。从 `switching` 开始，到后继的监听器或恢复后的 Host 应答为止，studio 不可用。

<a id="interrupted-updates"></a>

## 被中断的更新

从 `snapshot` 起，home 进程在每个阶段开始时写入日志文件 `run/<profile>/update.json`（权限 0600）：`{"v":1,"from":"<version>","to":"<version>","previous":"<version>","phase":"<phase>","startedAt":"<RFC 3339 UTC time>"}`。`previous` 为更新前 [C1](c01-home-layout.zh.md) 的 `previous` 指针所指的版本，没有 `previous` 指针时该字段不存在。

- **被杀死的请求方。** 杀死发送请求的终端或进程不会停止更新；home 进程继续运行，并完成更新或将其回滚。
- **被杀死的 home 进程。** 每次指针写入都是 [C1](c01-home-layout.zh.md) 的原子重命名，因此 `current` 始终指向一个完整的已安装版本。下次启动时，启动顺序的第 3 步读取日志文件：
  - 阶段早于 `switching` 时，它删除日志文件，没有任何改变；
  - 阶段为 `switching` 或 `health-check` 且 `current` 指向 `to` 时，启动对 `to` 运行健康检查；检查失败时，它把两个指针恢复为更新前的值（`current` 恢复为 `from`，`previous` 恢复为日志文件中的 `previous`，日志文件中没有该字段时则删除 `previous`），从 `from` 重新启动并记录这次回滚；
  - `current` 指向 `from` 时，启动先把 `previous` 恢复为日志文件中的 `previous`（日志文件中没有该字段时则删除 `previous`——两次指针写入之间被杀时它留存的是 `from`），再运行 `from` 并删除日志文件。
- **已安装的版本。** 被中断的更新安装的版本作为非当前版本留在仓库中，直到 [C1](c01-home-layout.zh.md) 的保留规则删除它。

<a id="rollback"></a>

## 回滚

- **CLI 运行时。** `delorun recover --runtime previous` 或 studio 的回滚发送 `rollback`。它以 `previous` 为目标运行握手的 `reporting`、`snapshot`、`waiting`、`switching` 与 `health-check` 阶段，不安装任何内容。提交之后，`current` 指向回滚到的版本，`previous` 指向回滚前的版本。没有 home 进程运行时，`delorun recover --runtime previous` 获取 home 锁与 `store.lock`，直接交换两个指针。
- **自动回滚。** 更新期间的健康检查失败，或被中断的更新之后启动时的健康检查失败，会按握手的规定恢复指针。
- **Profile。** [C3](c03-update-report.zh.md) 负责回滚触发条件与 profile 快照的恢复；本约定负责运行时切换。
- **桌面应用。** 桌面应用的回滚不使用运行时仓库。应用在其更新缓存中保留上一个已签名发布；其更新源拒绝自动降级，但接受本人请求的、回滚到已签名且已记入日志的较早发布（[C2](c02-release-manifest.zh.md)）。回滚从缓存重新安装该发布，并从桌面 profile 的历史恢复它。

<a id="the-desktop-app"></a>

## 桌面应用

- 桌面 Host 保留上游的 `desktop` profile，并运行在桌面应用自带的运行时上。它不获取 CLI 锁，没有启动令牌，也没有更新通道。
- `delorun update` 与 `delorun recover` 从不停止、排空或切换桌面 Host。运行中的桌面 Host 从不阻止 `delorun start`。
- 桌面应用通过自己的更新源（[C2](c02-release-manifest.zh.md)）更新，在更新报告（[C3](c03-update-report.zh.md)）中有自己的条目。
- 两个入口按上游各入口的共享方式使用 home 下的会话与工作区。桌面 Host 的 chat 不计入 CLI 更新的运行中 chat，因为它们不运行在 CLI 运行时上。

<a id="limits"></a>

## 限额

| 限额 | 值 |
| --- | --- |
| 每个 CLI profile 的 home 进程 | 1 |
| `delorun start` 等待 `running` | 120 秒 |
| 请求行 | 最多 16,384 字节 |
| 从连接到请求行的时间 | 5 秒 |
| 更新通道上打开的连接 | 最多 8 个 |
| 认证被拒的日志行 | 每秒最多 1 行 |
| 更新报告有效期 | 600 秒 |
| `drainTimeoutS` | 60 至 86,400 秒，默认 1,800 |
| `delorun stop` 的排空 | 1,800 秒 |
| 后继的 `ready` 与健康检查 | 120 秒 |
| 登录项重启 | 300 秒内最多 3 次 |
| 每个 profile 同时进行的更新或回滚 | 1 |
| 协议版本 `v` | 1 |

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `UNAUTHENTICATED` | 请求的令牌缺失、格式错误、错误或来自之前某次启动 |
| `SCHEMA_VIOLATION` | 请求的 `op` 未知、字段未知或字段类型错误 |
| `REQUEST_TIMEOUT` | 5 秒内未收到请求行 |
| `REQUEST_TOO_LARGE` | 请求行超过 16,384 字节 |
| `BUSY` | 已打开 8 个连接 |
| `UPDATE_IN_PROGRESS` | 已有更新或回滚在运行 |
| `REPORT_EXPIRED` | `update.apply` 指定的报告未知或已超过 600 秒 |
| `UPDATE_PENDING` | 因有更新在等待运行中的 chat，新轮次被拒绝 |
| `CHATS_RUNNING` | `abort-if-busy` 发现有运行中的 chat |
| `DRAIN_TIMEOUT` | 运行中的 chat 未在 `drainTimeoutS` 内降为零 |
| `HEALTH_CHECK_FAILED` | 后继未通过健康检查，或未在 120 秒内报告 `ready` |
| `VERIFY_FAILED` | 目标的元数据、日志条目或文件未通过 [C1](c01-home-layout.zh.md)、[C2](c02-release-manifest.zh.md) 或 [C18](c18-release-log.zh.md) 的检查 |
| `NO_PREVIOUS` | 请求了回滚，但不存在 `previous` 指针 |

<a id="consumers"></a>

## 使用方

- `delo/packages/home-process`：home 进程、更新通道、握手、日志文件与登录项。
- `delo/apps/cli`：`delorun`、`delorun start`、`stop`、`status`、`update` 与 `recover`。
- `delo/packages/runtime-store`：握手调用的指针写入与安装（[C1](c01-home-layout.zh.md)）。
- `delo/packages/logs`：home 进程的运行日志（[C20](c20-operational-logs.zh.md)）。
- `@delo/bundle-local` 中 Host 的更新插件：「Update now」与 studio 的回滚。
- 更新报告及其界面（[C3](c03-update-report.zh.md)），读取各阶段与结果。

<a id="compatibility"></a>

## 兼容性

- 协议版本 `v` 为 1。home 进程对 `v` 未知的请求回答 `SCHEMA_VIOLATION`。删除或重命名某个操作、字段或阶段的变更会提高 `v`，提高它的运行时在一个发布内同时接受两个版本，使上一个发布的 `delorun` 仍能更新它。
- 新的操作、可选字段与新的错误代码保持 `v` 不变；调用方忽略未知的响应字段。
- 上述登录项路径与命令参数是外部接口；改变其中任一项都是破坏性变更，需在 `delo/docs/upgrade-guide/` 下附升级指南。
- 类型包跟随 Delo 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

### 要求

1. 更新通道的套接字位于 home 之下；凡 [C1](c01-home-layout.zh.md) 的规则得到强制执行之处，受限命令都不能读取或连接它。方言无法强制执行这些规则时，`delorun verify` 通过 [C15](c15-verification-checks.zh.md) 的 `confinement-rule` 检查报告这一点。
2. 通道只接受携带当前 home 进程启动令牌的请求，并以恒定时间比较；缺失、错误或属于之前某次启动的令牌以 `UNAUTHENTICATED` 被拒绝，不附任何其他信息。
3. 通道只服务本人的 `delorun` 命令，以及代表已认证 studio 会话的 Host 更新插件。
4. 没有请求携带路径、归档、URL 或命令，因此持有令牌的调用方只能选择一个版本，由 home 进程自行获取并校验。
5. home 锁按 profile 划分。桌面 Host 既不获取它，也不加入排空，`delorun update` 从不切换桌面应用。
6. 只有在旧运行时上没有 chat 运行且新轮次被拒绝时，`current` 才切换；被中断的更新让一个完整版本处于当前状态，健康检查失败会恢复之前运行的版本。
7. 请求大小、请求时限与连接数都有限额，被拒绝的认证记录到日志时不含所提交的值。在 Landlock 下，受限命令仍能打开连接直至达到这些限额；这只影响可用性，`delorun` 会重试 `BUSY` 的连接。
8. 交接通过继承的管道传递；令牌从不出现在命令行、环境变量、响应或日志中。
9. 该保护依赖于对 agent 命令的限制。沙箱之外的本人用户进程可以自行运行 `delorun update`，本约定不声称能防范它。不存在 root 所有的辅助程序。
10. 只有不受限制地运行的命令才能携带令牌抵达更新通道。`danger-full-access` 提权只能经由 [C1](c01-home-layout.zh.md) 的提权提示批准，该提示说明完全访问可以触及 Delo 的 home、其令牌、Docker 监管器与更新通道。

### 拒绝测试

| 测试 | 证明 |
| --- | --- |
| `update-waits-for-chat` | 在样例 chat 的轮次运行期间应用的更新停留在 `waiting`，在该轮次结束前 `current` 保持不变；这期间的新轮次以 `UPDATE_PENDING` 被拒绝；使用 `abort-if-busy` 时更新以 `CHATS_RUNNING` 结束为 `aborted` |
| `update-channel-connect-denied` | 在每种强制执行 [C1](c01-home-layout.zh.md) `home-connect` 的方言上，受限的工作区命令连接更新通道失败，且无法读取启动令牌 |
| `update-channel-token-required` | 不带令牌、带错误令牌以及带之前启动令牌的请求，都收到 `UNAUTHENTICATED` 且没有其他字段 |
| `update-channel-landlock` | 在 Landlock 下，受限的工作区命令连接更新通道成功，但因无法读取令牌，其请求以 `UNAUTHENTICATED` 失败，`delorun verify` 会报告这一状态 |
| `update-channel-not-enforced-reported` | 在无法强制执行 [C1](c01-home-layout.zh.md) 规则的方言样例上，`delorun verify` 把它们报告为 `not-enforced` |
| `update-request-fields` | 带路径、URL 或命令字段，或带未知 `op` 的请求以 `SCHEMA_VIOLATION` 被拒绝，且不改变任何内容 |
| `update-request-limits` | 超过 16,384 字节的请求行、静默 5 秒的连接以及第九个连接，都以各自的代码关闭 |
| `desktop-independent` | 样例桌面 Host 运行时，`delorun start` 成功，`delorun update` 让桌面进程继续运行，桌面 profile 逐字节不变 |
| `requester-killed` | 在每个阶段杀死发起请求的终端，home 进程都继续运行，`current` 指向一个完整版本 |
| `home-killed-mid-switch` | 在 `switching` 与 `health-check` 中杀死 home 进程，`current` 都指向一个完整版本，且 `to` 失败时下次启动回滚到 `from` |
| `health-check-rollback` | 禁用了报告未列出插件的后继被回滚，前任的 Host 在 `from` 上重新运行 |
| `escalation-prompt-before-full-access` | 为发送更新请求而请求 `danger-full-access` 的受限工作区命令会看到 [C1](c01-home-layout.zh.md) 的提权提示，该提示指明更新通道；提示被拒绝或未作答期间，命令仍受限制，其请求被拒绝或根本未发送 |

### 本约定不能证明的内容

- **Landlock。** 受限命令能连接更新通道；拒绝只依赖于令牌不可读。这样的命令还能占用连接直至通道的限额，这会影响可用性。
- **完全访问。** 获准 `danger-full-access` 的命令可以读取令牌，并在封闭的请求集合内发送 `delorun` 命令能发送的任何请求。
- **进程内存。** 在 macOS 与 Windows 上，对 home 进程内存的保护依赖于操作系统自身关于读取其他进程内存的规则，没有 Delo 测试证明这一点。
- **本人自己的进程。** 沙箱之外的本人用户进程可以读取令牌，并自行运行 `delorun update`。

<a id="enforcement-per-platform-and-dialect"></a>

## 各平台与方言的强制执行情况

更新通道继承 [C1](c01-home-layout.zh.md) 对受限命令的规则；`delorun verify` 按 [C1](c01-home-layout.zh.md) 的表格报告它们，本表给出通道由此产生的行为。

| 平台与方言 | 受限命令的连接 | 其请求 |
| --- | --- | --- |
| Linux，bwrap | 失败：套接字被 tmpfs 遮蔽 | 未发送 |
| Linux，Landlock | 成功：Landlock 无法拒绝它 | 以 `UNAUTHENTICATED` 被拒绝：令牌不可读 |
| macOS，Seatbelt | 失败：`remote unix-socket` 路径字面量 | 未发送 |
| Windows，windows-acl | 在 `windows-pipe-connect-denied` 通过时失败：管道无法以写方式打开 | 未发送 |
| 无沙箱或 `danger-full-access` | 成功 | 命令读取令牌文件后被接受，与本人用户的任何进程相同 |

- **登录项。** systemd 用户单元、启动代理与计划任务都以本人的用户身份和该用户的访问权限运行；没有一个以提升的权限运行。
- **进程检查。** 令牌只保存在内存与令牌文件中，从不出现在命令行或环境中，而在 macOS 与 Linux 上同一用户的进程可以列出这些内容。bwrap 为受限命令提供独立的进程命名空间，Landlock 拒绝受限命令跟踪其域之外的进程。
