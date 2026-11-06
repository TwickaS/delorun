---
description: "约定 C20：每个 Delo 进程写入其运行日志的位置，以上游会话与轮次 id 为键的记录格式，按 10 MiB 轮转、保留 5 个文件并在 14 天后删除，覆盖 Delo 日志器与所捕获子进程输出的脱敏规则，delorun logs，以及清除时提供的清空进程日志选项。"
---

# C20 运行日志

[English](c20-operational-logs.md) | 中文

## 摘要

本约定定义 Delo 自身各进程记录其运行情况的文件，使本人或其 agent 无需 studio 就能查明故障原因。CLI home 进程、桌面 Host、Docker 监管器与自托管中继各自在固定位置写入自己的日志，格式为 JSON 行；当记录属于某个 chat 时，携带上游的会话与轮次 id。日志按 10 MiB 轮转，保留 5 个文件，并在 Delo 运行期间于 14 天后删除，这同时限定了被清除 chat 的片段能在其中留存多久。每条记录都经过脱敏步骤，因此任何密钥、令牌、私钥、所有者验证码或 cookie 都不会进入日志。`delorun logs` 显示每个日志及其位置。会话日志是另一回事：它们记录 chat，并永久保留。类型包 [`@delo/contract-operational-logs`](../../packages/contract-operational-logs/README.zh.md) 提供记录类型、入口与限额。

## 目录

