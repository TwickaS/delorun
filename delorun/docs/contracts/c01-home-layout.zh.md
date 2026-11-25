---
description: "约定 C1：~/.delorun home 目录树、其权限模式与拒绝规则、密钥与套接字的存放位置、每次启动的令牌、CLI profile、带 current 与 previous 指针的运行时仓库、npm 启动器的下载与校验，以及每种沙箱方言能强制执行的内容。"
---

# C1 Home 布局与运行时仓库

[English](c01-home-layout.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本约定规定 Delorun 把本人的 home 存放在磁盘上的位置，以及 `delorun` 命令如何找到并切换它所运行的运行时。它定义 `~/.delorun` 目录树及每个条目的所有者，home 及其受保护文件的权限模式（组件拒绝权限更宽的文件），密钥与两个拒绝受限命令的套接字的存放位置，每次 home 进程启动时写入的令牌，与桌面应用自身 profile 并列的 CLI profile，带 `current` 与 `previous` 指针文件的运行时仓库，覆盖变量，以及 npm 启动器的下载与校验。它说明每种操作系统与沙箱方言能强制执行哪些限制规则。类型包 [`@delorun/contract-home-layout`](../../packages/contract-home-layout/README.zh.md) 以常量形式提供名称、代码与限额。

<a id="status"></a>

## 状态

home、其在 Linux 与 macOS 上的权限模式、更新通道、锁、运行时仓库、npm 启动器，以及 CLI profile 在 bwrap、Landlock 与 Seatbelt 上的限制规则已经构建；报告这些规则的检查、Windows 以及 Docker 监管器的通道尚未构建。

- **已构建且已接入：** home 解析及其拒绝；home 的目录与受保护文件及其在 Linux 与 macOS 上的权限模式与拒绝规则；更新通道的套接字与启动令牌；home 锁；带安装、切换与启动检查的运行时仓库；npm 启动器的下载与校验；以及在 CLI profile 中，bwrap、Landlock 与 Seatbelt 上的 `home-write`、`home-read` 与 `token-read` 规则，bwrap 与 Seatbelt 上的 `home-connect` 与 `docker-connect` 规则，以及对包含 home 的可写根目录的拒绝；WSL 下 bwrap 上的 `wsl-interop` 规则（Landlock 在那里拒绝受限命令）；以及在内核提供虚拟机套接字的每个地方，bwrap 上的 `vsock` 规则。
- **已构建、但无任何接入：** Docker 监管器的套接字。`delorun start` 把它加入被拒绝的套接字，但没有任何进程创建它，因为没有任何命令启动监管器（[C9](c09-runtime-supervisor.zh.md)）。
- **尚未构建：** `delorun plugin` 下 Delorun 的规则（它运行上游的 pnpm 操作，不带其中任何规则）；每次启动时的探测，以及 `confinement-rule` 与 `home-modes` 检查（`delorun verify` 把它们报告为未运行）；setup 的 Docker 标注；完全访问提示中对完全访问可触及内容的说明；WSL 下与 Linux 上对 Docker Desktop 控制套接字目录的拒绝；Windows 上的 DACL 检查、命名管道以及任何读取限制；安装脚本、`bin/` 下的启动器副本与登录项；以及 npm 构建证明。这些规则见[原生限制设计](../design/native-confinement.zh.md)与[发布工作流设计](../design/release-workflow.zh.md)。

下文中被本列表列为尚未构建或无任何接入的要求与拒绝测试，在某次变更构建并接入它们之前，不保护任何人。

## 目录

- [状态](#status)
- [home 目录](#the-home-directory)
- [home 目录树](#the-home-tree)
- [权限模式与拒绝规则](#modes-and-the-refusal-rule)
- [密钥](#secrets)
- [套接字与启动令牌](#sockets-and-the-start-token)
- [home 锁](#the-home-lock)
- [Profile](#profiles)
- [运行时仓库](#the-runtime-store)
- [启动器与仓库的兼容性](#launcher-and-store-compatibility)
- [npm 启动器与安装脚本](#the-npm-launcher-and-the-install-script)
- [限制规则](#confinement-rules)
- [限额](#limits)
- [错误](#errors)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [各平台与方言的强制执行情况](#enforcement-per-platform-and-dialect)

<a id="the-home-directory"></a>

## home 目录

Delorun home 是每人每台机器一个的目录。上游 harness 把它用作自己的 home（`DSH_HOME`），因此上游数据与 Delorun 数据共用同一棵目录树。

- **解析。** `DELORUN_HOME` 已设置且非空时，`delorun` 用它解析 home；否则使用操作系统 home 目录拼接 `.delorun`（`~/.delorun`，Windows 上为 `%USERPROFILE%\.delorun`）。开头的 `~` 按上游 `expandHomePath` 的方式展开，结果规范化为绝对路径。home 父路径中的每个符号链接都会在该路径存在的范围内被解析，home 自身的名称保持不变，因此解析出的 home 与其下文件所报告的目录一致。本身是符号链接的 home 以 `HOME_MODE` 被拒绝。下述拒绝在解析每个符号链接（包括 home 自身的）之后比较路径。
- **拒绝。** 解析出的 home 若不是绝对路径、等于文件系统根目录或操作系统 home 目录（`HOME_INVALID`），或等于或位于上游默认 home `~/.dsh` 之内（`HOME_IS_DSH_HOME`），`delorun` 拒绝它。
- **上游变量。** `delorun` 在它启动的每个运行时进程的环境中把 `DSH_HOME` 设为解析出的 home。继承来的 `DSH_HOME` 被忽略；若其值不同，`delorun status` 会指出。
- **上游的 home。** Delorun 从不读取、写入或迁移 `~/.dsh`。本人只能通过显式导入把上游数据移入 Delorun。
- **覆盖变量。** `DELORUN_HOME` 选择 home。`DELORUN_PROFILE` 选择 CLI profile（[Profile](#profiles)）。没有其他变量改变布局；运行时仓库没有覆盖变量，`current` 以外的运行时只能按下文的切换规则运行。

<a id="the-home-tree"></a>

## home 目录树

Delorun 在 home 顶层添加标为 Delorun 的条目。其他每个条目都属于上游，保留上游的布局与权限模式，并由上游文档说明。

```text
~/.delorun/                         0700  the home; upstream's DSH_HOME
  .credentials.yaml              0600  upstream credentials provider: model keys, the browser session secret
  .env                           0600  upstream credentials fallback, never written by Delorun
  cordis.patch.yml                     upstream home patch
  AGENTS.md, skills/                   upstream user instructions and skills
  profiles/default/                    the CLI profile, in upstream's profile layout
  profiles/desktop/                    the desktop app's upstream profile and its lock
  profiles/headless/                   the profile delorun headless boots: upstream's headless template with @delorun/bundle-headless linked
  sessions/, attachments/, cache/, storages/, spill/, dsh-runtimes/, ...   upstream data
  logs/                                upstream startup reports and the operational logs of C20
  runtimes/                      0700  Delorun: the runtime store
  staging/                       0700  Delorun: runtime installs in progress
  packs/<release>/<pack>/        0700  Delorun: plugin packs, unpacked per release and sealed read-only like an installation
  trust/                         0700  Delorun: the verified release root, timestamp and log checkpoint (C2, C18), and the installations' identity records
  status/                        0700  Delorun: each installation's update status record (C3)
  catalogue/                     0700  Delorun: the verified catalogue index and revocation list (C13)
  secrets/                       0700  Delorun: secret files, 0600 each
  run/<profile>/                 0700  Delorun: home lock, start token, sockets, update record, update check, setup progress, start overlays
  data-copies/                   0700  Delorun: the session-data copy an update took, and a restore's journal (C3)
  data-set-aside/                0700  Delorun: chat data a rollback set aside (C3)
  trash/                         0700  Delorun: trashed chats and workspaces until retention ends or a restore (C8)
  archive/                       0700  Delorun: workspace archive imports, staged and published (C8)
  supervisor/                    0700  Delorun: the Docker supervisor's roots file (C9)
  bin/                           0700  Delorun: the launcher copy used by the install script and login items
  alerts/                        0700  Delorun: signed certificate-alert files (C5)
  trash/                         0700  Delorun: deleted chats and workspaces until a purge, and the retention record (C8)
  archive/                       0700  Delorun: imports in progress and imported workspaces (C8)
  changes/                       0700  Delorun: approved plugin content, the change log, protection, work sessions and harness edits (C21)
```

[C20](c20-operational-logs.zh.md) 定义的运行日志位于上游 `logs/` 下的各入口子目录中，与上游的 `startup-*.log` 报告并列。home 目录树以空目录创建 `status/`、`catalogue/`、`supervisor/`、`bin/` 与 `alerts/`，且没有任何内容写入它们：拥有它们的功能尚未构建或尚未接入（[状态](#status)）。

类型包的 `DELORUN_HOME_ENTRIES` 列出上面的每个 Delorun 条目；当 Delorun 的代码在 home 下构建了一个既不在该列表中、也不是上游条目的顶层条目时，其 `home-entries` spec 失败。

- **`trust/`。** `root.json` 是最新通过校验的根，`timestamp.json` 是最新通过校验的时间戳，其 `version` 即所保存的最高版本（[C2](c02-release-manifest.zh.md)），`checkpoint.json` 是最新通过校验的日志检查点（[C18](c18-release-log.zh.md)），`release-log.json` 是每个已安装发行版的发布日志检查状态——`verified`，或带原因的 `unchecked`——安装在运行时仓库安装该发行版后写入它，启动检查更新它（[C18](c18-release-log.zh.md#check-states)）。每个文件都以原子方式替换，且从不替换为更旧的版本；CLI 启动器与桌面更新器共用它们。`roots/<n>.root.json` 按根版本各保存一个安装所走过的根，最旧的在前，供启动时证明所保存的根比启动器自带的每个根都新（[C2](c02-release-manifest.zh.md#key-rotation)）。`channel.json` 记录 home 的发行版来源：`{"v":1}`，并带有安装它的启动器构建时所用的 `channelOrigin` 与 `logOrigin`，取生产值时省略对应字段；启动器在运行时仓库安装了来自它的发行版后写入该文件，`delorun update` 从这些来源获取，并以所保存的根为锚点，这些根必须构成链，每个根都由前一个签名。Delorun 的任何环境变量、设置或运行时命令都不能改变该通道：只有本人在终端中运行为另一通道构建的启动器时，Delorun 才会改变它。该文件位于 `trust/` 下，沙箱禁止受限命令写入；同一用户的非受限进程（包括 Host 插件）可以像写入 home 中任何文件一样写入它，因此该记录只决定从何处获取发行版，而发行版只有在所保存的根下通过校验才会安装。`runtime-files/delorun-<version>-<platform>.json`（权限 0600）是 C2 的启动检查所读取的已安装运行时的标识记录；运行时仓库在 `store.lock` 下写入它，保留规则随其版本一起删除它，且它位于受限命令的每个读取豁免之外。 `runtime-files/packs/<release>/<pack>.json`（权限 0600）记录外部 npm 包放进已安装插件包的文件的摘要；插件包安装在 `store.lock` 之下把它与封存的插件包一起写入，保留规则随发行版一起删除它。
- **`status/`。** `cli-home.json` 与 `desktop-host.json` 是 [C3](c03-update-report.zh.md) 的状态记录；每个安装只写自己的记录，并读取另一个的记录。
- **`run/<profile>/`。** 除锁、令牌与套接字外，它还保存 `setup-progress.json`（让中断的 setup 得以继续的记录，[C11](c11-setup-answers.zh.md)），以及启动时传给上游 profile 运行器的 overlay：`sandbox.patch.yml`，即[本约定](#confinement-rules)的限制规则，以及安全模式开启期间的 `safe-mode.patch.yml`。每次启动都会重写这些 overlay；它们不是本人的配置。home 进程的调试器监听期间（`delorun start --inspect`），它还保存 `inspector.json`，权限模式 0600，内含进程 id、调试器的地址与打开时间，进程退出时移除（[要求 16](#requirements)）。
- **`run/<profile>/update.json`。** [C19](c19-home-process.zh.md#interrupted-updates) 与 [C3](c03-update-report.zh.md#rollback) 的更新记录：两个版本、聊天数据是否不同、是否已复制，以及 `targetStarted`，以权限 0600 写入，并在目标进程生成之前同步到磁盘。更新提交后它以阶段 `committed` 保留，供之后的回滚读取，回滚完成时删除。
- **`run/<profile>/update-check.json`。** 更新检查的记录（[C3](c03-update-report.zh.md#update-check)）：该 profile 上一次检查的运行时间、它校验过的最新发行版，以及上一次检查失败的原因，以原子方式、权限 0600 写入，并在 profile 关闭了检查的启动中删除。
- **`run/<profile>/update-result.json`。** 上一次更新或回滚如何结束（[C19](c19-home-process.zh.md#the-outcome-record)）：结果、两个版本、拒绝代码与未通过的健康判据，由 home 进程在每次结束时以权限 0600 写入，使工作室在无法观察的切换之后能说明发生了什么；人在工作室中关闭它会将其删除，下一次更新或回滚会替换它。
- **`run/<profile>/update.previous.json`。** 较新的更新运行期间，上一次更新的已提交记录：较新的更新在切换之前结束或被回滚时，它恢复为 `update.json`；较新的更新提交时，它被删除。
- **`run/<profile>/changes-boot.json`。** 记录配置文件上次启动时 Changes 下加载了哪些插件，或该次启动的失败；由 home 进程在每次启动后以权限模式 0600 写入，由 `delorun doctor` 读取（[C21](c21-changes.zh.md#what-verify-and-doctor-report)）。没有任何启动读取它。
- **`run/<profile>/changes-work.json`。** 工作会话中最近一次失败的重新加载，即 `{"schema":"delorun.changes-work/1","plugin","at","error"}`，权限模式 0600；在 Delorun 回到上次加载成功的内容时写入，在工作会话中某次重新加载成功或会话开始时移除（[C21](c21-changes.zh.md#work-sessions)）。`delorun doctor` 与 studio 读取它；没有任何决定依据它。
- **`changes/harness/`。** 本人对 harness 自身的修改（[C21](c21-changes.zh.md#harness-edits)）：`log.json`，即 harness 的变更日志；以及每个已安装运行时的 `<runtime>/approved.json`，即批准内容与已签名发布不同的文件；`<runtime>/copy/app/`，即本人可写的该运行时 `app/` 目录副本（文件 0600，可执行文件 0700）；`<runtime>/scan-cache.json`；`<runtime>/pending.json`，即上一次读取该副本时找到的每项更改所在的文件；以及 `<runtime>/run/<digest>/`，即某次启动所运行的组合目录树，其中未编辑的文件是指向 `runtimes/<runtime>/` 的硬链接，文件与目录都是只读的。Changes 从不写入 `runtimes/` 本身。启动会移除它不再运行的组合目录树，以及运行时仓库中已不再安装的运行时的目录。
- **`run/data-users/<pid>`。** 每个使用共享存储（`sessions/`、`storages/` 及其旁边的其余存储）与 `runtimes/current` 的进程一个文件，权限 0600，保存 `{"mode":"shared"|"exclusive","command":"<name>"}`，并在平台报告时带有持有者的 `processStart` 与 `pidNamespace`（[home 锁](#the-home-lock)）。每个 home 进程从获取其 home 锁之前直到退出，都以 `"command":"start","profile":"<profile>"` 注册为 `shared`；`delorun headless` 与 `delorun plugin` 注册为 `shared`；`delorun trash`、`export` 与 `import` 在同时持有每个 profile 的 home 锁期间注册为 `exclusive`；没有 home 进程运行时的 `delorun recover rollback`（除非带 `--profile-only`）在持有其 profile 的 home 锁期间以 `"command":"recover"` 注册为 `exclusive`。只要列有其他任何存活进程，独占使用者就拒绝运行；只要列有独占使用者，共享使用者就拒绝运行；只要列有独占使用者，或另一个 profile 的更新或回滚处于其快照与结束之间，home 进程就拒绝启动。更新的准备、会话数据复制、恢复与运行时切换，以及回滚，只要列有其他任何存活进程（包括另一个 profile 的 home 进程）就拒绝运行，并指出该进程；更新在写入其更新记录之前检查一次，之后在其 Host 为切换而停止之前再检查一次，因此能发现在两者之间登记的进程。进程自己的文件从不计入。进程已退出、或记录的启动标识与存活进程不同的文件不算存活，会被删除；记录的 Linux 启动不是当前这次启动的文件不算存活，会被删除，无论它记录的是哪个 pid 命名空间；记录了另一个 pid 命名空间的本次启动的文件算存活，予以保留；无法读取的文件算作独占使用。`data-users` 从不是某个 profile 的运行目录：它是[保留的 profile 名称](#profiles)。
- **`data-format.json`。** 位于 home 根目录，权限模式 0600：`{schema: "delorun.home-data-format/1", delorun, dsh, formats}`，即最后一次在该 home 上启动的发布，以及该发布的 `data-formats.json`（[C3](c03-update-report.zh.md#data-formats)）。每次启动在 Host 打开数据之前，依据所运行发布的 `data-formats.json` 写入它；较旧发布的启动会留下一条记录，照原样显示较新的数据。在该记录出现之前创建的 home 没有它，读取方此时把该 home 的数据格式视为未知。`delorun repair` 把它与所安装的发布相比较。
- **`import-preview.txt`。** 位于 home 根目录，权限模式 0600：`delorun setup` 的导入分节会从 DeepSeek Harness 的 home 复制什么、以及什么会留在原处的完整列表，在该分节提出问题时写入，以便本人之后阅读（[C11](c11-setup-answers.zh.md)）。每个问题都会重写它；没有任何东西会读回它。
- **`runtimes.set-aside-<time>/`。** `npx delorun@latest repair` 所替换的程序仓库，完整保留。只有本人能通过 `delorun recover discard` 移除它；`delorun recover status` 会列出它。
- **`data-copies/`。** `<version>/` 保存更新到该版本时所做的会话数据副本：`sessions/` 与 `storages/` 的真实副本，以及旁边的 `copy.json`。较新的更新提交时删除较旧的副本，在切换之前结束的更新的副本随之删除。`restore.json` 是进行中的恢复的日志，在任何 Host 启动之前完成。更新的数据安全步骤写入副本，回滚写入日志，两者都经由 `delorun/packages/update`。
- **`data-set-aside/`。** `<version>-<time>/` 保存回滚用副本替换掉的 `sessions/` 与 `storages/`。除本人通过 `delorun recover discard` 外，没有任何东西删除它。`delorun/packages/update` 的回滚写入它。
- **`trash/`。** `items/<item>/` 保存一个已移入回收站的条目：其 `item.json` 以及从 `sessions/` 移出的对话，直到 home 进程的保留处理或 `delorun trash purge` 清除它，或恢复把它移回；`retention.json` 记录上一次保留处理。studio 的回收站插件与 `delorun trash` 写入它（[C8](c08-archive-and-trash.zh.md#trash-and-purge)）。
- **`archive/`。** `staging/` 保存进行中的导入，`imported/<workspace>/` 保存 `delorun import` 发布的每个工作区；已发布组合中没有任何行读取它（[C8](c08-archive-and-trash.zh.md)）。
- **`catalogue/`。** `index.json` 与 `revocations.json` 是最新通过校验的插件索引与撤销列表，`state.json` 保存二者各自的 `sequence` 与获取时间（[C13](c13-catalogue-revocation.zh.md)）。

<a id="modes-and-the-refusal-rule"></a>

## 权限模式与拒绝规则

在 Linux 与 macOS 上，home 及 Delorun 在其下创建的每个目录的权限模式为 0700，每个受保护文件为 0600。Delorun 以独占创建方式按这些模式创建它们，因此进程 umask 只能使其更严。

- **受保护文件。** `secrets/`、`trust/`、`status/` 与 `catalogue/` 下的每个文件、`run/<profile>/start-token`、`supervisor/roots.json` 以及 [C20](c20-operational-logs.zh.md) 的日志文件。上游的 `.credentials.yaml` 与 `.env` 遵循上游自己的检查：其他用户可读的文件会被拒绝。
- **拒绝规则。** 组件读取受保护文件前先用 `lstat` 检查它。路径是符号链接或不是普通文件、所有者不是本进程的用户，或设置了任一组或其他用户权限位（`0o077`）时，组件以 `SECRET_FILE_MODE` 拒绝该文件。错误给出路径与修复命令 `chmod 600 <path>`。
- **目录。** home、`secrets/` 或 `run/<profile>/` 设置了组或其他用户权限位、是符号链接或属于其他用户时，home 进程以 `HOME_MODE` 拒绝启动。错误给出路径与修复命令 `chmod 700 <path>`。
- **Windows。** Windows 没有权限位，上述检查在那里被跳过；没有任何检查读取路径的 DACL。DACL 检查见[原生限制设计](../design/native-confinement.zh.md#windows)。
- **检查。** `delorun doctor` 检查 home、`secrets/` 与 `run/<profile>/` 的权限模式。`delorun verify` 把其 `home-modes` 检查报告为未运行（[原生限制设计](../design/native-confinement.zh.md#checks-at-each-start)）。

<a id="secrets"></a>

## 密钥

Delorun 的密钥是 C4 至 C7 定义的 home-auth 密钥、中继与 TLS 密钥以及会话密钥。每个密钥存放在 `secrets/<owner>/` 下的一个文件中，由所属约定命名该文件并规定其格式。上游的模型密钥与浏览器会话密钥留在上游的 `.credentials.yaml` 中，它同样位于 home 之下。

- 密钥从不出现在 profile、`cordis.yml`、patch 文件、命令的环境、命令行或日志中。
- 插件的凭据也不例外：其 schema 赋予 `secret` 角色的配置字段，例如网页搜索插件的 DeepSeek API 密钥。无论来自工作室的设置、智能体、旧 `settings.yaml` 的导入还是上游配置编辑器的其他调用方，会把其值保存到 profile patch 的配置修改都会在写入文件之前被拒绝；这些监听器在 Loader 装载第一行之前注册。profile 历史不保存其文件含有此类值的版本；它仍列出各版本并给出原因，撤销与恢复仍可使用。每次启动时，在 Host 提供服务之前，profile patch 或 home patch 中的此类值会通过上游的凭据提供者移入 `.credentials.yaml`，前提是插件在旁边的 `credential-ref` 字段（例如 `apiKeyEnv`）中指明所存密钥：只有当该文件已在该字段给出的名称（包括 schema 默认值）下保存同一个值时才只删除它，否则把它存到一个新的 POSIX 标识符名称下（从不覆盖保存着其他值的名称），并把该字段设为这个名称。名称依据磁盘上的凭据文件选择，并持有每个整理中的启动都会获取的 home patch 写入锁，因此两次启动不会取到同一个名称；最多尝试 100 个名称，之后该值保留原处。改写 patch 之前，凭据文件及其目录会先刷写到磁盘。无法移动的值（其字段旁没有引用字段，或它是表达式）保留原处，每次启动都会在输出和日志中指明它以及移动方法 `!!js process.env.NAME`。空值和 null 视为未设置；`!!js` 表达式除非只读取一个环境变量，否则算作值。更新的快照在含有此类值时被拒绝，在没有 Host 运行、无法判断哪些字段是密钥时也被拒绝。只检查已加载插件的行，因为只有已加载插件的 schema 标出其密钥字段；没有 id 的插入行按其插件名匹配。
- `secrets/permission-defaults/` 还保存每个工作区的权限与网络存储（它们是同意与设置，而非密钥），以及 Host 运行期间其出站代理在 `proxy/<pid>/` 下的套接字；它们放在这里，使受限命令既不能读取也不能更改它们。
- 在 CLI profile 中，只要方言强制执行 `home-read`，home 的限制规则就拒绝受限命令读取 `secrets/` 与上游的凭据文件（[限制规则](#confinement-rules)）。
- Delorun 不把这些密钥存入操作系统密钥库。在 Linux 上，Secret Service 通过 D-Bus 访问，而 D-Bus 对受限命令仍可访问；在 macOS 上，钥匙串条目的访问列表信任运行时的 `node` 可执行文件，而受限命令同样运行它。只要方言强制执行读取规则，放在每种方言都拒绝的目录中的文件就能使受限命令无法读取这些密钥。

<a id="sockets-and-the-start-token"></a>

## 套接字与启动令牌

更新通道（[C19](c19-home-process.zh.md)）与 Docker 监管器（[C9](c09-runtime-supervisor.zh.md)）是拒绝受限命令的两个通道。二者都在 home 下监听，且只接受携带当前启动令牌的请求。没有任何命令启动监管器，因此只有更新通道在监听。

- **套接字路径。** 在 Linux 与 macOS 上，更新通道是 Unix 套接字 `run/<profile>/update.sock`，监管器是 `run/<profile>/supervisor.sock`。二者都是路径名套接字；Delorun 从不在抽象命名空间套接字上监听。套接字在启动令牌写入之后创建，绑定后设为 0600。
- **路径长度。** 套接字路径最多 103 字节。路径更长时，启动以 `SOCKET_PATH_TOO_LONG` 停止，错误给出该路径并要求使用更短的 `DELORUN_HOME`。
- **Windows。** 在每个平台上，更新通道都是文件系统套接字路径；不存在命名管道，也不存在管道 DACL。命名管道见[原生限制设计](../design/native-confinement.zh.md#windows)。
- **启动令牌。** 每次 home 进程启动都在任一通道监听之前，把一个新令牌写入 `run/<profile>/start-token`：来自操作系统加密随机源的 32 字节，以不带填充的 base64url 编码（43 个字符），后跟一个换行符。该文件以 0600 原子替换，home 进程正常停止时删除。
- **令牌有效期。** 令牌只在写入它的那次 home 进程启动运行期间有效。崩溃进程遗留的令牌文件在下次启动时被替换，任何监听方都不接受其值。
- **令牌处理。** 令牌只存在于 home 进程的内存、监管器的内存与令牌文件中。它从不出现在命令行、环境变量、URL、响应或日志中。`delorun` 客户端命令在发送请求时读取该文件。

<a id="the-home-lock"></a>

## home 锁

每个 profile 只有一个 home 进程，它在整个生命周期内持有 `run/<profile>/home.lock`（[C19](c19-home-process.zh.md)）。没有 home 进程运行时，`delorun update` 与 `delorun recover` 在修改仓库期间持有该锁。

- **创建。** 锁以独占创建方式、权限 0600 创建。它包含一个 JSON 对象：`{"v":1,"pid":<integer>,"startId":"<32 lowercase hexadecimal digits>","runtime":"<version>","startedAt":"<RFC 3339 UTC time>"}`，在平台报告时还带有 `"processStart":"<start identity>"` 与 `"pidNamespace":"pid:[<inode>]"`。`startId` 是随机值，在 [C19](c19-home-process.zh.md) 的协议与 [C20](c20-operational-logs.zh.md) 的记录中标识一次启动；它不是密钥。
- **启动标识。** 持有者的启动标识把它的进程与之后使用同一进程 id 的进程区分开。在 Linux 上它是 `linux:<boot id>:<start time>`，boot id 来自 `/proc/sys/kernel/random/boot_id`，启动时间是 `/proc/<pid>/stat` 的第 22 个字段；在 macOS 上它是 `darwin:<milliseconds since the epoch>`，即 `ps -o lstart=` 报告的启动时间。Windows 没有启动标识；没有启动标识的记录（例如 Delorun 在引入它之前写入的记录）只按进程 id 判断：复用该 id 的进程会被视为持有者。
- **启动。** Linux 的 `processStart` 以 boot id 开头，同一次启动的每个 pid 命名空间读到的 boot id 都相同。boot id 与当前系统不同的记录指向更早一次启动的进程，无论其进程 id 或 pid 命名空间现在指向什么，该进程都已退出，因此重启绝不会遗留一个读起来仍存活的锁。
- **同一内核。** home 只由同一个运行中内核的进程共享：同一虚拟机的容器、沙箱与 WSL 发行版，绝不是各自拥有内核的机器或虚拟机。boot id 与更新套接字正是在此假设下判断锁，因此共享 home 文件夹的另一个内核上的持有者会被读作更早的启动，其锁会被接管。
- **Pid 命名空间。** 在 Linux 上，记录写明其 `pid` 编号所在的 pid 命名空间，即写入者自己的命名空间，取 `/proc/self/ns/pid` 所链接的值：`pid:[<inode>]`。位于另一个 pid 命名空间的持有者（例如共享 home 的容器或沙箱）所记录的进程 id 在读取者的命名空间中不指向任何进程，因此当读取者自己的命名空间与记录的不同，或无法读取时，它不判断该持有者，而视其为存活。没有 `pidNamespace` 的记录（Delorun 在引入它之前写入的、其他平台写入的，以及 Linux 在无法读取 `/proc/self/ns/pid` 时写入的）只按进程 id 与启动标识判断。存在但不是该形式的 `pidNamespace` 会使记录格式错误。
- **失效的锁。** 只有当记录写明的是更早的启动，或者未写明 pid 命名空间或写明的是竞争者自己的命名空间并且记录的进程已不存在（`ESRCH`），或记录带有启动标识而使用该 id 的存活进程的启动标识不同时，竞争者才替换该锁。
- **已放弃的锁（同一次启动）。** 本次启动中写明另一个 pid 命名空间的记录无法被查找，例如 WSL 发行版重启而其虚拟机继续运行时。持有者在其更新通道绑定后，以原子方式把 `"listening":true` 写入其记录（其他字段不变），并在关闭通道之前将其移除；移交的记录在继任者的通道开始监听之前没有该字段。竞争者只有在记录写明 `listening`，且到持有者更新套接字的连接被拒绝（`ECONNREFUSED`，即没有进程在其上监听）时才接管这样的锁，并以在接管保护下重新读取的记录再判断一次。存活的监听者绝不会拒绝连接，而存活的持有者会在关闭之前取消标记，因此在 `listening` 之后出现拒绝，意味着持有者已关闭通道，正在退出或已死亡。从未到达 `listening` 的记录、超时、缺少套接字或令牌文件、任何其他失败以及任何应答，都保持拒绝；错误随后用平实的话指出补救办法。接管会向该次启动的日志写入一条警告。
- **无响应的持有者。** 记录的进程存在（有记录的启动标识时，启动标识也相同），或记录写明了另一个 pid 命名空间，但其更新通道在 2 秒内没有回答 `status` 时，竞争者以 `HOME_UNRESPONSIVE` 停止并给出进程 id。它从不接管该锁。
- **范围。** 锁按 profile 划分。桌面应用的上游锁 `profiles/desktop/lock` 是另一个文件，Delorun 从不获取、写入或等待它。

<a id="profiles"></a>

## Profile

- **CLI profile** 是 `default`，位于 `profiles/default/`，采用上游的 profile 布局（`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`node_modules/`）。在上游的文件旁边，`delorun-migrations.json` 以权限 0600 保存 `{"v":1,"done":[<id>…]}`，即全新启动已完成的一次性 profile 变更，例如把 studio 组合包加入较早发行版设置的 profile。全新启动在其 Host 启动之前、在 home 锁下运行每个未列出的变更，更新的后继进程则不运行任何变更。无法读取的记录不运行任何变更：启动在其输出与日志中给出警告，写明该文件以及删除它可以让下一次启动应用这些变更，然后不加改动地启动该 profile。没有记录的 profile 会一次性接管较早发行版保存在 `run/<profile>/migrations.json` 中的记录。profile 历史不跟踪该记录，因此恢复不改动它。`DELORUN_PROFILE` 或 `--profile` 选择另一个 CLI profile，其名称为 1 到 32 个小写字母、数字、连字符或下划线，以字母或数字开头（`PROFILE_NAME_PATTERN`）；启动器与 `delorun` 以同一规则拒绝其他任何名称。每个 CLI profile 都有自己的 `run/<profile>/` 目录、锁、令牌与通道。
- **保留名称。** CLI profile 不能使用同一 home 中其他东西在 `profiles/` 或 `run/` 下使用的名称，也不能使用某个 `delorun` 命令作为自己的 profile 启动的名称（`RESERVED_PROFILE_NAMES`）：`desktop`，桌面应用的 profile；`headless`，`delorun headless` 启动的 profile，Delorun 以沙箱 overlay 与 `@delorun/bundle-headless` 组合它；`data-users`，因为 `run/data-users/` 保存全 home 互斥的记录，而 profile 在那里的运行目录会绕过该互斥；`node_modules`，上游的包层 `profiles/node_modules/`，上游拒绝把它用作 profile；以及 Windows 设备名 `con`、`prn`、`aux`、`nul`、`com1` 到 `com9` 与 `lpt1` 到 `lpt9`，这些名称在 Windows 上不能用作文件夹。保留名称以任何大小写形式都会被拒绝。在 Delorun home 中没有任何东西启动的上游模板名称（例如 `web` 与 `tui`）仍可使用。启动器以及每个接受 `--profile` 或 `DELORUN_PROFILE` 的 `delorun` 命令，在读取或修改该 profile 或其运行目录之前，以用法退出码拒绝保留名称，并写明该名称及原因（`profileNameProblem`），setup 的 profile 问题会再次询问。`delorun plugin` 与 `delorun logs` 的解析器会再次读取 `--profile`，因此它们检查命令行携带的每个 `--profile` 值（`--profile <name>` 或 `--profile=<name>` 形式），并拒绝不一致的值；持有保留名称的 CLI profile 的 home 以同样方式被拒绝，直到本人把它移到另一个名称下。
- **headless profile** 是 `headless`，位于 `profiles/headless/`，采用上游的 profile 布局。第一次 `delorun headless` 运行从上游的 `headless` 模板创建它，并以一次性变更 `headless-bundle` 把 `@delorun/bundle-headless` 链接进去，`profiles/headless/delorun-migrations.json` 像记录 CLI profile 的变更一样记录它；每次 `delorun headless` 运行都在上游的 profile 文件锁下、不持有 home 锁地应用记录未列出的变更，无法读取的记录不运行任何变更。同一次运行会把该组合包带到较早发行版创建的 profile 中。加载器未加载该组合包的 profile 会在启动之前停止 `delorun headless`，并写明该组合包；删除 `profiles/headless/delorun-migrations.json` 可让下一次运行再次链接它，删除 `profiles/headless/` 文件夹可让 Delorun 重新创建该 profile。该组合包添加的行受 [C19](c19-home-process.zh.md#host-invariants) 的 Host 不变式约束。
- **桌面 profile** 是上游位于 `profiles/desktop/` 的 `desktop` profile，只由桌面应用管理。`delorun` 拒绝把 `desktop` 用于自己的运行和 `delorun plugin`，与上游 CLI 的拒绝方式相同。
- **`delorun plugin`** 是针对该 home 运行的上游 `dsh plugin`：它在上游的 profile 文件锁下，在某个 CLI profile 的目录中运行 pnpm，修改其 `package.json`、锁文件与 `node_modules/`，并记录组合包列表。它不启动 Host，因此[限制规则](#confinement-rules)、启动 overlay 与 C19 的 Host 不变式都不适用：pnpm 以该命令的环境不受限制地运行，只有在 profile 的 `pnpm-workspace.yaml` 允许某个依赖构建时才运行其安装脚本，并运行 `exec` 或 `dlx` 等 pnpm 命令所指定的任何内容。它不导入任何插件代码。它运行期间在 `run/data-users/` 中注册为共享使用者。
- **共享数据。** 会话、工作区、附件、凭据与 home patch 留在 home 下上游规定的位置，因此 CLI 与桌面应用按上游各入口的方式共享它们。

<a id="the-runtime-store"></a>

## 运行时仓库

运行时仓库保存已安装的运行时发行包，并指明当前活动的那一个。每次命令行启动只运行一个运行时，即 `current` 所指的那个。

```text
runtimes/
  store.json              {"layout":1}
  current                 the active version and one newline
  previous                the version kept for rollback and one newline; absent before the first switch
  store.lock              taken by install, switch and removal
  <version>/              one complete, verified runtime closure
  delorun-<version>.manifest.json            the verified release manifest, beside its installation
  delorun-<version>-<platform>.files.json    the verified runtime file list
  delorun-<version>.manifest.log.json        the release-log bundle
```

- **版本名。** 目录名是 Delorun 的发布版本：不带构建元数据的 SemVer 2.0，匹配 `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`，最多 64 个字符。
- **指针文件。** `current` 与 `previous` 保存 UTF-8 文本：恰好一个版本和一个换行符，最多 65 字节。替换指针的方法是：以独占创建方式、权限 0600 写入同级文件 `<pointer>.tmp-<16 hex>`，将其刷入磁盘，重命名覆盖指针，并在 Linux 与 macOS 上刷新 `runtimes/` 目录。从不使用符号链接，因为在 Windows 上创建符号链接需要特权，而运行中的 `node.exe` 会锁定其目录。
- **Windows 重命名。** 重命名报告 `EPERM`、`EBUSY` 或 `EACCES` 时，以退避方式重试，总计最多 2,000 毫秒。仍然失败的重命名以 `POINTER_REPLACE_FAILED` 停止，旧指针保持不变。
- **读取指针。** 读取方读取整个文件。缺失、为空、超长或格式错误的指针，或所指版本没有已安装目录的指针，都是 `NO_ACTIVE_RUNTIME`；此时启动器提供重新安装或回滚，从不自行挑选目录。
- **切换顺序。** 切换先把旧版本写入 `previous`，再把新版本写入 `current`，因此在两次写入之间被杀死的进程会让 `current` 仍指向完整的旧版本。
- **谁切换 `current`。** 只有四种事件切换它：不存在 `current` 时的首次安装；经由 [C19](c19-home-process.zh.md) 握手的更新；本人通过 [C19](c19-home-process.zh.md) 或 `delorun recover` 请求的回滚；以及 [C19](c19-home-process.zh.md) 在健康检查失败后的自动回滚。启动器从不自行切换 `current`，无论它比活动运行时新还是旧。
- **`store.lock`。** 该锁以权限 0600 保存 `{"v":1,"pid":<integer>,"id":"<32 lowercase hexadecimal digits>"}`，并像 home 锁那样记录持有者的 `processStart` 与 `pidNamespace`，其创建与替换方式也与 home 锁相同（[home 锁](#the-home-lock)）：位于读取者 pid 命名空间中或未写明命名空间、且持有者已退出或记录的启动标识与存活进程不同的锁是失效的。
- **安装。** 安装获取 `store.lock`，最多等待 30 秒，之后以 `STORE_BUSY` 停止。它下载到 `~/.delorun/staging/<16 hex>/`，该目录位于 `runtimes/` 之外、同一文件系统上，并执行 [C2](c02-release-manifest.zh.md) 的客户端校验：根与时间戳的遍历、manifest 的签名与新鲜度、发布日志 bundle 与在线检查（[C18](c18-release-log.zh.md)），以及归档与文件列表的摘要。它带路径检查地解压（不允许绝对路径、`..` 段、链接、设备文件以及文件列表之外的条目），按文件列表检查每个文件，然后把暂存目录重命名为 `runtimes/<version>/`，并把 manifest、文件列表与 bundle 放在其旁边。在全部检查通过之前，`runtimes/` 下不出现任何内容；失败的安装删除其暂存目录，不改动其他任何内容。
- **已安装文件。** 重命名之后，`<version>/` 下的目录权限为 0555，文件为 0444，可执行文件为 0555；在 Windows 上它们带只读属性。启动器的启动检查（[C2](c02-release-manifest.zh.md#client-verification)）对每个文件计算哈希，或比较上一次计算哈希后记录的标识，它才是完整性控制；这些权限模式只防止意外写入。
- **保留。** 切换提交之后，仓库保留 `current` 与 `previous` 所指的版本及其发布文件与标识记录，删除其他每个 `<version>/` 及其发布文件与标识记录，以及 `staging/` 下没有安装占用的每个目录。失败的删除（例如 Windows 上仍在使用的目录）在下次启动时重试。同一时间最多存在两个版本和一个暂存目录。
- **回滚范围。** 运行时回滚不改动 `runtimes/` 及其位于 `trust/runtime-files/` 下的标识记录之外的任何文件。从 profile 历史恢复 profile，以及从本人所做的副本恢复聊天数据，是 [C3](c03-update-report.zh.md#rollback) 的步骤，每次回滚都经过 C3 的表格。

<a id="launcher-and-store-compatibility"></a>

## 启动器与仓库的兼容性

只有当启动器既理解仓库、又理解运行时的启动接口时，它才运行活动运行时。

- `store.json` 记录仓库布局编号，当前为 1。只有仓库的某个条目移动或改变含义时，布局编号才改变。
- 每个运行时的已签名 manifest（[C2](c02-release-manifest.zh.md)）记录其启动协议编号，当前为 1。启动协议规定运行时的入口文件、启动器传入的参数以及它设置的环境变量（`DSH_HOME`、`DELORUN_HOME`、`DELORUN_PROFILE`；`DELORUN_LAUNCHER_ROOTS`，即启动器自带的发布根所在的目录，`delorun verify`、每次更新、每次回滚以及健康检查的启动检查都以它为所保存的根的锚点。没有它而启动的运行时不安装、不更新、也不回滚到任何版本，以 `ROOT_NOT_ANCHORED` 拒绝，其 `delorun verify` 只按所保存的根自身的签名检查它，并说明这一点；以及 `DELORUN_LAUNCHER_VERSION`，即启动器包自身的版本，`delorun setup` 把它安装的 `delorun` 命令固定到该版本，`delorun verify` 把它与发布版本已签名的 `npm` 条目比较。启动器会丢弃所有继承来的 `DELORUN_LAUNCHER_*` 变量，因此运行时只看到它设置的值。没有该版本而启动的运行时不提供该命令的安装；该变量在启动协议 1 中是可选的，因此不设置它的启动器仍能启动该协议的每个运行时）。
- 启动器支持仓库的布局编号和运行时的启动协议编号时，才运行 `current`。否则它以 `RUNTIME_INCOMPATIBLE` 停止，给出两个编号；运行时较旧时提供更新流程，启动器较旧时提供启动器更新。它既不改动 `current`，也不改动仓库的任何其他文件。

<a id="the-npm-launcher-and-the-install-script"></a>

## npm 启动器与安装脚本

- **包中不含运行时。** npm 包 `delorun` 只是启动器。它没有运行时依赖，也不携带运行时发行包。
- **下载。** 安装某个版本时，启动器只通过 HTTPS 下载 [C2](c02-release-manifest.zh.md) 指定的发布文件：从 `releases.delorun.com` 下载根与时间戳，从 Delorun 公开仓库的 GitHub Releases 下载 manifest、其 bundle、文件列表与对应平台的归档（`.tar.gz`，Windows 上为 `.zip`）。它只跟随指向 `github.com`、`objects.githubusercontent.com` 与 `release-assets.githubusercontent.com` 的重定向，对其他任何主机以 `DOWNLOAD_REFUSED` 拒绝。发布日志检查访问根元数据 `log.origin` 所指的主机，如 [C18](c18-release-log.zh.md) 所述。通道的来源是启动器的构建常量，在面向本地日志的构建中，日志的来源同样是构建常量（生产构建读取其受信任根所指明的日志）：构建把它们传给打包器，由打包器写入代码，此后任何设置、参数或环境变量都无法改变它们。两者都未指明的构建即生产启动器，使用上述主机。面向本地通道的构建可以指明一个 `https:` 来源，或计算机自身回环地址上的 `http:` 来源，在其下提供 `timestamp.json`、`root/<n>.root.json` 与 `releases/download/v<version>/<file>`；此时下载器只允许该来源的主机。
- **下载限额。** 归档最多 1,073,741,824 字节（1 GiB），manifest 最多 4,194,304 字节（4 MiB）。30 秒内未建立的连接，或 60 秒内未传送任何字节的连接，会使下载失败。
- **安装前校验。** 启动器按已签名 manifest（[C2](c02-release-manifest.zh.md)）与该 manifest 在发布日志中的条目（[C18](c18-release-log.zh.md)）校验归档，且在 `runtimes/<version>/` 下出现任何文件之前完成，如[运行时仓库](#the-runtime-store)所述。
- **无网络时。** 启动器在离线启动检查后运行已安装的 `current`。安装始终需要网络和日志收录证明。
- **未通过检查的 `current`。** 当 `current` 未通过启动检查、而 `previous` 在同一锚定根下通过时，裸 `delorun`、`delorun start` 或 `delorun recover rollback`（各自只带 `--profile` 选项，`--` 之后没有内容）会让启动器打印一行说明，并以 `delorun recover rollback` 启动 `previous`，profile 通过 `DELORUN_PROFILE` 传入；该命令应用 [C3](c03-update-report.zh.md#rollback) 的回滚表格，没有记录到 `current` 的更新时以 `NO_UPDATE_RECORD` 拒绝。其他每个命令都被拒绝：启动器不启动任何发行版，不改动任何内容，写明未通过启动检查的发行版及检查的原因，写明 `delorun recover rollback` 是启动 `previous` 以回滚到它的命令，并以 1 退出。没有这样的 `previous` 时，以及以 `--release` 指明了发行版时，启动的拒绝维持不变。启动器自己不切换任何指针。
- **信任锚。** `npx delorun` 在任何 Delorun 检查能够运行之前，就运行 npm 提供的启动器。没有任何工作流发布该包，因此没有构建证明把它与公开仓库关联起来；带证明的发布，以及通过公布的哈希获得信任的安装脚本，见[发布工作流设计](../design/release-workflow.zh.md)。
- **启动器副本。** 不存在安装脚本，`delorun start` 也不安装登录项，因此没有任何东西写入 `bin/`。

<a id="confinement-rules"></a>

## 限制规则

上游的沙箱方言只限制文件写入。在由 `delorun setup` 创建、由 `delorun` 或 `delorun start` 启动的 CLI profile 中，Delorun 对上游沙箱提供方的设置为在 `read-only` 或 `workspace-write` 下运行的每条命令添加下列规则。`delorun headless` 在同一 overlay 下启动；`delorun plugin` 不启动 Host，这些规则都不适用于它的命令。在 `danger-full-access` 下运行的命令（无论由本人设置还是作为提权获得批准）不受限制，本节的任何规则都不适用于它。

| 规则 | 受限命令不能 |
| --- | --- |
| `home-write` | 在 home 下创建、修改或删除任何内容 |
| `home-read` | 读取 home 下读取豁免之外的任何内容 |
| `token-read` | 读取启动令牌 |
| `home-connect` | 连接 home 各通道的套接字或管道 |
| `docker-connect` | 连接位于其真实路径的 Docker 套接字 |
| `wsl-interop` | 通过 WSL 的互操作启动 Windows 程序，无论按路径、按裸名称还是作为副本 |
| `vsock` | 创建虚拟机（`AF_VSOCK`）套接字（WSL 等虚拟机与其主机之间的传输），或创建 io_uring 实例（其请求无需 `socket` 调用即可创建套接字） |
| `session-escape` | 连接以下位置中的套接字：本人的运行时目录 `/run/user/<uid>`、系统总线的 `/run/dbus`、tmux 服务器的 `/tmp/tmux-<uid>`、GNU screen 的 `/run/screen`、X 服务器的 `/tmp/.X11-unix`、WSLg 的 `/mnt/wslg`，或 Docker Desktop 的 `/mnt/wsl/docker-desktop/shared-sockets` 与 `~/.docker/desktop`；程序可经由它们在沙箱之外启动，或以本人的权限行事 |
| `daemon-connect` | 连接 Docker Desktop 的 `/run/docker-cli.sock`，或 tailscaled 的 LocalAPI 套接字（`/run/tailscale/tailscaled.sock`、`/var/run/tailscaled.socket`） |
| `agent-connect` | 连接 `delorun start` 运行时 `SSH_AUTH_SOCK` 所指的 ssh-agent 套接字 |
| `private-tmp` | 读取或连接主机 `/tmp` 中的任何内容，位于其中的工作区之外的部分 |
| `network` | 向其工作区的网络设置不允许的网络主机发起连接：`off` 下不允许任何主机，`allowlist` 下只允许列出的主机与端口，且经由 Delorun 的出站代理；默认的 `open` 允许所有主机。该规则覆盖命令自己发起的连接以及规则 19 所隐藏的守护进程；命令能够触及的、位于另一个路径名套接字之后的守护进程，例如 ssh ControlMaster 套接字或本人 home 下 gpg 的 `S.dirmngr`，仍可替它发起连接 |

- **读取豁免。** 受限命令可以读取并执行 `runtimes/`、`skills/` 与 `dsh-runtimes/`。PTC worker 与其他受限进程运行 `runtimes/` 中运行时自带的 `node`，命令运行 `skills/` 中本人的技能脚本，桌面应用的工作区依赖运行于 `dsh-runtimes/`。CLI profile 的启动再增加一个只读条目，即该 profile 位于 `changes/profiles/<profile>/active/` 的已批准插件副本，使把自身工具的路径交给智能体的插件能够工作；该条目只包含已批准的副本，绝不包含待处理或未批准的内容、其他 profile 的副本，或它们旁边的记录与日志，且受限命令无法写入它。豁免之下不写入任何密钥；保管密钥的组件使用 `secrets/`。面向模型的文件与搜索工具还可以读取所属 chat 自己在 `spill/` 下的目录（对该 chat 而言过长的工具输出保存在那里供模型读取），但不能读取其他 chat 的；受限命令不得读取 `spill/`，也没有任何运行器授予该权限。
- **可写根目录。** home 从不位于可写根目录之内。工作区根目录或附加可写根目录在解析符号链接后等于 home、位于其内或包含它时，`workspace-write` 以 `HOME_IN_WRITABLE_ROOT` 被拒绝。根目录包含 home 的工作区（例如 `~`）仍可运行 `read-only` 命令。
- **Docker 套接字。** 该套接字位于 home 之外。`delorun start` 从当前 Docker context 解析其路径：rootful 引擎为 `/var/run/docker.sock`，rootless 引擎为 `$XDG_RUNTIME_DIR/docker.sock`，或 Docker Desktop 的 context 所指明的路径。该规则覆盖 context 的路径、其解析后的真实路径、在 Linux 上封装命令时发现的、通向同一套接字的每一处其他挂载（例如 WSL 下 Docker Desktop 的 `/mnt/wsl/docker-desktop-bind-mounts/<distro>/docker.sock`），以及在 macOS 上，启动时存在的 Docker Desktop 套接字：`~/Library/Containers/com.docker.docker/Data/` 下的 `docker.raw.sock` 与 `docker.sock`，以及 `~/.docker/run/docker.sock`。Docker Desktop 的其他控制套接字同样被拒绝：`delorun start` 把 `/mnt/wsl/docker-desktop/shared-sockets` 与 `~/.docker/desktop` 指定为逃逸套接字目录（`session-escape`），并按路径拒绝 `/run/docker-cli.sock`（它向 `docker` 组提供其后端的 API，`daemon-connect`）。它在 macOS 上的控制目录 `~/Library/Containers/com.docker.docker/Data/` 与 `~/.docker/run/` 不会被整体隐藏；原因见[原生限制设计](../design/native-confinement.zh.md#docker-desktops-control-sockets)。端点为 TCP 或 SSH 的 context 使用网络，而任何方言都不限制网络，因此对它不强制执行 `docker-connect`。
- **会话套接字。** `session-escape` 的目录保存本人会话的套接字：在 `/run/user/<uid>` 中，有会话总线 `bus` 与用户管理器的 `systemd/private`（`systemd-run --user` 经由它们，以用户单元的形式在所有命名空间之外启动任意程序，带有主机网络与整个 home）、gpg-agent 及其 ssh 套接字、密钥环、显示与音频服务器、编辑器与终端的控制套接字，以及 rootless Docker 与 Podman；系统总线，它以本人会话的 polkit 授权行事；tmux 与 screen 服务器，它们在本人的终端会话中运行命令；X 服务器，它为本人的其他窗口接收输入；在 WSL 下，WSLg 的显示与音频套接字，以及它对 `/run/user/<uid>` 与 `/` 的第二处挂载；以及 WSL 下和 Linux 上 Docker Desktop 的控制套接字，其中包括其后端的 API，其路由涉及它的设置、引擎的 `daemon.json` 与容器操作。`delorun start` 仅凭用户 id 与操作系统 home，在每台有用户 id 的机器上指定相同的目录，由提供方在每次封装时检查哪些存在。`XDG_RUNTIME_DIR` 指向别处的运行时目录，以及 `TMUX_TMPDIR` 下的 tmux 套接字目录，不在指定之列。
- **ssh-agent。** 代理会为任何连接的客户端用本人的密钥签名。受限命令不继承 `SSH_AUTH_SOCK`，`agent-connect` 拒绝启动时它所指的套接字，`private-tmp` 与 `session-escape` 隐藏代理默认监听的位置。没有任何 profile 设置会把代理转发给受限命令；需要代理的命令（例如经 ssh 的 `git push`）通过已批准的 `danger-full-access` 提权运行。
- **主机的 `/tmp`。** 在 bwrap 下，`workspace-write` 命令本来就得到一个空的可写 `/tmp`；`private-tmp` 给 `read-only` 命令一个空的只读 `/tmp`，其中位于 `/tmp` 下的工作区根目录以只读方式绑定回来，并在两种模式下隐藏主机 `/tmp` 的其他每处挂载，例如 WSLg 的 `/mnt/wslg/distro/tmp`。因此 `read-only` 命令以及同样以 `read-only` 运行的 `glob` 与 `grep` 搜索，在工作区之外的 `/tmp` 中什么也找不到；以那里为根的搜索以 `ENOENT` 失败。
- **其他套接字。** 其他路径名套接字（例如本人 home 下的，或 `XDG_RUNTIME_DIR` 指向别处的运行时目录下的）、抽象套接字，以及网络为 `open` 的工作区的网络，对受限命令仍可访问（[此举不能证明什么](#what-this-does-not-prove)）。
- **网络设置。** `@delorun/plugin-permission-defaults` 把每个工作区的网络设置保存在 `secrets/permission-defaults/network.json` 中，权限模式 0600，以工作区的规范路径为键；没有条目的工作区采用行 `delorun-permission-defaults` 的 `network` 与 `allowedHosts`，默认为 `open` 与无。它挂载 `sandboxNetwork` 解析器，使每条受限命令的策略携带 `off` 或出站代理的套接字。代理监听 `secrets/permission-defaults/proxy/<pid>/<list>.sock`，每个不同的允许名单一个，且在任何策略指名它们之前就已存在；bwrap 把命令自己的套接字绑定在 home 的 tmpfs 之内，因此 home 下没有其他套接字变得可达。该设置只能通过 `/api/delorunNetwork.list` 与 `/api/delorunNetwork.set` 读取和更改，它们只回应回环监听器上、回环 `Host` 下的请求，而放宽设置的更改需要本人在那里确认。权限宽于 0600、为链接或为其他格式的存储，会使每个工作区都按 `off` 计，直到本人修复。本人的[指南](../guide/safety-and-updates/prompt-injection.zh.md)说明每项设置关闭了什么。
- **报告。** 启动时不运行任何探测，`delorun verify` 把 [C15](c15-verification-checks.zh.md) 的 `confinement-rule` 检查报告为未运行，因此没有任何东西报告在某台机器上哪些规则成立。沙箱提供方会计算它是否找到了 home 与每个被拒绝套接字的其他每个挂载（别名覆盖），但没有任何东西读取该结果。探测、该检查与 setup 的 Docker 标注见[原生限制设计](../design/native-confinement.zh.md#checks-at-each-start)。
- **提权提示。** `danger-full-access` 提权的批准提示来自上游，它写明所请求的模式与操作，但不说明完全访问会触及 Delorun 的 home、其密钥与令牌，或更新通道。该说明见[原生限制设计](../design/native-confinement.zh.md#full-access)。

<a id="limits"></a>

## 限额

| 限额 | 值 |
| --- | --- |
| home 及 Delorun 目录的权限模式 | 0700 |
| 受保护文件的权限模式 | 0600 |
| 套接字路径长度 | 最多 103 字节 |
| 启动令牌 | 32 个随机字节，43 个 base64url 字符 |
| Windows 管道名中的 `homeId` | 16 位十六进制数字 |
| 锁被视为无响应之前等待 `status` 回答的时间 | 2 秒 |
| 运行时版本名 | 最多 64 个字符 |
| 指针文件 | 最多 65 字节 |
| 等待 `store.lock` | 30 秒 |
| Windows 指针重命名重试 | 总计最多 2,000 毫秒 |
| 已安装运行时版本 | 最多 2 个，外加 1 个暂存目录 |
| 归档下载 | 最多 1 GiB |
| manifest 下载 | 最多 4 MiB |
| 下载连接 | 30 秒内建立，60 秒无字节即失败 |
| 仓库布局编号 | 1 |
| 启动协议编号 | 1 |

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `HOME_INVALID` | 解析出的 home 不是绝对路径，或是文件系统根目录或操作系统 home 目录 |
| `HOME_IS_DSH_HOME` | 解析出的 home 是上游的 `~/.dsh` 或位于其内 |
| `HOME_MODE` | home、`secrets/` 或 `run/<profile>/` 的权限宽于 0700、是符号链接或属于其他用户 |
| `SECRET_FILE_MODE` | 受保护文件的权限宽于 0600、是符号链接、不是普通文件或属于其他用户 |
| `SOCKET_PATH_TOO_LONG` | 某个通道的套接字路径超过 103 字节 |
| `HOME_IN_WRITABLE_ROOT` | 某个可写根目录等于 home、位于其内或包含它 |
| `HOME_RUNNING` | 该 profile 有一个存活的 home 进程持有锁 |
| `HOME_UNRESPONSIVE` | 锁记录的进程存在，但其更新通道未在 2 秒内回答 |
| `STORE_BUSY` | `store.lock` 在 30 秒内未释放 |
| `NO_ACTIVE_RUNTIME` | `current` 缺失、格式错误或所指版本未安装 |
| `POINTER_REPLACE_FAILED` | 指针重命名在重试后仍失败；旧指针保持不变 |
| `RUNTIME_INCOMPATIBLE` | 启动器不支持仓库的布局编号或运行时的启动协议编号 |
| `INSTALL_VERIFY_FAILED` | 安装期间摘要、签名、新鲜度、日志收录、路径或文件哈希检查失败 |
| `DOWNLOAD_REFUSED` | 下载重定向到列表之外的主机、超过大小限额或超时 |

<a id="consumers"></a>

## 使用方

- `delorun/apps/cli`：`delorun` 命令与 CLI profile，经由 `delorun/packages/home`。
- `delorun/packages/home`：home 解析、home 目录树及其权限模式、按拒绝规则读写受保护文件，以及 home 锁。
- `delorun verify` 与 `delorun doctor`（`delorun/apps/cli`）：`doctor` 检查 home 的目录权限模式；`verify` 对权限模式与每条限制规则的检查尚未构建。
- 上游的 `packages/sandbox/sandbox-local` 与 `packages/sandbox/sandbox`：各方言的 profile 与对可写根目录的拒绝。
- `delorun/apps/install` 与 `delorun/apps/npm-launcher`：下载、校验与启动器副本。
- `delorun/packages/runtime-store`：仓库、指针文件、安装、切换与保留。
- `delorun/packages/home-process`：经由 `delorun/packages/home` 持有锁，以及启动令牌与更新通道的套接字（[C19](c19-home-process.zh.md)）。
- `delorun/packages/supervisor`：监管器的套接字及其令牌检查（[C9](c09-runtime-supervisor.zh.md)）；没有任何命令启动它。
- `delorun/packages/home-auth`：`secrets/home-auth/` 下的密钥文件，经由 `delorun/packages/home` 读写；每个 CLI profile 都加载它。`delorun export` 在那里写入 home 密钥。

<a id="compatibility"></a>

## 兼容性

- 目录树只通过添加条目改变。移动、重命名条目或改变其含义，要么提高仓库布局编号，要么属于破坏性变更并在 `delorun/docs/upgrade-guide/` 下附升级指南；做出该变更的运行时能读取两种形式。
- `DELORUN_HOME`、`DELORUN_PROFILE`、CLI profile 名称与通道路径是外部接口；改变其中任一项都是破坏性变更，需附升级指南。
- 上游的条目保留上游的布局与兼容性规则，包括其会话格式。
- 只有启动器传入的入口文件、参数或环境发生变化时，启动协议编号才提高。启动器支持它能安装的所有运行时的启动协议编号。
- 类型包跟随 Delorun 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

1. home 的权限为 0700，其受保护文件为 0600。组件拒绝权限更宽、是符号链接或属于其他用户的受保护文件；home、`secrets/` 或 `run/<profile>/` 权限更宽时，home 进程拒绝启动。`delorun verify` 检查其中每一项，并打印 `chmod` 修复命令，Windows 上为 `icacls` 修复命令。尚未构建：`verify` 检查以及每项 Windows 检查。
2. Delorun 的密钥存放在 `secrets/` 下的文件中，在 CLI profile 中强制执行 `home-read` 的方言上，每种方言都拒绝读取该目录。上游的凭据文件位于 home 之下，适用同一规则。读取豁免路径、profile、patch 文件、命令的环境或命令行以及日志中都不写入任何密钥。已加载插件的密钥角色配置字段的值会被配置编辑器和 profile 历史拒绝，并在启动时移入凭据文件（在插件能指明它的情况下）（[密钥](#secrets)）。
3. 在任何方言上，受限命令都不能写入 home 下的任何内容；在强制执行 `home-read` 的方言上，除读取豁免外，它也不能读取 home 下的任何内容。
4. 在强制执行 `home-connect` 与 `docker-connect` 的方言上，受限命令不能连接 home 的通道，也不能连接位于真实路径的 Docker 套接字。bwrap 在 home 上挂载一个空 tmpfs，并把 `/dev/null` 绑定到 Docker 套接字的真实路径上，从不绑定到其父目录，因为 `/run/user/<uid>/` 还存放着 ssh-agent 套接字。Seatbelt 拒绝对 home 的 `file-read*`，并拒绝对每个通道套接字与两个 Docker 套接字路径的 `remote unix-socket` 路径字面量的 `network-outbound`。Landlock 无法拒绝对路径名套接字的连接，因此在 Landlock 上 `home-connect` 与 `docker-connect` 报告为 `not-enforced`。
5. 在 Landlock 下，对 home 的读取拒绝使启动令牌不可读，因此受限命令可以连接任一通道，但其请求认证失败，`delorun verify` 会报告这一状态。尚未构建：该报告。
6. 两个通道只接受携带当前 home 进程启动令牌的请求；缺失的令牌、错误的令牌与之前某次启动的令牌一律被拒绝。令牌是来自操作系统随机源的 256 位值，从不记录到日志，也不通过命令行或环境传递，并以恒定时间比较。
7. 该保护依赖于对 agent 命令的限制。在沙箱外运行的本人用户进程可以读取令牌，也本来就可以自行运行 `delorun` 与 `docker`，本约定不声称能防范它。不存在 root 所有的辅助程序。
8. `danger-full-access` 下的命令不受限制；上述规则都不适用于它，`delorun verify` 对处于该模式的工作区报告 `unconfined`。该模式的批准提示说明，完全访问可以触及 Delorun 的 home、其令牌、Docker 监管器与更新通道。尚未构建：该报告与提示中的说明。
9. home 从不位于可写根目录之内；根目录等于 home、位于其内或包含它时，`workspace-write` 被拒绝。
10. 启动器从不自行切换 `current`。安装在 `runtimes/<version>/` 下出现任何文件之前，校验归档、manifest 的签名与新鲜度、其日志收录以及每个文件的哈希；指针只通过原子重命名替换。
11. Delorun 从不读取或写入上游的 `~/.dsh`。
12. 在只有 Landlock、且 Docker 套接字为 rootful 的系统上，`delorun verify` 把该套接字报告为未强制执行，setup 给出它并提供 rootless 引擎。尚未构建。
13. 每个启动 Host 的命令都应用规则 2 至 4 与规则 9。尚未构建：`delorun plugin` 不启动 Host，不应用其中任何规则。
14. 在 WSL 下，内核的 `WSLInterop` binfmt 处理程序会启动任何带 Windows 文件头的可执行文件，无论它位于何处，方法是向 `/run/WSL` 中的套接字发送请求，无论 `WSL_INTEROP` 是否设置，它都能找到该套接字；Windows 进程在每个 Linux 命名空间、挂载规则与受保护的 home 之外，以本人的 Windows 账户运行。`delorun start` 在每台机器上都把 `/run/WSL` 列为逃逸套接字目录，提供方在每次包装时检查它是否存在。存在时，bwrap 在其上挂载一个空的只读 tmpfs，因此无论命令以何种方式经由这些套接字到达处理程序，该程序都无法启动：按其 `/mnt/<drive>` 路径、通过 `PATH` 按裸名称、作为副本、直接调用 `/init`，或以 `WSL_INTEROP` 指明某个套接字。受限命令只能以只读方式看到 `binfmt_misc`，且看不到处理程序的注册。无法拒绝套接字连接的方言（Linux 上的 Landlock）在该目录存在期间以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝每条受限命令。WSL 的内核向 Windows 提供虚拟机套接字，规则 15 拒绝它们。位于 Windows 驱动器上的工作区按其策略保持可读可写。在 `delorun plugin` 下尚未构建，如规则 13 所述。
15. 在内核提供虚拟机套接字的每个地方（即包装时 `/proc/net/protocols` 列出 `AF_VSOCK`），或存在逃逸套接字目录，或该列表无法读取时，bwrap 在一个 seccomp 过滤器下启动每条受限命令。在 x86-64（包括 x32 编号）、i386、AArch64 与 32 位 Arm 上，它以 `EAFNOSUPPORT` 拒绝 `socket(AF_VSOCK, …)`，以 `ENOSYS` 拒绝 `io_uring_setup`，并以 `ENOSYS` 拒绝它未列出的架构的每个调用。只在第一次调用时才加载 vsock 的内核没有加载任何虚拟机监控程序传输，这样的套接字只能到达本地回环传输。该过滤器适用于任何带 vsock 的虚拟机，而不仅是 WSL，并且在那里：需要 io_uring 的程序会失败；通过 `socketcall` 创建套接字的 32 位程序（如早于 2.23 的 32 位 glibc）无法创建任何套接字，因为过滤器无法读取该调用的协议族；在过滤器未列出其架构的主机（例如 RISC-V）上，每条受限命令都以 bwrap 诊断失败。bwrap 从描述符 9 读取过滤器，因此包装从 `/bin/sh` 启动它；调用方的描述符 3 到 7 会传给命令，描述符 8 与 9 不会；缺少 `printf` 或标准输入已关闭时，命令启动之前即以 `bwrap:` 诊断失败；shell 始终是 bwrap 的父进程，因此其 bwrap 被信号杀死的命令报告的退出状态为 128 加信号编号。Landlock 不应用任何 seccomp 过滤器；在 WSL 下它按规则 14 拒绝每条命令，在其他虚拟机上则不限制 vsock 与 io_uring。在 `delorun plugin` 下尚未构建，如规则 13 所述。
16. 受限命令无法触及本人会话中那些在沙箱之外启动程序、或以本人权限行事的路径名套接字。`delorun start` 在每台机器上把 `session-escape` 的目录指定为逃逸套接字目录，由提供方在每次封装时检查哪些存在。凡存在之处，bwrap 在其上以及挂载表列出的它的每一处其他挂载上覆盖一个空的只读 tmpfs，因此 `systemd-run --user` 与 `busctl --user` 在路径上找不到总线，`tmux` 与 `screen` 找不到服务器，X 客户端在 `/tmp/.X11-unix` 下找不到显示套接字。抽象套接字不会被隐藏：bwrap 共享主机的网络命名空间，所以 Linux 桌面上 X 服务器的 `@/tmp/.X11-unix/X<n>`，以及地址被 `dbus-launch` 设为抽象的会话总线，仍可访问，而经由这样的总线，`systemd-run --user` 会在沙箱之外启动程序。Seatbelt 对封装时存在的每个条目的路径字面量拒绝 `network-outbound`。Landlock 无法拒绝对路径名套接字的连接，只要其中任何一个存在，就以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝每条受限命令；在 Linux 上，凡 logind、elogind 或 WSLg 创建了运行时目录，或系统总线在监听之处，都是如此。由于几乎每台 Linux 机器上都存在逃逸套接字目录，规则 15 的过滤器在那里同样适用，需要 io_uring 的程序在受限命令中会失败。隐藏目录内部的路径不会得到自己的挂载：隐藏目录已经覆盖了它。在 `delorun plugin` 下尚未构建，如规则 13 所述。
17. `delorun start` 把其启动环境中 `SSH_AUTH_SOCK` 所指的 ssh-agent 套接字及该套接字的真实路径加入被拒绝的套接字，并且沙箱行设置 `privateTmp`。bwrap 把 `/dev/null` 绑定到代理的套接字上，并给每条受限命令一个没有主机文件与套接字的 `/tmp`，如 `private-tmp` 所述；Seatbelt 拒绝代理的路径字面量，并且与 Landlock 一样不表达 `private-tmp`，在 `private-tmp` 之下 `read-only` 命令会读取主机的 `/tmp`。没有任何一层能关闭 `privateTmp`：启动的覆盖层设置它，启动会拒绝没有它的已启动行，更新的 H3 会拒绝其行关闭它的后继版本。
18. `delorun start` 在每台有用户 id 的机器上拒绝 `daemon-connect` 的守护进程套接字，无论它们在启动时是否存在：WSL 下 Docker Desktop 的 `/run/docker-cli.sock`（它向 `docker` 组提供其后端的 API），以及 tailscaled 的 LocalAPI 套接字（其操作员经由它更改节点的设置）。bwrap 把 `/dev/null` 绑定到封装时存在的每一个上，Seatbelt 拒绝其路径字面量；Landlock 无法拒绝该连接。在 `delorun plugin` 下尚未构建，如规则 13 所述。
19. 受限命令的网络遵循其工作区的设置（[限制规则](#confinement-rules)）。在 bwrap 下，`off` 与 `allowlist` 使命令在它自己的网络命名空间中启动，其中只有一个回环接口，没有主机的任何抽象套接字；在 `allowlist` 下，出站代理的套接字是唯一的出路，代理在查询之前就拒绝未列出的主机或端口，拒绝解析到抓取防护所拒绝的地址的列出名称，只连接它检查过的地址，并以它检查过的主机发送纯 HTTP 请求。bwrap 在隐藏目录与 home 的只读重新挂载之后、`/tmp` 变为只读之前绑定代理的套接字。在两种设置下，bwrap 还隐藏 systemd-resolved 的 varlink 目录、nscd、avahi 与 snapd 的套接字、CUPS 的 `/run/cups`、系统 D-Bus 与 tailscaled 的套接字，使命令无法触及这些守护进程。命名空间并不切断路径名套接字：凡不被本规则、`session-escape`、`daemon-connect` 或 `agent-connect` 隐藏的路径名套接字仍然可达，其后的守护进程可以替命令发起连接，例如 ssh ControlMaster 套接字，或在 gpg 没有运行时目录时本人 home 下 gpg 的 `S.dirmngr`。Landlock、Seatbelt 与 windows-acl 以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝此类工作区的每条命令。`web_fetch` 遵循同一设置。该设置只能在 home 所在的电脑上更改，放宽只能在本人确认之后，且模型的任何工具与任何 `plugin_manager` 更改都触及不到它。`danger-full-access` 下的命令无论设置如何都能访问网络。
20. 当 `delorun start --inspect` 的调试器在监听时，这些保证一概不成立：这台电脑上任何能触及 `127.0.0.1:9229` 的进程（包括受限命令）都能以 home 进程的身份在沙箱之外运行代码。启动只在本人于终端确认或使用 `--yes` 之后才打开它，从不在安全模式下打开，并在它监听期间保留 `run/<profile>/inspector.json`（权限模式 0600），`delorun status` 会报告它。

<a id="denial-tests"></a>

### 拒绝测试

每个测试在其方言存在的每个 CI 平台上运行，只针对本地固定样例。

| 测试 | 证明 |
| --- | --- |
| `home-read-denied` | 在每种强制执行 `home-read` 的方言上，位于 `~` 工作区中的受限命令无法读取 `secrets/` 下的 home-auth 密钥样例与启动令牌，但能读取 `runtimes/` 下的文件 |
| `home-write-denied` | 在每种方言上，受限命令无法在 home 下创建、修改或删除文件 |
| `home-socket-connect-denied` | 在 bwrap 与 Seatbelt 上，受限命令连接 home 下的套接字失败，而连接 home 之外的 ssh-agent 套接字样例成功 |
| `docker-socket-connect-denied` | 在 bwrap 与 Seatbelt 上，受限命令连接位于 rootful 真实路径和 rootless 路径的 Docker 套接字失败，而与 rootless Docker 套接字同一目录中的 ssh-agent 套接字仍可访问 |
| `secret-mode-refused` | 在设备密钥文件权限为 0640 的 home 样例中，读取组件以 `SECRET_FILE_MODE` 拒绝该文件，并给出修复命令 `chmod 600 <path>` |
| `home-mode-refused` | home 权限为 0755 时，home 进程以 `HOME_MODE` 拒绝启动，并给出修复命令 `chmod 700 <path>` |
| `writable-root-refused` | 工作区根目录为 `~` 时，以及根目录位于 home 内时，`workspace-write` 以 `HOME_IN_WRITABLE_ROOT` 被拒绝，不运行任何命令 |
| `launcher-leaves-current` | 较新的启动器与较旧的启动器都使 `current` 与 `previous` 保持逐字节不变 |
| `pointer-switch-interrupted` | 在两次指针写入之前、之间与之后杀死执行切换的进程，`current` 都指向一个完整的已安装版本 |
| `install-verify-first` | 错误的签名、错误的文件哈希、缺失的日志条目以及含 `..` 的归档条目，都不会在 `runtimes/<version>/` 下留下任何内容，也不留下暂存目录 |
| `secret-field-refused` | 在已启动的 Host 上，从设置保存密钥角色字段的值被拒绝，profile patch 与每个历史版本都不含该值；手工写入此类值（字面值，或不只读取环境变量的 `!!js` 表达式）的 patch 不会被保存为版本；写入 home patch 的密钥使更新的快照以 `SNAPSHOT_FAILED` 失败，profile 中的 home patch 副本被放回原样，下一次插件改动的版本也不含该密钥；patch 含有此类值时，启动把它移入 `.credentials.yaml` 并正常启动；任何消息都不含该值 |
| `reserved-profile-refused` | 启动器、`delorun --profile <name>` 与 `DELORUN_PROFILE=<name>` 拒绝 `desktop`、`headless`、`data-users` 与 `node_modules`，并写明该名称及原因；持有名为 `data-users` 的 CLI profile 的 home 样例在启动时被拒绝，该 profile 逐字节不变，且不创建任何运行目录；普通名称（包括 `web` 与 `tui`）被接受 |
| `dsh-home-untouched` | 在继承了 `DSH_HOME` 的首次运行之后，`~/.dsh` 样例逐字节不变，且运行时以设为 Delorun home 的 `DSH_HOME` 运行 |
| `wsl-interop-denied` | 在启用了互操作的 WSL 下，在 bwrap 上，受限命令无法按其 `/mnt/c` 路径、按裸名称、作为其工作区中的副本、通过 `/init`，或以 `WSL_INTEROP` 指明每个互操作套接字来启动 `whoami.exe`；它无法连接任何互操作套接字，看到的 `/run/WSL` 为空，看不到可写的 `binfmt_misc` 挂载，其中也既没有 `register` 也没有 `WSLInterop`；它能读写 Windows 驱动器上的工作区。不在 WSL 下时，每个用例按名称跳过并给出原因 |
| `wsl-vsock-denied` | 在启用了互操作的 WSL 下，在 bwrap 上，受限命令无法创建 vsock 套接字（同一命令不受限时可以创建），`io_uring_setup` 以 `ENOSYS` 失败；IPv4 与 Unix 套接字仍可创建。在 x86-64 上，经由 32 位 `int 0x80` 入口（`socket`、`socketcall(SYS_SOCKET)`、`io_uring_setup`）与 x32 `socket` 同样成立，而它们不受限时都能创建所请求的内容。不在 WSL 下、在其他架构上或没有 32 位入口时，每个用例按名称跳过并给出原因 |
| `wsl-interop-landlock-refused` | 在启用了互操作的 WSL 下，按 `delorun start` 的方式配置的提供方在 Landlock 级别以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝包装，并写明 `/run/WSL` |
| `user-manager-denied` | 在 bwrap 上，于 `read-only` 与 `workspace-write` 下，受限命令无法运行 `systemd-run --user --pipe --wait -- true` 与 `busctl --user list`（二者在不受限时成功），看到的 `/run/user/<uid>` 为空，并且无法通过 WSLg 对它的另一处挂载列出会话总线。缺少会话总线、systemd-run、busctl 或 bwrap 时，各用例按名称跳过并给出原因 |
| `system-bus-denied` | 在 bwrap 上，于两种模式下，受限命令无法运行 `busctl --system list`（不受限时成功）。缺少系统总线、busctl 或 bwrap 时，该用例跳过并给出原因 |
| `terminal-server-denied` | 在 bwrap 上，于两种模式下，受限命令无法列出套接字位于 `/tmp/tmux-<uid>` 的样例 tmux 服务器的会话，无论按该路径还是通过 WSLg 对 `/tmp` 的另一处挂载；不受限时，同一命令能列出它们。缺少 tmux 或 bwrap 时，该用例跳过并给出原因 |
| `ssh-agent-denied` | 在 bwrap 上，于两种模式下，`ssh-add -l` 无法连接启动时 `SSH_AUTH_SOCK` 所指、位于 `/tmp` 与运行时目录之外的样例代理，也无法连接启动时未知的 `/tmp` 下的代理；不受限时，两者都能连接。缺少 ssh-agent 或 bwrap 时，各用例跳过并给出原因 |
| `display-denied` | 在 bwrap 上，于两种模式下，受限命令无法连接 X 服务器的套接字 `/tmp/.X11-unix/X0`，无论按该路径还是通过 WSLg 的挂载（不受限时能连接），并且看到的 `/mnt/wslg` 为空。缺少该套接字、WSLg 或 bwrap 时，各用例跳过并给出原因 |
| `docker-desktop-denied` | 在 bwrap 上，于两种模式下，受限命令无法连接 `/mnt/wsl/docker-desktop/shared-sockets` 或 `~/.docker/desktop` 中（至多向下一层目录）的任何套接字，也无法连接 `/run/docker-cli.sock`，其中每一个在不受限时都能连接。其中没有任何一个在不受限时可达，或缺少 bwrap 时，该用例跳过并给出原因 |
| `private-tmp` | 在 bwrap 上，`read-only` 命令能读取位于 `/tmp` 下的工作区，看不到那里的其他目录，也无法写入 `/tmp`；上游的 `private-tmp-denied` 表明，启用 `privateTmp` 时，它在两种模式下都无法连接主机 `/tmp` 中的套接字，不启用时则能连接 |
| `session-escape-landlock-refused` | 凡存在逃逸套接字目录之处，按 `delorun start` 的方式配置的提供方，在 Landlock 档位上以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝封装，并指明存在的第一个目录 |
| `network-off-denied` | 在 bwrap 上，网络为 `off` 的工作区的受限命令，无法连接主机回环上的监听器与桥接端口，也无法打开另一个工作区的代理套接字；同一命令在 `allowlist` 工作区中只能到达代理。沙箱提供方自身的规格还表明，它到达不了任何在没有该设置时能到达的回环之外的地址 |
| `network-allowlist-proxy` | 在 bwrap 上，`allowlist` 工作区的命令通过代理（按其代理变量与 `CONNECT`）获取列出的主机，其对未列出主机的 `CONNECT` 不经查询即返回 403；文档地址代替公共主机，并到达本地监听器 |
| `network-dns-closed` | 在 bwrap 上，`allowlist` 工作区的命令自身无法解析名称，也无法连接 systemd-resolved 的 varlink 套接字、系统 D-Bus、nscd、avahi、snapd、CUPS 或 tailscaled（机器上有这些时），并且代理从不查询名单未允许的名称 |
| `network-private-refused` | 在 bwrap 上，解析到私有地址的列出名称以 403 拒绝，代理规格中解析到回环、链路本地以及 IPv4 映射私有地址的列出名称也是如此 |
| `network-lists-separate` | 在 bwrap 上，命令能到达其自身名单的代理套接字，找不到其他名单的套接字 |
| `network-refused-elsewhere` | Landlock、Seatbelt 与 windows-acl 以 `SANDBOX_UNSUPPORTED_POLICY` 拒绝策略为 `off` 或 `proxy` 的封装，并在没有网络的情况下封装同一命令 |

<a id="what-this-does-not-prove"></a>

### 本约定不能证明的内容

- **Landlock 与套接字。** Landlock 无法拒绝对路径名套接字的连接。在只有 Landlock 的系统上，受限命令能访问 rootful Docker 套接字，这等同于 root，而且没有任何东西报告它；在那里没有 Delorun 机制能阻止它。更新通道之所以仍然关闭，只是因为启动令牌不可读。
- **所指名位置之外的套接字。** `session-escape`、`agent-connect` 与 `private-tmp` 覆盖的是会话服务默认监听的位置，而不是本人的程序可能创建的每一个套接字。本人 home 下的套接字仍然可达，例如在没有运行时目录的系统上 gpg-agent 的 `~/.gnupg/S.gpg-agent`、启动时 `SSH_AUTH_SOCK` 没有指向的代理、密码管理器的代理或编辑器的服务器；`XDG_RUNTIME_DIR` 指向别处的运行时目录、`TMUX_TMPDIR` 下的 tmux 服务器，以及授予 root 权限的组所有者守护进程套接字（例如 libvirt、LXD 或 Incus 的，`docker-connect` 不覆盖它们）也是如此。抽象套接字在每种方言上都仍然可达，如下文 WSL 条目所述；在 Linux 桌面上，X 服务器还监听抽象名称 `@/tmp/.X11-unix/X<n>`，因此 `display-denied` 在那里无法阻止受限命令访问该 X 服务器，而由 `dbus-launch` 在抽象地址上启动的会话总线不会被 `session-escape` 隐藏，经由它的 `systemd-run --user` 会在沙箱之外启动程序。私有网络命名空间，或 Linux 6.12 起在 bwrap 内应用的 Landlock 抽象套接字范围，可以同时关闭这两者；bwrap 两者都没有应用。
- **命令启动后重新创建的套接字。** bwrap 在包装命令时把 `/dev/null` 绑定到被拒绝套接字的路径上；之后在该路径上被删除并重新创建的套接字（例如 Docker 引擎重启之后）是一个新文件，绑定不覆盖它，因此之前已启动的命令不会被拒绝访问它。让受限命令长时间运行的组件（例如终端或后台任务）在被拒绝的套接字重新创建时重新包装或停止这些命令；该组件的契约承担这一要求。
- **隐藏其别名的文件系统。** 别名通过把路径在 `stat` 中的设备号与挂载表匹配来查找。btrfs 与 bcachefs 子卷以及 overlayfs 层报告的设备号，挂载表不会把它们与其他挂载对应起来，因此在这些文件系统上可能找不到别名；提供方在那里把别名覆盖报告为 `unknown`，依赖它的规则都不会显示为 `enforced`。以另一个设备号在别处暴露 home 的文件系统（例如 FUSE 镜像）在任何文件系统上都检测不到。
- **被替换文件的绑定挂载。** home 下某个文件的绑定挂载在该文件被删除或替换后（例如通过原子重命名轮换的密钥）仍附着在原文件上。此时挂载表把它的根标记为已删除，别名检测会跳过它，而它的挂载点仍能访问旧内容；没有 profile 覆盖这种情况。
- **写入工具的先检查后写入窗口。** 进程内写入围栏先检查路径再按路径写入，因此同时运行的受限命令可以在两者之间把该路径上的目录换成链接；[基于描述符的写入](https://github.com/twickas/delorun/issues/71)可以消除这一点。
- **之后新增的挂载与链接。** profile 覆盖包装命令时已存在的、home 所在文件系统与每个被拒绝套接字的其他挂载。命令运行期间新增的挂载，以及在沙箱外为 home 下文件创建的硬链接，不在覆盖范围内。
- **Landlock 与 home 的上级目录。** Landlock 按目录树授予读取权限，因此 profile 授予从 `/` 到 home 路径旁的每个条目，而不是这些目录本身：受限命令不能列出 `/`、操作系统主目录或这条路径上的任何其他目录，命令启动后在其中新建的条目对它不可读。这些条目在包装命令时列出，因此在启动器应用规则集之前被删除的条目会让启动器拒绝运行；该命令不会运行，无论是否受限。
- **Windows。** windows-acl 只限制写入。Windows 上的受限命令可以读取 home 下的一切，包括 Delorun 的密钥、上游的凭据文件与启动令牌，因此令牌无法让它远离更新通道，而且 home 的权限模式在那里不被检查。
- **CLI profile 之外的命令。** `delorun headless` 在与 CLI profile 相同的沙箱 overlay 下启动，因此其受限命令适用上述规则，其 profile 加载 `@delorun/bundle-headless`：抓取防护、指令写入同意、MCP 同意与定时任务同意、完全访问同意以及回合闸门都适用，并受到保护而不受插件管理影响；询问本人的防护会拒绝，因为该 profile 未组合任何审批应答方；对于没有授权的工作目录，完全访问被拒绝，本人在 home 的电脑上于 studio 中或使用 `delorun workspace full-access` 记录该授权。在 `delorun plugin` 下（它不启动 Host，也不应用任何 overlay），插件操作运行的命令可以读取整个 home（包括启动令牌），并能连接更新通道的套接字。
- **互操作套接字之下的 WSL。** 在 bwrap 下，`vsock` 过滤器拒绝 vsock 套接字与 io_uring。抽象 Unix 套接字在每种方言上都仍可访问：连接在内存中指明其地址，seccomp 过滤器无法读取它，而唯一能限定它们范围的内核规则——自 Linux 6.12 起 Landlock 的抽象套接字作用域——在 WSL 所带的 6.6 内核上不可用，也不是 bwrap 应用的规则。WSL 自身不在任何抽象套接字上监听：它的互操作套接字是 `/run/WSL` 下的路径名套接字，而 WSL 安装所列出的抽象名称属于 systemd 总线连接的已连接端，它们不接受任何连接。本人运行的、在抽象套接字上监听的程序可被受限命令访问。把它们全部隐藏需要网络命名空间（`--unshare-net`），而那也会移除网络访问。WSLg 的显示与音频套接字（`/tmp/.X11-unix`、`/mnt/wslg`）以及继承的 `WSL_INTEROP` 与 `WSLENV` 变量仍然可见；这些变量只指明被隐藏的套接字与共享的变量名称。
- **作为聊天数据使用者的桌面应用。** 桌面应用共享 `sessions/` 及其旁边的存储，但 home 下没有任何文件显示它是否在运行：`profiles/desktop/lock` 只在该应用准备其 profile 时被持有，而它的单实例锁属于平台，位于 home 之外。因此 `run/data-users/` 的全 home 互斥不计入它，更新的复制、恢复或回滚，以及 `delorun trash`、`export` 与 `import`，都可能在桌面应用写入同样的存储时运行。这是首个发行版中已接受的缺口，该发行版不提供桌面应用。
- **经网络的 Docker。** 端点为 TCP 或 SSH 的 Docker context，在每种方言上都可被任何有网络访问的命令访问。
- **完全访问。** `danger-full-access` 下的命令可以读取 home 下的每个密钥与启动令牌，并能访问更新通道；任何规则都不适用，而上游的提权提示不说明这一点。
- **哪个组合包声明了受保护的行。** 启动时检查 sandbox 行与每个 Delorun 行是否来自声明它们的组合包（[C19](c19-home-process.zh.md#host-invariants)），该检查按包名识别该组合包——`@deepseek-ai/dsh-base` 或 `@delorun/` 作用域中的名称——而不是按它解析到的包目录。profile 从正在运行的发行版之外的位置解析到的同名包能通过该检查。
- **本人自己的进程。** 沙箱之外的本人用户进程可以读取和修改 home 下的一切；权限模式防范的是其他用户，而不是它。

<a id="enforcement-per-platform-and-dialect"></a>

## 各平台与方言的强制执行情况

本表说明每种方言对 CLI profile 中的命令强制执行什么。没有任何东西按机器报告它：`delorun verify` 把 `confinement-rule` 检查报告为未运行。

| 规则 | bwrap（Linux） | Landlock（Linux） | Seatbelt（macOS） | windows-acl（Windows） | 无沙箱或 `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| `home-write` | enforced：home 未以可写方式绑定 | enforced：home 下没有写授权 | enforced：可写根目录之外 `deny file-write*` | enforced：低完整性令牌无法写入带标签的根目录之外 | unconfined |
| `home-read` | enforced：home 上覆盖空 tmpfs，豁免路径以只读方式绑定 | enforced：一个叠加的规则集，授权读取 home 之外和豁免路径 | enforced：对 home `deny file-read*`，允许豁免路径 | not-enforced：该方言不限制读取 | unconfined |
| `token-read` | enforced，同 `home-read` | enforced，同 `home-read` | enforced，同 `home-read` | not-enforced，同 `home-read` | unconfined |
| `home-connect` | enforced：套接字被 tmpfs 遮蔽 | not-enforced：Landlock 没有连接路径名套接字的权限项；令牌检查拒绝该请求 | enforced：`remote unix-socket` 路径字面量 | not-enforced：该方言不添加任何套接字或管道规则，且启动令牌可读 | unconfined |
| `docker-connect` | enforced：把 `/dev/null` 绑定到套接字真实路径上 | not-enforced | enforced：context 路径与真实路径的路径字面量 | not-enforced | unconfined |
| `wsl-interop` | 在 WSL 下 enforced：`/run/WSL` 上覆盖空的只读 tmpfs | 在 WSL 下拒绝：每条受限命令都以 `SANDBOX_UNSUPPORTED_POLICY` 失败，因为 Landlock 没有连接路径名套接字的权限项 | 不适用 | 不适用 | unconfined |
| `vsock` | 在内核提供 vsock 的每个地方 enforced：seccomp 过滤器拒绝 `socket(AF_VSOCK, …)` 与 `io_uring_setup` | 在 WSL 下拒绝，同 `wsl-interop`；在其他虚拟机上 not-enforced | 不适用 | 不适用 | unconfined |
| `session-escape` | enforced：每个存在的目录及其每处其他挂载上覆盖空的只读 tmpfs | 凡存在其中一个目录之处即拒绝：每条受限命令都以 `SANDBOX_UNSUPPORTED_POLICY` 失败 | enforced：封装时对每个存在条目的 `remote unix-socket` 路径字面量 | 不适用 | unconfined |
| `daemon-connect` | enforced：把 `/dev/null` 绑定到封装时存在的每个套接字上 | not-enforced | enforced：每个套接字的路径字面量 | 不适用 | unconfined |
| `agent-connect` | enforced：把 `/dev/null` 绑定到套接字真实路径上 | not-enforced | enforced：两种写法的路径字面量 | not-enforced | unconfined |
| `private-tmp` | enforced：两种模式下都是空的 `/tmp`，`read-only` 下为只读，并在主机 `/tmp` 的每处其他挂载上覆盖空的只读 tmpfs | not-enforced：主机的 `/tmp` 可读，`workspace-write` 下可写 | not-enforced：主机的 `/tmp` 可读，`workspace-write` 下可写 | not-enforced | unconfined |
| `network` | enforced：命令自身的网络命名空间；`allowlist` 下只有绑定的代理套接字，在该命名空间的回环上提供服务 | 拒绝：网络为 `allowlist` 或 `off` 的工作区的每条命令都以 `SANDBOX_UNSUPPORTED_POLICY` 失败 | 拒绝，同 Landlock | 拒绝，同 Landlock | unconfined |
| 经 TCP 或 SSH 的 Docker | not-enforced | not-enforced | not-enforced | not-enforced | unconfined |
| 其他 `AF_UNIX` 套接字与网络 | 可访问 | 可访问 | 可访问 | 可访问 | 可访问 |

- **没有 bwrap 的 Linux。** 无法使用非特权用户命名空间时，bwrap 的探测失败，上游的提供方选择 Landlock。二者都不可用时，上游的提供方拒绝运行受限命令；对本人以 `danger-full-access` 运行的工作区，每条规则都显示为 `unconfined`。
- **Landlock 授权。** 叠加的规则集为从 `/` 到 home 路径上的每个同级条目授权，因此在受限命令运行期间直接在 home 某个祖先目录中创建的文件，对该命令不可读。
- **macOS 路径。** Seatbelt 匹配解析后的路径，因此 profile 用 `/private/var/...` 表示 `/var/...`，并同时列出 Docker Desktop 的 context 路径及其真实路径。
- **WSL2。** WSL2 中的 Delorun 就是 Linux，适用 Linux 各列。Windows 主机上的进程位于沙箱之外；`wsl-interop` 与 `vsock` 使受限命令无法启动它们，也无法通过虚拟机传输访问 Windows。
