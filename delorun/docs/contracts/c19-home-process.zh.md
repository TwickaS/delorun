---
description: "约定 C19：持有 CLI profile 锁并运行其 Host 的 home 进程，delorun start、stop 与 status，登录时启动，带每次启动令牌的更新通道协议，运行时切换前如何排空运行中的 chat，交接与健康检查，被中断的更新，回滚，以及桌面应用的独立更新。"
---

# C19 Home 进程与更新握手

[English](c19-home-process.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本约定定义让本人的 CLI home 保持运行的后台进程，以及更新抵达它所经过的握手。每个 CLI profile 有一个 home 进程，它在 `~/.delorun` 下持有该 profile 的锁，运行其 Host，并在每次启动时写入一个新的启动令牌。`delorun update` 与 studio 的「Update now」通过更新通道抵达它；更新通道是 `~/.delorun` 下的一个套接字，只接受携带当前令牌的请求。更新会等到旧运行时上没有 chat 运行，再把 profile 交给运行在新运行时上的进程，检查其是否健康，不健康时回滚，因此被中断的更新始终让一个完整版本处于当前状态。桌面应用保留上游自己的 Host 与 profile，并独立更新。类型包 [`@delorun/contract-home-process`](../../packages/contract-home-process/README.zh.md) 提供协议、状态与限额。

<a id="status"></a>

## 状态

home 进程、带令牌检查与固定请求集合的更新通道、握手、被中断的更新与回滚都已构建，并由 `delorun`、`delorun start`、`stop`、`status`、`update` 与 `recover` 使用；监管器的启动、限制探测、登录时启动、studio 的调用方与 Windows 管道尚未构建。

- **已构建并已接入：** 锁；以恒定时间比较的每次启动令牌；Host 的通道令牌与 `studio.open-token`（由 `delorun open`、启动过程与 setup 的结尾使用）；位于 Unix 套接字 `run/<profile>/update.sock` 上、带请求、大小、时间与连接限额的更新通道；带 CLI profile 轮次拒绝的排空；通过继承管道的交接；健康检查与自动回滚；以及在下次启动时完成被中断更新的日志文件。
- **未构建：** 启动顺序的第 6 步，因为 `delorun start` 不向 home 进程传递监管器（[C9](c09-runtime-supervisor.zh.md)）；第 8 步，即限制探测，以及 `delorun verify` 对其结果的报告；登录时启动、`--at-login` 及其运行的启动器副本；Host 的更新插件已构建，因此 studio 的 Update now、回滚与 Stop 都能抵达该通道；`delorun status --follow`；Windows 上的命名管道：通道在每个平台上都使用同一个套接字路径，没有测试表明它能在 Windows 上打开，windows-acl 也没有拒绝受限命令连接或读取令牌的规则；要求 10 所指的提权提示措辞（[C1](c01-home-layout.zh.md)）。
- **Delorun 的沙箱规则未覆盖：** 在 `danger-full-access` 下运行的命令（`delorun headless` 任务只有在工作目录记录了完全访问授权时才会到达这种情况），以及 `delorun plugin` 操作所运行的命令，都能在 home 进程运行期间读取启动令牌并连接通道；要求 4 的封闭请求集合仍然适用于它们。

下文中被本列表列为未构建或无任何调用方接入的要求与拒绝测试，在某次变更构建并接入它们之前不保护任何人。

## 目录

- [状态](#status)
- [home 进程](#the-home-process)
- [命令](#commands)
- [登录时启动](#start-at-login)
- [更新通道](#the-update-channel)
- [请求与响应](#requests-and-responses)
- [更新握手](#the-update-handshake)
- [被中断的更新](#interrupted-updates)
- [回滚](#rollback)
- [重启](#the-restart)
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
- **其他 profile。** 不同 CLI profile 的 home 进程可以同时运行：每个都有自己的锁、令牌、通道与 studio 端口，它们共享 home 的 chat 数据与 `current`（[C1](c01-home-layout.zh.md)）。因此每个 home 进程在获取锁之前，都会在 C1 的 `run/data-users/` 下以其 profile 注册为共享使用方，并保持该注册直到退出。当 `delorun trash` 或离线的 `delorun recover rollback` 这类独占使用方已注册，或另一个 profile 的更新或回滚处于其快照与结束之间时，它拒绝启动。当另一个 profile 的 home 进程或其他使用方已注册时，更新的准备、会话数据副本、恢复与运行时切换，以及除仅 profile 回滚之外的每次回滚，都以 `CHATS_RUNNING` 拒绝，并写明该使用方及其 profile；进程自身的注册从不计入。无论是否制作副本，`update.apply` 都在写入更新记录之前检查一次，并在 `switching` 中、记录写入之后、Host 停止之前再检查一次：在记录存在之前注册的使用方由第二次检查发现，之后注册的使用方会发现该记录并自行拒绝。
- **脱离终端。** `delorun start` 以脱离终端的方式启动它，关闭标准输入，并把标准输出与标准错误导入其运行日志（[C20](c20-operational-logs.zh.md)）。
- **状态。** `starting`、`running`、`waiting`（更新在等待运行中的 chat）、`switching`（正在交接到新运行时）、`stopping`。由交接启动的后继进程在交接完成前处于 `standby`。
- **启动顺序。** 启动按下列顺序执行各步，在第一次失败时停止，并把失败写入日志和发起启动的终端：
  1. 检查 home、`secrets/` 与 `run/<profile>/` 的权限模式（[C1](c01-home-layout.zh.md)）；
  2. 获取 home 锁，否则以 `HOME_RUNNING` 或 `HOME_UNRESPONSIVE` 停止；
  3. 运行[启动前步骤](#host-invariants)，然后根据更新日志文件完成被中断的更新（[被中断的更新](#interrupted-updates)）；在运行时仓库之外运行的进程在记录不是 `committed` 时于此以 `NO_RUNTIME_STORE` 停止，并保留该记录；
  4. 写入新的启动令牌（[C1](c01-home-layout.zh.md)）；
  5. 在更新通道上监听，从这一步起它对 `status` 回答 `starting`；
  6. 机器已设置 Docker 时启动 Docker 监管器（[C9](c09-runtime-supervisor.zh.md)）；尚未构建，因此不启动任何监管器；
  7. 通过 Delorun 唯一的组合启动 Host，并使其遵守 [Host 不变量](#host-invariants)；
  8. 运行 [C1](c01-home-layout.zh.md) 的限制探测并记录结果；尚未构建，因此不运行任何探测；
  9. 进入 `running`。
- **正常停止。** 进程关闭 Host，删除令牌文件，关闭更新通道，停止它启动的监管器，删除锁并退出。关闭失败的 Host 会被记录到日志，后续步骤照常执行。
- **启动失败。** 在 Host 已启动之后失败的启动（包括被 [Host 不变量](#host-invariants)拒绝的 Host）会通过 Host 自身的拆除流程停止它，该流程不结束任何进程，最多等待 5 秒，然后完成其失败处理：被中断更新的回滚、锁的释放、重新启动与拒绝。拆除失败或耗时更长时，Host 可能仍在使用数据：拒绝信息还会写明拆除情况，不回滚也不重新启动任何内容，锁保持被持有，进程在报告拒绝后以 1 退出。
- **信号。** 从启动持有锁的那一刻起，或从后继开始启动其 Host 起，只有该进程响应 `SIGTERM` 与 `SIGINT`；Host 的 profile 运行器不安装任何信号或失败即报错的处理器。第一个信号立即执行正常停止，不等待 chat，对 `SIGTERM` 以 0 退出，对 `SIGINT` 以 130 退出。在该停止运行期间收到的第二个信号会以其自身的代码立即退出。Host 启动期间收到的信号会删除令牌、套接字与锁，正在启动的 Host 随进程一同结束。

<a id="host-invariants"></a>

### Host 不变量

Delorun 在 home 之上启动的每个 Host 都经过同一个组合：前台启动、其脱离终端的子进程、setup 的结尾、更新或回滚的后继，以及被中断更新之后的启动（都运行 `delorun start --foreground`），安全模式，以及 `delorun headless`——它启动 home 的 `headless` profile，即链接了 `@delorun/bundle-headless` 的上游 `headless` 模板。该组合准备 profile，拒绝跳过了某个 Delorun 组合包的 profile，拒绝未加载 `@delorun/bundle-headless` 的 `headless` profile，应用安全模式过滤后的层与 overlay，应用已批准插件内容步骤的 overlay，并最后写入 [C1](c01-home-layout.zh.md) 的沙箱 overlay，使其覆盖在组合包层、profile patch、home patch 与其他每个 overlay 之上。在任何插件运行之前检查组合后的行，启动之后再次检查 Loader 的行：

- 每个必需行、`sandbox` 行以及 Delorun 组合包插入的每一行，都由声明它的组合包插入一次（`sandbox` 由上游的 `@deepseek-ai/dsh-base` 插入，Delorun 行由 Delorun 组合包插入），并运行该组合包指定的插件：任何其他组合包、profile patch、home patch 或 overlay 对该 id 的第二次插入都会被拒绝，因为上游会挂载两个条目，后一个会替换该行；
- 每个必需行都已启用且处于活动状态，安全模式的 overlay 从不豁免其中任何一行；
- `sandbox` 行的 `protectedHome` 是 home 的真实路径，其 `deniedSockets` 包含 C1 拒绝的每个套接字，其 `escapeSocketDirectories` 包含启动过程指定的每个目录（例如 WSL 的 `/run/WSL`），且它不设置 `runnerCommand` 或 `runnerFailureSignatures`；
- 在 CLI profile 中，每个提示行的开关取已记录的提示答案赋予它的值（「Ask me first」取 Delorun 的默认值，「Ask less (like DeepSeek Harness)」取对等值），且 `delorun-fetch-guard` 与 `delorun-update-gate` 为开启，更新闸门带 `holdUntilChecked`，若 `delorun` 未释放它，等待中的轮次在 `checkWaitSeconds`（默认 60）之后以 `START_CHECK_PENDING` 结束；在没有 setup 答案的 `headless` profile 中，`@delorun/bundle-headless` 的各行取 Delorun 的默认值：`delorun-instruction-consent`、`delorun-mcp-consent`、`delorun-schedule-consent`、`delorun-permission-defaults`、`delorun-fetch-guard` 与 `delorun-update-gate` 为开启，更新闸门带 `holdUntilChecked`，且插件管理像 `@delorun/bundle-local` 那样保护这些行与沙箱行；
- 启动之后，必需行提供的每个服务都由该行的 fiber 或其下的 fiber 提供，而不仅仅是存在：`sandbox` 由 `sandbox` 提供，`fetchGuard` 由 `delorun-fetch-guard` 提供，`delorunTurnGate` 由 `delorun-update-gate` 提供，`writeConsent`、`mcpAddConsent` 与 `scheduleConsent` 由各自的同意行提供，`permissionDefaults`、`sandboxModeGuard`、`delorunCommandNetwork` 与 `sandboxNetwork` 由 `delorun-permission-defaults` 提供；只有当某行的开关关闭时，其服务才可以不存在。

违反这些规则会在启动之前停止启动，或停止已启动的 Host，并给出一条拒绝信息，写明每一行、设置该值的文件以及补救办法：删除该设置，或运行 `delorun recover safe-mode`。在 CLI profile 与 `headless` profile 中，更新闸门会保持每个 agent 轮次的第一步，直到已启动的 Host 通过检查，因此任何轮次的模型请求都不会在此之前发送；被拒绝的 Host 停止时仍在等待的轮次以 `UPDATE_PENDING` 被拒绝。闸门只保持轮次：轮次步骤之外的模型调用，例如上游的 chat 标题生成、自动审查以及本人发起的压缩，不受保持。在 `headless` profile 中，没有更新或停止会等待该闸门；它保持任务的第一步直到检查通过，因此任务只在 Delorun 检查了各行与各服务之后才开始，被检查拒绝的 Host 会与任务一同停止。需要询问本人的防护在 `headless` profile 中会拒绝，因为它不组合任何审批应答方。在 `headless` profile 中，`delorun-permission-defaults` 的完全访问同意会拒绝在没有完全访问授权的工作目录中切换到完全访问的每个请求，本人在 home 的电脑上于 studio 中或使用 `delorun workspace full-access` 记录该授权。当 `delorun headless` 从 `--permission-mode`（`danger-full-access`，或任一层映射到 `danger-full-access` 沙箱模式的预设）或 `DSH_PERMISSION_MODE=danger-full-access`（各自去除首尾空白并忽略大小写）读到这样的请求，或无法读取授权记录时，它也会在启动之前提前拒绝。`delorun headless` 运行在启动之后崩溃时，由 CLI 的最后兜底处理器结束进程，该处理器会先在其时限内销毁 Host。启动从不使用上游的浏览器交接，因此 studio 只有在 home 进程运行、检查通过之后，才通过 `studio.open-token` 打开。

在任何 Host 启动之前，会运行一个有序的启动前步骤列表：撤回被中断的库存 DeepSeek Harness home 导入；完成被中断的会话数据副本恢复（[C3](c03-update-report.zh.md)）；这两步在运行期间都会把启动自身的数据使用方注册改为独占，并在有其他进程注册时拒绝；在全新启动（而非更新的后继）以及每次 `delorun headless` 运行时，执行 profile 的 `delorun-migrations.json` 未列出的 profile 一次性变更，该记录无法读取时不执行任何变更（[C1](c01-home-layout.zh.md#profiles)）；`headless` profile 的变更 `headless-bundle` 链接 `@delorun/bundle-headless`，并在首次运行时创建该 profile；以及更新提示的检查，这是一个在该功能落地之前不做任何事的位置。home 进程在持有其 home 锁之后、完成被中断的更新之前运行该列表；`delorun headless` 在注册为 chat 数据的共享使用方之后运行导入与提示步骤以及 profile 的一次性变更。任一步骤抛出异常都会拒绝启动。

Host 的启动环境是上游的 `.env` 层（工作目录的与 harness home 的）叠加在 `delorun` 启动时的环境之上。设置了 `DELORUN_` 名称的层会在任何层生效之前被拒绝，启动器的发布根目录与 Docker 上下文从 `delorun` 启动时的环境读取。`delorun headless` 使用 `headless` profile，并拒绝上游的 `--profile`、`--patch`、`--from-default-profile` 与配置转储；它不获取 home 锁，因为它不提供更新通道，并注册为 chat 数据的共享使用方。

<a id="commands"></a>

## 命令

- **`delorun start`** 为该 profile 启动 home 进程，并等待它报告 `running`，最多 120 秒；未进入 `running` 的启动会打印失败原因与日志位置。若已有存活的 home 进程回答 `status`，该命令打印其状态并以 0 退出。`--foreground` 在终端中运行该进程，同时写入其日志。会先安装登录项的 `--at-login`（[登录时启动](#start-at-login)）尚未构建。
- **不带参数的 `delorun`** 在没有 CLI profile 的 home 上运行 setup；否则它像 `delorun start` 一样启动 home 进程，并像 `delorun open` 一样打开 studio。
- **`delorun open`** 以 `studio.open-token` 向运行中的 home 进程请求一个 studio 链接，并把它交给默认浏览器；`--print` 改为打印该链接一次，`--port <n>` 为一个转发到 studio 的回环端口生成链接。在 Delorun 的组合下，该链接只能在 60 秒内登录一次（[C4](c04-admission.zh.md#launch-tokens)）。启动会打印不带令牌的 studio 地址以及指出 `delorun open` 的那一行；`delorun start --open`、不带参数的 `delorun` 与 setup 的结尾通过 `studio.open-token` 打开 studio，从不从日志中读取地址。没有 home 进程运行时，`delorun open` 以 3 退出。
- **`delorun stop`** 以 `drain` 模式发送 `stop`：home 进程拒绝新的轮次，等待运行中的 chat 最多 1,800 秒，然后停止。`--now` 发送 `cancel` 模式，通过上游的取消机制取消运行中的轮次与后台作业，然后停止。在另一个 `stop` 等待期间发送的 `stop` 会加入它并得到相同的最后一行；加入的 `cancel` 会先取消运行中的 chat，因此 `delorun stop --now` 会结束正在排空的停止的等待。被接受的停止总会发送其最后一行并结束进程：取消失败会被记录到日志，停止继续进行；无法读取的状态会从该行中省略。`--at-login` 同时移除登录项。没有 home 进程运行时，该命令打印这一情况并以 0 退出。对于 `--now` 停止，若 home 进程在 60 秒内未发送最后一行、未发送最后一行就关闭了通道，或在接受后 120 秒仍未退出，则以信号结束它：先 `SIGTERM`，若 30 秒后进程仍在运行则 `SIGKILL`。每次发送信号之前，该命令都确认该进程是锁的持有者：锁仍持有开始时读取的记录，且存活的进程具有其 `pid` 与 `processStart`，并在记录了 `pidNamespace` 时位于该命名空间中。无法确认的持有者（未记录 `processStart`、另一个或无法读取的 pid 命名空间、不同或无法读取的启动标识，或无法读取的锁）不会被发送信号；该命令写明进程 id 以及需要检查的内容，并以 1 退出。Windows 不记录启动标识，因此在那里 `--now` 从不发送信号。该命令打印它发送了哪个信号以及进程是否已退出；`SIGKILL` 之后它还会打印 Delorun 启动的命令可能仍在运行，因为在其自身 systemd scope 中启动的命令会在 home 进程结束后继续存在。`SIGKILL` 5 秒后仍在运行的进程使该命令以 1 退出。拒绝停止的 home 进程以及排空停止从不会被发送信号。
- **`delorun status`** 打印状态、进程 id、`startId`，`current`、`previous` 与运行中的运行时版本，正在进行的更新的阶段（如有）、运行中的 chat 数量以及 studio 的地址；它不打印启动器版本；它不显示登录项，因为登录项尚未构建。`--json` 打印 `status` 响应。home 进程运行时以 0 退出，没有运行时以 3 退出，出错时以 1 退出。

<a id="start-at-login"></a>

## 登录时启动

登录时启动尚未构建：`delorun start` 与 `delorun stop` 不接受 `--at-login` 选项，setup 不询问这样的问题，也不安装任何登录项。下面的规则是要求。登录时启动默认关闭。本人通过 `delorun start --at-login` 或 setup 中的问题开启它，通过 `delorun stop --at-login` 关闭它。

| 平台 | 登录项 |
| --- | --- |
| Linux | systemd 用户单元 `~/.config/systemd/user/delorun-<profile>.service` |
| macOS | 启动代理 `~/Library/LaunchAgents/com.delorun.home.<profile>.plist` |
| Windows | 在登录时触发的按用户计划任务 `delorun-home-<profile>` |

- 每个登录项都从 [C1](c01-home-layout.zh.md) 的启动器副本运行 `<home>/bin/delorun start --foreground --profile <profile>`，因此既不需要 npm，也不需要网络。
- 失败后，登录项在 300 秒内最多重启该进程 3 次，之后保持停止，直到下次登录或手动启动。
- **`npx delorun@latest repair`** 是启动器自己的命令，而不是 home 进程的命令：它只在启动器中、从终端、且没有任何 profile 的 home 进程运行时才运行（`HOME_RUNNING` 写明 `delorun stop`）。它不接受来自更新通道、Connection 路由或远程设备的请求，通道的请求集中没有针对它的操作；拒绝规格 `apps/npm-launcher/tests/repair.spec.ts` 守住这一点。

<a id="the-update-channel"></a>

## 更新通道

更新通道是 [C1](c01-home-layout.zh.md) 放在 `run/<profile>/update.sock` 的套接字，在 Windows 上则是 [C1](c01-home-layout.zh.md) 命名的命名管道。它承载读取或改变 home 进程状态的每个请求。

- **调用方。** 它服务读取令牌文件的本人的 `delorun` 命令。任何 Host 都不读取另一个 profile 的令牌文件，也不向另一个 profile 的通道发送请求。Host 的更新插件（`@delorun/plugin-update`）代表已由 studio 自身认证（上游的回环认证，或远程访问监听器上 C4 的准入）放行的 studio 会话行事，并附上它在内存中持有的令牌；它在读取请求之前，依据 Changes 访问表决定谁可以更新、回退或停止，并且从不把令牌或报告 id 交给页面。
- **调用方规则。** 请求携带的令牌指明其调用方：令牌文件中的令牌指明本人自己的命令，Host 的通道令牌指明 Host。每个操作都接受两者，但 `studio.open-token`、`devices.approve`、`devices.remove`、`devices.elevate`、`pin.set`、`pin.options`、`pin.off`、`pin.resume`、`mcp.accept`、`mcp.decline` 与 `mcp.revoke` 除外，home 进程会在读取其他任何内容之前对 Host 的通道令牌拒绝这些操作（`UNAUTHENTICATED` 与 `LOOPBACK_REQUIRED`），因为 Host 代表每个监听器上的会话行事，包括远程访问会话（[C14](c14-oidc-passkeys.zh.md#tailnet-membership)）。
- **令牌检查。** 每个连接的第一行是带有 `token` 字段的请求。home 进程以恒定时间把它与当前启动的令牌比较。缺失、格式错误、错误或属于之前某次启动的令牌收到 `UNAUTHENTICATED`，连接随即关闭；该响应不携带其他任何信息。
- **Host 的通道令牌。** home 进程在每次启动时创建第二个令牌，只把它保存在内存中，并在 Host 启动时通过其收到的 `UpdateChannelAccess` 交给 Host。通道对除 `studio.open-token` 之外的每个操作都接受它，`studio.open-token` 对它回答 `UNAUTHENTICATED`。
- **帧格式。** 每个连接承载一个请求，编码为一行最多 16,384 字节的 UTF-8 JSON，以及回答它的若干响应行，每行一个 JSON 对象后跟换行符。home 进程在最后一个响应行之后关闭连接。
- **时限。** 连接建立 5 秒后仍未收到请求行时，以 `REQUEST_TIMEOUT` 关闭连接。同一时间最多打开 8 个连接；更多的连接立即以 `BUSY` 关闭。
- **日志。** 被拒绝的认证会记录到日志，但不记录所提交的值，每秒最多一行；该秒内更多的拒绝计入下一行。

<a id="requests-and-responses"></a>

## 请求与响应

每个请求都有字段 `v`（协议版本，1）、`token`、`op`，以及操作需要时的 `args`。操作未定义的字段以 `SCHEMA_VIOLATION` 被拒绝。没有任何操作接受文件路径、归档或 URL，也没有任何操作指定由 home 进程运行的命令：更新只指定一个版本，由 home 进程自行获取并校验该版本（[C1](c01-home-layout.zh.md)、[C2](c02-release-manifest.zh.md)、[C18](c18-release-log.zh.md)）；`mcp.revoke` 只以接受 id 指定一个已接受的 MCP 服务器启动。

| `op` | `args` | 响应 |
| --- | --- | --- |
| `status` | 无 | 一行：`state`、`pid`、`startId`、`runtime`（`current`、`previous`、`running`）、`chats`（运行中的数量）、`update`（有更新进行时的阶段与目标） |
| `update.prepare` | `target`：一个版本，省略时为本人渠道上的最新发布 | 获取与校验该版本期间的进度行，然后是一行 `reportId` 与更新报告（[C3](c03-update-report.zh.md)） |
| `update.apply` | `reportId`；`wait`：`drain`、`abort-if-busy` 或 `cancel`；`drainTimeoutS`：60 至 86,400，默认 1,800；`dataCopy`：布尔值，即本人对会话数据副本的选择 | 每个阶段的进度行，然后是带 `outcome`（`committed`、`rolled-back`、`aborted` 或 `failed`）与原因代码的最后一行 |
| `update.cancel` | 无 | 一行；仍处于 `waiting` 的更新回到 `running`，运行时不变，仍在等待 chat 的[重启](#the-restart)则结束，此时该行带有 `"restartCancelled":true` |
| `rollback` | `wait` 与 `drainTimeoutS`，同 `update.apply`；`profileOnly`：布尔值 | 同 `update.apply`，目标为更新记录的 `from`；最终的 `outcome` 为 `rolled-back`、`aborted` 或 `failed` |
| `stop` | `mode`：`drain` 或 `cancel` | 进度行，然后是进程退出前的最后一行，能读取时带 `status` |
| `studio.open-token` | `port`，可选：转发到 studio 的回环端口，1 至 65535 | 一行：`url`，即 studio 的回环地址（给出 `port` 时以它代替 studio 自己的端口）以及 Host 为本次请求签发的启动令牌，和 `oneTime`，即该令牌是否只能在 60 秒内使用一次（[C4](c04-admission.zh.md#launch-tokens)）；没有 Host 运行、Host 不提供 studio、其 studio 在回环以外的地址上监听，或它在公共 URL 上发布 studio 时，返回带原因的 `STUDIO_UNAVAILABLE` |
| `changes.reload` | 无 | 一行 `reload`：Host 运行了 profile 文件所指定的内容时为 `{"ok":true}`；热重载关闭、插件加载或启动失败，或该更改需要重启时为 `{"ok":false,"error":"<why>"}`；更新或回滚正在运行，或进程不处于 `running` 时为 `UPDATE_IN_PROGRESS` |
| `devices.approve` | 无；`requestId` 与 `typedCode` 一起；或单独的 `cancelRequestId` | 不带参数时：打开 [C5](c05-device-approval.zh.md#approval-window) 的批准窗口，为本地的本人认领没有所有者的 home，并在有请求待处理或窗口关闭后回答一行 `closesAt` 与 `pending`；带 `requestId` 与 `typedCode` 时：[C5](c05-device-approval.zh.md#local-approval) 的本地批准，回答一行已批准的 `device`；带 `cancelRequestId` 时：取消该待处理请求，回答一行 `cancelled` |
| `devices.remove` | `deviceId` | 移除一台受信任的设备（[C5](c05-device-approval.zh.md)），立即结束其会话并关闭其远程访问连接，回答一行 `removed`、`sessions` 与 `connections` |
| `pin.set` | `secret`；可选的 `idleMinutes`（1 到 60）与 `lockWhenHidden`，只存储，没有效果 | 设置或替换 PIN 或口令并开启 PIN 模式（[C14](c14-oidc-passkeys.zh.md#pin-mode)）；回答一行 `enabled` 与 `secret` 的种类 `pin` 或 `passcode`；密钥绝不会在拒绝中回显，也不会被记入日志 |
| `pin.options` | `idleMinutes`（1 到 60）与 `lockWhenHidden`，至少一个 | 只更改已开启的 PIN 模式中存储的空闲分钟数与隐藏时锁定，无需密钥（[C14](c14-oidc-passkeys.zh.md#pin-mode)）；它们没有效果，因为没有设备持有解锁窗口；哈希保持不变；回答一行 `enabled: true`、`idleMinutes` 与 `lockWhenHidden`；模式关闭时为 `PIN_FAILED`（`PIN_MODE_OFF`） |
| `pin.off` | 无 | 关闭 PIN 模式并丢弃 PIN；回答一行 `enabled: false` |
| `pin.resume` | 无 | 恢复因全 home 十次错误尝试而暂停的 PIN 与 Face ID；回答一行 `paused: false` |
| `devices.elevate` | 无；`requestId` 与 `typedCode` 一起；或单独的 `revokeId` | 答复设备解锁敏感操作的请求（[C14](c14-oidc-passkeys.zh.md#elevation)）；无参数时：回答一行 `pending`，即等待中的请求，带 `requestId`、`deviceId`、`label`、`platform`、`requestedAt` 与 `expiresAt`，但从不带验证码，以及 `running`，即正在进行的提权，带 `id`、`deviceId`、`label`、`platform` 与 `endsAt`；带 `requestId` 与 `typedCode` 时：用设备显示的验证码批准该请求，回答一行已开始的 `elevation`（`id`、`deviceId`、`endsAt`）；带 `revokeId` 时：拒绝该请求或结束该提权，回答一行 `revoked`，即是否找到其中之一 |
| `permission.reload` | 无 | Host 重新读取 `@delorun/plugin-permission-defaults` 的按工作区权限存储，并把失去授权的工作区中打开的 chat 设回更安全的预设；一行 `digest`，即 Host 现在持有的存储条目的 SHA-256，`added` 与 `lost`，即自其打开的 chat 上次被设置以来，有多少工作区获得和失去了授权，存储无法读取时还带 `storeProblem`。没有任何 Delorun 进程发送它：每个 Host 都监视该存储文件，并在另一个进程写入后一秒内重新读取它，无论如何都会在其下一次决定时读取 |
| `mcp.list` | 无 | 一行 `servers`：Host 的添加时同意拒绝了其启动的每个 stdio MCP 服务器，带 `serverName`、`reviewId`、`command`、`args`、`cwd`、`resolvedCommand` 与 `resolvedCwd`（该启动实际解析到的绝对可执行文件和规范目录）、`resolvedShell`（在 Windows 上，运行批处理文件的命令 shell；其他情况下不出现）、`env`（每个变量的 `name`，只有 `NODE_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`PATH`、`PYTHONPATH` 与 `DYLD_*` 这些会改变运行内容的变量才带 `value`）、`files`（该启动所运行的文件，以 `path`（规范路径）和 `sha256`（内容的摘要）固定：先是可执行文件，其路径即服务器被生成时所用的文件，然后是每个参数所指名的文件及其 `argument` 索引；文件无法读取时为空）、`writableByChats`（位于该 profile 的某个工作区或临时目录内、因而 chat 可以写入的规范工作目录和已固定文件）、`reason`、`change`（与该服务器的接受相比有何不同：`new`、`command`、`arguments`、`directory`、`environment`，现在解析到另一个可执行文件、目录或命令 shell 的启动为 `resolved`，已固定文件发生变化或无法读取时为 `contents`，接受存储无法读取时为 `unreadable`）、`changedVariables`（对 `environment` 而言，增加、删除或变更的变量）、`state`（`waiting`，或本人搁置直到其变化的启动的 `declined` 或 `revoked`）与 `reviewedAt`；以及 `accepted`：每个服务器名称已接受的启动，带 `acceptanceId`、`serverName`、`command`、`args`、`cwd`、`resolvedCommand`、`resolvedCwd`、存在时的 `resolvedShell`、`env`、`files`、`acceptedAt` 与 `configured`（是否有已配置服务器使用该名称），存储无法读取时为空 |
| `mcp.accept` | `serverName`、`reviewId` | 把该审查所显示的启动记录为已接受，并再次启动该服务器被拒绝的行；一行 `started`，即启动了多少行 |
| `mcp.decline` | `serverName`、`reviewId` | 把该审查搁置为已拒绝，不记录任何接受；服务器保持停止，直到其启动变化或本人接受它；一行 `declined` |
| `mcp.revoke` | `acceptanceId`（32 位小写十六进制数字） | 撤回 `mcp.list` 以该 id 显示的接受，并停止该服务器运行中的行，这些行以已撤销状态保持停止，直到其启动变化或本人再次接受它；其他每项接受不变；一行 `stopped`，即停止了多少行 |

`delorun devices pin set | options | off | resume` 用令牌文件中的令牌发送这四个请求。`options` 接受 `--idle-minutes <1-60>` 与 `--lock-when-hidden` 或 `--no-lock-when-hidden`，至少需要一个，不要求密钥，在发送之前检查范围，并说明这些选项没有效果；`set` 接受并忽略这两者，并用一行说明这一点。`set` 从隐藏的终端提示读取 PIN 或口令（询问两次），或用 `--stdin` 读取标准输入的一行（标准输入是终端时被拒绝，因为那会显示密钥），绝不从参数或环境变量读取，并在发送之前检查 [C14](c14-oidc-passkeys.zh.md#pin-mode) 的 PIN 与口令规则；这四个命令中任何一个不接受的参数或选项都会被拒绝，消息不重复该参数。`delorun devices pin status` 读取 home 中的 PIN 文件，写明哪些设置正等待恢复，并且不发送任何内容。

- **响应行。** 每行都有 `ok`（布尔值）；失败行带有 `error`，即[错误](#errors)中的代码；进度行带有 `phase`，或在 `update.prepare` 安装目标期间带有 `line`：安装进度中带换行符的一行，与启动器安装发布时打印的文本相同。报告在 `update.prepare` 返回后 600 秒过期；以过期或未知的 `reportId` 调用 `update.apply` 会以 `REPORT_EXPIRED` 失败。若请求以 home 进程不在通道上报告的方式失败，则该请求在没有最终行的情况下结束，失败记录在 home 进程的日志中；请求方将该请求的结果视为未知，`delorun update` 会说明这一点并指出 `delorun logs home`。
- **`failed`。** 以 `failed` 结束的 `update.apply` 或 `rollback` 留下一个 home 进程可能无法自行完成的回滚；home 进程在发送最后一行后停止，更新记录保留到下次启动（[被中断的更新](#interrupted-updates)）。
- **一次一个。** 同一时间只运行一个更新或回滚；第二个以 `UPDATE_IN_PROGRESS` 失败。
- **`changes.reload`。** 它不改变任何文件：Host 通过上游的热重载，根据 profile 的文件重新组合 profile。`delorun changes` 在 profile 的写锁下改变 profile 的文件之后发送它（[C21](c21-changes.zh.md#commands)）。
- **断开的请求方。** 请求方断开连接不会改变正在运行的更新。`delorun status` 显示正在进行的更新的阶段；`delorun status --follow` 尚未构建。

<a id="the-update-handshake"></a>

## 更新握手

更新把一个 profile 从正在运行的版本 `from` 移到目标版本 `to`。各阶段按以下顺序运行：

1. **`checking`。** 获取并检查 `to` 的发布元数据（[C2](c02-release-manifest.zh.md)）与日志条目（[C18](c18-release-log.zh.md)）。在此阶段之前，若用于保存快照的 git 无法运行，`update.prepare` 以 `GIT_UNAVAILABLE` 拒绝；下载未能完成时以 `CHANNEL_UNREACHABLE` 结束，发布未通过检查时以 `VERIFY_FAILED` 结束。
2. **`installing`。** 按 [C1](c01-home-layout.zh.md) 的校验把 `to` 安装到运行时仓库，除非它已安装且其文件与其 manifest 一致。
3. **`reporting`。** 针对 `to` 计算更新报告（[C3](c03-update-report.zh.md)），并由 `update.prepare` 返回。在 `update.apply` 指定该报告之前，此阶段之后的步骤都不运行。
4. **`snapshot`。** 保存一个以该更新命名的 profile 历史版本，包括 home patch（[C3](c03-update-report.zh.md)）；更新记录把其 id 保存为 `snapshot`。
5. **`waiting`。** 运行中的 chat 是指本 Host 中有活动轮次或运行中后台作业的会话。从本阶段开始，新的轮次以 `UPDATE_PENDING` 被拒绝，studio 会连同取消操作一起显示它；计划投递被暂缓到更新结束。使用 `drain` 时，本阶段等待运行中的 chat 数量降为零，最多 `drainTimeoutS`，之后更新以 `DRAIN_TIMEOUT` 结束为 `aborted`。使用 `abort-if-busy` 时，若本阶段开始时有任何 chat 在运行，更新以 `CHATS_RUNNING` 结束为 `aborted`。使用 `cancel` 时，通过上游的取消机制取消运行中的轮次与作业，待它们结束后本阶段继续。
6. **`switching`。** 在没有 chat 运行且新轮次被拒绝的情况下，前任进程先像启动器在启动某个版本之前那样检查 `to`（[C2](c02-release-manifest.zh.md) 对锚定根目录下每个文件的启动检查，然后是 [C18](c18-release-log.zh.md) 的发布日志启动检查）；未通过的版本使更新在任何改变之前以 `VERIFY_FAILED` 结束为 `aborted`，回滚的目标也会在任何步骤之前以同样方式检查。然后它再次检查没有其他 chat 数据使用方注册（[其他 profile](#the-home-process)）；若有，则在任何改变之前以 `CHATS_RUNNING` 拒绝该更新，其记录按在 `switching` 之前结束的更新处理。然后它停止其 Host 与它启动的监管器，写入本人所选的会话数据副本，把本人已批准的 harness 文件带到 `to`（[C21](c21-changes.zh.md#harness-edits)），当其合并结果与 `update.apply` 所指定的报告不同时以 `HARNESS_REPORT_STALE` 拒绝，并在持有 harness 的锁期间写入 [C1](c01-home-layout.zh.md) 的 `previous` 与 `current` 指针；在指针写入之前失败的带入会使更新以 `aborted` 结束，并移除它为 `to` 写入的内容，前任重新启动其 Host。然后它写入日志文件，并从 `to` 以 `standby` 启动后继进程。前任通过作为文件描述符 3 继承的管道传递交接，从不通过命令行或环境变量传递。为切换而停止 Host 不结束任何进程：前任最多等待 `drainTimeoutS` 让 Host 完成拆除；拆除失败或超时时，不切换任何内容，也不写入副本，更新以 `HOST_STOP_FAILED` 结束为 `aborted`，其记录按在 `switching` 之前结束的更新处理，前任重新启动其 Host；该启动失败时，前任停止，下次启动运行 `from`。Host 未能停止的回滚也以同样方式在任何步骤之前结束，并保留其记录。
7. **`health-check`。** 后继进程启动其 Host。满足以下条件即通过：Host 在 120 秒内完成启动，它在启动时禁用的插件是报告所列插件的子集，且 studio 监听器回答其健康请求。 如果后继进程的 Host 在 `SUCCESSOR_DEADLINE_MS`（100 秒）内不健康，其 Host 运行器会撤销这次启动在 profile 中所做的改动，并在前任进程的 120 秒结束之前自己发送 `failed`。
8. **`committed`。** 后继进程通过管道报告 `ready`。前任以原子方式把锁改写为后继的进程 id 与 `startId`，然后关闭其更新通道。后继写入新的启动令牌，在更新通道上监听，启动监管器，进入 `running`，并把更新记录标记为 `committed`；然后它只保留本次更新的会话数据副本，删除暂存记录，并删除 `current` 与 `previous` 所指版本之外的每个已安装运行时（[C1](c01-home-layout.zh.md) 的保留规则），删除失败的由下一次更新重试。前任退出。

**会话数据副本。** 当本人选择了副本（[C3](c03-update-report.zh.md#data-formats)）时，`update.apply` 在 `snapshot` 之前检查它是否放得下（否则为 `DATA_COPY_NO_SPACE`，不改变任何内容），并在 `switching` 中、Host 停止之后、指针改变之前写入它。更新记录的 `targetStarted` 在后继进程被创建之前写入并同步。

**运行中的工作与已停止的 Host。** CLI 的 Host 根据上游的 `agent/status` 事件计数运行中的 chat（一个 agent 从 `running` 到 `idle`），并根据作业注册表的事件计数任何所有者的作业（从 `registered` 到 `settled`）；在 Host 报告之前就已开始的工作不计入。`cancel` 取消每个被计数的轮次，并通过注册表杀死每个被计数的作业。闸门保持期间，`@delorun/bundle-local` 的 `delorun-update-gate` 行（[C16](c16-parity-composition.zh.md) 开关 `update_turn_refusal`）以 `UPDATE_PENDING` 拒绝每个新轮次的第一步：该轮次带此消息结束，不发出任何模型请求，其消息也不会被发送；已在运行的轮次的后续步骤照常进行，因此运行中的轮次结束后等待即告结束。在闸门保持期间到期的计划投递会被记录为已投递，其轮次像其他轮次一样被拒绝；投递不会被暂缓。

**Host 停止之后的子进程。** Host 停止之后，Host 的子进程不会写入 home 的 `sessions/` 或 `storages/`。作业的子进程只写入它自己的管道：Host 读取这些管道，并自行追加每个会话事件与存储写入；长输出的溢出文件写入系统临时目录下的按进程目录。停止 Host 会销毁作业注册表（它取消每个作业并等待每个作业结束），以及子进程提供方（它终止每个受管进程范围并等待其清空），因此会话数据副本只在最后一个受管子进程退出之后才开始。失败或超过 `drainTimeoutS` 的销毁不写入副本，也不切换任何内容：更新以 `HOST_STOP_FAILED` 结束为 `aborted`，如 `switching` 所述。离开其受管范围的后代进程不会被等待：在有用户 systemd 管理器的 Linux 上，该范围是一个 systemd scope，它保留 `setsid` 与被重新指定父进程的后代；在 Windows 上它是一个 Job 对象，脱离（breakaway）的进程会离开它；在 macOS 以及没有用户 systemd 管理器的 Linux 上，它是一个进程组，后代进程可以离开它。

**`switching` 或 `health-check` 中的失败。** 后继进程退出、发送 `failed`，或未在 120 秒内报告 `ready` 时，前任用 `SIGKILL` 停止它，信号发给后继所领导的进程组（后继交接给的、组合树中的 `delorun` 留在该进程组中，[C21](c21-changes.zh.md#harness-edits)），在 Windows 上则对其进程树使用 `taskkill /T /F`，并应用 [C3](c03-update-report.zh.md#rollback) 的回滚表，把两个指针恢复为更新前的值：恢复 profile 快照，并在数据不同且目标已启动时恢复副本。在执行该表的第一步之前，记录被改写为阶段 `rolling-back`。然后前任在 `from` 上重新启动自己的 Host，删除记录，放回暂存的记录，并回到 `running`；更新以带原因的 `rolled-back` 结束，当后继进程的 Host 已启动但未通过 [C3](c03-update-report.zh.md) 的某项标准时，还带有点名该标准的 `criterion`，例如 `H2-host-ready`，`delorun update` 会打印它。当该表因数据不同、目标已启动且不存在副本而拒绝时，不恢复任何内容：记录增加 `refused`，更新以 `ROLLBACK_NEEDS_DATA_COPY` 结束为 `failed`，`current` 指向 `to`，前任停止。回滚开始后某一步失败时，更新以 `failed` 结束，记录保持为 `rolling-back`，前任停止，不再运行其 Host。

**由此保证的规则。** 只有在等待阶段确认运行中的 chat 为零且新轮次被拒绝之后，`current` 才切换，因此运行时从不在运行中的 chat 之下切换。从 `switching` 开始，到后继的监听器或恢复后的 Host 应答为止，studio 不可用。

<a id="interrupted-updates"></a>

## 被中断的更新

从 `snapshot` 起，home 进程在每个阶段开始时写入更新记录 `run/<profile>/update.json`（权限 0600）：`{"v":1,"from":"<version>","to":"<version>","previous":"<version>","phase":"<phase>","startedAt":"<RFC 3339 UTC time>","dataDiffers":<boolean>,"copy":<boolean>,"targetStarted":<boolean>,"snapshot":"<id>","health":{"disabledPlugins":[…],"namedRows":[…],"bundles":[…]}}`。`previous` 为更新前 [C1](c01-home-layout.zh.md) 的 `previous` 指针所指的版本，没有 `previous` 指针时该字段不存在。`snapshot` 是 profile 历史版本的 id，从 `waiting` 阶段起存在。`health` 是报告对健康检查的预测，不预测任何组合包时没有 `bundles`。当 C3 的表拒绝了自动回滚时，会添加 `refused: true`。

- **记录的唯一规则。** 后继进程运行后把记录标记为 `committed`，记录保留以供之后回滚。每次回滚都在执行表的第一步之前把它改写为阶段 `rolling-back`，只有在回滚到的运行时通过健康检查之后，记录才会删除。在切换之前结束的更新会删除它。
- **暂存。** 在更新写入其第一条记录之前，上一次更新的 `committed` 记录会通过一次刷新的重命名移到 `run/<profile>/update.previous.json`。当更新在切换之前结束或被自动回滚时，它会被移回；当更新提交时，它会被删除；在切换之前结束的更新还会丢弃其会话数据副本。

- **被杀死的请求方。** 杀死发送请求的终端或进程不会停止更新；home 进程继续运行，并完成更新或将其回滚。
- **被杀死的 home 进程。** 每次指针写入都是 [C1](c01-home-layout.zh.md) 的原子重命名，因此 `current` 始终指向一个完整的已安装版本。下次启动时，启动顺序的第 3 步读取日志文件：
  - 没有记录但有暂存时，暂存的记录被移回，启动按下述方式读取它；
  - 带 `refused` 时，启动以 `ROLLBACK_NEEDS_DATA_COPY` 失败，不启动任何 Host；本人运行保留 `to` 的 `delorun recover rollback --profile-only`，或 `delorun recover safe-mode`；
  - 带 `committed` 时，只要 `current` 指向 `to`，记录就保留，旁边残留的暂存会连同除本次更新之外的每个副本一起被删除；`current` 指向 `from` 时记录被删除；
  - 阶段早于 `switching`，或阶段为 `switching` 或 `health-check` 且 `current` 指向 `from` 时，没有任何切换发生：启动把 `previous` 恢复为记录中的 `previous`（记录中没有该字段时则删除 `previous`——两次指针写入之间被杀时它留存的是 `from`），丢弃该更新的会话数据副本，删除记录，放回暂存的记录，并运行 `from`；
  - 阶段为 `switching` 或 `health-check` 且 `current` 指向 `to` 时，启动记录 `targetStarted`，并针对记录的 `health` 在 `to` 上运行 H1 至 H5（记录中没有它时只运行 H1 与 H2）；通过时，它把记录标记为 `committed`，并按 `committed` 的方式处理暂存；失败时，它在仍持有锁的情况下应用 [C3](c03-update-report.zh.md#rollback) 的回滚表，把两个指针恢复为更新前的值（`current` 恢复为 `from`，`previous` 恢复为记录中的 `previous`，记录中没有该字段时则删除），然后释放锁，并在 `from` 通过启动器在启动前运行的检查后从 `from` 重新启动（未通过检查的 `from` 会被记录到日志，不启动任何内容）；当该表拒绝时，记录增加 `refused`；
  - 阶段为 `rolling-back` 且 `current` 指向 `to` 时，启动在任何 Host 启动之前通过该表完成回滚，把 `current` 设为 `from`、`previous` 设为 `to`，然后释放锁，从 `from` 重新启动，并以 `HEALTH_CHECK_FAILED` 失败；
  - 阶段为 `rolling-back` 且 `current` 指向 `from` 时，启动的 Host 启动即为 `from` 的健康检查（H1 与 H2）：通过时，记录被删除，暂存的记录被移回；失败时，记录保留，启动以 `HEALTH_CHECK_FAILED` 失败。
- **已安装的版本。** 被中断的更新安装的版本作为非当前版本留在仓库中，直到 [C1](c01-home-layout.zh.md) 的保留规则删除它。

<a id="rollback"></a>

## 回滚

- **CLI 运行时。** `delorun recover rollback [--profile-only]` 或 studio 的回滚发送带 `profileOnly` 的 `rollback`。它读取更新记录，需要一个到正在运行版本的 `committed` 更新（否则为 `NO_UPDATE_RECORD`），以记录的 `from` 为目标运行 `reporting`、`waiting`、`switching` 与 `health-check` 阶段，不安装任何内容，并在 `switching` 中、Host 停止之后应用 [C3](c03-update-report.zh.md#rollback) 的回滚表。该表先运行其预检，然后记录被改写为阶段 `rolling-back`，然后数据、profile 快照与运行时按此顺序回退。预检的拒绝（`ROLLBACK_NEEDS_DATA_COPY` 或 `ROLLBACK_TARGET_UNUSABLE`）让一切保持原样，Host 重新运行。之后的任何失败都使回滚以 `failed` 结束：此 Host 不再运行，home 进程停止，下次启动完成回滚。使用 `profileOnly` 时只恢复 profile 快照，记录保持 `committed` 直到此 Host 重新运行，然后被删除。否则，回滚到的版本作为后继启动；一旦它通过健康检查并完成接管，它就删除记录。它未通过健康检查时，指针保持在回滚到的版本上，回滚以 `HEALTH_CHECK_FAILED` 结束为 `failed`，home 进程停止。提交之后，`current` 指向回滚到的版本，`previous` 指向回滚前的版本。没有 home 进程运行时，`delorun recover rollback` 获取 home 锁，在 C1 的 `run/data-users/` 下注册为独占使用方直到结束，当有任何其他使用方（包括另一个 profile 的 home 进程）注册时写明这些进程并拒绝，然后完成被中断的副本恢复，并应用同一张表，把指针从记录的 `to` 切换到其 `from`；在它运行期间启动的 home 进程会发现该独占使用方并拒绝。使用 `--profile-only` 时它不注册任何内容，只恢复 profile 快照，把被中断的副本恢复留给下次启动。
- **自动回滚。** 更新期间的健康检查失败，或被中断的更新之后启动时的健康检查失败，会应用同一张表，并按握手的规定恢复指针。其记录保持为 `rolling-back`，直到 `from` 再次启动。在已启动过一个 Host 的进程中再次启动 Host 时（例如切换失败之后），它先把每个已记录的活动插件副本指向运行时仓库的链接重新指向该进程所运行的发行版，使这些副本在其中加载。
- **Profile。** [C3](c03-update-report.zh.md) 负责回滚触发条件与 profile 快照的恢复；本约定负责运行时切换。
- **桌面应用。** 桌面应用的回滚不使用运行时仓库。应用在其更新缓存中保留上一个已签名发布；其更新源拒绝自动降级，但接受本人请求的、回滚到已签名且已记入日志的较早发布（[C2](c02-release-manifest.zh.md)）。回滚从缓存重新安装该发布，并从桌面 profile 的历史恢复它。

<a id="the-outcome-record"></a>

## 结果记录

home 进程在每次更新结束或本人发起的回滚结束时写入 `run/<profile>/update-result.json`（权限 0600）：`{ v: 1, kind: 'update' | 'rollback', outcome: 'committed' | 'rolled-back' | 'aborted' | 'failed', from, to, reason?, criterion?, at }`。`reason` 是拒绝或失败代码，`criterion` 是目标版本未通过的第一条健康判据，例如 `H2-host-ready`。该记录先于最后一行响应写入，在下一次尝试开始时替换上一条记录，并在本人于 studio 中关闭时删除。读取者把缺失、无法读取、更宽松或格式未知的文件视为没有记录：该记录只做报告，不做任何决定。切换、回滚或被拒绝的启动之后运行的 Host 把它提供给 studio，因为页面无法读取它所停止的那次切换的最后一行。

<a id="the-restart"></a>

## 重启

studio 的 Restart（[C21](c21-changes.zh.md#harness-edits)）让 CLI 的 Host 在其所运行的版本上重新启动，使已决定的、对 Delorun 本身文件的非即时生效的更改得以运行。没有通道请求能到达它：home 进程在进程内把重启作为 `changesRestart` 服务交给它所启动的 Host，由 studio 的路由决定谁可以使用它。它按以下步骤运行：

1. **拒绝。** 另一个重启运行期间，重启以 `RESTART_IN_PROGRESS` 被拒绝；更新或回滚运行期间、进程不处于 `running` 期间、或存在阶段不是 `committed` 的更新记录时，以 `UPDATE_IN_PROGRESS` 被拒绝；进程在运行时仓库之外运行时，以 `NO_RUNTIME_STORE` 被拒绝。重启运行期间，每个更新与回滚请求都以 `RESTART_IN_PROGRESS` 被拒绝；`stop` 与 `update.cancel` 会结束仍在等待 chat 的重启，而一旦重启正在启动新 Host，`stop` 就以 `RESTART_IN_PROGRESS` 被拒绝。
2. **等待。** 与更新的 `waiting` 阶段相同，新的轮次以 `UPDATE_PENDING` 被拒绝，重启等待运行中的 chat 降为零，最多等待 studio 设定的时长；使用 `stopChats` 时，先取消运行中的轮次与作业。因超时而结束的等待让 Host 保持运行且不改变任何内容，studio 的取消、`update.cancel` 与 `stop` 以同样方式结束等待。
3. **启动。** Host 如同切换时那样停止；未能停止的 Host 重新运行，不启动任何内容。然后 home 进程在同一版本上启动后继进程，交接行的 `type` 为 `restart`，其 `from` 与 `to` 都指向该版本。后继进程的健康检查是针对运行中 Host 的 H1 至 H5：它在启动时禁用了运行中 Host 未禁用的任何插件，则检查失败。通过的后继进程如同 `committed` 那样接管锁，前任退出。
4. **失败。** 未通过健康检查、退出或未在 120 秒内报告 `ready` 的后继进程，如同更新失败时那样被停止。当运行中的 Host 并未运行运行时最新已应用的 harness 更改，而该更改仍以其内容作为已应用记录在案时（[C21](c21-changes.zh.md#harness-edits)），它被排除在外，前任在它此前运行的文件上重新启动其 Host。

重启不写入指针、更新记录、暂存、会话数据副本或保留：为重启启动的后继进程不会结算任何更新记录。

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
| `delorun stop --now` 等待最后一行 | 60 秒 |
| `delorun stop --now` 在 `SIGTERM` 之后、`SIGKILL` 之前的等待 | 30 秒 |
| `delorun stop --now` 在 `SIGKILL` 之后的等待 | 5 秒 |
| 启动失败时 Host 的拆除 | 5 秒 |
| 后继的 `ready` 与健康检查 | 120 秒 |
| 后继进程自行报告 `failed` 的期限 | 100 秒（`SUCCESSOR_DEADLINE_MS`） |
| 登录项重启 | 300 秒内最多 3 次 |
| 每个 profile 同时进行的更新或回滚 | 1 |
| 协议版本 `v` | 1 |

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `UNAUTHENTICATED` | 请求的令牌缺失、格式错误、错误或来自之前某次启动，或 `studio.open-token` 携带了 Host 的通道令牌 |
| `SCHEMA_VIOLATION` | 请求的 `op` 未知、字段未知或字段类型错误 |
| `REQUEST_TIMEOUT` | 5 秒内未收到请求行 |
| `REQUEST_TOO_LARGE` | 请求行超过 16,384 字节 |
| `BUSY` | 已打开 8 个连接 |
| `UPDATE_IN_PROGRESS` | 已有更新或回滚在运行；对重启而言，还包括阶段不是 `committed` 的更新记录 |
| `RESTART_IN_PROGRESS` | 重启运行期间收到更新、回滚或第二次重启的请求，或在重启启动新 Host 期间收到 `stop`（[重启](#the-restart)） |
| `REPORT_EXPIRED` | `update.apply` 指定的报告未知或已超过 600 秒 |
| `UPDATE_PENDING` | 因有更新在等待运行中的 chat，新轮次被拒绝 |
| `CHATS_RUNNING` | `abort-if-busy` 发现有运行中的 chat，或另一个 profile 的 home 进程或其他 chat 数据使用方已注册（[其他 profile](#the-home-process)） |
| `DRAIN_TIMEOUT` | 运行中的 chat 未在 `drainTimeoutS` 内降为零 |
| `HEALTH_CHECK_FAILED` | 后继未通过健康检查，或未在 120 秒内报告 `ready` |
| `VERIFY_FAILED` | 目标的元数据、日志条目或文件无法获取，或未通过 [C1](c01-home-layout.zh.md)、[C2](c02-release-manifest.zh.md) 或 [C18](c18-release-log.zh.md) 的检查；该行的 `detail` 是启动器对同一失败的拒绝说明及其补救办法 |
| `CHANNEL_UNREACHABLE` | `update.prepare` 的某次下载未能完成：连接失败、停滞，或对方以 200 以外的状态应答；未安装任何内容，该行的 `detail` 是启动器对同一失败的拒绝说明 |
| `GIT_UNAVAILABLE` | 保存与恢复 profile 历史所用的 git 无法运行；`update.prepare` 与每次回滚都在任何步骤之前以它拒绝，因此回滚绝不会因此半途停止 |
| `HARNESS_CHANGES_PENDING` | 对运行中的运行时的 harness 所作的更改在其可写副本中等待审阅（[C21](c21-changes.zh.md#harness-edits)），更新会把它们丢在后面；`update.prepare` 在获取任何内容之前拒绝，`update.apply` 在切换之前拒绝且不切换任何内容 |
| `HARNESS_COPY_UNREADABLE` | 运行中的运行时的可写副本无法扫描（超出扫描限制、条目不可读、文件在读取期间发生变化），因此不知道是否有更改在等待审阅；在与 `HARNESS_CHANGES_PENDING` 相同的位置被拒绝，detail 写明失败之处、`delorun changes edit-harness --discard` 与 `delorun changes list` |
| `HARNESS_REPORT_STALE` | 切换之前重新规划的、本人已批准的 harness 文件的合并结果，与本人确认的报告中的 `harness` 项不同（[C3](c03-update-report.zh.md#harness-files-across-an-update)）；`update.apply` 拒绝且不切换任何内容，本人需再次运行 `delorun update` |
| `NO_PREVIOUS` | 请求了回滚，但不存在 `previous` 指针 |
| `NO_UPDATE_RECORD` | 请求了回滚，但没有记录到正在运行版本的已提交更新 |
| `DATA_COPY_NO_SPACE` | 本人选择的会话数据副本在 home 的文件系统上放不下（[C3](c03-update-report.zh.md#data-formats)） |
| `ROLLBACK_NEEDS_DATA_COPY` | 数据不同、目标已启动且不存在副本，因此 [C3](c03-update-report.zh.md#rollback) 的表拒绝回滚；在启动时，表示记录表明该表拒绝了自动回滚 |
| `ROLLBACK_TARGET_UNUSABLE` | 回滚要回到的版本未安装或未通过其启动检查，因此回滚在任何步骤之前被拒绝 |
| `STUDIO_UNAVAILABLE` | `studio.open-token` 没有找到运行中的 Host，或找到的 Host 无法为这台电脑生成链接；该行的 `detail` 说明是哪种情况 |
| `HOST_STOP_FAILED` | 为切换而进行的 Host 拆除失败或未在 `drainTimeoutS` 内完成；没有切换任何内容，Host 重新运行 |
| `NO_RUNTIME_STORE` | 启动时存在一条不是 `committed` 的更新记录，而进程在运行时仓库之外运行，因此它不启动任何 Host；本人通过启动器启动 Delorun，或运行 `delorun recover` |
| `LOOPBACK_REQUIRED` | `devices.approve`、`devices.remove`、`devices.elevate`、`pin.set`、`pin.options`、`pin.off`、`pin.resume`、`mcp.accept`、`mcp.decline` 或 `mcp.revoke` 携带了 Host 的通道令牌 |
| `APPROVAL_FAILED` | 本地批准或取消被拒绝；detail 写明 [C5](c05-device-approval.zh.md#errors) 的代码，例如 `APPROVAL_CODE_MISMATCH` |
| `APPROVALS_UNAVAILABLE` | `devices.approve`、`devices.remove`、`devices.elevate`、`pin.set`、`pin.options`、`pin.off` 或 `pin.resume` 抵达了未加载 `@delorun/home-auth` 的 profile |
| `REMOVAL_FAILED` | home-auth 拒绝了一次 `devices.remove`；detail 写明其代码 |
| `PIN_FAILED` | home-auth 拒绝了一次 `pin.set`、`pin.options`、`pin.off` 或 `pin.resume`，例如 PIN 过弱（`PIN_WEAK`）；detail 写明其代码，从不包含密钥 |
| `ELEVATION_FAILED` | home-auth 拒绝了一次 `devices.elevate`，例如验证码错误（`APPROVAL_CODE_MISMATCH`）或请求已不再等待（`APPROVAL_EXPIRED`）；detail 写明其代码 |
| `CONSENT_UNAVAILABLE` | `permission.reload` 或某个 `mcp.*` 操作抵达的 Host 所在的 profile 未挂载该同意，因为其开关关闭 |
| `STALE_REVIEW` | `mcp.accept` 或 `mcp.decline` 指定的审查已不属于该服务器：在 `mcp.list` 显示它之后，其启动被再次审查或被接受；或 `mcp.revoke` 指定的接受 id 已不在存储中：在 `mcp.list` 显示它之后，该服务器被再次接受或被撤回 |
| `CONSENT_FAILED` | Host 因其他原因拒绝了一次 `mcp.accept` 或 `mcp.revoke`，例如无法写入的接受存储；detail 写明其代码 |

<a id="consumers"></a>

## 使用方

- `delorun/packages/home-process`：home 进程、更新通道、握手、日志文件与登录项。
- `delorun/apps/cli`：`delorun`、`delorun start`、`open`、`stop`、`status`、`update` 与 `recover` 与 `changes`，以及通过 `studio.open-token` 打开 studio 的 setup 结尾；`delorun devices`，自己写入权限存储且不向运行中的 profile 发送任何内容的 `delorun workspace full-access`，以及 `delorun mcp`。`delorun changes` 在更改 profile 的文件之后发送 `changes.reload`。
- `delorun/packages/runtime-store`：握手调用的指针写入与安装（[C1](c01-home-layout.zh.md)）。
- `delorun/packages/logs`：home 进程的运行日志（[C20](c20-operational-logs.zh.md)）。
- `delorun/packages/plugin-update`：Host 的更新插件，即 studio 的 Check now、Update now、Go back 与 Stop，由 `@delorun/bundle-local` 挂载。
- `@delorun/bundle-local` 的 `delorun-update-gate` 行：`delorunTurnGate` 服务，在 CLI 的 chat 闸门保持期间拒绝新轮次。
- 更新报告及其界面（[C3](c03-update-report.zh.md)），读取各阶段与结果。

<a id="compatibility"></a>

## 兼容性

- 协议版本 `v` 为 1。home 进程对 `v` 未知的请求回答 `SCHEMA_VIOLATION`。删除或重命名某个操作、字段或阶段的变更会提高 `v`，提高它的运行时在一个发布内同时接受两个版本，使上一个发布的 `delorun` 仍能更新它。
- 新的操作、可选字段与新的错误代码保持 `v` 不变；调用方忽略未知的响应字段。
- 交接行有自己的 `v`，为 1。后继进程检查它认识的每个字段，并丢弃它不认识的每个字段（顶层、`health`、行与 `previousProtection` 中均如此），因此前驱进程可以添加一个可选字段，只要忽略该字段的后继进程不读它也能安全地完成检查。后继进程为安全检查必须读取的字段，或现有字段含义的改变，都会提高交接行的 `v`；后继进程拒绝 `v` 未知的行，前驱进程随后如同健康检查失败一样回滚。`v` 1 包含 `health.previousProtection`，以及不涵盖该行保护的 sandbox 行 `configHash`。其 `type` 为 `handover` 或 `restart`；重启的后继进程运行前任自己的版本，因此总是认识 `restart`。 A `handover` may carry the optional `purpose`, `update` or `rollback`: a predecessor's update writes `update` and its rollback writes `rollback`. Only a handover whose purpose is not `rollback` lets the successor treat the files its release installed as Changes' baseline ([C21](c21-changes.zh.md#plugin-packs-across-an-update)); a line without a purpose, as older releases write, is an update's.
- 上述登录项路径与命令参数是外部接口；改变其中任一项都是破坏性变更，需在 `delorun/docs/upgrade-guide/` 下附升级指南。
- 类型包跟随 Delorun 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

### 要求

1. 更新通道的套接字位于 home 之下；凡 [C1](c01-home-layout.zh.md) 的规则得到强制执行之处，受限命令都不能读取或连接它。方言无法强制执行这些规则时，`delorun verify` 通过 [C15](c15-verification-checks.zh.md) 的 `confinement-rule` 检查报告这一点。
2. 通道只接受携带当前 home 进程启动令牌的请求，并以恒定时间比较；缺失、错误或属于之前某次启动的令牌以 `UNAUTHENTICATED` 被拒绝，不附任何其他信息。
3. 通道只服务本人的 `delorun` 命令，以及代表已认证 studio 会话的 Host 更新插件。
4. 没有请求携带路径、归档或 URL，也没有请求指定由 home 进程运行的命令，因此持有令牌的调用方能选择的发布只有一个版本，由 home 进程自行获取并校验；`mcp.revoke` 只以接受 id 指定一个已接受的启动。
5. home 锁按 profile 划分。桌面 Host 既不获取它，也不加入排空，`delorun update` 从不切换桌面应用。
6. 只有在旧运行时上没有 chat 运行且新轮次被拒绝时，`current` 才切换；被中断的更新让一个完整版本处于当前状态，健康检查失败会恢复之前运行的版本。
7. 请求大小、请求时限与连接数都有限额，被拒绝的认证记录到日志时不含所提交的值。在 Landlock 下，受限命令仍能打开连接直至达到这些限额；这只影响可用性，`delorun` 会重试 `BUSY` 的连接。
8. 交接通过继承的管道传递；令牌从不出现在命令行、环境变量、响应或日志中。
9. 该保护依赖于对 agent 命令的限制。沙箱之外的本人用户进程可以自行运行 `delorun update`，本约定不声称能防范它。不存在 root 所有的辅助程序。
10. 只有不受限制地运行的命令才能携带令牌抵达更新通道。`danger-full-access` 提权只能经由 [C1](c01-home-layout.zh.md) 的提权提示批准，该提示说明完全访问可以触及 Delorun 的 home、其令牌、Docker 监管器与更新通道。
11. 通道只为携带启动令牌的 `studio.open-token` 提供 studio 链接，从不为携带 Host 通道令牌的请求提供。响应行与链接都不会记录到日志，`delorun` 只在 `delorun open --print` 下打印链接。
12. `devices.approve`、`devices.remove`、`devices.elevate`、`pin.set`、`pin.options`、`pin.off`、`pin.resume`、`mcp.accept`、`mcp.decline` 与 `mcp.revoke` 只在携带本人自己的命令从令牌文件读取的令牌时才被接受；Host 的通道令牌（home 进程只把它保存在内存中）对其中每一个都会被拒绝。
13. `mcp.accept` 与 `mcp.decline` 指定 `mcp.list` 显示的审查，`mcp.revoke` 指定它显示的接受 id；对服务器已不再持有的审查的答复，或对存储已不再持有的接受的撤回，以 `STALE_REVIEW` 被拒绝，且不记录任何内容。没有任何操作开启工作区的完全访问：`delorun workspace full-access` 在本人于终端确认之后自行写入权限存储，`permission.reload` 只让 Host 读取存储中的内容。

### 拒绝测试

| 测试 | 证明 |
| --- | --- |
| `update-waits-for-chat` | 在样例 chat 的轮次运行期间应用的更新停留在 `waiting`，在该轮次结束前 `current` 保持不变；这期间的新轮次以 `UPDATE_PENDING` 被拒绝；使用 `abort-if-busy` 时更新以 `CHATS_RUNNING` 结束为 `aborted` |
| `update-channel-connect-denied` | 在每种强制执行 [C1](c01-home-layout.zh.md) `home-connect` 的方言上，受限的工作区命令连接更新通道失败，且无法读取启动令牌 |
| `update-turn-refused-while-held` | chat 闸门保持期间，新轮次在任何模型请求之前以 `UPDATE_PENDING` 结束，已在运行的轮次继续其下一步，开关 `update_turn_refusal` 关闭时不拒绝任何轮次 |
| `the channel token cannot answer an MCP server` | 携带 Host 通道令牌的 `mcp.accept`、`mcp.decline` 与 `mcp.revoke` 以 `LOOPBACK_REQUIRED` 被拒绝且不触及任何同意，而同一令牌的 `mcp.list` 成功；本人的令牌可以接受与撤回，过期的审查与过期的接受以 `STALE_REVIEW` 被拒绝，包含路径的服务器名称与指定命令或其他形式 id 的撤回以 `SCHEMA_VIOLATION` 被拒绝 |
| `the channel token cannot call devices.approve` | 携带 Host 通道令牌的 `devices.approve` 以 `LOOPBACK_REQUIRED` 被拒绝，不打开窗口也不批准任何内容，而同一令牌的 `status` 成功，本人的令牌可以打开窗口 |
| `update-channel-token-required` | 不带令牌、带错误令牌以及带之前启动令牌的请求，都收到 `UNAUTHENTICATED` 且没有其他字段 |
| `update-channel-landlock` | 在 Landlock 下，受限的工作区命令连接更新通道成功，但因无法读取令牌，其请求以 `UNAUTHENTICATED` 失败，`delorun verify` 会报告这一状态 |
| `update-channel-not-enforced-reported` | 在无法强制执行 [C1](c01-home-layout.zh.md) 规则的方言样例上，`delorun verify` 把它们报告为 `not-enforced` |
| `changes.reload carries no arguments` | 带 `args` 或任何其他字段的 `changes.reload` 请求以 `SCHEMA_VIOLATION` 被拒绝 |
| `update-request-fields` | 带路径、URL 或命令字段，或带未知 `op` 的请求以 `SCHEMA_VIOLATION` 被拒绝，且不改变任何内容 |
| `studio-open-token-person-only` | `studio.open-token` 对启动令牌返回一个新链接；Host 的通道令牌（`status` 接受它）以及缺失或错误的令牌收到 `UNAUTHENTICATED`；带未知参数或 1 至 65535 之外端口的请求收到 `SCHEMA_VIOLATION`；链接及其令牌都不会进入 home 日志 |
| `update-request-limits` | 超过 16,384 字节的请求行、静默 5 秒的连接以及第九个连接，都以各自的代码关闭 |
| `desktop-independent` | 样例桌面 Host 运行时，`delorun start` 成功，`delorun update` 让桌面进程继续运行，桌面 profile 逐字节不变 |
| `requester-killed` | 在每个阶段杀死发起请求的终端，home 进程都继续运行，`current` 指向一个完整版本 |
| `home-killed-mid-switch` | 在 `switching` 与 `health-check` 中杀死 home 进程，`current` 都指向一个完整版本，且 `to` 失败时下次启动回滚到 `from` |
| `a handed-off successor that hangs at boot is gone, parent and child, after stop()` | 停止一个不响应的后继会结束其进程组：已签名后继所移交的、所组合树中的 `delorun` 随之停止（`delorun/apps/cli/tests/update/successor-stop.integration.spec.ts`） |
| `restart never runs during an update` | 更新等待期间或存在不是 `committed` 的记录时，重启以 `UPDATE_IN_PROGRESS` 被拒绝；重启等待期间，更新以 `RESTART_IN_PROGRESS` 被拒绝（`delorun/packages/home-process/tests/restart.integration.spec.ts`） |
| `restart keeps previous and its runtime` | 重启让指针、已提交的更新记录、暂存与每个已安装的运行时保持原样 |
| `a failed restart keeps the old Host and leaves the newest harness change out` | 未通过 H2 或禁用了运行中 Host 未禁用的插件的后继进程被停止，运行中 Host 的锁与进程保留，最新已应用的 harness 更改被排除在外 |
| `health-check-rollback` | 禁用了报告未列出插件的后继被回滚，前任的 Host 在 `from` 上重新运行 |
| `escalation-prompt-before-full-access` | 为发送更新请求而请求 `danger-full-access` 的受限工作区命令会看到 [C1](c01-home-layout.zh.md) 的提权提示，该提示指明更新通道；提示被拒绝或未作答期间，命令仍受限制，其请求被拒绝或根本未发送 |

### 本约定不能证明的内容

- **Landlock。** 受限命令能连接更新通道；拒绝只依赖于令牌不可读。这样的命令还能占用连接直至通道的限额，这会影响可用性。
- **完全访问。** 获准 `danger-full-access` 的命令可以读取令牌，并在封闭的请求集合内发送 `delorun` 命令能发送的任何请求。
- **进程内存。** 在 macOS 与 Windows 上，对 home 进程内存的保护依赖于操作系统自身关于读取其他进程内存的规则，没有 Delorun 测试证明这一点。
- **本人自己的进程。** 沙箱之外的本人用户进程可以读取令牌，并自行运行 `delorun update`。持有令牌时，它还可以运行 `devices.approve`（打开批准窗口，并在给出匹配码时批准待处理的请求）、`devices.remove`、`devices.elevate`（在给出设备显示的验证码时批准设备解锁敏感操作的请求），以及返回新的 studio 登录链接的 `studio.open-token`。同时控制一台请求批准的设备的持有者可以在无人在场的情况下批准它。防范 agent 做同样的事，只依赖于其命令无法读取令牌文件或连接套接字。
- **Host 中的代码。** Host 的通道令牌阻止 Host 通过通道发送的请求（例如它为 studio 会话转发的请求）获得 studio 链接。它不限制 Host 代码：Host 插件在 home 进程中不受限制地运行，可以自行调用上游的 `authenticatedUrl` 或读取令牌文件。

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
- **进程检查。** 令牌只保存在内存与令牌文件中，从不出现在命令行或环境中，而在 macOS 与 Linux 上同一用户的进程可以列出这些内容。bwrap 为受限命令提供独立的进程命名空间，Landlock 拒绝受限命令跟踪其域之外的进程。`delorun open` 交给浏览器启动器的 studio 链接位于启动器的命令行上；[C4](c04-admission.zh.md#what-this-does-not-prove) 说明了这一暴露。