- [入口与存放位置](#surfaces-and-destinations)
- [日志包含什么](#what-a-log-holds)
- [记录格式](#record-format)
- [轮转与保留](#rotation-and-retention)
- [脱敏](#redaction)
- [delorun logs](#delorun-logs)
- [清除与进程日志](#purge-and-process-logs)
- [限额](#limits)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [各平台与方言的强制执行情况](#enforcement-per-platform-and-dialect)

<a id="surfaces-and-destinations"></a>

## 入口与存放位置

每个入口通过 Delo 的日志器 `@delo/logs` 写入一个日志。除非该行另有说明，路径都相对于 Delo home（[C1](c01-home-layout.zh.md)）。

| 入口 | 名称 | 活动文件 | 写入方 |
| --- | --- | --- | --- |
| CLI home 进程 | `home-<profile>` | `logs/home-<profile>/home.log` | home 进程（[C19](c19-home-process.zh.md)），包括其 Host 及其标准输出与标准错误 |
| Docker 监管器 | `supervisor-<profile>` | `logs/supervisor-<profile>/supervisor.log` | 监管器（[C9](c09-runtime-supervisor.zh.md)） |
| 桌面 Host | `desktop-host` | `logs/desktop-host/desktop-host.log` | 桌面应用的主进程，来自 Host 子进程的标准输出与标准错误 |
| 自托管中继 | `relay` | 中继容器内的 `/var/log/delo-relay/relay.log`，位于中继指南指定的卷上 | 中继数据面 |

- **桌面 Host。** 桌面应用的主进程把 Host 子进程的输出写入该文件，同时保留上游在内存中保存的标准错误末尾片段，因此 Host 的诊断记录从不只存在于 Electron 的控制台中。
- **中继容器。** 其标准输出只承载一行启动记录与致命错误，二者都经过脱敏；它的日志是该文件。
- **上游的报告。** 上游的 `logs/startup-*.log` 文件只由上游自己的 `dsh` 入口写入，它记录原始诊断信息，并说明其中可能包含凭据值。`delorun` 从不写入它们：`delorun` 进程的启动失败通过 Delo 的日志器写入该进程的入口。`delorun logs` 连同上游的警告一起列出现有的 `startup-*.log` 文件，清除时提供的选项也覆盖它们。
- **会话日志。** 会话日志是 `sessions/` 下上游的会话记录。本约定从不轮转、脱敏、删除或读取它们。

<a id="what-a-log-holds"></a>

## 日志包含什么

- Delo 自己的记录说明操作、状态、结果、耗时、版本、id 与错误代码。它们从不包含 chat 消息文本、提示词、模型输出、工具参数、工具结果或文件内容。
- 捕获的输出是入口所运行上游代码的标准输出与标准错误：home 进程中 CLI Host 的控制台输出，以及桌面 Host 子进程的输出流。它可能包含来自 chat、命令与文件的文本，例如引用了某条命令的错误行；它与 Delo 的记录经过同样的脱敏。

<a id="record-format"></a>

## 记录格式

日志文件是 UTF-8 JSON Lines：每行一个 JSON 对象，每行（含换行符）最多 16,384 字节。

| 字段 | 类型 | 出现时机 |
| --- | --- | --- |
| `ts` | 带毫秒的 RFC 3339 UTC 时间 | 始终 |
| `level` | `error`、`warn`、`info` 或 `debug` | 始终 |
| `surface` | 入口名称 | 始终 |
| `pid` | 写入进程的 id | 始终 |
| `startId` | [C1](c01-home-layout.zh.md) 中 home 进程的启动 id | 在 `home-<profile>` 与 `supervisor-<profile>` 入口上 |
| `logger` | Cordis 日志器名称；捕获的输出为 `stdout` 或 `stderr` | 始终 |
| `source` | `delo` 或 `captured` | 始终 |
| `msg` | 脱敏后的消息 | 始终 |
| `sessionId` | 上游的会话 id | 记录属于某个会话时 |
| `turn` | 上游 `turn/start` 事件的编号 | 记录属于某个轮次时 |
| `workspaceId` | 上游的工作区 id | 记录属于某个工作区时 |
| `err` | `name`、`code`，以及脱敏后的 `message` 与 `stack` | 错误记录上 |
| `truncated` | 被删去的字节数 | 记录被截短以适应长度时 |

- **会话与轮次键。** `sessionId` 与 `turn` 是上游自己的值，因此可以从 chat 的某个轮次追溯到其背后的进程记录。任何会话日志事件都不增加字段。
- **过长的记录。** 超过 16,384 字节的记录先脱敏再截短：缩短 `msg` 与 `err.stack`，并由 `truncated` 说明删去了多少字节。
- **捕获的行。** 捕获的输出按换行符拆分，每行成为一条记录。一行在其换行符到达前被暂存，最多 65,536 字节；更长的行在该大小处作为整体脱敏，写成一条带 `truncated` 的记录，该行到下一个换行符为止的其余部分被丢弃并计数。

<a id="rotation-and-retention"></a>

## 轮转与保留

| 项目 | 设置 |
| --- | --- |
| 轮转大小 | 10 MiB（10,485,760 字节） |
| 每个入口保留的文件 | 5 个：活动文件与 4 个轮转文件 |
| 删除期限 | 14 天（1,209,600 秒） |
| 期限检查 | 机器上任一 Delo 进程启动时、有 Delo 进程运行期间每 3,600 秒一次，以及执行 `delorun logs --prune` 时 |

- **轮转。** 在某次写入会使活动文件超过 10 MiB 之前，写入方把 `<name>.log.3` 重命名为 `<name>.log.4`，再依次把编号更小的文件向上重命名，把活动文件重命名为 `<name>.log.1`，然后打开新的活动文件。超出 `.4` 的轮转文件被删除。因此每个入口最多占用 50 MiB。
- **期限。** 每次期限检查时，入口中最早记录早于 14 天的每个文件都被删除；该文件是活动文件时，先轮转再删除。任一 Delo 进程启动时，都会清理它能访问的每个本地入口的过期文件，因此已停止的 home 进程的日志同样会被清理；`delorun logs --prune` 按需执行清理。
- **上限（Delo 运行期间）。** 机器上有 Delo 进程运行期间，一条记录在它满 14 天后的第一次期限检查时被删除，最多晚 3,600 秒。没有 Delo 进程运行期间，过期记录保留到某个 Delo 进程启动或执行 `delorun logs --prune` 为止。
- **会话日志** 从不按这些规则轮转或删除。

<a id="redaction"></a>

## 脱敏

每条记录在写入之前都经过脱敏器，包括 Delo 自己的记录与捕获的输出。脱敏器在截短之前运行，因此它从不会遇到被截成两半的密钥。

1. **已知值。** 进程持有或读取的每个密钥值都在加载时向脱敏器登记：模型与提供方密钥、启动令牌、会话密钥、cookie 值、所有者验证码、设备与中继密钥、S2 辅助通道密钥，以及被转发的部署密钥与令牌。至少 8 个字符的已登记值的每次出现都被替换为 `[redacted:<kind>]`，包括其 base64、base64url、十六进制与 URL 编码形式。
2. **结构化字段。** 序列化之前，名称包含 `key`、`token`、`secret`、`password`、`passwd`、`cookie`、`credential`、`authorization` 或 `session`（不区分大小写）的每个对象键的值都被替换为 `[redacted]`。本约定指定的 id（`sessionId`、`startId`、`workspaceId`）不受此规则影响。
3. **模式。** 匹配以下形式的文本被替换为 `[redacted:<kind>]`：`Authorization`、`Proxy-Authorization`、`Cookie` 或 `Set-Cookie` 头的值；`Bearer` 或 `Basic` 凭据；URL 中的用户信息；名称包含 `token`、`key`、`secret`、`password`、`code` 或 `sig` 的 URL 查询参数的值；PEM 私钥块；以 `sk-` 开头的提供方密钥；以 `ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_` 或 `github_pat_` 开头的 GitHub 令牌；以 `AKIA` 开头的 AWS 访问密钥 id；JSON Web Token；以 `xox` 开头的 Slack 令牌；位于非字母数字字符之间、恰好由 26 个 `A`–`Z` 与 `2`–`7` 字符组成的串，即所有者验证码的形式；以及名称包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD` 或 `COOKIE` 的 `NAME=value` 对的值。
4. **错误。** 错误的消息与堆栈经过第 1 步与第 3 步；错误自身的属性经过第 2 步。

<a id="delorun-logs"></a>

## delorun logs

| 命令 | 打印 |
| --- | --- |
| `delorun logs` | 每个本地入口及其位置、是否存在、大小与最早记录的时间，然后是当前 profile 的 home 进程的最后 50 条记录 |
| `delorun logs <surface>` | 该入口的最后 50 条记录；`-n <count>` 设置条数，最多 10,000 |
| `--follow` | 新写入的记录，跨越轮转 |
| `--since <duration>` | 比该时长更新的记录，例如 `30m` 或 `2d` |
| `--session <id>`、`--turn <n>` | 带该 `sessionId`、以及带该 `turn` 的记录 |
| `--json` | 按存储形式输出的记录 |
| `--path` | 只输出活动文件的路径 |
| `--clear [<surface>]` | 确认后删除该入口的轮转文件并清空其活动文件；不指定入口时，作用于每个本地入口与上游的 `startup-*.log` 文件 |
| `--prune` | 立即删除每个本地入口的每个过期文件（与期限检查相同），并打印每个被删除的文件 |

- **入口名称。** `home`（当前 profile 的 home 进程，或 `--profile <name>`）、`supervisor`、`desktop-host` 与 `startup`。`relay` 不在本地：`delorun logs relay` 打印中继容器内的位置，以及中继指南中读取它的命令。
- **人类可读输出。** `<ts> <level> <surface> [<sessionId>/<turn>] <msg>`。

<a id="purge-and-process-logs"></a>

## 清除与进程日志

清除（[C8](c08-archive-and-trash.zh.md)）从 Delo 控制的每个存储中删除一个 chat。进程日志仍可能在捕获的输出或错误行中保留它的片段。

- **说明。** 清除会说明：被清除内容的片段可能留在进程日志中，直到本约定的保留规则删除它们：在 Delo 运行期间，最多在写入后 14 天，其上限如[轮转与保留](#rotation-and-retention)所规定。
- **选项。** 清除提供立即清空进程日志的选项。受影响的日志是每个本地入口的文件以及上游的 `startup-*.log` 文件，因为捕获的记录并不总是携带会话 id。选择该选项时，对这些文件执行 `delorun logs --clear` 的效果。
- **运行中的写入方。** 清空操作就地清空每个活动文件，并删除每个轮转文件，因此运行中的写入方会继续写入被清空的文件。

<a id="limits"></a>

## 限额

| 限额 | 值 |
| --- | --- |
| 记录行 | 最多 16,384 字节 |
| 暂存的捕获行 | 最多 65,536 字节 |
| 轮转大小 | 10 MiB |
| 每个入口保留的文件 | 5 |
| 删除期限 | 14 天 |
| 期限检查间隔 | 3,600 秒 |
| 登记密钥的最小长度 | 8 个字符 |
| 默认打印的记录数 | 50 |
| `-n` | 最多 10,000 |
| 日志目录的权限模式 | 0700 |
| 日志文件的权限模式 | 0600 |

<a id="consumers"></a>

## 使用方

- `delo/packages/logs`：日志器、Cordis 日志器导出器、捕获、脱敏、轮转与跨入口拒绝测试套件。
- `delo/apps/cli`：`delorun logs` 与清除时提供的选项。
- `delo/packages/home-process`、`delo/packages/supervisor` 与 `delo/apps/relay`：它们各自的入口。
- 上游的 `apps/desktop`：桌面 Host 的日志文件。
- 清除与回收站（[C8](c08-archive-and-trash.zh.md)）：说明与选项。

<a id="compatibility"></a>

## 兼容性

- 文件位置、入口名称、`delorun logs` 的参数与记录字段都是外部接口：agent 会读取它们。可以添加字段；删除或重命名字段、移动位置属于破坏性变更，需在 `delo/docs/upgrade-guide/` 下附升级指南。
- 读取方忽略未知字段。
- 轮转与保留的取值只在本约定中修改，并同时修改清除的说明。
- 对本约定的任何修改都不改变上游的会话格式。
- 类型包跟随 Delo 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

### 要求

1. 任何密钥、令牌、私钥、所有者验证码或 cookie 都不会进入进程日志。脱敏覆盖 Delo 自己的日志器与上游代码被捕获的输出，并在截短之前运行。
2. Delo 自己的记录不包含 chat 文本、提示词、模型输出、工具参数或结果，也不包含文件内容。
3. 日志目录的权限为 0700，日志文件为 0600，因此只有本人能读取它们；它们位于 Delo home 之下，在那里每种沙箱方言都拒绝受限命令写入，并在 [C1](c01-home-layout.zh.md) 的 `home-read` 得到强制执行之处拒绝读取。
4. 记录中的 `sessionId`、`turn`、`workspaceId` 与 `startId` 都是不携带密钥的 id。
5. 监管器从不记录请求正文、凭据或环境变量的值；更新通道记录被拒绝的认证时不含所提交的值。
6. 在 Delo 运行期间，进程日志在写入 14 天后删除；任一 Delo 进程启动与 `delorun logs --prune` 都会清理过期日志，清除会说明这一上限，并提供立即清空日志的选项。
7. `delorun` 从不写入上游的原始启动报告。

### 拒绝测试

| 测试 | 证明 |
| --- | --- |
| `log-canary-every-surface` | 脱敏器第 1 步中每种类型的金丝雀密钥，经 Delo 的日志器以及经树中每个入口所捕获的上游输出植入后，都不会以原始、base64、base64url、十六进制或 URL 编码形式出现在任何日志文件（包括轮转文件）中 |
| `log-canary-split` | 被拆分到两次捕获输出写入中的金丝雀密钥，以及位于超过 65,536 字节的行中的金丝雀密钥，都不会出现在日志文件中 |
| `log-canary-patterns` | 捕获输出中植入的 `Authorization` 头、URL 用户信息、PEM 密钥与所有者验证码形式的值都被脱敏 |
| `log-desktop-host-file` | 桌面 Host 的输出到达 `logs/desktop-host/desktop-host.log` |
| `log-rotation` | 写入超过 10 MiB 时文件轮转，最多存在 5 个文件，最早记录早于 14 天的文件在下一次期限检查、下一个 Delo 进程启动时以及由 `delorun logs --prune` 删除，会话日志不受影响 |
| `log-modes` | 日志目录以 0700 创建，文件以 0600 创建 |
| `log-session-keys` | 一个轮次的记录携带其 `sessionId` 与 `turn`，对等回放显示没有会话日志事件带有新字段 |
| `log-purge-clear` | 选择清空选项后完成清除，被清除 chat 的金丝雀残留不会留在任何日志文件中 |
| `log-confined-write-denied` | 在每种方言上，受限命令都无法写入日志文件（[C1](c01-home-layout.zh.md) 的 `home-write`） |

### 本约定不能证明的内容

- **Delo 停止时的保留。** 14 天的上限只在 Delo 运行期间成立。没有操作系统定时器删除日志，因此在没有任何 Delo 进程启动的机器上，过期记录会保留到某个 Delo 进程启动或本人执行 `delorun logs --prune` 为止。
- **脱敏无法捕获的内容。** 第 1 步与第 3 步捕获已登记的值与列出的形式。Delo 从未加载、也不匹配任何列出形式的密钥，若由上游代码打印出来，可能会通过；拒绝测试套件证明列出的各类型，其余部分由保留上限与清除时提供的选项覆盖。
- **捕获的内容。** 捕获的上游输出可能包含来自 chat、命令与文件的文本；脱敏从中删除密钥，但不删除这些文本，它们保留到保留规则或清除时的清空选项将其删除为止。

<a id="enforcement-per-platform-and-dialect"></a>

## 各平台与方言的强制执行情况

| 要求 | Linux | macOS | Windows | 中继容器 |
| --- | --- | --- | --- | --- |
| 仅所有者可访问 | 权限模式 0700 与 0600 | 权限模式 0700 与 0600 | [C1](c01-home-layout.zh.md) 检查的 DACL | 容器内权限模式 0700 与 0600，归中继的用户所有 |
| 受限命令无法写入日志 | 每种方言（[C1](c01-home-layout.zh.md) 的 `home-write`） | Seatbelt（[C1](c01-home-layout.zh.md) 的 `home-write`） | windows-acl（[C1](c01-home-layout.zh.md) 的 `home-write`） | 那里不运行 agent 命令 |
| 受限命令无法读取日志 | 在 [C1](c01-home-layout.zh.md) 的 `home-read` 得到强制执行之处：bwrap 与 Landlock | Seatbelt | 在 `windows-home-read-label` 通过之处 | 那里不运行 agent 命令 |
| 没有 Delo 进程运行时的清理 | 下一次 Delo 启动或执行 `delorun logs --prune` 时 | 下一次 Delo 启动或执行 `delorun logs --prune` 时 | 下一次 Delo 启动或执行 `delorun logs --prune` 时 | 下一次中继启动时 |
