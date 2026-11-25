---
description: "约定 C21：更改。本人的 harness 是已签名的发布加上本人所作的更改，每项更改都有记录，并且在保护开启时只包含本人在自己电脑上批准的更改：home 之下的已批准内容存储、更改的种类和状态、启动如何为从文件夹链接的插件加载内容、本人对 harness 自身的编辑以及启动所运行的组合树、保护设置及其关闭期间无需审查即加载的内容、带实时重新加载的工作会话、遗漏其失败所涉更改的启动、风险摘要，以及谁可以从何处更改其中每一项。"
---

# C21 更改

[English](c21-changes.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>

## 摘要

本人的 harness 所运行的内容是已签名的发布加上本人所作的更改，每项更改都有记录；在保护开启时，只包含本人在自己电脑上批准的更改。profile 从文件夹链接的插件，从保存在 Delorun home 之下的、其已批准内容的副本加载。保护默认关闭：每次启动，以及 Delorun 运行期间在文件夹中的每次保存，都使该文件夹的内容成为已批准的内容，并把它记录为一项已应用的更改，本人可以列出、查看并撤销它（[保护设置](#the-protection-setting)）。在保护开启时，文件夹中的编辑是待处理的更改，直到本人应用它们。本人对 harness 自身的编辑在已安装发布的可写副本中进行，应用之后从已签名安装旁边的组合树运行，该安装从不被编辑（[harness 编辑](#harness-edits)）。库是 [`@delorun/changes`](../../packages/changes/README.zh.md)；`delorun start` 和 `delorun headless` 在其启动前步骤 `changes` 中、在上游准备 profile 之前应用它，并在组合的已批准插件内容步骤中使已准备好的 profile 遵守其不变量。

<a id="contents"></a>

## 目录

- [home 的 changes 目录](#the-homes-changes-directory)
- [更改的种类与状态](#change-kinds-and-states)
- [加载已批准的内容](#loading-approved-content)
- [harness 编辑](#harness-edits)
- [Plugin packs across an update](#plugin-packs-across-an-update)
- [重新加载与恢复](#reloads-and-restores)
- [回收存储](#collecting-the-store)
- [Changes 下的首次启动](#the-first-start-under-changes)
- [保护设置](#the-protection-setting)
- [工作会话](#work-sessions)
- [启动失败时](#when-a-start-fails)
- [风险摘要](#the-risk-summary)
- [智能体与插件](#the-agent-and-plugins)
- [保护关闭时智能体的插件操作](#the-agents-plugin-actions-with-protection-off)
- [谁可以从何处做什么](#who-may-do-what-from-where)
- [路由与恢复屏幕](#routes-and-the-recovery-screen)
- [studio 的 Changes 一节](#the-studios-changes-section)
- [命令](#commands)
- [verify 与 doctor 报告什么](#what-verify-and-doctor-report)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="the-homes-changes-directory"></a>

## home 的 changes 目录

`changes/` 是 home 中的一个 Delorun 条目（[C1](c01-home-layout.zh.md#the-home-tree)），模式为 0700；其中每个文件都是模式为 0600 的受保护文件。

| `changes/` 之下的路径 | 保存的内容 |
| --- | --- |
| `protection.json` | `{"schema":"delorun.changes-protection/1","level":"on"\|"off","setAt":<ISO time>}`；缺失表示 `off` |
| `notices.json` | `{"schema":"delorun.changes-notices/1","notices":[…]}`：最多 20 条由已配对设备所做的保护设置更改，按从旧到新排列，每条为 `{"id","kind":"protection","level","at","deviceId","device"}`；更改日志保持其模式 |
| `store/objects/<sha256>` | 一个文件的字节，以其 SHA-256 命名，从不被重写 |
| `store/versions/<sha256>.json` | 一个内容版本：`{"schema":"delorun.changes-version/1","entries":[…]}`，条目按路径排序；其名称是其规范条目的 SHA-256 |
| `store.lock` | 存储的锁，保存其持有者的进程 id：存储文件夹和回收都持有它（[回收存储](#collecting-the-store)） |
| `profiles/<profile>/active/<plugin>/` | profile 对该插件的 `link:` 依赖所指名的目录；`@scope/name` 写作 `@scope+name` |
| `profiles/<profile>/active.json` | 每个活动目录所保存的内容：一个版本以及 `approved` 或 `work-session`，或者带有版本或不带版本的 `left-out`（[启动失败时](#when-a-start-fails)） |
| `profiles/<profile>/log.json` | 更改日志：`{"schema":"delorun.changes-log/1","migratedAt"?,"entries":[…]}` |
| `profiles/<profile>/agent-log.json` | 保护关闭时运行的智能体 `plugin_manager` 操作：`{"schema":"delorun.changes-agent-log/1","entries":[…]}`, 条目与 `log.json` 中相同，种类为 `plugin-setting-change`，并允许 `historyBefore` 字段；启动从不读取它（[保护关闭时智能体的插件操作](#the-agents-plugin-actions-with-protection-off)） |
| `profiles/<profile>/work-session.json` | 工作会话持续期间的工作会话（[工作会话](#work-sessions)） |
| `profiles/<profile>/scan-cache.json` | 按 inode、大小和时间记录的文件摘要；这是一种优化，从不被信任用于决定 |
| `harness/log.json` | harness 自身文件的更改日志，整个 home 一份，每个 profile 的列表都显示它（[harness 编辑](#harness-edits)） |
| `harness/<runtime>/approved.json` | `{"schema":"delorun.changes-harness/1","runtime","files":{"<path>":{"version","signed"?,"change","approvedAt"}}}`：运行时 `app/` 之下已批准内容与已签名发布不同的文件 |
| `harness/<runtime>/copy/app/` | 本人对运行时 `app/` 目录的可写副本 |
| `harness/<runtime>/scan-cache.json` | 该副本的扫描缓存 |
| `harness/<runtime>/pending.json` | 上一次读取该副本时找到的每项更改所在的文件，按更改 id 记录；针对单项更改的操作用它只读取该文件，无法使用时则读取整个副本 |
| `harness/<runtime>/run/<digest>/` | 该运行时的一次启动所运行的组合树 |
| `harness.lock` | 每项 harness 决定、组合和保留所持有的锁 |

版本条目是文件（`path`、`digest`、`size`、`executable`）或链接（`path`、`target`、`outside`）。profile 的 `package.json` 把每个已批准的插件记录在 `delorun.changes` 之下，形式为 `{"schema":"delorun.changes-approved/1","plugins":{"<name>":{"source","version","approvedAt","approvedAtUpgrade"?}}}`，因此 profile 历史的每个版本都保存已批准的版本，并且上游的撤销和恢复会把它带回来。

<a id="change-kinds-and-states"></a>

## 更改的种类与状态

| 种类 | 更改的内容 |
| --- | --- |
| `plugin-edit` | 已链接插件的文件夹与其已批准内容不同 |
| `plugin-install`, `plugin-update`, `plugin-remove` | 添加插件、将插件移到另一个版本或移除插件 |
| `plugin-off`, `plugin-on` | 关闭或重新开启一个插件 |
| `harness-edit` | harness 自身的某个文件与已签名发布的不同 |
| `guard-weakening` | 某项设置削弱了同意或防护，或者保护被关闭 |
| `plugin-setting-change` | 智能体的 `plugin_manager` 在保护关闭时运行了一个既不是安装也不是移除的操作：开启或关闭、某项设置、版本豁免、撤销或恢复 |

更改处于 `pending`、`applied`、`discarded`、`left-out-at-start` 或 `undone` 之一。决定的 `decidedFrom` 是：`terminal` 或 `studio`，表示本人自己的决定（`studio` 是电脑上的 studio，或已解锁的已配对设备的 studio；设备的决定还会在 `decidedOn` 中记录该设备的 id 和名称，之后的决定会清除它）；`upgrade`，表示 Changes 下的首次启动；`start`，表示失败的启动所遗漏的更改；`update`，表示本人确认的更新带到它所安装的运行时的 harness 文件；以及 `unreviewed`，表示保护关闭期间 Delorun 未经审查而加载的内容（[保护设置](#the-protection-setting)）。其 id 是 `c` 加上其种类、主体和两个版本的 SHA-256 的十个十六进制数字，因此 id 恰好指名了所展示的内容。每项已应用的更改是 profile 历史的一个版本。

<a id="loading-approved-content"></a>

## 加载已批准的内容

在上游准备 profile 之前，启动取得上游的 profile 写锁（`package.json` 的文件锁），并对每个 `link:` 依赖：

1. 指向运行时仓库的链接，或指向运行中的安装为该包名所携带的目录的链接，就是 harness，不作处理。
2. 任何其他链接都被移到 `package.json` 中该插件的活动目录、锁文件的 importer 条目和 `node_modules/<name>`，因为 pnpm 在每次操作中都会把链接重置为所记录的依赖。保护开启时，被移动的插件作为来自该文件夹的待处理 `plugin-install` 等待审查，除非该文件夹就是其已批准的那个；保护关闭时，其文件夹的内容按第 3 步加载。文件夹缺失或指名了一个文件的链接同样会被移动，并且无论哪种设置，都作为来自该文件夹、其 `to` 为空版本的待处理 `plugin-install` 等待审查，因此之后在那里创建的文件夹在启动或重新加载读取它之前不会加载任何内容。
3. 使活动目录保持：在该插件的工作会话中，保持文件夹的内容；在失败的启动所遗漏的更改仍被遗漏期间，保持它之前的内容，或什么都没有（[启动失败时](#when-a-start-fails)）；保护开启时，保持已批准的版本，没有已批准版本的插件则什么都没有，上游随后会跳过它；保护关闭时，保持文件夹的内容，它按[无需审查的加载](#loading-without-review)所述成为已批准的内容，除非本人拒绝了恰好这份内容，此时保留已批准的版本。内容不同的文件原地替换，因此热重载只替换已更改的模块。
4. 启动检查每个链接都指名其插件的活动目录，`node_modules/<name>` 存在时它解析到那里，并且每个活动目录保存的是 `active.json` 所记录的内容，保护开启时，在工作会话和被遗漏的更改之外，该内容是已批准的版本；否则它以 `LOAD_REFUSED` 拒绝，profile 不启动。

插件的内容是其文件夹之下除 `.git` 和含有反斜杠的名称之外的每个文件，其链接的目标按哈希计入：留在文件夹之内的链接（既按所写的位置，也按它在磁盘上的解析位置判断）仍是相对链接；指向已安装包的链接（`node_modules` 目录之下的真实路径，例如 pnpm 的 `.pnpm` 存储中的路径）、指向同级工作区包的链接，或指入该文件夹或其所含包的 `.git` 目录的链接，会在该链接的路径下被复制。同级工作区包是持有普通 `package.json` 的目录，链接在路径 `…node_modules/<name>`（`<name>` 为包名）处到达它，就像 pnpm 工作区链接它那样。以这种方式包含的已安装包，会带上其 `package.json` 所列（`dependencies`、`optionalDependencies`、`peerDependencies`）且按 pnpm 的安装方式安装在它旁边的依赖，位于 `<its path>/node_modules/<name>` 之下，遵循同样的规则，因此该副本像 Node 解析原件那样解析它们。无法解析的链接、指向文件夹之外的任何其他链接，以及指向 Delorun home 或 `/proc`、`/sys`、`/dev` 中目标的每个链接，都被排除在副本之外，并列在扫描无法包含的路径中：保留这种链接的副本会在运行时加载那里的任何内容，而 Delorun home 保存着本人的密钥，存储和远程会话读取的差异从不得包含它们。扫描也从不进入 Delorun home。每个文件最多读取其打开时状态所给出的大小，这是计入上限的大小，存储的副本读取不会更多；持有更多内容的文件以 `CHANGED_WHILE_READING` 被拒绝，因此永不结束的文件无法使启动停滞。

一个内容版本最多持有 50,000 个文件、链接和目录以及 512 MiB（`CONTENT_ENTRY_LIMIT`、`CONTENT_BYTE_LIMIT`），其所含包计算在内。超过某个上限、在读取期间发生变化或无法读取的文件夹从不使启动停止：

- 该插件保留其已批准的内容，没有已批准内容的则什么都不加载，并且启动写明该插件和原因（对于上限，为 `CONTENT_TOO_LARGE`）：超过上限的插件被拒绝，直到它变小。
- 保护关闭时，只因其已安装的包而超过上限的文件夹是例外：它连同那些保持为指向其安装位置的链接的包一起存储，并且每次加载它的启动都会说明这一点，当其中某个包位于本人的主文件夹之下（受限命令可以在那里写入）时还会补充说明。
- 启动所移动的链接，如果其文件夹无法读取，则无论哪种设置，都作为其 `to` 为空版本的待处理 `plugin-install` 等待审查，下一次启动会再次读取该文件夹；Changes 下的首次启动不批准这样的插件。
- 存储已不再持有的已批准内容，例如收集之后移除了的、被恢复的历史版本所指名的版本，不加载任何内容，并且启动写明该插件。

<a id="harness-edits"></a>

## harness 编辑

本人可以更改 harness 自身：已安装运行时 `app/` 目录之下的文件。`runtimes/<runtime>/` 之下的已签名安装从不被编辑，运行时仓库对它的启动检查在任何保护设置下都不放宽。harness 编辑按运行时版本且全 home 范围有效，而不是按 profile；`node/` 和 `app/` 之外的每个路径从不是 harness 文件。库是 [`harness.ts`](../../packages/changes/src/harness.ts) 和 [`harness-tree.ts`](../../packages/changes/src/harness-tree.ts)；`delorun` 通过 [`harness-command.ts`](../../apps/cli/src/changes/harness-command.ts) 和 [`harness-start.ts`](../../apps/cli/src/changes/harness-start.ts) 到达它们。

| 部分 | 它是什么 |
| --- | --- |
| 已签名的文件列表 | 读取安装的每个操作都读取运行时仓库经过验证的文件列表：在启动器锚定的根之下的启动检查（如 `checkStoredRuntime` 所运行的那样），并且从安装读取的每个字节都再次对照该列表的长度和 SHA-256 检查 |
| 记录 | `harness/<runtime>/approved.json`：已批准内容与已签名文件不同的每个文件，作为存储中的单文件内容版本（`version`，对被移除的文件为空版本），连同已签名文件的版本（`signed`）、批准它的更改及其时间。没有记录的运行时运行其已签名的发布 |
| 可写副本 | `delorun changes edit-harness` 为运行中的运行时创建 `harness/<runtime>/copy/app/`：安装的 `app/` 的副本，从不是硬链接，其中记录的已批准文件在位，被移除的文件缺失；文件为 0600，可执行文件为 0700，目录为 0700。第二次运行打印该文件夹且不改变任何内容。在复制任何内容之前，它根据已签名的文件列表和记录，按副本的扫描方式计算副本将持有的条目和字节，当任一项超过扫描上限时，以 `CONTENT_TOO_LARGE` 拒绝，写明上限以及无法为此发布进行 harness 编辑 |
| 待处理的更改 | 副本中内容或执行位与运行时所运行的内容（记录的版本，或已签名的文件）不同的每个文件，是一项待处理的 `harness-edit` 更改，主体为 `{file, runtime}`，`from` 为所运行内容的单文件版本（什么都没有运行时为空版本），`to` 为副本的版本（本人删除了它时为空版本）。新增的文件也计算在内。链接、FIFO、套接字、设备和 `app/` 之外的路径被列为已跳过，且从不被跟随；名为 `*.mine` 的文件（更新在无法合并的文件旁边写入它们）被列为保留在旁。扫描具有插件扫描的上限，以及它自己的扫描缓存。不是目录的副本、超过上限的副本或持有无法读取的条目的副本，使对整个副本的每次读取都以 `HARNESS_COPY_UNREADABLE` 被拒绝，主体为该副本的 `app/` 目录，其详情写明原因和 `delorun changes edit-harness --discard`；在读取期间发生变化的文件以 `CHANGED_WHILE_READING` 被拒绝。对单项更改的 `show`、`apply` 和 `discard` 只读取 `pending.json` 为其 id 指明的文件：该文件会被重新读取并重新哈希，从不取自扫描缓存，且仅当结果与该 id 一致时才使用；否则它们读取整个副本。待处理的更改在每次读取时计算，只在被决定时才记入日志 |
| 日志 | `harness/log.json`，与 profile 的日志模式相同的更改日志，其条目携带 `subject.runtime`；每个 profile 的 `list` 和 `show` 都包含它 |

每项决定都在 `harness.lock` 之下运行，并以 `decidedFrom` 记入日志；本人的每项决定都需要在场证明，并在读取或写入任何内容之前，拒绝 attest 函数未签发的证明：

- **应用。** 先存储两侧；副本的内容成为记录中该文件的已批准内容，当它等于已签名的文件，或已签名的发布没有这样的文件而副本也不持有时，该条目被移除。它打印审查和风险摘要，并像插件的应用那样请求第二次确认。`runtimes/` 从不被写入。更改从下一次启动或重启起运行，若为实时更改则立即生效（[实时更改与重启](#live-changes-and-restart)）。失败的启动所遗漏的更改，在记录仍持有其内容期间会再次被应用。studio 的 `harness-apply` 还接收审查所显示的完整内容版本，因为 id 只通过十个数字绑定内容，对其他版本以 `CHANGED_SINCE_REVIEW` 拒绝。
- **丢弃。** 副本再次持有运行时对该文件所运行的内容：已批准或已签名的字节，或没有文件。该更改记入日志为已丢弃。
- **撤销。** 只在记录中该文件的内容（记录没有指名时为已签名的文件）是该更改的 `to` 期间：文件回到该更改的 `from`，当它是已签名的文件时该条目被移除，副本持有它，该更改记入日志为已撤销。否则 `NOT_ALLOWED` 写明较晚的更改。
- **丢弃每项更改。** `delorun changes edit-harness --discard` 询问 harness 是否回到已签名的发布，把每项待处理的更改记入日志为已丢弃，把记录持有其内容的每项已应用或被遗漏的更改记入日志为已撤销，清空记录并移除副本，先使其目录可写，被移除处的链接不被跟随。无法读取的副本（`HARNESS_COPY_UNREADABLE` 或 `CHANGED_WHILE_READING`）不会使其停止：在那里等待的更改随副本一起被移除而不记入日志，并且该命令打印副本无法读取的原因。下一次启动原样运行已签名的发布。
- **未经审查的应用。** 保护关闭时，决定下面的交接的那次启动，在组合树之前，无需在场证明就应用副本中等待的每项更改（`applyUnreviewedHarnessChanges`）：它在 `harness.lock` 之下再次读取保护设置，开启时不应用任何内容；否则每项更改被存储，其内容记录在 `harness/<runtime>/approved.json` 中，并以 `decidedFrom: "unreviewed"` 记入日志为已应用，启动打印 `Delorun itself (<file>) changed without review, because protection is off: delorun changes show <id>`。`list`、`show` 和 `undo` 像对待其他更改那样到达这些更改。无法读取的副本（`HARNESS_COPY_UNREADABLE` 或 `CHANGED_WHILE_READING`）不应用任何内容，启动打印 `Delorun could not read your copy of Delorun <runtime>, so it runs what it ran: <reason>` 并继续。

组合树是 `harness/<runtime>/run/<digest>/`，`<digest>` 是一次启动所运行的路径与版本对的规范列表的 SHA-256：记录的版本，其中失败的启动所遗漏且仍被遗漏的每项更改被替换为其 `from`，当它是已签名的文件时该条目被丢弃。它是安装的完整树：每个未被批准的已签名路径都是指向安装文件的硬链接（只有在文件系统以 `EXDEV`、`EPERM` 或 `ENOTSUP` 拒绝该链接时，才是其已验证字节的副本），每个已批准的文件都从存储中经过验证的对象以 0444 写出（可执行时为 0555），被移除的文件缺失，并且每个目录在填充之后为 0555。它在临时同级目录中构建，并在锁之下重命名到位；挡在构建路径上的路径（`ENOTDIR` 或 `EEXIST`：本应是目录之处有一个文件，或另一个构建者写入的内容）使启动以 `HARNESS_CHANGED` 被拒绝并写明该路径，对于 `ENOTDIR`，写明最近的非目录父路径。每次构建或复用一棵树的启动，都在锁之下设置该树目录的时间。每次运行之前都要检查：每个未被批准的已签名路径是安装的文件（同一设备和 inode，按 64 位整数比较，或具有已签名长度、SHA-256 和执行位的普通文件），每个已批准的路径是具有已批准摘要和执行位的普通文件，并且不存在其他任何内容。未通过的树会被重建一次；第二次失败使启动以 `HARNESS_CHANGED` 被拒绝并写明该路径。

| 步骤 | 发生什么 |
| --- | --- |
| 谁来决定 | 只有已签名的代码：从仓库的安装（而不是组合树）运行的 `delorun start --foreground`，针对不处于安全模式、且其运行时的记录组成了任何文件的 profile，在保护关闭时应用了副本的更改而未经审查之后。处于安全模式的 profile（`run/<profile>/safe-mode.json`）运行不带任何 harness 更改的已签名安装，并且不应用任何更改，直到安全模式结束 |
| 交接 | 它的第一个动作，先于任何锁、令牌或日志：安装的启动检查，构建或检查组合树，保留，然后树的 `node` 以与该终端相同的参数作为子进程运行树的 `delorun` 入口，位于本进程的进程组中，描述符 3 在打开时（更新后继的交接）被传递，`SIGTERM` 和 `SIGHUP` 被转发，并返回子进程的退出码。在子进程启动之前，交接写入 `run/<profile>/hand-off-<pid>`，`<pid>` 是它自己的进程 id；每次启动的第一个动作都是移除其父进程写入的文件。以非 0 退出码退出而该文件仍在的子进程，是在其启动运行之前就失败了 |
| 哪个入口 | `startEntry` 是唯一的函数：交接启动组合树的入口；后台的 `delorun start` 以及在启动遗漏了某项更改之后的重试，启动已签名安装的入口，因此已签名的代码再次组合。发生交接的后台启动等待子进程所启动的 home 进程，该进程的进程 id 不是子进程的 |
| 在组合树中 | `runtimeOfFile` 把 `harness/<runtime>/run/<digest>/` 之下的文件映射到设置了 `store: true` 和 `composed` 的运行时。更新支持和发布通道检查已签名的安装；全新启动的运行时检查和 C3 的健康检查 H1 先检查安装，然后检查组合树，该树必须是记录现在所组成的树。闭包的 pnpm、其安装锚点和 Delorun 的 bundle 在组合树之内解析 |
| 保留 | 交接之后，该运行时的其他组合树被移除，除非任何 profile 的 home 进程在运行（它可能从其中一棵运行），并且最近一小时之内被某次启动设置过时间的树除外（`TREE_RETENTION_GRACE_MS`）：并发的启动可能已选择了它，但尚未启动标记其为使用中的 home 进程。仓库已不再安装的每个运行时的 `harness/<runtime>/` 目录也被移除。目录先被设为可写。失败会被打印，下一次启动再试 |

**错误的启动。** 当 profile 的更改日志和运行中运行时的 harness 日志里最新的决定是一项记录仍持有其内容的已应用 `harness-edit` 时，启动的重试（[启动失败时](#when-a-start-fails)）遗漏该更改：它的 harness 日志条目变为带失败信息的 `left-out-at-start`，profile 的文件不受触动，重新启动的已签名入口不带它地组合，并且文字把它称为 `Delorun itself (<file>)`，附带 `delorun changes apply <id>` 和 `undo <id>`。harness 更改没有自己的 Loader 行；由启动的失败决定它。

**在启动之前失败的组合树。** 当组合树的 `delorun` 在其启动运行之前以非 0 退出码退出（例如 Node 导入时已更改的文件抛出异常），并且该交接不是更新后继的交接时，已签名的进程做组合树的启动无法做的事（[`retry.ts`](../../apps/cli/src/changes/retry.ts) 的 `retryHandOff`）：`leaveOutNewestHarnessChange` 把该运行时最新的 harness 决定标记为带失败信息的 `left-out-at-start`，前提是它是记录仍持有其内容的已应用 `harness-edit`，无论 profile 的日志持有什么；文字如上所述称呼它，并且启动在同一进程中通过同一交接再运行一次，设置重试标记，该次启动不带该更改地组合，或运行已签名的安装。已带有重试标记，或没有找到可遗漏之物的启动，打印「Delorun did not start with your changes to Delorun itself.」，对最新的已应用 harness 更改打印「To undo the newest one: delorun changes undo `<id>`.」（没有时打印「See them with: delorun changes list.」），以及「To start the installed release without any of them: delorun changes edit-harness --discard.」，并以子进程的退出码退出。由 `delorun start` 在后台启动的 home 进程则以遗漏退出码退出，并由其启动者写明该更改并再启动一次。更新的后继从不重试：更新的健康检查和回滚决定它，停止后继也会停止被组合的子进程（[C19](c19-home-process.zh.md#the-update-handshake)）。

**跨越一次更新。** 更新通过与目标的已签名文件的三向合并，把运行中的运行时所运行的、非其已签名的文件，带到它所安装的运行时，如 [C3](c03-update-report.zh.md#harness-files-across-an-update) 所述：当有更改在副本中等待审查时，它以 `HARNESS_CHANGES_PENDING` 拒绝，当副本无法扫描时以 `HARNESS_COPY_UNREADABLE` 拒绝；它连同差异一起显示合并成双方都没有的内容的文件，并要求本人对它确认；当在 harness 锁之下重新规划的合并与本人确认的报告不同时，它以 `HARNESS_REPORT_STALE` 拒绝；它替换较早的安装在 `harness/<to>/` 之下留下的任何内容，写入带有每个所带文件的目标记录，并以 `decidedFrom: "update"` 把它记入日志为目标运行时的已应用 `harness-edit`，并把本人对每个冲突文件的内容保留为目标可写副本中的 `<file>.mine`。运行中运行时的记录、副本和日志条目保持不变，因此回滚会再次运行它们。库是 [`harness-merge.ts`](../../packages/changes/src/harness-merge.ts)。

**studio。** studio 的 harness 路由依据正在运行的运行时的签名文件列表来决定对 Delorun 本身的更改，home 进程把该列表作为根服务 `changesHarness` 交给 Host；没有它的 Host（例如从源码检出运行的 Host）在这些路由上应答 `409 HARNESS_UNAVAILABLE`。Changes 一节制作副本，列出在副本中等待的更改和已记入日志的更改及其差异，并通过这些路由应用、丢弃和撤销它们（[路由与恢复画面](#routes-and-the-recovery-screen)，[studio 的 Changes 一节](#the-studios-changes-section)）。

<a id="live-changes-and-restart"></a>

### 实时更改与重启

运行中的 Delorun 运行一棵组合树或已签名的安装，其文件从不改变，因此对 Delorun 本身已决定的更改要么实时生效，要么在重启时生效。服务器代码从不实时生效：从另一棵树加载的模块会把它导入的每个包再加载一份。库是 [`harness-live.ts`](../../packages/changes/src/harness-live.ts)；studio 一侧是 [`live-apply.ts`](../../packages/plugin-changes/src/live-apply.ts) 和 [`restart-route.ts`](../../packages/plugin-changes/src/restart-route.ts)。

- **Host 运行什么。** home 进程在其 `changesRestart` 服务中，把 Host 启动时所用的组合交给它所启动的 Host：已签名的安装，或由记录在其启动时所组成内容的摘要命名的组合树。任何其他树都是未知的，此时每项已决定的更改都算作等待重启的更改。
- **实时类别。** 只有 studio 构建出的客户端资源是实时的：位于 `app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/` 之下的文件，其在该目录之下的路径是一个或多个由字母、数字、`.`、`_` 和 `-` 组成且不以 `.` 开头的段，因此其 URL 路径 `/assets/<path>` 就是按所写形式的文件名。每次 studio 对 Delorun 本身的更改作出决定之后，`@delorun/plugin-changes` 把记录所组成的内容与 Host 所运行的内容作比较，读取每个不同的实时文件的组合内容（存储的对象或已签名的文件，各自对照其摘要检查），并且只有在每次读取都成功之后，才通过位于静态文件席位之前的、精确匹配的 web 服务器路由，在其 URL 路径上提供它们。Connection 的围栏先决定每个这样的请求，如同它对静态文件席位所做的那样，每个回答都带有 `cache-control: no-cache` 和一个弱 ETag。该决定的回答写明 `live` 并带有 `page: true`，页面重新加载后即可看到更改；运行中的 chat 不受影响。不再不同的文件，其路由被移除，因此再次提供运行中树的文件。同一进程再次启动的 Host（重启失败之后或重新加载之后），在插件启动时提供记录所组成的实时文件。
- **失败的实时更改。** 当某个实时文件无法读取时，每个路由继续提供它此前所提供的内容，已应用的更改在仍以其内容记入记录时，如同错误的启动将其遗漏那样被遗漏（[错误的启动](#harness-edits)）：其条目变为 `left-out-at-start` 并带有该失败，决定来源为 `start`，回答写明 `left-out` 及该失败。
- **等待重启的内容。** 任何其他已决定的更改，以及 Host 的组合未知期间的每项更改，都回答 `restart`；没有已安装发布的 home 进程运行的 Host 回答 `not-running`，更改从下一次启动起运行。当记录所组成的内容在某个非实时的文件上与 Host 所运行的内容不同时，`state.restart` 为 `needed`，并带有这类文件的数量和运行中的 chat 数。
- **重启。** `POST /delorun/changes/restart` 请求 home 进程的重启（[C19](c19-home-process.zh.md#the-restart)）：它最多等待运行中的 chat `restartWaitSeconds`（插件的配置，默认 600 秒），或用 `stopChats` 停止它们，在同一版本上启动新的 Host，后者组成记录现在持有的内容；当新 Host 未通过健康检查时保留运行中的 Host，并且在运行中的 Host 并未运行对 Delorun 本身最新已应用的更改时，把该更改排除在外。重启运行期间，`state.restart` 为 `restarting` 并带有其阶段和运行中的 chat；失败后为 `failed`，带有时间、原因（`health`、`chats` 或 `host`）和被排除的更改，直到下一次对 Delorun 本身的更改作出决定。`restart-cancel` 结束仍在等待 chat 的重启。

<a id="plugin-packs-across-an-update"></a>

## 更新期间的插件包

`packs/<release>/` 下某个包的文件夹保存某个发布自己的文件，而 profile 通过 `packs/current` 链接它（[C1](c01-home-layout.zh.md)）。更新会把该链接移到新发布的文件夹，因此已批准的内容（即上一个发布的文件）与该文件夹之间的差异，正是该发布所替换的内容。这一差异属于该发布，而不是本人的更改：更新的后继进程用文件夹的内容替换已批准的内容，作为决定为 `update`、摘要为 “Replaced by the update to `<version>`: `<package>`” 的已应用 `plugin-edit`，并写入一个 profile 历史版本，启动的措辞会指名它（`delorun changes show <id>`）。无论保护开启还是关闭，它都这样做；保护关闭时，它不会被记录为 `unreviewed`。该库是 [`update-baseline.ts`](../../packages/changes/src/update-baseline.ts)，由 `enforceApprovedContent` 的启动阶段带着 `updateBaseline` 请求字段调用。

- **谁可以。** 只有一次更新的后继进程的第一次 Host 启动（[`start.ts`](../../apps/cli/src/changes/start.ts) 的 `repointForSuccessor`，它在后继进程的副本被重新指向之前、在其健康检查之前运行；[`update-baseline.ts`](../../apps/cli/src/changes/update-baseline.ts)），并且只针对一次更新向更新版本的交接：回滚、重启、全新启动、健康检查失败之后的启动、重新加载以及 `delorun headless` 都得不到基线，其 `to` 不是比 `from` 更新的语义版本的更新也得不到。本人从更新版本发起的回滚会用 `purpose` 为 `rollback` 的交接行启动其后继进程（[C19](c19-home-process.zh.md#compatibility)），它不为基线提供发布；不写 `purpose` 的前任进程属于一次更新，正如该字段之前的每个发布那样，而更新版本的规则对它仍然成立。没有任何路由、studio 调用、插件或命令能到达它。
- **它得到什么。** 该更新离开的那个发布与本进程所运行的发布的已签名包文件，由运行时仓库的 `openSignedPacks` 从每个发布所存储的包文件读取，仓库会在锚定的 root 之下、对照该发布的 manifest 与发布日志记录再次验证它们。只有当某个已批准的插件从 `packs/` 链接、且两个发布之一把它列为包时，后继进程才构建基线并为其运行 Changes 的启动；否则它不读取该 profile 的任何插件文件夹，与基线存在之前一样。只有当某个等待中的更改触及某个包时，才索取该包的已签名文件，每个包一次，并且不对任何已安装的包计算哈希：比较使用已批准内容与文件夹的扫描已经持有的摘要，对照已验证包文件的摘要，并且只为下面的允许情形读取一个已安装的 `package.json` 或 `pnpm-lock.yaml`，且要在其字节哈希到已签名摘要之后。某个包所固定的外部包的文件不在已签名列表中，因此其中之一的更改会等待。该启动运行期间，它从活动副本的文件读到的摘要只保留在本次启动的内存中，放在以每个文件的路径、设备、inode、大小以及纳秒级修改与状态变更时间为键的备忘中，只用于启动与重新指向决定是否重写副本的地方：启动之后的加载检查与副本写入之后的检查都会读取每个文件，而此后被改动的文件会被再次读取。文件无法验证的发布不给出基线：什么也不替换，启动会说明对包的更改等待审查。
- **什么会被替换。** 一个属于本进程所运行发布的包、从 `packs/` 下的文件夹链接、其文件夹内容不是本人拒绝过的内容，并且以下两条都成立的插件。只有已批准内容与文件夹之间不同的条目会被判定。文件夹持有而已批准内容未按其原样持有的每个条目，必须是本进程所运行发布的包文件为它列出的、具有相应摘要与可执行位的文件；已批准内容持有而文件夹不再按其原样持有的每个条目，必须是上一个发布的包文件所列出的文件；本进程所运行发布列出的文件不得从文件夹中缺失；而已批准内容缺少的条目也不得被上一个发布列出（本人的删除不会被撤销）。不同条目中的链接，或已签名列表未担保的任何条目，都会让该更改等待；两侧相同的条目不被判定。随后已批准的内容被整体替换。
- **什么不会。** 任何其他差异。真正的编辑、包文件未列出的文件、不匹配的摘要，或与发布文件混在一起的编辑，都会让整个更改像没有这次更新时那样等待，其中属于发布文件的那部分仍留在差异中；不会从中丢弃任何东西，也不会把任何东西并入基线。
- **一项范围很窄的允许。** 到 0.1.0-preview.2.1 为止的发布，会把某个包的 `package.json` 与 `pnpm-lock.yaml` 连同构建的临时文件夹写进它们的依赖说明符（`delorun-release-build-<random>`），因此每个发布的包与上一个发布的包只在这两个文件上不同。当把两段文本中的每个 `delorun-release-build-<random>` 文件夹片段替换为一个固定标记之后，已批准的 `package.json` 或 `pnpm-lock.yaml` 等于上一个发布已安装包中该文件的文本（其字节与已签名摘要相符，且该文件共享其可执行位）时，它也算作上一个发布的文件。别的什么也不规范化，文件夹那一侧从不规范化。该允许是一条带有上限的安全不变量：只有当更新离开 0.1.0-preview.2.1 或 0.1.0 预览线的更早发布（[`update-baseline.ts`](../../packages/changes/src/update-baseline.ts) 中的 `LAST_RELEASE_WITH_BUILD_PATHS`）时才适用，那是最末几个其包带有此类文件夹名称的发布；对于离开任何其他发布的更新，已批准的文本必须与某个已签名文本完全相等。提高该上限会扩大更新并入基线的内容。
- **健康检查失败之后。** 当后继进程的健康检查失败时，回滚会恢复该 profile 的文件（包括已批准记录），但不恢复 `active.json`，它仍然指名后继进程所决定的内容。前任进程的 Host 会再次启动：在那次启动之前，每个加载已批准内容的活动副本都被设为恢复后的已批准记录所指名的版本（对于没有已批准版本的插件则设为空），其目录像启动时那样从存储填充。不从任何文件夹读取任何东西，也不批准任何东西，因此无论保护开启还是关闭，前任进程加载的正是该 profile 再次批准的内容。用于工作会话或从失败启动中被排除的副本不受影响，而记录与所加载内容之间的任何其他不一致仍然会拒绝启动。这适用于本发布或更晚发布的前任进程。0.1.0-preview.2.1 或更早的前任进程（基线所适用的每次更新都会离开它）没有这样的步骤，并且当 `active.json` 指名其恢复后的已批准记录所没有的内容时拒绝继续，因此后继进程自己撤销基线：当其 Host 健康检查失败或无法启动时，在报告失败之前，它把基线改动过的每个已批准记录条目与每个 `active.json` 条目放回，并把它放回的条目的每个活动目录再次填入该条目的内容，或对于启动所新增的条目填入空（[`enforce.ts`](../../packages/changes/src/enforce.ts) 中的 `revertDecisions`，经由 Host 运行器的 `abandon` 运行，后者会先等待仍在应用的基线），并保留此后被改动过的任何条目。后继进程还给自己一个期限，即 [C19](c19-home-process.zh.md) 的 `SUCCESSOR_DEADLINE_MS`（前任进程 120 秒之下的 20 秒），前提是其启动改动过某个记录：如果到那时它还不健康，它就撤销基线并自己报告 `failed`，因此前任进程永远不必在基线仍处于应用状态时停止它。没有改动任何记录的启动没有可撤销的东西，也不设期限，因此适用前任进程的 120 秒。它不会等到健康检查才应用基线，因为其 Host 在启动时就加载已批准的内容，而基线之前的一次启动会加载上一个发布的包文件。更改日志与历史保留记录这次替换的条目。


## 回收存储

在每次启动结束时，在 profile 写锁之下、检查之后，`collectStore` 移除 Changes 下没有任何 profile 引用的每个版本文件和对象：每个 profile 的已批准记录、其更改日志中状态为 `pending`、`applied` 或 `left-out-at-start` 的条目（`from` 和 `to`）、其 `active.json` 和其工作会话（`from`、`lastLoaded`、`lastFailed`）。最近一小时之内写入的版本文件被保留（`COLLECT_GRACE_MS`），因此为审查而计算、但尚未被决定的更改保留其内容。回收不等待就取得存储的锁，在另一个进程存储文件夹期间什么都不做，当这些记录中任何一个无法读取时什么都不移除，两秒后停止（`COLLECT_TIME_LIMIT_MS`），其余留给下一次启动；移除某个文件失败时保留它，启动继续。只被 `discarded` 或 `undone` 条目引用，或只被较早的 profile 历史版本引用的版本会被移除，因此恢复这样的历史版本不会为该插件加载任何内容，直到本人再次应用某项更改。

<a id="reloads-and-restores"></a>

## 重新加载与恢复

对运行中 profile 的每次重新组合，都在任何内容停止之前先检查：上游的热重载在 `reconcileProfile` 中等待可选的 `profileReconcileCheck` 服务，而 `@delorun/plugin-changes` 无论其开关如何都提供它。这涵盖 `changes.reload`、工作会话的重新加载、本人在 studio 中对插件的更改（Plugin Manager 的安装、移除、`set_bundle`、`set_plugin`、`configure`、`set_version_exemption`、`undo` 和 `restore`），以及在 `delorun plugin` 或对 `package.json` 的任何编辑之后 profile 自己的文件监视。该检查 `prepareReload`：

1. 把指名文件夹的每个 `link:` 依赖（包括缺失的文件夹或文件，如恢复或撤销写回 `link:<folder>`、插件管理器安装文件夹所写入的，以及 `delorun plugin --profile default add link:<folder>` 所写入的）像启动那样移到插件的活动目录；保护开启时，它记录一项待处理的 `plugin-install`，除非该文件夹就是已批准的那个，并且不批准任何内容；保护关闭时，它像启动那样批准并记录该文件夹的内容（[无需审查的加载](#loading-without-review)）；它不记录历史版本；
2. 使它所移动插件的活动目录保持启动将会加载的内容，并从不重写任何其他目录；
3. 像[加载已批准的内容](#loading-approved-content)的第 4 步那样检查链接和活动目录，并在某个不是 Changes 所保持的状态时（例如两次启动之间写入的活动目录），以 `LOAD_REFUSED` 拒绝重新组合。其余一切继续运行。

profile 写锁决定它是否可以写入。当 Host 自己的进程持有该锁时，Plugin Manager 正在更改 profile 并在其锁内重新加载，因此该检查不取锁就写入。当没有进程持有它时，该检查取得它，最多等待两秒（`RELOAD_LOCK_WAIT_MS`）。当另一个进程持有它时（例如 `delorun changes` 在等待重新加载的答复期间，以及 `pnpm` 运行期间），该检查不写入任何内容而只验证，因此指向文件夹的链接会使重新组合被拒绝，直到持有者完成。

`delorun plugin` 在上游的操作之后，无论其成功与否，都在它自己的进程中运行同样的检查，除非该 profile 在 Changes 下的首次启动尚未运行：保护开启时，`delorun plugin --profile default add link:<folder>` 让插件链接到其空的活动目录，并打印 `<plugin> is not loaded until you review it: delorun changes show <id>`；保护关闭时，活动目录保存文件夹的内容，该命令打印 `<plugin> loaded without review, because protection is off: delorun changes show <id>`。当上游的操作失败或该检查拒绝时，该命令以 1 退出。

保护开启且 `plugin_changes_pending` 开启时，模型对 `plugin_manager` 的那些会改变所运行内容（而不是安装和移除）的调用不会运行（[智能体与插件](#the-agent-and-plugins)）。

<a id="collecting-the-store"></a>

<a id="the-first-start-under-changes"></a>

## Changes 下的首次启动

在其日志没有 `migratedAt` 的 profile 于 Changes 下的首次启动，会按原样批准每个已链接的插件，前提是该 profile 是 home 在任何 profile 于 Changes 下的首次启动时持有的 profile：那次启动通过独占创建写入 `changes/migration.json`，即 `{"schema":"delorun.changes-migration/1","at","profiles":[…]}`，写明当时 `profiles/` 中的每个 profile。每个插件被存储，以 `approvedAtUpgrade` 记录，并作为在 `upgrade` 时决定的已应用 `plugin-install` 记入日志；一个 profile 历史版本记录这次移动。在该记录之后创建的 profile 是新的：其已链接的插件都不在升级时被批准。与首次启动之后才链接的插件一样，每个插件都是待处理的 `plugin-install` 更改，在保护开启时，它在被应用之前不加载任何内容，在保护关闭时则无需审查即加载。

每次启动都会写明在升级时被批准的插件，直到某个终端显示了它们：只有当启动的输出到达终端（`delorun start` 运行 home 进程时其输出只进入日志），或 `delorun changes list` 在终端上打印了它们时，条目才获得 `shownAt`。在此之前，`delorun status` 和 `delorun changes list` 也会写明它们。

<a id="the-protection-setting"></a>

## 保护设置

`changes/protection.json` 保存 `on` 或 `off`；没有该记录的 home 是 `off`，这是默认值，审查是本人自己打开的。终端证明或 studio 证明可以更改它：`delorun changes protection on|off`（[命令](#commands)）、setup 的 Full 模式（它只会打开保护）（[C11](c11-setup-answers.zh.md)），以及 studio 的 `protection-on` 与 `protection-off` 路由，来自电脑或来自已配对的设备（[谁可以从何处做什么](#who-may-do-what-from-where)）。关闭它会在 profile 的更改日志中记为一项已应用的 `guard-weakening` 更改，`subject.setting` 为 `protection`，摘要为 `Protection turned off: changes load without review`，`decidedFrom` 按证明为 `terminal` 或 `studio`。每个依赖该设置的决定都在决定时读取它：一次启动、重新加载之前的检查、home 进程的监视器、启动的 harness 步骤，以及 `@delorun/plugin-changes` 在每次 `plugin_manager` 调用时。该设置的更改在下一次决定时生效，无需重启。

- **保护关闭。** 更改无需审查即加载，并且仍被记录（[无需审查的加载](#loading-without-review)）。已链接插件的文件夹或 harness 可写副本的任何写入者，都会在没有人先审查的情况下更改 harness 所加载的代码：在完全访问工作区中工作的模型、下载的程序，或本人用户的任何其他进程。每个这样的更改都是日志中的一项已应用更改，`delorun changes list`、`show`、`verify` 和 `doctor` 会写明它，`undo` 会撤销它。仍受保护的是：受限工作区的命令和文件工具的写入仍然只去往沙箱允许的地方，受限命令仍然无法写入 Delorun home（`~/.delorun`），其中包括 `changes/` 和 harness 的可写副本（[C1](c01-home-layout.zh.md#security)）；沙箱允许受限工作区写入的插件文件夹（例如位于该工作区之内的文件夹）会无需审查就加载其所写入的内容。文件工具向 profile 的活动目录的写入，在两种设置下都被拒绝（[智能体与插件](#the-agent-and-plugins)）。
- **保护开启。** 已更改的插件加载其已批准的内容，直到本人应用该更改，没有已批准内容的插件不加载任何内容；harness 编辑只在被应用之后才运行；智能体的插件安装和移除要等待本人；并且智能体在 chat 中首次通过文件工具向已批准插件的文件夹写入时会询问（[智能体与插件](#the-agent-and-plugins)）。终端检查和沙箱对 home 的写入规则使受限的模型无法关闭保护或批准某项更改（[谁可以从何处做什么](#who-may-do-what-from-where)）。
- **第二次询问。** 关闭保护在终端和 studio 中都会询问两次。第二次询问指出等待中的更改会立即加载的插件，以及本人的 Delorun 副本中会在下次启动时应用的文件数量；在请求带 `confirmed: true` 重发之前，studio 的路由以 `409 CONFIRM_PROTECTION` 和 `willLoad {plugins, harnessFiles}` 应答它。第二次询问防的是误点，不是防在电脑前的人：能回答它的人就能关闭保护。
- **来自手机的更改。** 从已配对设备对该设置所做的更改（无论哪个方向）会在 `notices.json` 中添加一条通知。电脑的 `state.notices` 列出它，`delorun changes list` 把它打印在 “Changed from a phone:” 下，并在列表到达终端时清除它，`notice-seen` 在电脑上的 studio 中清除它。设备无法清除通知，因此手机无法隐藏它所做的更改。

已签名安装中被更改的文件，在两种设置下都会被运行时仓库的启动检查拒绝；从仓库启动的 home 进程在全新启动时像启动器那样检查其运行时。本人对 harness 文件的编辑，在两种设置下都只作为已应用的 harness 更改，从组合树运行（[harness 编辑](#harness-edits)）。

<a id="loading-without-review"></a>

### 无需审查的加载

保护关闭时，Delorun 只在下列各点无需审查就批准内容，并且每个写入者都在 profile 写锁之下（harness 则是 `harness.lock`）再次读取该设置，在它开启时不写入任何内容（[`unreviewed.ts`](../../packages/changes/src/unreviewed.ts)）：

- **每次启动时。** 启动前步骤存储每个已链接插件的文件夹。当其内容与已批准的内容不同时，它成为 profile 的 `delorun.changes` 记录和 `active.json` 中的已批准内容，并且日志增加一项已应用的 `plugin-edit`（对于新链接或没有已批准内容的插件则是 `plugin-install`），其 `decidedFrom: "unreviewed"`，摘要以 `Loaded without review:` 开头。更改了任何内容的启动记录一个 profile 历史版本，其主题写明这些插件，例如 `Changes: loaded without review my-plugin, other-plugin`，并对每个插件打印 `<plugin> loaded changes without review, because protection is off: delorun changes show <id>`（对于安装则是 `<plugin> loaded without review, …`）。`delorun headless` 在其启动前步骤中做同样的事。
- **重新加载之前。** 重新加载之前的检查所移动的链接（如插件管理器安装文件夹、`delorun plugin --profile default add link:<folder>` 或恢复所写入的）以同样的方式被批准并记入日志，不产生历史版本（[重新加载与恢复](#reloads-and-restores)）。
- **Delorun 运行期间。** home 进程监视 profile 链接到其活动目录的每个插件的文件夹，递归监视且不含 `.git`，并跟随 `changes/protection.json` 和 profile 的 `package.json`，因此开启或关闭保护以及链接或移除插件会改变它所监视的内容而无需重启；保护开启时它不监视任何文件夹。当某个文件夹的事件已安静 300 毫秒之后，它通过与 `changes.reload` 相同的 Host 重新加载来加载该文件夹的内容（[`unreviewed-watch.ts`](../../apps/cli/src/changes/unreviewed-watch.ts)）。成功的重新加载批准该内容，并记入一项决定为 `unreviewed` 的已应用更改，带一个 profile 历史版本。失败的重新加载会回退：已批准的记录、活动目录和 `active.json` 保持其原先持有的内容，一个历史版本 `Went back: <summary> failed to load` 记录这一点，Host 再重新加载一次，该更改为带 `lastFailure` 的 `pending`，并且在文件夹持有其他内容之前不再尝试。home 进程的日志写明每次加载和失败。不需要工作会话；处于工作会话的插件交给该会话处理，并且 `delorun headless` 不监视文件夹。
- **harness 的可写副本。** 已签名安装的启动应用副本的更改（[harness 编辑](#harness-edits)）。

本人拒绝的内容不会再次加载：当某个插件最新被决定的内容更改（`plugin-edit` 或 `plugin-install`，而不是智能体的请求）被撤销或丢弃，且带来的恰好是该文件夹所持有的内容时，该插件保留其已批准的内容，该文件夹的内容像保护开启时那样等待审查，直到该文件夹持有其他内容。失败的启动所遗漏的更改，在文件夹仍持有它所带来的内容期间一直被遗漏（[启动失败时](#when-a-start-fails)）；新的文件夹内容会加载并结束这种状态。

<a id="work-sessions"></a>

## 工作会话

工作会话在本人对一个已批准插件工作期间，实时加载该插件的文件夹，最长 480 分钟，无论保护开启还是关闭；保护关闭时，它所涵盖的插件在其持续期间不属于[无需审查的加载](#loading-without-review)。其记录是 `{"schema":"delorun.changes-work-session/1","plugin","source","from","startedAt","startedFrom":"terminal"|"studio","endsAt","lastLoaded"?,"lastFailed"?}`：`from` 是它开始时的已批准内容，`endsAt` 是在没有本人参与时它结束的时间，`lastLoaded` 是最近加载的文件夹内容，`lastFailed` 是在此之后重新加载失败的文件夹内容。每个 profile 同一时间只有一个会话；打开它是独占创建。

- **加载什么。** 插件仍然从其活动目录加载。每次加载都存储文件夹的内容，使活动目录保持它（`active.json` 种类为 `work-session`），只替换内容不同的文件，并像 `changes.reload` 那样要求运行中的 Host 重新加载。成功会记录 `lastLoaded` 并移除 `run/<profile>/changes-work.json`。
- **实时重新加载。** home 进程监视 `work-session.json`，并在会话打开期间递归监视插件的文件夹（不含 `.git`），在事件安静 300 毫秒之后加载每个更改。Delorun 自己监视该文件夹，而不设置上游的 `hmr.root`，因为 Host 从插件的活动目录加载它，所以对文件夹的源监视会监视并未被加载的文件。已经处于活动状态的文件夹内容，或等于 `lastFailed` 的内容，不会再次加载，并且 `endsAt` 过去之后不再加载任何内容。
- **打开。** `startWork` 接受会话长度，即 1 至 `WORK_SESSION_MAX_MINUTES`（480）的整数分钟，并在读取任何内容之前以 `NOT_ALLOWED` 拒绝其他任何值；它需要 profile 从其活动目录加载、带有已批准内容、且其文件夹存在的插件（否则为 `NOT_LINKED`），以 `startedAt` 之后该分钟数的 `endsAt` 打开记录（已有一个打开时为 `WORK_SESSION_OPEN`），并立即加载文件夹的内容。当 Delorun 没有为该 profile 运行时，它再次关闭会话，放回活动目录和 `active.json`，并以 `NOT_ALLOWED` 拒绝。
- **长度。** `delorun changes work <plugin> --for <minutes>` 设定它，没有 `--for` 时为 120 分钟；不是 1 至 480 的整数分钟的值是用法错误。长度是命令的选项而不是配置字段，因为 CLI 的 home 进程运行会话，而 profile 不存在 CLI 自身设置的已验证配置。
- **失败的重新加载会回退。** 活动目录再次持有 `lastLoaded`，尚未加载任何内容时持有 `from`，Host 再重新加载一次，记录注明 `lastFailed`，并写入 `run/<profile>/changes-work.json`：`{"schema":"delorun.changes-work/1","plugin","at","error"}`，这是受保护的文件，`delorun doctor` 和 studio 读取它，而没有任何东西据它决定。会话保持打开。
- **按本人的意思结束。** `reviewWork` 存储文件夹的内容，并返回它以及它与 `from` 的差异；`delorun changes done` 打印其前 7 位数字、其文件、风险摘要和有界差异（每一行都经过终端转义器），然后询问；当检查发现了问题时，写明种类再询问第二次。`finishWork` 随后恰好批准它所得到的内容：当文件夹持有任何其他内容（包括文件夹已消失）时，它以 `CHANGED_SINCE_REVIEW` 拒绝，不批准任何内容，并让会话保持打开。当活动目录尚未持有该内容且 Delorun 在运行时，它先加载，回退的加载不批准任何内容，并让会话保持打开。已消失的文件夹保留 `from`。当已批准的内容发生变化时，一个 profile 历史版本 `Work on <plugin>: <first 7 digits of from> → <first 7 digits of the new version>` 记录它，日志增加一项从 `from` 到新版本、带该摘要且创建于 `startedAt` 的已应用 `plugin-edit` 更改。`active.json` 把该内容记录为 `approved`，记录和 `changes-work.json` 被移除。
- **没有本人参与的结束。** Host 的 `close` 停止监视器并结束打开的会话；home 进程的启动发现有会话打开时（这是未停止的 home 进程所留下的），先结束它并说明这一点，而 `delorun headless` 在其 `endsAt` 之前不处理它；任何发现会话已过 `endsAt` 的启动，都在从文件夹加载任何内容之前结束它并说明这一点；监视器在 `endsAt` 结束会话并记录它因到达时限而结束。每一种都经过 `finishWorkWithoutPerson`（单独的入口 `@delorun/changes/stop`），并且不批准任何内容：已批准的内容保持为 `from`，活动目录再次持有它，`active.json` 种类为 `approved`（在 `endsAt` 时运行中的 Host 重新加载），记录和 `changes-work.json` 被移除，不记录任何日志也不记录历史版本，文件夹的内容就是针对 `from` 的普通待处理 `plugin-edit`，在保护关闭时它会在下一次启动或保存时无需审查即加载。文件夹不被读取，因此无法读取的文件夹永远不会让会话保持打开。
- **在哪里显示。** `delorun status` 打印 `work session: <plugin> since <startedAt>, ends at <endsAt>`，`delorun changes list` 打印 `Working on <plugin> since <startedAt>, until <endsAt> at the latest: edits in its folder load live.`，`workSessionFact` 为 studio 给出同样的内容。

<a id="when-a-start-fails"></a>

## 启动失败时

在某项更改之后立即失败的启动，会在没有该更改的情况下重新启动，并且 profile 的文件不会为此被重写（[`left-out.ts`](../../packages/changes/src/left-out.ts)、[`retry.ts`](../../apps/cli/src/changes/retry.ts)）。

| 步骤 | 发生什么 |
| --- | --- |
| 哪些启动 | home 进程的全新启动：从不是更新或回滚的后继，从不是第二次启动本身，也不是 `delorun headless` |
| 什么算失败 | 上游的 profile 运行器抛出异常；已启动的 Host 被拒绝（某个 Delorun bundle 的行没有激活，或组合的某个不变量不成立）；或者它可能遗漏的那项更改所属插件的某个已启用行没有激活 |
| 哪项更改 | 改变了所运行内容的最新决定（`applied`、`undone` 或 `left-out-at-start`，按 `decidedAt`，再按其在日志中的位置），前提是它应用的是本人作出的、或 Delorun 未经审查就加载的 `plugin-edit`、`plugin-install`、`plugin-update` 或 `plugin-on`（而不是在升级时的批准），所涉及的插件链接到其活动目录且其活动目录持有已批准的内容，对于内容更改，该内容是更改的 `to`，它同时也是已批准的版本。否则启动像以前一样失败，因此一连串失败最多遗漏一项更改 |
| 遗漏它 | `leaveOutNewestChange` 只在 profile 写锁之下写更改日志：条目变为 `left-out-at-start`，带有 `decidedAt`、`decidedFrom: "start"` 和 `leftOut {at, failure}`，其中 `failure` 是不带堆栈的错误消息，最多 2 KiB 的 UTF-8。它不需要在场证明；只有 `apps/cli/src/changes/retry.ts` 和包之外的 `leaveOutNewestHarnessChange` 指名它 |
| 第二次启动 | 带有 `DELORUN_CHANGES_RETRY=1` 的新 `delorun start --foreground` 进程：在终端中，第一个进程打印文字并以同一终端运行它，传递 `SIGTERM` 和 `SIGHUP`，并以其退出码退出；后台的 `delorun start` 把它的子进程标记为 `DELORUN_CHANGES_STARTER=detached`，该子进程改为以退出码 4 退出，并再启动一次。两个标记都从 home 进程的环境中移除。第二次启动从不遗漏任何更改 |
| 之后每次启动加载什么 | 其启动前步骤 `changes` 使插件的活动目录持有该更改的 `from`（`active.json` 种类为 `left-out`），对于安装或被开启的插件则什么都没有（没有 `version`），直到本人再次应用该更改或撤销它，或已批准的版本不再是该更改的 `to`；保护关闭时，仅当插件的文件夹仍持有该更改的 `to` 或已消失，或该更改开启了插件期间，因此新的文件夹内容会无需审查即加载并结束这种状态。插件上的工作会话像以前一样加载其文件夹 |
| 本人读到什么 | 「Delorun did not start with your latest change to `<plugin>` (`<id>`): `<failure>`.」/「It starts without it now; your files are unchanged.」/「To try it again: delorun changes apply `<id>`. To undo it: delorun changes undo `<id>`.」，失败原因为一行并在 200 个字符处截断，出现在失败的启动处以及之后的每次启动；第二次失败则打印「Delorun did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start.」 |
| 再次应用它 | `apply <id>` 使活动目录再次持有已批准的内容（即该更改的 `to`），条目变为 `applied`；失败的重新加载使它带着 `lastFailure` 继续被遗漏 |
| 撤销它 | `undo <id>` 把它当作已应用的更改撤销：已批准的版本回到 `from`，对于安装则为无；`plugin-on` 会关闭该插件 |

保护开启时，不变量只在被遗漏且仍处于被遗漏状态的插件更改持有某个版本时，才接受持有该版本的 `left-out` 内容；不持有任何内容的 `left-out` 内容不加载任何东西，并且总是被接受。`delorun changes list` 在各自的分组中写明每项仍被遗漏的更改，`delorun doctor` 写明该插件、该更改和失败，并附上两条命令，`leftOutFacts` 为 studio 给出同样的内容。

<a id="the-risk-summary"></a>

## 风险摘要

九项内置检查读取一项更改及其 `package.json` 两侧的新增和已更改的行：注册或替换同意、防护或沙箱策略；添加一个回答批准提示的监听器（`answers-approvals`）；自己安装、移除或加载插件（`manages-plugins`）；添加模型可以调用的工具；运行命令；打开网络连接；读取 Delorun home 之下的内容；添加或更改依赖或构建或安装脚本；含有差异不显示的内容（`not-shown`）。`not-shown` 写明差异省略了其行的每个新增或已更改的文件：名称以 Node 会加载的扩展名结尾的二进制文件（`.js`、`.jsx`、`.mjs`、`.cjs`、`.ts`、`.tsx`、`.mts`、`.cts`、`.json`、`.node`、`.wasm`）、大于 1 MiB 的文本文件、差异已达到 256 KiB 之后的文本文件，以及对每个包一次，文件夹内 `node_modules` 目录之下的文件。任何发现都会在应用之前要求第二次确认，并且第二个问题列出每个 `not-shown` 文件。该摘要是启发式的，是对读者的帮助而不是保护：插件代码拥有 harness 的全部权限。`reviewChange(input, checks)` 是后续扩展点用已注册的检查来扩展的那个函数。

<a id="the-agent-and-plugins"></a>

## 智能体与插件

Delorun 的组合中有两种行为，决定智能体可以对 harness 所运行的插件做什么。每一种都位于它自己的 [C16](c16-parity-composition.zh.md) 开关之后，在本人运行的组合中开启，在对等组合中关闭，在后者中智能体的写入和 `plugin_manager` 调用像上游那样运行。每一种都在每次调用时读取保护设置，并且只在保护开启时才阻止或询问。

- **保护开启时，向已批准插件的文件夹写入，每个 chat 询问一次**（开关 `approved_plugin_write_consent`，`@delorun/plugin-instruction-consent` 的 `approvedPluginWrites`）。保护开启时，在智能体于某个 chat 中首次向 profile 已批准的插件的 `source` 文件夹写入之前，会询问本人：「The agent is changing what your harness runs: <plugin>. The change will wait for your review in Changes.」，并附上该工具携带的差异。保护设置和文件夹在每次写入时从 Host 所运行的 home 和 profile 读取。写入按文件后端所写入的路径（目标的 `targetKey`）比较，上游的本地后端把它设为真实路径（文件自己的真实路径，对于尚不存在的文件则是其最深的现有祖先的真实路径再附上其余部分）；文件夹的真实路径以同样的方式计算。当该路径或其词法路径位于该文件夹或其下时，目标就算在文件夹内；当用另一种大小写探测文件夹自己的路径而在其卷上找到同一个目录时，忽略大小写；或者当目标的某个现有祖先就是该文件夹的目录（同一设备和 inode）时，同样如此，因此符号链接、链接之后的 `..` 以及进入该文件夹的大小写变体也会询问。通过悬空链接的写入不询问：后端以链接自己的路径作为其键，并因其不是普通文件而拒绝它。本人允许之后，同一 chat 中后续对该插件文件夹的写入直接通过，直到 Host 重启；另一个 chat 会再次询问。被拒绝、被取消或无法回答的询问使文件保持不变，并且模型读到带类型的拒绝 `FS_CONSENT_DENIED`，例如 `the user refused the write to "<path>", which changes the plugin <plugin>; it stays unchanged, so stop and explain instead of working around it`。无法读取的保护记录或 profile 记录会使写入被拒绝。文件工具向 profile 活动目录（`changes/profiles/<profile>/active/`）的写入，在两种设置下无论是否是已批准的插件都不询问就被拒绝，因为只有 Changes 才在那里写入，而这样的写入永远不会成为本人的插件；模型读到 `FS_CONSENT_DENIED`，附带 `the write to "<path>" was not run: it is inside the directory Changes loads the harness's plugins from, which only Changes writes, …; change the plugin's own folder instead`。本人允许的写入像任何人的写入一样是待处理的更改，只在本人应用它们时加载，或在工作会话期间实时加载。保护关闭时，向插件文件夹的写入不询问，智能体在那里写入的内容像任何文件夹内容一样无需审查即加载（[无需审查的加载](#loading-without-review)）。
- **shell 写入不询问。** 只审查文件工具的写入。沙箱允许其写入插件文件夹的 shell 命令或 PTC 脚本，不经询问就更改它；保护开启时，该更改是待处理的更改，在本人应用它之前不加载，保护关闭时，它在下一次启动时、或 Delorun 运行期间在文件夹稳定时无需审查即加载，而在该插件的工作会话期间它实时加载，因为本人打开了工作会话。
- **保护开启时，智能体对插件的安装、更新和移除要等待本人**（开关 `plugin_changes_pending`，`@delorun/plugin-changes`）。保护开启时，动作为 `install_bundle` 或 `remove_bundle` 的 `plugin_manager` 调用不会运行，并且从不到达该工具的完全访问批准：它作为待处理的 `plugin-install`、`plugin-update`（对 profile 已有的插件的注册表版本的安装；该工具没有更新动作）或 `plugin-remove` 记入更改日志，带有 `subject.spec`，以及在规格指名它时的 `subject.plugin`，并且模型读到 `Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.`（对于更新是 `Nothing was installed or updated.`，对于移除是 `Nothing was removed.`），错误码为 `PLUGIN_CHANGE_PENDING`。没有指名目标的调用、pnpm 不会接受的规格、移除不是依赖的名称，或无法写入的日志，以 `PLUGIN_CHANGE_UNRECORDED` 被拒绝，且不记录任何内容。重复仍在等待的请求会返回其 id；重复已被决定的请求则是新的更改。动作为 `set_bundle`、`set_plugin`、`configure`、`set_version_exemption`、`undo` 或 `restore` 的调用同样不会运行，也不记录任何内容：模型读到本人在自己的电脑上、在 studio 中或使用 `delorun plugin` 进行该更改，错误码为 `PLUGIN_CHANGE_AT_COMPUTER`。保护关闭时，每个这样的调用像上游那样运行，只由该工具自己的完全访问批准来决定，但 chat 在任何保护级别下都从不启动未在运行的插件：安装会被记录，而开启（`enabled` 为布尔值 `false` 以外的任何值）、`undo` 和 `restore`（它们可能带回一个插件）则以 `PLUGIN_CHANGE_AT_COMPUTER` 被拒绝：来自文件夹的安装在它引起的重新组合时纳入 Changes，重新加载之前的检查把该插件链接到其活动目录，并把文件夹的内容记为决定为 `unreviewed` 的已应用更改，而注册表安装或移除只记录在上游所写的 profile 历史中。无法读取的保护记录会拒绝每个这样的调用，并写明无法读取该设置。工具防护会拒绝该插件的监听器没有处理的任何这样的调用，因此不调用 `next()` 就允许该调用的 `tools/pre-execute` 监听器无法使其运行；保护关闭时监听器放行的调用算作已处理。CLI profile 通过 `@delorun/bundle-local` 的 `delorun-plugin-changes` 行挂载该插件，`delorun headless` 通过 `@delorun/bundle-headless` 的同 id 的行挂载，两者都受到保护而不被 `plugin_manager` 工具更改；headless profile 不提供 studio，因此那里不注册 Changes 路由，并且它对智能体首次向已批准插件文件夹写入的批准会被拒绝，因为没有人回答它。 With protection off, every such call runs as upstream runs it and is recorded in Changes once it ran ([The agent's plugin actions with protection off](#the-agents-plugin-actions-with-protection-off)).

应用这样的更改（在终端，或在电脑上的 studio 中经第二次确认之后，[路由与恢复屏幕](#routes-and-the-recovery-screen)）会在 profile 写锁之下运行上游的 profile 插件操作 `runProfilePnpm`，如插件管理器的 `installBundle` 运行它那样，并带有 `installBundle` 运行的检查：对安装或更新是 `add <spec>`，对移除是 `remove <name>`，它同时也移除该插件的批准。指名文件夹、路径、`file:<path>`、`link:<path>`、`<name>@file:<path>` 或 `<name>@link:<path>` 的规格，从不链接到该文件夹：插件被链接到其活动目录，该目录什么都不持有，文件夹的内容被记录为来自该文件夹的待处理 `plugin-install`，像任何其他更改那样被应用，因此保护开启时，智能体所请求的内容在本人审查其内容之前都不会加载，保护关闭时它按[无需审查的加载](#loading-without-review)所述无需审查即加载；`<name>` 必须是该文件夹所持有的包。范围既不是注册表版本、范围或 dist-tag、也不是这样的文件夹的 `<name>@<range>` 规格（例如 `workspace:`、`npm:`、git 或 URL 来源或路径），在智能体请求时以及在被应用时都以 `INVALID_REQUEST` 被拒绝，因为 pnpm 会从该来源安装它，而上游的解析器把它读作注册表安装。

| `installBundle` 的步骤 | 应用智能体的请求 |
| --- | --- |
| pnpm 在没有终端且环境被清理的情况下运行（`execution: 'service'`），没有允许构建脚本的选项 | 相同：`execution: 'service'` 且没有构建选项，因此只有 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 条目决定运行哪些脚本，并且 pnpm 无法询问 |
| 只有当本人传入待处理的名称时才批准构建（`approvedBuilds`） | 没有任何东西批准构建；本人通过编辑 `allowBuilds` 来决定 |
| 失败的运行把 pnpm 报告为被阻止的构建脚本记录为 `set this to true or false`（`recordPendingBuilds`）并返回它们 | 同一个函数记录它们，并且该更改的 `lastFailure` 写明每一个以及在哪里决定它 |
| 失败的运行放回 `package.json` 和 `pnpm-lock.yaml`；已下载的文件保留 | 任何失败或被拒绝的操作之后，同样的文件被放回 |
| `runProfilePnpm` 在 pnpm 运行之前或之后拒绝与此 Delorun 或 DSH 不兼容的版本 | 同一个函数，并且失败写明该版本；对于文件夹规格（其链接尚未持有任何内容），文件夹的 `package.json` 在 pnpm 运行之前用上游的 `evaluatePluginCompatibility` 和 profile 的豁免检查 |
| 更改多于一个依赖的安装（`ambiguous-install`），或没有 `dsh.bundle.patch` 的包（`not-bundle`），被拒绝 | 相同的拒绝，之后文件被放回；文件夹规格的包必须声明 `dsh.bundle.patch` |
| 当 profile 挂载可选的 `pluginAudit` 服务时，它审计该 bundle | 不咨询：没有任何 Delorun 组合挂载它（[C13](c13-catalogue-revocation.zh.md)） |
| 按方案顺序询问的注册表（`registryPlan`）、GitHub 连接检查和 Git 传输选择 | 只有 pnpm 自己配置的注册表和传输；这些步骤决定从哪里获取包，而不是它是否运行 |

在终端，pnpm 的输出进入命令的流；在 studio 中，Host 用 profile 启动器的 pnpm 从自己的目录运行该操作，其输出进入 Host 的日志。失败或被拒绝的操作使更改保持待处理并带有 `lastFailure`；成功的操作记录一个历史版本 `Applied: …` 并重新加载运行中的 Host，重新加载失败时更改保持已应用，留给下一次启动。

模型只读到上面的工具结果，每个结果像任何其他结果一样作为工具调用的结果记入日志，因此这两种行为都不增加会话事件；询问则记为上游的 `approval/asked` 和 `approval/decided`。

<a id="the-agents-plugin-actions-with-protection-off"></a>

## 保护关闭时智能体的插件操作

保护关闭且 `plugin_changes_pending` 开启时，智能体的 `plugin_manager` 表现得和 stock DeepSeek Harness 在该工具唯一一次完全访问批准给出之后一样：`install_bundle`、`remove_bundle`、`set_bundle` 与 `set_plugin`（包括开启插件）、`configure`、`set_version_exemption`、`undo` 与 `restore` 都会运行。Delorun 额外的拒绝不在了，但批准并没有消失：没有任何东西跳过或预先回答它，本人不批准的调用不运行任何东西，也不记录任何东西。保护开启时，这里的一切都不适用：安装和移除被记录为待处理的更改，其他每个操作都留给本人（[智能体与插件](#the-agent-and-plugins)）。

该设置在每次调用时从 `changes/protection.json` 读取。无法读取的记录会像保护开启那样拦住该调用，并写明无法读取该设置；无法读取的设置绝不会被读作 `off`。没有该记录的 home 是 `off`，如[保护设置](#the-protection-setting)所述。

每个改动了 profile 的操作都记录在该 profile 的智能体操作日志 `changes/profiles/<profile>/agent-log.json` 中，作为决定为 `unreviewed` 的已应用更改（[`agent-actions.ts`](../../packages/changes/src/agent-actions.ts)）。该日志是带有自己 schema 标签 `delorun.changes-agent-log/1` 的独立文件，并校验每一条记录：未知的标签、种类或字段都是 `RECORD_UNREADABLE`。`log.json` 不新增种类，也不新增字段，因此本节之前的发布能读取它的日志并启动该 profile；这样的发布从不读取 `agent-log.json`。启动 profile 只读取 `log.json`：无法读取的智能体操作日志会使 `delorun changes list`、`show` 与 `undo` 停止，studio 的状态把它显示为问题，启动失败不会留下任何东西，但没有任何启动会因此停止。`list`、`show`、studio 的最近更改，以及未经审查就加载的更改计数，都会读取这两个文件。

记录围绕该工具分两步进行，因此没有任何操作会在未记录的情况下运行：

1. 在工具运行之前，监听器读取该 profile 最新的历史版本，以及插件管理所写文件的摘要，判定该更改的种类，并写入条目，其摘要以 `Delorun did not see how it ended, so check what it changed with delorun changes list and delorun recover` 结尾。记录无法读取或写入的调用以 `PLUGIN_CHANGE_UNRECORDED` 被拒绝，且不运行任何东西。因此，该操作所安装、链接或开启的插件，以及在加载时停止的 Host，都会发现条目已经在那里。
2. 在工具运行之后，post-execute 监听器补全该条目，它注册在其他监听器之前。它读取自第 1 步以来写入的历史版本。一个 `Changed-by` 为 `agent` 的版本就是该条目的 `historyVersion`；紧在它之前的版本是 `historyBefore`，当本人亲手做过编辑时，那就是本人自己的编辑，因为上游把在插件管理之外所做的编辑保存为它自己的版本，所以撤销该操作会保留那次编辑。当中间夹着另一个作者的版本时，该条目没有 `historyBefore`。没有智能体版本且文件未变：该操作什么也没有改动，条目被移除。没有智能体版本而文件已变（历史无法保存版本）：条目保留下来但没有版本，模型读到 `PLUGIN_CHANGE_UNRECORDED`，并说明它是在没有撤销的情况下被记录的。有多个智能体版本时（例如两个对话同时操作）：条目保留下来但没有版本，因为无法分辨哪个是哪个。因排在前面的监听器拦住了结果、或结果从未到达 post-execute 而停留在第 1 步的条目，会说明 Delorun 没有看到它如何结束，并且没有撤销；本人用 `delorun recover` 检查该 profile。历史不会被重建为条目：上游在插件加载之后才保存版本，因此一次停止 Host 的加载不会留下版本。

条目的种类：

- 安装、更新或移除是 `plugin-install`、`plugin-update` 或 `plugin-remove`，带有 `subject.spec`，以及在规格指名它时的 `subject.plugin`，摘要以 `The agent ran:` 开头；
- 其他每个操作，以及规格无法由 Changes 归类的安装或移除，都是 `plugin-setting-change`，`subject.setting` 为该操作的名称，当目标是包名时 `subject.plugin` 为该包名，摘要形如 `The agent turned on <target>`；不是包名、插件 id 或版本 id 的目标会在一行内加引号并截到 60 个字符；
- 重复的操作是一个新条目。

从文件夹安装（`link:<folder>`、`file:<folder>`）还会在它引起的重新组合时出现在 Changes 之下，重新加载之前的检查把该插件链接到其活动目录，并把文件夹的内容记录为决定为 `unreviewed` 的已应用 `plugin-install`（[未经审查就加载](#loading-without-review)）；随后该插件在其文件夹稳定时重新加载，就像本人链接的插件那样。两个条目都会被列出。

撤销某个条目（`delorun changes undo <id>` 或 studio）会把插件管理所写的文件（`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 以及两个豁免文件）恢复为该条目之前的版本所持有的内容，使用 `delorun recover` 所用的历史恢复，别的什么也不动：home patch 与该 profile 对它的副本、Delorun 的安全记录和更新报告都保留它们现在持有的内容，安全记录保持禁用的插件仍然禁用。随后它像上游的恢复那样安装那套依赖（`pnpm install --ignore-scripts`，然后 `pnpm rebuild --pending`），经由“应用智能体的请求”的插件操作、在 profile 写锁之下进行，记录一个历史版本，重新加载运行中的 Host，并把该条目标记为 `undone`。不运行任何审计步骤，因为没有任何 Delorun 组合挂载 `pluginAudit`。当插件管理所写的文件已不再是该操作留下的样子时（先撤销较晚的更改，或用 `delorun recover` 恢复某个版本），对于没有 `historyBefore` 的条目，以及对于不是 `applied` 的条目，撤销以 `NOT_ALLOWED` 被拒绝；失败的安装或重新加载会把 profile 放回该操作留下的样子，条目保持已应用并带有 `lastFailure`。启动失败绝不会把智能体操作排除在外：当决定运行什么的最新更改就是这样一个操作时，启动不排除任何东西，而本人批准过的较早更改也不会被排除在外作为替代（[启动失败时](#when-a-start-fails)）。

保护关闭时，已经拥有完全访问或在危险模式下运行的对话会安装、开启并启动插件，而不再有任何提示，因为上游的工具对这样的对话不请求批准。这是 stock DeepSeek Harness 的行为：条目会被记录并且可以撤销，但没有任何东西事先询问。保护开启时，这里的一切都不适用。

<a id="who-may-do-what-from-where"></a>

## 谁可以从何处做什么

| 操作 | 允许从何处 |
| --- | --- |
| 打开保护 | 在终端运行 `delorun changes protection on`；setup 的 Full 模式（它只会打开保护），通过同样的终端证明；电脑上的 studio；以及无需确认的已配对设备（类别 `free`） |
| 关闭保护 | 在终端运行 `delorun changes protection off`；电脑上的 studio；以及持有一次一个操作的授权凭证（grant）的已配对设备（类别 `face`）；studio 会再询问一次（[保护设置](#the-protection-setting)） |
| 撤销或丢弃某个插件的更改；丢弃对 Delorun 本身的更改 | 在终端运行 `delorun changes`；电脑上的 studio；以及持有一次一个操作的授权凭证的已配对设备（类别 `face`） |
| 应用某个插件的更改；关闭或开启某个插件；打开或关闭工作会话；创建插件、把它的安装请求排入队列、在电脑上显示它的文件夹；导出、检视或应用某个 setup；启动安全模式；重启 | 在终端运行带有该命令的 `delorun changes`，或电脑上的 studio（[路由与恢复屏幕](#routes-and-the-recovery-screen)）；持有一次一个操作的授权凭证的已配对设备（类别 `face`）。`delorun recover safe-mode` 与电脑上的恢复屏幕同样会启动安全模式 |
| 创建 harness 的可写副本；应用或撤销对 Delorun 本身的更改 | 在终端从已安装的发布运行 `delorun changes`，或电脑上 studio 的 harness 路由；持有一次一个操作的授权凭证的已配对设备（类别 `face`）。没有模型工具能决定其中任何一项 |
| 丢弃对 Delorun 本身的每项更改 | 仅在终端运行 `delorun changes edit-harness --discard` |
| 清除设备所做更改的通知 | 电脑上的 studio，以及在终端运行 `delorun changes list`；从不是设备 |
| 读取更改 | 本人自己的命令，以及 studio 准入的任何会话，包括远程会话 |
| 遗漏某项更改 | 引导失败的全新启动（[启动失败时](#when-a-start-fails)），不需要在场证明；它只写更改日志 |
| 在没有人参与的情况下结束工作会话 | Delorun 停止、崩溃之后的启动以及会话的结束时间会关闭它，不批准任何内容 |
| 无需审查就加载内容 | 仅在保护关闭时：启动的启动前步骤和重新加载之前针对插件文件夹的检查、Delorun 运行期间针对保存操作的 home 进程监视器，以及针对 harness 可写副本的已签名安装的启动（[无需审查的加载](#loading-without-review)），每一种都不需要在场证明 |

已配对的设备是 reach 调度器准入的远程会话，其设备在 home 的列表中。它按控件的类别行事：[`access.ts`](../../packages/plugin-changes/src/access.ts) 中的 `CONTROL_LEVELS` 给每个控件指定 [`AUTH_CLASSES`](c14-oidc-passkeys.zh.md#face-id-unlock) 中的一个类别，`free`（任何已批准的设备，无提示）、`face`（恰为这一次调用的一次确认：Face ID 授权凭证，或设备的 PIN 作为一次一个操作的授权凭证，或有效的 Face ID 通行期）或 `computer`。没有授权凭证的 `face` 控件，答复 `403 ELEVATION_REQUIRED`；`computer` 控件答复 `403 LOOPBACK_REQUIRED`。批准宽限期（设备被批准之后的那几分钟）从不算数，持有通行密钥的设备只由授权凭证或 Face ID 通行期准入。

在场证明只由 `attestTerminal`（标准输入和输出是终端）、`attestStudio`（电脑上的 studio 请求）和 `attestDevice`（来自持有针对该请求的授权凭证的已配对设备的 studio 请求，它同时写明该设备）签发，写入方拒绝任何不是它们签发的值。只有 studio 的 Changes 路由调用 `attestStudio` 和 `attestDevice`。因此关闭保护取决于三种证明之一：终端的；studio 的，即回环监听器、studio 的凭据和同源请求；或已配对设备的，带有针对恰为该请求的授权凭证。更改日志把电脑与设备的证明同样记为 `decidedFrom: "studio"`，设备的决定在 `decidedOn` 中写明该设备。

终端检查无法区分人和模型：模型的终端工具会给它的命令一个真实的伪终端。两条规则共同使受限工作区中的模型无法关闭保护或批准某项更改：终端检查，以及沙箱对 home 的写入规则，在该规则之下，受限命令不能在 Delorun home 之下（包括 `changes/`）写入任何内容，并且包含该 home 的工作区会被拒绝（[C1](c01-home-layout.zh.md#security)）。具有完全访问权限的工作区以本人自己的权限运行命令：在那里工作的模型可以像本人一样关闭保护并批准更改，并且保护关闭时，它对已链接插件文件夹的写入无需审查即加载。因此基本要求 [F16](../security/fundamentals.zh.md) 保持为设计目标：按其措辞它也涵盖完全访问工作区，而此处没有任何东西阻止它们，并且它在保护开启时适用。

<a id="routes-and-the-recovery-screen"></a>

## 路由与恢复屏幕

一旦 web 服务器和 Connection 存在，`@delorun/plugin-changes` 就向 web 服务器注册 studio 的 Changes 路由（无论其开关如何设置），并通过索引全局 `dshRecoveryRoutes` 向引导页写明它们的前缀。

| 路由 | 谁 | 它做什么 |
| --- | --- | --- |
| `GET /delorun/changes/state` | studio 准入的任何会话，包括远程会话 | 只来自记录，不写入任何内容，也不读取任何插件的文件夹：`access`（请求者的 `actor`，以及对每个控件给出 `ok` 或它 `needs` 什么的 `may`）、`harnessAvailable`、`unreviewedSinceOff`（自保护上次被关闭以来未经审查就加载的更改）、`notices`（仅电脑）、上一次启动失败的内容（`changes-boot.json`）、在某次启动时被遗漏的更改，以及每次启动记录的失败（`leftOut`）、Changes 之下的插件及其文件夹（`folders`，插件的任何内容尚未被批准时为 `plugin-install`）、agent 等待审查的请求、最新的 20 项已决定的更改及各自能否撤销、来自 harness 日志的最新 20 项已决定的对 Delorun 本身的更改（`harness`：id、状态、文件、运行时、摘要、时间和被遗漏时的失败）、保护设置、安全模式、工作会话、是否需要、正在进行或已失败的重启（`restart`，[实时更改与重启](#live-changes-and-restart)）、每条无法读取的记录一句话，以及 `atComputer` |
| `GET /delorun/changes/show?id=<id>`、`?work=<plugin>`、`?pending` | 相同 | 一项更改：其插件、文件夹、文件、风险摘要和有界差异，或其日志条目；对于没有任何插件更改拥有而 harness 日志拥有的 id，则是带有文件、风险摘要和其两个版本的有界差异的条目，当回收移除了已丢弃或已撤销更改的内容时则不带这些；打开的工作会话的文件夹版本与其开始时的内容相比；或者插件文件夹中等待审查的每项更改及其文件数量、风险种类和最近一次失败，以及在 `harness` 之下，本人的 Delorun 副本中等待的每项更改及其完整的 `to` 版本。每个都读取它所指名的文件夹并存储其内容，如 `delorun changes list` 所做的那样 |
| `POST /delorun/changes/apply`、`discard`、`undo` | 电脑；按[级别表](#who-may-do-what-from-where)的已配对设备 | `{ "id", "confirmedRisk"? }`：与 `delorun changes` 相同；`apply` 在 `confirmedRisk` 为 `true` 之前回答 `409 CONFIRM_RISK`，附带种类和差异不显示的每个文件，对于智能体的插件请求，在 `confirmedRisk` 为 `true` 之前回答 `409 CONFIRM_RISK`，写明其规格（Delorun 在 pnpm 解析它之前不显示其内容），然后按[智能体与插件](#the-agent-and-plugins)所述应用它，并回答条目、运行中的 Host 如何重新加载，以及对于指名文件夹的规格，持有文件夹内容的那项更改；每个路由都在任何操作运行之前，对 harness 日志拥有的 id 以 `409 HARNESS_ROUTE` 拒绝，因为对 Delorun 本身的更改在 harness 路由上决定 |
| `POST /delorun/changes/off`、`on` | 相同 | `{ "plugin" }`：关闭或开启该插件 |
| `POST /delorun/changes/work`、`done` | 相同 | `work` 接受 `{ "plugin", "minutes"? }`，默认 120 分钟；`done` 接受 `{ "plugin", "version", "confirmedRisk"? }`，即 `show?work=` 所显示的版本，对其他版本以 `409 CHANGED_SINCE_REVIEW` 拒绝，并像 `apply` 那样请求第二次确认 |
| `POST /delorun/changes/safe-mode` | 相同 | `{}`：profile safety 的安全模式，带有该插件的行的 `installationBundles`，即 Delorun 的 profile bundle 列表；没有它时，`503 SAFE_MODE_UNAVAILABLE` 写明 `delorun recover safe-mode` |
| `POST /delorun/changes/exit-safe-mode` | 相同 | `{}`：通过移除安全模式的记录来结束它，使下一次启动加载整个 profile；答复 `delorun recover exit-safe-mode` 打印的各行 |
| `POST /delorun/changes/harness-apply`、`harness-undo`、`harness-discard`、`harness-copy` | 相同 | 对 Delorun 本身的更改，依据正在运行的运行时的签名文件列表。`harness-apply` 接收 `{ "id", "to", "confirmedRisk"? }`，其中 `to` 是 `show?pending` 为该更改列出的完整 64 位十六进制内容版本，对其他版本回答 `409 CHANGED_SINCE_REVIEW`；它像 `apply` 那样请求第二次确认。`harness-undo` 和 `harness-discard` 接收 `{ "id" }`，`harness-copy` 接收 `{}` 并制作本人的运行时 `app/` 目录的可写副本。没有正在运行的运行时的 harness 的 Host 上，每个都回答 `409 HARNESS_UNAVAILABLE`；已应用或已撤销的更改的回答写明它是实时生效还是重启之后生效 |
| `POST /delorun/changes/restart`、`restart-cancel` | 与 `harness-apply` 相同 | `restart` 接收 `{ "stopChats"? }`，默认为 false，并在 Host 停止之前回答 `{ "kind": "restarting", "runningChats" }`；`restart-cancel` 接收 `{}` 并回答 `{ "cancelled" }`。重启运行期间每个都回答 `409 RESTART_IN_PROGRESS`，更新或回滚运行期间回答 `409 UPDATE_IN_PROGRESS`，在没有已安装发布的 home 进程运行的 Host 上回答 `409 RESTART_UNAVAILABLE`（[实时更改与重启](#live-changes-and-restart)） |
| `POST /delorun/changes/protection-on`、`protection-off` | 相同 | `protection-on` 接收 `{}`，并回答保护关闭期间未经审查而加载的更改。`protection-off` 接收 `{ "confirmed"? }`，在 `confirmed` 为 `true` 之前回答 `409 CONFIRM_PROTECTION` 和 `willLoad {plugins, harnessFiles}`，这是挡住误点、而不是挡住电脑前的人的第二次询问（[保护设置](#the-protection-setting)）。来自已配对设备的更改还会写入一条通知 |
| `POST /delorun/changes/notice-seen` | 只限电脑 | `{ "id" }`：清除设备所做保护更改的通知；设备以 `403 LOOPBACK_REQUIRED` 被拒绝 |
| `POST /delorun/changes/create`、`request`、`reveal` | 与 `apply` 相同 | 在工作区的 `plugins/` 文件夹中制作的插件、作为等待审查的更改排队的其安装请求，以及在电脑的文件管理器中显示的其文件夹；没有一个开启插件或批准内容 |
| `POST /delorun/changes/setup-export`、`setup-inspect`、`setup-apply` | 相同 | setup 的迁移方式见 [C8](c08-archive-and-trash.zh.md#the-setup-archive)。`setup-export` 接收 `{ "list": true }` 并返回本人添加的插件，或接收选择 `{ "settings"?, "localCode"?, "plugins"?, "note"? }` 并以 base64 返回已签名的文件（至多 32 MiB，否则 `413 SETUP_TOO_LARGE`），并给出放进了什么、略去了什么；被携带的设置含凭据时返回 `422 SETUP_REFUSED`。`setup-inspect` 接收 `{ "file" }`（base64）或已保存文件的 `{ "token" }`，并带导入选择 `"settings"`（默认 true）、`"removeOthers"`（默认 false）与 `"endpointsConfirmed"`（默认 false）；它运行 `delorun setup import` 的全部检查，不写入任何内容，返回签名者（未签名或由未知密钥签名的文件为 `unverified` 并带密钥指纹）、每个将添加、移动或移除的插件、每个将设置或恢复默认的设置、端点、未应用的内容、要添加的密钥与保护设置，并带提供方默认值之外的端点（`endpointNotices`）和一个令牌；未通过某项检查的文件返回 `422` 及归档的错误码。令牌保留那份被检查的文件十分钟，并绑定到规划时所用的选择：用该令牌和其他选择再次检查会重新规划并返回新令牌，旧令牌为 `410 SETUP_EXPIRED`。`setup-apply` 接收 `{ "token", "settings"?, "removeOthers"?, "endpointsConfirmed"? }`，先保存版本“Before importing a setup”，再通过 `applyInstallChange` 的插件请求只应用一次，返回该版本、被移除与已安装的内容（在另一台电脑上编写的插件附带保存其代码以待审阅的变更），以及设置是否已写入；其他令牌或已用过的令牌为 `410 SETUP_EXPIRED`，与令牌不同的选择为 `409 SETUP_CHOICES_CHANGED`，它会保留已保存的文件；含未确认端点的导入在任何更改之前以 `SETUP_REFUSED` 被拒绝。setup 的应答携带代码和字段（略去了什么及原因、替换了什么、设置或更改了哪些设置、要添加的密钥、端点），而不是句子，因此界面用本人的语言来表述它们。 |

每个请求首先由 Connection、Host/Origin 屏障，然后由 studio 的签名 cookie 或 `authenticator` 提供方准入：没有凭据的请求回答 `401 NOT_SIGNED_IN` 或 `403 FORBIDDEN`，其他什么都不运行。随后 `POST` 在读取请求体之前按以下顺序决定：

1. **站点。** 在电脑上，`Sec-Fetch-Site` 指名另一个站点、或 `Origin` 不是该请求自己回环 origin 的请求，回答 `403 CROSS_SITE`。来自已配对设备时，外来的 `Sec-Fetch-Site`，或缺少 `Origin`、或 `Origin` 不是远程访问监听器所检查的 studio 地址 `https://<Host>`，同样回答 `403 CROSS_SITE`。
2. **控件的级别**（[谁可以从何处做什么](#who-may-do-what-from-where)）。既不在电脑上也不来自已配对设备的请求，以及其控件需要电脑的设备，答复 `403 LOOPBACK_REQUIRED` 和「This needs you at your computer.」。对 `face` 控件没有授权凭证的设备，无论是已锁定还是仅处于批准宽限期，答复 `403 ELEVATION_REQUIRED`。
3. **证明。** 电脑用 `attestStudio` 作证，设备用 `attestDevice` 作证。两者都记录为 `decidedFrom: "studio"`；设备的决定还把设备的 id 和名称记录为 `decidedOn`，`state` 把它显示为条目的 `decidedOn` 名称。

当请求到达时 `Host` 指名回环 authority、携带了凭据、并且 Connection 的 `isReachPeer` 没有指名其会话时，该请求就在电脑上。这依赖两项检查：每个远程访问监听器都拒绝不是它自己地址的 `Host`，该地址从不是回环地址，并且 `isReachPeer` 指名了远程访问分发器准入的每个会话。这些路由还读取 `@delorun/home` 的监听器戳记 `REQUEST_LISTENER`（`home-auth` 的 authenticator 在远程访问监听器所准入的每个请求上设置它），并拒绝带有另一个监听器戳记的请求。没有 `isReachPeer` 的 Connection 不注册任何路由。已配对设备是远程访问分发器为 home 列出的设备所准入的会话。目前还不存在会话因子，之后对远程访问的更改会用会话因子取代电脑检查。请求体随后是一个最多 16 KiB、只含上述字段的 JSON 对象，路由为该请求作证。设备所执行的操作成功之后，它的解锁会被续期。更改 Host 所运行内容的操作，用 `reloadProfile` 和 Host 的热重载在 Host 自己的进程中重新加载它。回答是带 `cache-control: no-store` 的 JSON，只含面向本人的字段：不含 home 之下的路径，也不含内容版本（`done` 批准的那个以及 `show?pending` 中对 Delorun 本身的更改的 `to` 除外）；文件名、差异和失败是 JSON 字符串。其文字写明 Delorun home 的拒绝回答其代码，附带「Its details name files Delorun keeps; the Host log has them.」，`state` 中因这种原因而无法读取的部分用该句子写明这一部分，Host 日志保留原文；已记录的失败文本（加载、启动或重新加载失败）把 home 写作 `<Delorun home>`。Changes 的拒绝保留其代码，`UNKNOWN_CHANGE` 为 404，`NOT_AT_COMPUTER` 为 403，无法读取的记录为 500，其他为 409。

恢复屏幕是上游引导页的一部分，不需要客户端插件。在其索引写明 `dshRecoveryRoutes` 的页面上，它在以下情况显示于失败报告之下：客户端入口无法加载或激活，或引导在 studio 挂载之前抛出异常；引导开始 30 秒后 studio 仍未挂载；以及在 `/recovery`，上游的 frontend-static 服务器只在索引注入行写明 `dshRecoveryRoutes` 时，才在同一屏障之后把它渲染为索引，否则像任何缺失的路径那样回答；在那里引导页不加载任何客户端插件。它读取 `state` 并显示失败了什么、上次启动的插件及其 Turn off、近期的更改以及可撤销处的 Undo，以及 Start in safe mode（安全模式开启时则为 Leave safe mode）；每个操作都请求浏览器的确认，并 POST 到其路由。其索引还写明 `dshRecoveryUpdateRoutes`（全局的 `@delorun/plugin-update` 添加，前缀为 `/delorun/update`）的页面会读取该前缀的 `state`，并在 `available` 与 `rollback.available` 为 true 时提供 Roll back 到 `rollback.to`：它说明自该更新以来创建的聊天只是被搁置，并未删除，并以 `{ chats: "wait", profileOnly }` POST `rollback`，其中 `profileOnly` 在 `rollback.dataCopyMissing` 为 true 时为 true，按钮此时显示「settings only」。拒绝 `403 LOOPBACK_REQUIRED` 或 `403 ELEVATION_REQUIRED` 在那里被表述为「This needs you at your computer.」，因为该页面不提供解锁。远程会话可以读取该屏幕，并且在 `atComputer` 为 false 时，以及在某个操作回答 `403 LOOPBACK_REQUIRED` 时，被告知「This needs you at your computer.」。其文字按浏览器语言为英文或中文，它只用 DOM 文本构建其元素，因此在远程访问监听器的 Content Security Policy 和 Trusted Types 之下运行，并且它是一个带有获取焦点的标题的带标签区域，对拒绝使用 alert，对结果使用 polite 状态。

<a id="the-studios-changes-section"></a>

## studio 的 Changes 一节

`@delorun/plugin-changes` 的浏览器部分（`@delorun/plugin-changes/client`）注册 `settings.section` `delorun-changes`、`shell.overlay` toast 以及 `sidebar.footer.action` `delorun-changes.work-badge`；`delorun-plugin-changes` 行加载它，因此禁用该行的对等组合不显示其中任何一个。它只通过上面的路由并按 [`src/wire.ts`](../../packages/plugin-changes/src/wire.ts) 的路径和字段读取和操作，并在加载时、每次操作之后以及页面可见期间每 15 秒读取 `state`。插件的文件夹和本人的 Delorun 副本共用一次 `show?pending` 读取，它在该节打开时、每次操作之后以及本人选择 Read the folders again 或 Read your copy again 时进行，从不在 15 秒的读取中进行；再次读取期间，屏幕上保留上一份列表，直到新的回答到达。

- **它显示什么。** 工作会话；在启动时被遗漏的更改及该启动记录的失败；插件文件夹中等待审查的更改及其文件夹、文件数量和风险种类；智能体的插件请求及其终端命令、Apply 和 Discard；近期的更改及可撤销处的 Undo；分组「Changes to Delorun itself」；保护开关；每条无法读取的记录；安全模式；以及失败的上次启动。保护关闭时，有一条说明表示更改无需审查即加载，并且已链接的插件每次保存时都实时重新加载。除「Changes to Delorun itself」一项下写明的那一条终端命令外，每个控件都是通过路由操作的按钮或开关。
- **Review 与 Apply。** Review 读取 `show?id=`，并以文本显示文件夹、带状态的文件、风险种类及每项检查发现的位置、固定句子「This summary is a help to read the change, not a protection: a plugin's code can do anything Delorun can.」、差异不显示的每个文件、扫描无法包含的路径，以及带有其所省略文件的有界差异。Apply 提交 `{ id }`；当路由回答 `409 CONFIRM_RISK` 时，第二个对话框根据该回答写明每个种类和差异不显示的每个文件，并重复该句子，只有它的 Apply anyway 才提交 `confirmedRisk: true`。Discard 从该审查中提交。对智能体的插件请求执行 Apply 时，会请求一次写明该请求的确认，提交 `apply`，并请求路由为每个请求回答的第二次确认，该确认说明 Delorun 在运行它之前无法显示它安装了什么。
- **对 Delorun 本身的更改。** `state.harnessAvailable` 为 `unavailable` 时，该分组列出已决定的更改，并说明只有由 `delorun start` 启动的已安装发布才能更改它自己的文件。可用且本人还没有副本时，Make my copy 提交 `harness-copy`，并显示副本的文件夹和版本，无论副本是刚制作的还是原本就在。在副本中等待的更改来自 `show?pending` 的 `harness`，每项显示其文件、状态和 Delorun 版本；无法读取的副本（`harnessProblem`）显示为警示，并且不把任何内容列为等待中。Review 打开一个读取 `show?id=` 的对话框，显示副本中该文件的版本、其风险摘要和差异；Apply 提交 `harness-apply { id, to }`，其中的 `to` 是该次读取返回的版本，因此文件在之后又改变时，路由以 `409 CHANGED_SINCE_REVIEW` 拒绝；在 `409 CONFIRM_RISK` 之后，第二个对话框重复「对 Delorun 本身的更改可以做 Delorun 能做的任何事」这一句子，只有它的 Apply anyway 才提交 `confirmedRisk: true`。列表中的 Discard 先请求一次确认，说明该文件会回到已安装发布的版本，然后提交 `harness-discard`；审查中的 Discard 直接提交它。已决定的更改随后按从新到旧排列，每项显示其文件、状态、时间、Delorun 版本，以及由已配对设备决定时的 `decidedOn`；Review 显示其差异，或说明 Delorun 已不再保留其内容；条目为 `undoable` 时有 Undo，确认后提交 `harness-undo`。本页应用或撤销的更改带有一个来自回答 `effect` 的标签：Running now、Runs after a restart、Runs at the next start 或 Left out，`page: true` 的 `live` 回答还会加上 Reload the page；日志不保存它，因此重新加载页面会忘记它。剩下的唯一一条终端命令是 `delorun changes edit-harness --discard`，它让 Delorun 回到已安装的发布，Delorun 无法启动时也可用。
- **保护。** 该设置是一个开关。开启时请求一次确认，说明此后什么会等待审查，并且在 `unreviewedSinceOff` 大于 0 时说明保护关闭期间有多少项更改未经审查就已加载，然后提交 `protection-on`。关闭时提交 `protection-off {}`；路由的 `409 CONFIRM_PROTECTION` 回答带有 `willLoad`（插件，以及本人副本的文件数 `harnessFiles`），它填充那一次确认，或说明没有任何内容等待审查，只有该确认才提交 `{ confirmed: true }`；Cancel 不再发送任何内容。在电脑上，`state.notices` 显示在顶部，已配对设备所作的每次保护更改一条，写明设备和时间，Dismiss 提交 `notice-seen { id }`。
- **重启。** `state.restart` 为 `needed` 时，各分组上方有一张卡片，说明有多少个文件在重启后运行。`available` 为 true 时，Restart now 打开一个对话框，说明重启做什么，以及它要等待的正在运行的对话（期间不开始新的回合）；Wait, then restart 提交 `restart {}`，有对话在运行时，Stop chats and restart 提交 `restart { stopChats: true }`。`available` 为 false 时，卡片说明这些更改在下次启动时运行，不提供 Restart。从提交起直到某次状态读取显示没有正在进行的重启，以及 `state.restart` 为 `restarting` 的任何时候，卡片显示 Restarting：在 `waiting` 中带有它等待的对话和 Cancel restart（`restart-cancel`），在 `starting` 中说明页面会自行重新连接；该节每 2 秒读取一次 `state`，读取失败时卡片保留。一次不含 `restart` 的读取以一个 toast 结束它。对于 `failed`，卡片是一条警示，写明 `reason`（`health`、`chats` 或 `host`）、失败原因、Delorun 照旧运行，以及有 `leftOut` 时被略过的文件及其 Undo，后者先请求一次 Undo 的确认，再提交 `harness-undo`；对于 `chats` 和 `host`，它提供 Try again，其对话框不声称有多少对话在运行。Restart 遵循 `restart` 的访问级别，Undo 遵循 `harness-undo` 的访问级别。
- **Undo、Apply again、Start working。** 每个都先请求确认。Apply again 对在启动时被遗漏的更改提交 `apply`，Undo 提交 `undo`；Start working 对上次启动的插件以路由的默认长度提交 `work`。
- **Done。** Done 读取 `show?work=<plugin>`，以前 7 位数字显示文件夹的版本及其与会话开始时的内容的差异，并恰好以该版本提交 `done`；被标记的版本像 Apply 那样请求第二次确认。已消失的文件夹不提供批准。
- **在设备上。** 每个控件读取 `state.access.may[control]`。需要电脑的控件是禁用的按钮，悬停文字为「Needs your computer」。需要确认的控件保持可用：在没有通行密钥的设备上，悬停文字为「Unlock this phone first」；在持有通行密钥的设备上为「Confirm with Face ID」，按下它会为该次调用打开 Face ID 确认面板（`state.access.may[control].needs` 为 `unlock` 或 `face`）。在解锁路径上，按下后发送请求，路由答复 `403 ELEVATION_REQUIRED`，该节发出 `remote/call-denied`，端点为 `delorunChanges/<control>`，原因为 `elevation-required: delorunChanges/<control>`，它会打开 studio 的解锁对话框，并有一条 toast 提示先解锁。答复 `403 LOOPBACK_REQUIRED` 的操作显示 toast「This needs you at your computer.」，且不禁用其他任何内容；Review 仍可读取。设备页面顶部的提示写明谁在操作：是已锁定的、处于批准宽限期的（算作已锁定）或已解锁的手机，还是用 Face ID 确认每项操作的手机。电脑的页面不显示该提示。
- **徽章。** 当 `state` 写明一个 `endsAt` 尚未过去的工作会话时，徽章在侧边栏底部写明该插件，在窄栏中是一个点，其提示文字与之相同；一旦 `state` 不再写明任何会话，徽章就消失。
- **结果。** 每个操作的结果是一个比设置对话框存活更久的 toast：已应用、已丢弃、已撤销、Delorun 未运行、回退并附带其失败的重新加载、审查之后更改的文件夹、附带其句子的拒绝、无回答、已制作或已找到的副本、保护开启或关闭，以及对 Delorun 本身的更改何时生效（现在运行、重新加载页面即可看到、重启后运行、下次启动时生效、无法立即运行而被略过并附原因），Delorun 已重启，以及重启已取消。每条文案都有英文和中文词典。

<a id="commands"></a>

## 命令

`delorun changes` 是终端到达 `@delorun/changes` 的各项操作（`listChanges`、`showChange`、`applyChange`、`discardChange`、`undoChange`、`turnOff`、`turnOn`、`changeProtection`、`startWork`、`finishWork`）的途径。

| 子命令 | 它做什么 |
| --- | --- |
| `list`（默认）`[--json]` | 等待审查的更改（根据每个文件夹现在的状态计算）和等待审查的智能体插件请求（`requests`，标为 `asked in a chat`），然后是失败的启动所遗漏且仍被遗漏的更改（`leftOut`），然后是其他每项已记入日志的更改（最新的在前）、文件夹已消失的每个插件、保护设置、已配对设备所做的保护更改（在 “Changed from a phone:” 之下）以及任何工作会话；在终端上它会清除它所打印的通知，在其他地方则保留它们 |
| `show <id> [--diff] [--json]` | 一项更改：插件、其文件夹、其文件（依赖文件分组）、风险摘要的各行，以及带 `--diff` 时的有界差异，并说明差异何时被截短 |
| `apply <id>` | 插件的已批准内容变为该 id 所指名的版本；当其文件夹持有任何其他内容时为 `CHANGED_SINCE_REVIEW`。对于智能体的插件请求，上游的插件操作针对其规格运行（[智能体与插件](#the-agent-and-plugins)）；失败时为 `OPERATION_FAILED`。在启动时被遗漏的更改再次加载（[启动失败时](#when-a-start-fails)） |
| `discard <id>` | 该更改变为 `discarded`：它从不加载，并且在文件夹持有该内容期间不被列出；文件夹从不被写入 |
| `undo <id>` | 已应用的插件更改，或在启动时被遗漏的更改：已批准的内容回到该更改的 `from`，或者在撤销其安装之后该插件没有任何已批准内容，并且其活动目录持有它；保护关闭时，它所撤销的文件夹内容在文件夹持有其他内容之前不再加载（[无需审查的加载](#loading-without-review)）；`plugin-off` 会开启该插件，`plugin-on` 会关闭它；当该插件的较晚更改已被应用，以及对于其他种类，为 `NOT_ALLOWED` |
| `off <plugin>`、`on <plugin>` | 包名离开 profile 的 `package.json` 中的 `dsh.profile.bundles`，或被追加到其中，如上游的插件管理器所写；对 `@delorun/bundle-local` 以及 profile 没有处于该状态的插件为 `NOT_ALLOWED` |
| `protection [on\|off]` | 打印该设置及其含义，或在说明新设置的含义并询问之后更改它；将其关闭会再问一次，指出届时哪些内容会不经审查就加载，并记为一项已应用的 `guard-weakening` 更改（[保护设置](#the-protection-setting)） |
| `work <plugin> [--for <minutes>]` | 打开一个持续 `--for` 分钟（默认 120，最多 480）的工作会话，并打印 `Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>, at the latest until <endsAt>.`；当文件夹的内容无法立即加载时，它还会报告失败，并以 1 退出而会话保持打开 |
| `done <plugin>` | 打印文件夹的版本、其文件、风险摘要以及相对于已批准内容的有界差异，询问（检查发现了问题时询问两次），并恰好批准该版本；当文件夹在此期间发生变化时为 `CHANGED_SINCE_REVIEW`，当该版本加载失败时以 1 退出而会话保持打开 |
| `edit-harness [--discard]` | 创建运行中运行时的 `app/` 目录的可写副本并打印其文件夹，或在它已存在时打印它而不改变任何内容；`--discard` 先询问，然后丢弃运行中运行时的每项 harness 更改（[harness 编辑](#harness-edits)）。在源码检出中被拒绝，因为那里没有可更改的已安装发布 |

`list`、`show`、`apply`、`discard` 和 `undo` 在没有任何插件更改拥有某个 id 之后，按 id 到达 harness 更改：`list` 把每个等待中的更改写作 `<id>  Delorun <runtime> itself: <file> (<status>)`，然后是 harness 被遗漏的和已记入日志的更改、副本的文件夹、其被跳过的条目以及保留在旁的文件；`show --diff` 打印两个单文件版本之间的有界差异，该文件算作 harness 自己的而不是依赖的，尽管它位于 `node_modules` 之下。无法读取的副本（例如超过扫描上限的副本）会在列表中被写明而不是使列表失败。

- **在场与确认。** 每个更改任何内容的子命令首先需要标准输入和输出是终端，否则在读取或写入任何内容之前以「This needs you at your computer: run it in a terminal.」拒绝。然后它询问一个是或否的问题；`y` 或 `yes` 之外的任何回答都不改变任何内容。`apply` 首先打印该更改的摘要和风险行以及有界差异，在终端上分页显示（Enter 显示下一页，`a` 显示其余部分），并且当检查标记了该更改时，询问写明各种类和差异不显示内容的每个文件的第二个问题。`protection off` 首先说「Changes will load without your review.」以及关闭意味着什么，`protection on` 说「Changes will wait for your review.」以及开启意味着什么；两者随后都询问。`protection off` 接着在指出等待中的更改会立即加载的插件，以及本人的 Delorun 副本中会在下次启动时应用的文件数量之后，再问一次；第二次询问防的是误点，不是防在电脑前的人。该命令说明更改在 Delorun 的下一次决定时生效，无需重启。
- **一个历史版本。** 每个操作都在上游的 profile 写锁之下运行，并记录一个 profile 历史版本（`kind: person`），其主题以该更改的摘要而非其 id 写明它：`Applied: …`、`Applied again: …`、`Undid: …`、`Turned off <plugin>`。丢弃和保护设置不更改任何 profile 文件，也不记录历史版本。
- **重新加载运行中的 Home。** 当 profile 的 home 进程应答时，该操作在 profile 写锁之下运行，然后发送 [C19](c19-home-process.zh.md) 的 `changes.reload`，它不携带任何内容：Host 通过上游的热重载重新组合 profile。热重载关闭、插件加载或启动失败，或该更改需要重启时，重新加载失败。当没有 home 进程应答时，该命令在该操作期间持有 profile 的 home 锁，因此其间不会运行任何启动，并且下一次启动加载该更改。
- **失败的重新加载会回退。** 已批准的记录、插件的活动目录和 `active.json`，或 bundle 列表，回到该操作之前所持有的内容；第二个历史版本 `Went back: <summary> failed to load` 记录这一点；条目回到 `pending`，对于撤销则保持 `applied`，带有 `lastFailure` `{at, failure}`；Host 再重新加载一次；该命令报告失败并以 1 退出。被关闭或开启而加载失败的插件连同其失败一起被列出，并按其 id 再次应用。
- **处于工作会话的插件。** 对有打开的工作会话的插件执行 `apply` 和 `undo`，以 `NOT_ALLOWED` 被拒绝。
- **来自文件的文本。** 文件名、文件夹、差异行、摘要、规格和失败消息被打印时，每个控制字符、行或段分隔符和双向字符都写作 `\uXXXX`，超过 200 个字符的行在下一行继续，并以 `  ↪ ` 开头；`--json` 把相同的字符写为 JSON 转义。`off` 和 `on` 把不是包名的名称作为用法错误拒绝，并且 `changes/` 之下的每个路径都只根据包名构建。

<a id="what-verify-and-doctor-report"></a>

## verify 与 doctor 报告什么

`delorun verify` 在发布的检查行之后打印一个 Changes 块：保护设置，它在任一设置下都不是故障；本人批准的更改，每个插件及其文件夹，并在 Changes 下的首次启动批准它时加以标记；然后，与它们分开的分组「N changes loaded without review (protection is off)」（现在开启时为「(while protection was off)」），列出其已批准内容由决定为 `unreviewed` 的更改带来的每个插件，及其文件夹和该更改的 id；然后是存在但本人未批准的一切：文件夹与其已批准内容不同的每个插件，以及每个不成立的不变量。从运行时仓库之外运行时会说明它是源码检出或开发构建，没有可供其文件比较的已签名发布。摘要行为每个存在的部分增加一个子句：存在多少本人未批准的更改、多少更改无需审查即加载，以及其更改中有多少部分不是 Changes 所保持的样子，因此对于无人审查的内容它从不读作简单的通过。只有在某个不变量不成立，或组合树未通过其检查时，该次运行才以 1 退出；待处理的更改和无需审查即加载的更改是被报告的，而不是故障。`--json` 在 `changes` 之下携带相同的报告。

`delorun doctor` 打印 `changes` 行：保护设置（在任一设置下都是 `pass`）、打开的工作会话、来自 `run/<profile>/changes-work.json` 的工作会话中最近一次失败的重新加载（`warn`），以及对 Changes 下的每个插件：它在上次启动时是否加载、其活动目录持有什么（对于决定为 `unreviewed` 的更改所带来的内容，为 `it runs content that loaded without review (<id>)`）、其活动 `package.json` 声明的 `engines.dsh` 和 `engines.delorun`，以及内置的同意、防护和沙箱检查在其活动内容中发现了什么。当上次启动失败或某个插件没有加载时，一行写明该插件及其最新的已应用更改，附带 `delorun changes undo <id>`；没有写明 Changes 下任何插件的失败，则写明任何插件最新的已应用更改。失败的启动所遗漏且仍被遗漏的每项更改，连同其插件、该启动的时间、其失败以及 `delorun changes apply <id>` 和 `undo <id>` 被写明，并且其插件的行说明它运行的是该更改之前的内容，或什么都没有。待处理的更改、被遗漏的更改和没有加载的插件是 `warn`；不成立的不变量是 `fail`。每一行都像 `delorun changes` 转义其文本那样被转义，插件或记录携带的失败消息在 200 个字符处截断，并说明省略了多少。

从运行时仓库运行时，它还报告本人对其所检查发布的 harness 所作的更改：`verify` 把每个已批准的 harness 文件作为 `Delorun <runtime> itself: <file>` 计入本人批准的更改，或者当决定为 `unreviewed` 的更改批准了它时，连同该更改的 id 计入无需审查即加载的更改分组；它把在副本中等待的每项更改列在本人未批准的内容之中（它不运行），说明下一次启动何时构建组合树，并把未通过其检查的组合树报告为不是 Changes 所保持的部分，因此摘要从不读作简单的通过，并且该次运行以 1 退出。其发布未通过验证的树被写明为未检查。`doctor` 报告记录的文件（本人批准的在一行 `pass` 上，保护关闭期间无需审查即加载的在另一行上）、可写副本、在那里等待的每项更改、在启动时被遗漏的每项更改，以及组合树的状态：未通过其检查时为 `fail`，未被检查时为 `warn`。两者都不连同其扫描缓存读取该副本。

`delorun status` 在其 home 进程各行之前，写明没有任何终端显示过的、在升级时被批准的每个插件，以及等待审查的每项更改，因为 `delorun start` 只在日志中显示其启动的各行。

两个命令都不写入。文件夹的读取不带扫描缓存，因此待处理的更改只有在存储已持有该文件夹的内容时才携带其 id，否则指向 `delorun changes list`。无法读取的记录被报告为不成立的不变量。

每次启动之后，home 进程写入 `run/<profile>/changes-boot.json`（[C1](c01-home-layout.zh.md)），这是受保护的文件 `{"schema":"delorun.changes-boot/1","at":<ISO time>,"plugins":[{"plugin","rows":[{"id","state"}],"loaded","error"?}],"failure"?}`：对 Changes 下的每个插件（已批准的，或作为安装等待审查的），其模块是该包或其内部路径的 Loader 行，以及它是否有已启用的行，以及每个已启用的行是否都已变为活动；profile 没有启动时设置 `failure`。写入它失败会被记入日志，启动继续；没有任何启动读取它。

<a id="consumers"></a>

## 消费方

`delorun/apps/cli`（带有 home 进程的插件文件夹监视器的 `delorun start`、`delorun headless`、`delorun changes`、`delorun plugin`、`delorun verify`、`delorun doctor`，以及可以开启保护的 `delorun setup` 的 Full 模式）；`@delorun/plugin-changes` 的路由和上游的引导页，其恢复屏幕通过它们读取和操作；以及之后的 studio Changes 一节。

<a id="compatibility"></a>

## 兼容性

在 Changes 之前的 profile 会在其首次启动时被迁移，而不改变它所运行的内容。每条记录都携带一个 schema 标签；读取者以 `RECORD_UNREADABLE` 拒绝未知的标签、字段或值，随后启动停止而不是猜测。`level` 既不是 `on` 也不是 `off` 的 `delorun.changes-protection/1` 记录就是这样的值。

<a id="security"></a>

## 安全

### 要求

要求 2 和 8，以及要求 1 中本人的决定，在保护开启时成立；要求 20 至 22 在保护关闭时成立；其他要求在两种设置下都成立。

1. 在工作会话之外，从文件夹链接的插件从不从该文件夹加载：profile 的依赖、锁文件条目和链接指名其活动目录，该目录持有已批准的版本。保护开启时，只有本人的决定才能更改已批准的版本。
2. 没有已批准内容的插件不加载任何内容。
3. 受限命令不能写入 `changes/`：它位于受保护的 home 之下，且不是读取豁免（[C1](c01-home-layout.zh.md#security)）。因此在伪终端中运行、通过终端检查的受限命令，仍然无法关闭保护或批准某项更改（[F16](../security/fundamentals.zh.md)），也无法写入 harness 的可写副本。
4. 只有终端证明或 studio 证明才能更改保护设置：终端的；电脑上 studio 的（回环监听器、studio 的凭据和同源请求）；或持有针对该请求的授权凭证的已配对设备的（要求 23）。只有终端证明或 studio 证明才能打开或关闭工作会话，但不经本人而结束会话的情形除外（Delorun 停止、崩溃之后的启动、会话的结束时间），这不批准任何内容，并通过 `@delorun/changes/stop` 进行，除 CLI 的启动模块外没有任何模块导入这个入口。
5. 存储的对象和版本在每次读取时都对照其名称检查。
6. 每个改变 profile 所运行内容的操作，在读取或写入任何内容之前，都会拒绝 attest 函数未签发的证明；`delorun changes` 只在终端获得其证明；并且除 `delorun changes`（`delorun/apps/cli/src/changes/`，包括只开启保护的 setup 一节）、`@delorun/changes` 和 studio 的 Changes 路由（`delorun/packages/plugin-changes/src/routes.ts`）之外，Delorun 或上游的任何模块都不导入某个操作或 attest 函数；这些路由导入 `attestStudio`、`attestDevice`、`changeProtection`、`dismissNotice` 和 harness 操作，而不导入 `attestTerminal`、`setProtection` 和 `discardAllHarnessChanges` 中的任何一个。
7. 在工作会话中，失败的重新加载使最近加载的内容或已批准的内容继续运行，且会话保持打开。没有本人参与的会话结束不批准任何内容：已批准的内容保持为会话开始时的版本。`done` 只批准它所显示的版本。会话在其 `endsAt` 结束，最晚在开始后 480 分钟，此后没有任何启动加载其文件夹。
8. 保护开启且 `plugin_changes_pending` 开启时，智能体的 `plugin_manager` 安装、更新或移除不更改任何 profile 文件，也从不到达该工具的批准；指名文件夹的智能体规格在本人审查该文件夹的内容之前不加载任何内容，范围指名另一个来源的则被拒绝；保护开启且 `approved_plugin_write_consent` 开启时，智能体在 chat 中首次通过文件工具向已批准插件的文件夹写入时会询问，无论路径如何拼写；该开关开启时，文件工具向 profile 活动目录的写入在两种设置下都被拒绝。应用智能体的请求不会运行 profile 的 `allowBuilds` 不允许的构建脚本，也不会安装与此 Delorun 不兼容的版本。
9. `delorun changes`、`verify`、`doctor` 和 `status` 从文件、日志条目或插件的失败中打印的内容，无法移动光标、另起一行或重新排列其周围的文本。差异不显示其新内容的更改、Node 会加载的二进制文件、超过差异上限的文件或文件夹内依赖的文件，会请求第二次确认并写明该文件。在 Changes 下的首次启动之后创建的 profile，不在升级时批准其任何链接。
10. 在对运行中 profile 的每次重新组合之前以及每次启动时，每个链接都指名其插件的活动目录，并且每个活动目录都持有 Changes 所保持的内容，否则不加载任何东西：指向文件夹的链接在 profile 写锁允许处先被移动，任何其他不同之处都使启动或重新加载被拒绝（[重新加载与恢复](#reloads-and-restores)）。已批准插件的已安装依赖从已批准的副本按哈希加载，从不从其安装位置加载，只因其已安装的包而超过内容上限、且保护关闭时的插件除外。
11. 无法作为一个内容版本读取的文件夹使已批准的内容继续运行，且从不使启动停止；存储只保留记录所引用的内容，宽限期内写入的版本除外（[回收存储](#collecting-the-store)）。
12. 在某项更改之后立即失败的启动，只遗漏该项更改，方法是只写更改日志，并且只加载在它之前已批准的内容或什么都不加载，直到本人再次应用它或撤销它，或者在保护关闭时，文件夹持有其他内容；第二次启动不遗漏任何内容（[启动失败时](#when-a-start-fails)）。
13. Changes 路由只回答 Connection 以 studio 的凭据准入的请求。操作只对电脑上的请求生效，即回环监听器上、在没有任何远程访问分发器准入的回环 `Host` 之下的请求，或者按要求 23 对已配对设备的请求，并在读取请求体之前拒绝任何其他请求以及另一个站点发送的请求（[路由与恢复屏幕](#routes-and-the-recovery-screen)）。
14. 存储插件的内容从不读取 Delorun home 或 `/proc`、`/sys`、`/dev` 中的文件，只跟随文件夹之外的链接到它所包含的已安装包、同级工作区包或 `.git` 目录，并且对每个文件的读取不超过计入内容上限的大小（[加载已批准的内容](#loading-approved-content)）。
15. 没有任何 harness 操作写入 `runtimes/` 之下，并且已签名安装的启动检查在两种保护设置下相同。从安装读取的每个字节都对照经过验证的已签名文件列表检查（[harness 编辑](#harness-edits)）。
16. 待处理的 harness 更改从不运行：启动运行的是已签名的安装，或记录的组合树，而后者只由已应用的更改写入。
17. 启动只在检查了每个未编辑的路径都是安装的文件、每个已批准的路径都持有已批准的内容且不存在其他任何内容之后，才运行组合树；两次失败的树使启动被拒绝。只有已签名安装的代码才把启动交接给组合树，并且失败之后启动的第二次运行启动已签名的安装。
18. 只有终端证明、电脑上的 studio，或按要求 23 解锁的已配对设备才创建可写副本或决定 harness 更改；受限命令不能写入 `changes/harness/`（要求 3），没有任何模型工具到达 harness 操作，并且路由依据正在运行的运行时的签名文件列表决定，否则回答 `409 HARNESS_UNAVAILABLE`，保护关闭时启动的未经审查的应用除外（要求 22）。studio 只应用审查所显示的内容版本。
19. 丢弃每项 harness 更改会清空该运行时的记录，因此下一次启动原样运行已签名的发布。紧接着一项 harness 更改之后失败的启动，只遗漏该更改，记在 harness 的日志中，并且不写入 profile 的任何文件；其 `delorun` 在启动运行之前就失败的组合树同样如此，第二次这样的失败不再遗漏更多内容。处于安全模式的 profile 运行不带任何 harness 更改的已签名发布。
20. 保护关闭时，无需审查就加载的内容在 Host 加载它之前被记录：它是 profile 的 `delorun.changes` 记录或运行时的 harness 记录中的已批准内容，也是更改日志中决定为 `unreviewed` 的已应用更改，`delorun changes list`、`show`、`undo`、`verify` 和 `doctor` 都能到达它；加载了任何内容的启动以及每次实时重新加载还会记录一个 profile 历史版本。
21. 保护关闭时，本人拒绝的内容不加载：当某个插件最新被决定的内容更改被撤销或丢弃，且带来的恰好是其文件夹所持有的内容时，该插件保留其已批准的内容。实时重新加载失败的内容不会再次加载，直到文件夹持有其他内容，并且失败的启动所遗漏的更改，在文件夹持有它所带来的内容期间一直被遗漏。
22. 只有启动的启动前步骤和重新加载之前的检查、home 进程的插件文件夹监视器（`loadUnreviewed`，在 `@delorun/changes` 之外只被 `delorun/apps/cli/src/changes/unreviewed-watch.ts` 指名），以及针对 harness 可写副本的已签名安装的启动（`applyUnreviewedHarnessChanges`，只被 `delorun/apps/cli/src/changes/harness-start.ts` 指名）无需审查就加载内容。每一个都在 profile 写锁（或 `harness.lock`）之下读取保护设置，并在它开启时不写入任何内容；没有任何路由、模型工具或插件指名它们。
23. 已配对设备只按控件的类别使用 studio 控件：`free` 不需要提示（打开保护）；`face` 需要针对恰为该请求的一次一个操作的授权凭证或有效的 Face ID 通行期，从不使用批准宽限期；也从不能使用 `computer` 控件（清除通知）。站点、类别和证明按此顺序在读取请求体之前决定。设备对保护设置的更改会留下一条设备无法清除的通知。关闭保护的第二次询问只防止误点，不算作针对电脑前的人的防御（[C14](c14-oidc-passkeys.zh.md#face-id-unlock)）。

### 拒绝测试

除非某一行写明保护关闭，否则每个测试都在保护开启时运行。

| 测试 | 证明 |
| --- | --- |
| `a plugin outside a work session never loads from its folder` | 要求 1（`delorun/packages/changes/tests/enforce.integration.spec.ts`） |
| `a changed plugin does not load with protection on` | 要求 1 |
| `a new linked plugin without approved content loads nothing with protection on` | 要求 2 |
| `puts a tampered active directory back to the approved version` | 要求 1 |
| `refuses an object that only looks like a terminal proof`, `refuses when standard input or output is not a terminal` | 要求 4（`records.spec.ts`） |
| `a confined command inside a pseudo-terminal cannot lower protection` | 要求 3：在 bwrap 之下，以及在可用时的 Landlock 之下，保护开启时，在伪终端中回答 `y` 的 `delorun changes protection off` 失败，`changes/protection.json` 保持为 `on`，对 `changes/` 的直接写入失败，包含 home 的工作区被拒绝，而没有 home 规则时同一命令会把它降低（`delorun/packages/home-process/tests/changes-confinement.integration.spec.ts`） |
| `refuses an object whose bytes do not have its digest`, `refuses a version file whose content is not the version its name says` | 要求 5（`store.integration.spec.ts`） |
| `refuses a fresh start from the store whose runtime files differ, before the profile is touched` | harness 启动检查（`delorun/apps/cli/tests/changes-start.spec.ts`） |
| `every state-changing changes action refuses without a terminal` | 要求 6（`delorun/apps/cli/tests/changes-command.spec.ts`） |
| `the changes actions refuse a proof the attest functions did not issue` | 要求 6（`delorun/packages/changes/tests/actions.integration.spec.ts`） |
| `a remote session and the model cannot start or end a work session` | 要求 4（`work.integration.spec.ts`；`reach.spec.ts` 涵盖 `startWork`、`finishWork` 和 `finishWorkWithoutPerson`） |
| `a failed reload in a work session leaves the previous version running` | 要求 7（`delorun/apps/cli/tests/changes-work.spec.ts`） |
| `a work session's edits load live` | [工作会话](#work-sessions)（`changes-work.spec.ts`） |
| `ending a work session without the person approves nothing new` | 要求 7：Delorun 停止、崩溃之后的启动和结束时间都使已批准的内容保持为 `from`，并使文件夹的内容保持待处理（`work.integration.spec.ts`、`changes-work.spec.ts`） |
| `done approves exactly the version it showed` | 要求 7：显示之后更改的文件夹以 `CHANGED_SINCE_REVIEW` 被拒绝，且不批准任何内容（`work.integration.spec.ts`；`changes-command.spec.ts` 在问题等待期间更改文件夹） |
| `a work session ends at its bound` | 要求 7：`endsAt` 之后不加载任何内容，监视器在那时结束会话，并且 1 至 480 分钟之外的长度被拒绝（`work.integration.spec.ts`、`changes-work.spec.ts`） |
| `no model tool or route reaches a changes action` | 要求 6（`reach.spec.ts`） |
| `changes.reload carries no arguments` | [C19](c19-home-process.zh.md) 对 `changes.reload` 的封闭 schema（`delorun/packages/home-process/tests/changes-reload.integration.spec.ts`） |
| `verify never prints a plain pass with content that loaded without review, and exits 0`, `verify never prints a plain pass with an invariant that does not hold, and exits 1` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`delorun/apps/cli/tests/verify/changes.spec.ts`） |
| `protection off is no fault while nothing loaded without review, and a protection record that cannot be read is`, `the protection line passes in either setting` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`verify/changes.spec.ts`、`doctor/changes.spec.ts`） |
| `writes control and bidirectional characters in file names, diffs, summaries and failures as escapes, and wraps long lines` | 要求 9（`changes-command.spec.ts`；`verify/changes.spec.ts` 和 `doctor/changes.spec.ts` 有各自的转义用例） |
| `a .js file with one invalid byte, a file above the limit and a dependency inside the folder each need the second confirmation` | 要求 9（`delorun/packages/changes/tests/pending.integration.spec.ts`） |
| `a file Node loads that the diff does not show asks the second confirmation and is named`, `apply shows the diff a page at a time before it asks` | 要求 9 和[命令](#commands)（`changes-command.spec.ts`） |
| `a profile created after the first start does not approve its links at upgrade` | 要求 9（`records.spec.ts`；`changes-start.spec.ts` 通过一次启动） |
| `a start whose output reaches no terminal names the plugins approved at upgrade again at the next start`, `changes list names them until a terminal showed them` | [Changes 下的首次启动](#the-first-start-under-changes)（`changes-start.spec.ts`、`changes-command.spec.ts`） |
| `refuses a name that is not a package name before any path is built from it`, `off and on refuse a name that is not a package name before any path is built` | 要求 9（`delorun/packages/changes/tests/paths.spec.ts`、`changes-command.spec.ts`） |
| `doctor names the plugin and the change that introduced a failed load` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`delorun/apps/cli/tests/doctor/changes.spec.ts`） |
| `no tool can apply a change, start or end a work session, or change the protection setting` | 针对 `@delorun/plugin-changes` 和 `@delorun/plugin-instruction-consent` 的要求 6，其中 `applyInstallChange` 受到防护（`reach.spec.ts`） |
| `the studio routes are the only module that attests a studio request, and they do` | 针对这些路由的要求 6（`reach.spec.ts`） |
| `an HTTP caller without the studio's credential cannot reach any Changes route` | 要求 13：每个路由在读取 profile 或请求体之前回答 401 或 403（`delorun/packages/plugin-changes/tests/routes.spec.ts`） |
| `a remote session cannot use the recovery actions` | 要求 13：远程访问会话、不是回环的 `Host` 和远程访问戳记各自得到 `403 LOOPBACK_REQUIRED`，请求体被扣留，在 2 秒内回答（`routes.spec.ts`） |
| `a cross-site request is refused before its body is read` | 要求 13：`Sec-Fetch-Site` 以及外来的或 `null` 的 `Origin` 得到 `403 CROSS_SITE`，请求体被扣留，在 2 秒内回答（`routes.spec.ts`） |
| `registers no Changes route when Connection cannot name a remote session` | 要求 13：没有 `isReachPeer` 就不注册任何路由（`delorun/packages/plugin-changes/tests/routes-plugin.spec.ts`） |
| `a route's error answer names the code and no path under the home` | [路由与恢复屏幕](#routes-and-the-recovery-screen)：拒绝回答其代码和固定句子，`state` 中无法读取的部分连同它写明该部分，Host 日志保留路径，已记录的失败在 home 的路径及其真实路径之下写明 `<Delorun home>`（`routes.spec.ts`） |
| `GET state writes nothing under the home`, `GET state reads no plugin's folder` | [路由与恢复屏幕](#routes-and-the-recovery-screen)：home 的条目、大小和修改时间不变，没有 `node:fs/promises` 调用指名该文件夹中的路径，而 `show?pending` 读取并存储它（`delorun/packages/plugin-changes/tests/routes-state.integration.spec.ts`；`delorun/packages/changes/tests/state.integration.spec.ts` 中只有 `recordedChanges`） |
| `reads the plugins' folders only through show?pending: when it opens, after an action and when asked, never on the state's poll` | [studio 的 Changes 一节](#the-studios-changes-section)（`changes-section.client.spec.tsx`） |
| `/recovery is not served when Delorun's Changes service is not mounted` | [路由与恢复屏幕](#routes-and-the-recovery-screen)：没有写明 `dshRecoveryRoutes` 的索引行时，已登录的 `/recovery` 是 `404`（`packages/host/frontend-static/tests/frontend-static.spec.ts`） |
| `apply asks the second confirmation when the change has a risk` | [路由与恢复屏幕](#routes-and-the-recovery-screen)：`409 CONFIRM_RISK` 写明各种类和差异不显示的文件，并且在 `confirmedRisk` 之前不批准任何内容（`delorun/packages/plugin-changes/tests/routes.integration.spec.ts`） |
| `the recovery screen renders with every plugin's client code failing` | [路由与恢复屏幕](#routes-and-the-recovery-screen)：每个插件 bundle 都加载失败，而该屏幕提供 Turn off、Undo 和安全模式（`packages/client/web/tests/boot.client.spec.ts`） |
| `the recovery screen shows This needs you at your computer for a remote session` | 屏幕上的要求 13（`packages/client/web/tests/boot-page.client.spec.ts`） |
| `the studio asks a second confirmation before applying a flagged change` | [studio 的 Changes 一节](#the-studios-changes-section)：第一次 Apply 不发送 `confirmedRisk`，路由的 `409 CONFIRM_RISK` 打开一个写明各种类和差异不显示的文件的对话框，Cancel 不再发送任何内容，只有 Apply anyway 才发送 `confirmedRisk: true`（`delorun/packages/plugin-changes/tests/changes-section.client.spec.tsx`） |
| `a locked phone sees the changes, the controls the computer keeps are disabled, and Undo asks it to unlock` | 该节中的要求 13 和 23：已锁定的手机看到每个部分和提示，类别为 `computer` 的控件以「Needs your computer」禁用，`face` 控件以「Unlock this phone first」保持可用，审查仍可读取，被拒绝的 Undo（`403 ELEVATION_REQUIRED`）为 `delorunChanges/plugin-undo` 发出 `remote/call-denied` 并弹出 toast，只发出了那一次请求，没有发送其他任何内容（`changes-section.client.spec.tsx`） |
| `a phone in its approval grace is told it counts as locked`, `shows the computer no access note` | 该节中的要求 23：宽限期的措辞为已锁定，电脑的页面没有提示（`changes-section.client.spec.tsx`） |
| `a notice's Dismiss stays at the computer` | 该节中的要求 23：设备对保护的更改留下一条通知，其 Dismiss 在设备上以「Needs your computer」禁用（`changes-section.client.spec.tsx`） |
| `a work session's badge is shown while it lasts` | [studio 的 Changes 一节](#the-studios-changes-section)：`state` 写明该会话期间徽章写明该插件，不再写明时徽章消失（`changes-section.client.spec.tsx`） |
| `needs the person at their computer` | 针对 `applyInstallChange` 的要求 6（`install-actions.integration.spec.ts`） |
| `the agent's first write to an approved plugin's folder asks` | 要求 8；同一 chat 中的第二次写入不询问，另一个 chat 再次询问（`delorun/packages/plugin-instruction-consent/tests/plugin-folders.spec.ts`） |
| `the agent's write through a symlink, a case variant or .. into an approved plugin's folder asks` | 要求 8：按文件后端所写入的真实路径比较（`plugin-folders.spec.ts`） |
| `the agent's write into a plugin's active directory is refused` | 要求 8（`plugin-folders.spec.ts`） |
| `a refused ask leaves the file unwritten, and the next write asks again` | [智能体与插件](#the-agent-and-plugins)（`plugin-folders.spec.ts`） |
| `with the switch at parity the write runs as upstream runs it` | `approved_plugin_write_consent` 关闭时不询问任何内容（`plugin-folders.spec.ts`） |
| `the model's plugin_manager install creates a pending change and installs nothing` | 要求 8：manifest、锁文件和 `node_modules` 不变（`delorun/packages/plugin-changes/tests/plugin-changes.spec.ts`） |
| `the model's plugin_manager remove creates a pending change and removes nothing` | 要求 8（`plugin-changes.spec.ts`） |
| `the model's plugin_manager update creates a pending change and updates nothing` | 要求 8（`plugin-changes.spec.ts`） |
| `a listener that allows the call without the plugin's listener is overruled by its guard` | 要求 8（`plugin-changes.spec.ts`） |
| `with the switch at parity the plugin_manager action asks stock's approval` | `plugin_changes_pending` 关闭时保持上游的流程（`plugin-changes.spec.ts`） |
| `links a folder to its active directory, which holds nothing, and leaves the folder's content waiting for review` | 针对已应用的智能体请求的要求 1（`delorun/packages/changes/tests/install-actions.integration.spec.ts`） |
| `applying a held install keeps install scripts held back as stock does` | 要求 8：使用真实的 pnpm 时脚本不运行，其名称等待在 `allowBuilds` 之下，并且 `package.json` 和锁文件被放回（`delorun/apps/cli/tests/changes-plugin-operation.integration.spec.ts`） |
| `applying a held install refuses a version incompatible with this Delorun` | 要求 8（`changes-plugin-operation.integration.spec.ts`） |
| `a reload refuses an active directory that differs from its approved version` | 要求 10：通过挂载了 `@delorun/plugin-changes` 的上游热重载，被替换的内容都不会被求值（`delorun/packages/plugin-changes/tests/reload-check.spec.ts`；仅 `prepareReload` 在 `delorun/packages/changes/tests/load-check.integration.spec.ts` 中） |
| `a restore that names a folder link loads nothing from the folder` | 要求 10：上游自己的 `pluginManager.restore` 恢复链接该文件夹的历史版本，其重新组合在管理器的锁之下运行，不从该文件夹求值任何内容（`reload-check.spec.ts`） |
| `delorun plugin add link:<folder> while Delorun runs loads nothing from the folder` | 要求 2 和 10：操作持有锁期间被拒绝，之后被移动且不加载任何内容（`reload-check.spec.ts`）；`delorun plugin add link:<folder> links the plugin to its empty active directory and leaves the folder waiting for review` 涵盖该命令（`delorun/apps/cli/tests/plugin-command.spec.ts`） |
| `upstream evaluates nothing of a plugin with no approved content with protection on` | 要求 2：通过上游的 profile 准备和 loader 启动，插件的模块和 bundle patch 不被求值，更改被应用之后才被求值（`reload-check.spec.ts`） |
| `the model's plugin_manager restore, undo and settings changes do not run and record nothing`, `a listener that allows a restore without the plugin's listener is overruled by its guard` | 针对模型的要求 10（`plugin-changes.spec.ts`） |
| `stops nothing and loads nothing when the distribution's profile check refuses` | 上游的扩展点（`packages/boot/hmr/tests/package-reload.spec.ts`） |
| `a start refuses a profile whose installed link names the folder` | 启动时的要求 10（`load-check.integration.spec.ts`） |
| `an approved plugin's outside dependency loads from the approved copy` | 要求 10：pnpm 存储中已更改的文件不会改变该副本所导入的内容（`load-check.integration.spec.ts`） |
| `judges a relative link by where it resolves on disk, not by its spelling` | 要求 1：经过一个离开该文件夹的链接的链接，不被保留为内部链接（`delorun/packages/changes/tests/tree.integration.spec.ts`） |
| `a link whose spelling leaves the folder is outside even when its real path is inside` | 要求 1：按所写的样子保留这样的链接，会使该副本指名另一个插件的活动目录（`tree.integration.spec.ts`） |
| `a link to a missing folder is brought under Changes and loads nothing` | 要求 2 和 10：启动和重新加载之前的检查把它移到空的活动目录，之后在那里创建的文件夹等待审查（`delorun/packages/changes/tests/enforce.integration.spec.ts`） |
| `a link to a file under the Delorun home is never copied into the store` | 要求 14（`store.integration.spec.ts`） |
| `a link into /proc is never read` | 要求 14（`tree.integration.spec.ts`） |
| `a file that grows while it is read is refused`, `the byte limit counts the bytes actually read` | 要求 14：扫描和存储的副本读取的内容不超过计入上限的大小（`tree.integration.spec.ts`、`store.integration.spec.ts`） |
| `an agent install of name@file:/dir is reviewed as a folder`, `an agent install whose range names another protocol is refused` | 要求 8（`install-actions.integration.spec.ts`） |
| `a start after a work session's end loads nothing from the folder` | 要求 7：不先结束已打开会话的启动（如 `delorun headless` 的启动），结束过了其 `endsAt` 的会话且不批准任何内容（`work.integration.spec.ts`） |
| `a scan failure with protection on keeps the approved content running` | 要求 11（`load-check.integration.spec.ts`；上限情形见 `refuses a plugin over the content limits with protection on with the reason, and keeps its approved content`） |
| `collection keeps every referenced version and removes the rest` | 要求 11（`delorun/packages/changes/tests/collect.integration.spec.ts`） |
| `a start that fails on a new plugin starts without it and names it` | 要求 12：第二次启动加载更改之前的内容，且两次启动都写明它（`delorun/apps/cli/tests/changes-left-out.integration.spec.ts`） |
| `the retry writes nothing to the profile` | 要求 12：在遗漏一项更改并启动两次之后，`package.json`、锁文件、`cordis.patch.yml`、`node_modules` 链接和 profile 历史逐字节相同（`delorun/packages/changes/tests/left-out.integration.spec.ts`） |
| `a second failure stops with the safe-mode command and does not retry again` | 要求 12：只有一次第二次启动，安全模式命令那一行只出现一次，并且较早的更改仍保持已应用（`changes-left-out.integration.spec.ts`；后台启动者见 `changes-retry.spec.ts`） |
| `a left-out change stays out at the next start until applied or undone` | 要求 12（`left-out.integration.spec.ts`） |
| `applying a left-out change loads it again` | [启动失败时](#when-a-start-fails)：失败的重新加载使它继续被遗漏（`left-out.integration.spec.ts`） |
| `refuses left-out content with protection on that no change left out of the plugin holds, and accepts holding nothing` | 针对不变量的要求 12（`left-out.integration.spec.ts`） |
| `only the start's retry leaves a change out, and no route, tool or plugin names it` | 要求 12（`reach.spec.ts`） |
| `doctor names the plugin and the change a failed start left out, and what its plugin runs instead` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`doctor/changes.spec.ts`） |
| `applying a harness change never writes under runtimes/` | 要求 15：安装的字节、模式和 inode 不变（`delorun/packages/changes/tests/harness.integration.spec.ts`） |
| `a copy whose signed file differs from the signed list is refused and leaves no copy`, `reads signed files only through the verified list` | 要求 15（`harness.integration.spec.ts`） |
| `a pending harness change never runs: the start runs the signed entry` | 要求 16（`delorun/apps/cli/tests/changes-harness.spec.ts`） |
| `an applied change runs: the composed tree holds the approved file and hard links to every other signed file`, `an applied change runs: the start hands off to the composed tree's entry with the same arguments` | [harness 编辑](#harness-edits)（`delorun/packages/changes/tests/harness-tree.integration.spec.ts`、`changes-harness.spec.ts`） |
| `a composed tree with a changed, extra or missing file is rebuilt once`, `a composed tree that fails its check after it was rebuilt refuses the start, naming the path` | 要求 17（`harness-tree.integration.spec.ts`、`harness-tree-refusal.integration.spec.ts`） |
| `a changed file whose inode differs from the installation's only past 2^53 is not taken for its hard link` | 要求 17：设备和 inode 按 bigint 比较（`harness-tree-refusal.integration.spec.ts`） |
| `a file where the trees' directory belongs refuses the start with HARNESS_CHANGED naming it`, `a path in the way of a hard link refuses the start with HARNESS_CHANGED naming it`, `never removes a tree a start chose within the grace period, built or reused` | [harness 编辑](#harness-edits)（`harness-tree.integration.spec.ts`、`harness-tree-refusal.integration.spec.ts`） |
| `edit-harness refuses before copying anything when the copy would pass the limits of its scan`, `a copy that cannot be scanned is refused with HARNESS_COPY_UNREADABLE naming the copy and the way back` | [harness 编辑](#harness-edits)（`harness.integration.spec.ts`） |
| `a process already in a composed tree, or outside the store, runs the start itself`, `a process in a composed tree starts the signed installation's entry, and the hand-off the composed tree's` | 要求 17（`changes-harness.spec.ts`） |
| `edit-harness and every harness decision refuse without a terminal`, `edit-harness and every harness decision refuse a proof the attest functions did not issue` | 要求 18（`changes-harness.spec.ts`、`harness.integration.spec.ts`） |
| `a confined command inside a pseudo-terminal cannot lower protection` | 要求 18：对现有可写副本、harness 记录和 harness 日志的受限写入失败（`changes-confinement.integration.spec.ts`） |
| `discarding every harness change returns to the signed release`, `discarding every harness change returns to the signed release: the start runs the signed entry` | 要求 19（`harness.integration.spec.ts`、`changes-harness.spec.ts`；`discarding every harness change from a copy that cannot be read` 组针对超过上限的副本、含有无法读取条目的副本，或本应是链接之处） |
| `the retry leaves out a newest harness change, marks it left out and writes nothing to the profile` | 要求 19（`harness.integration.spec.ts`、`changes-harness.spec.ts`） |
| `leaves the newest harness change out and starts once more through the hand-off, which composes without it`, `a second failure names edit-harness --discard and undo, and starts no third time`, `a start marked as the second one, or one whose newest harness decision was already left out, leaves nothing out`, `never retries for an update's successor, a child whose start ran, or one a signal ended` | 针对在启动之前失败的组合树的要求 19（`changes-harness.spec.ts`） |
| `runs the signed installation without the approved harness changes` | 针对安全模式的要求 19（`changes-harness.spec.ts`） |
| `runtimeOfFile maps a composed path to its runtime` | [harness 编辑](#harness-edits)（`changes-harness.spec.ts`） |
| `verify never prints a plain pass when the composed tree fails its check` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`changes-harness.spec.ts`） |
| `a phone uses a control only where its class lets it, and only with a confirmation it entered`, `the state says what each control needs, with the same decisions the routes make`, `a phone's request from another site is refused before its level or its body` | 要求 23：对于有授权凭证、处于批准宽限期以及没有确认的情形，每个路由都在读取请求体之前答复 `LOOPBACK_REQUIRED` 或 `ELEVATION_REQUIRED`，或者首先答复 `CROSS_SITE`（`delorun/packages/plugin-changes/tests/decisions.spec.ts`、`face-grants.spec.ts`） |
| `a harness decision in the studio needs the studio proof`, `a remote session cannot apply, discard or undo a harness change`, `a Host that runs no installed release decides no change to Delorun itself` | 要求 18：被拒绝之后记录和日志不变，设备只有持有针对该请求的授权凭证才能应用，没有运行时的 harness 时为 `409 HARNESS_UNAVAILABLE`（`decisions.spec.ts`） |
| `a plugin's action route refuses a change to Delorun itself` | 对 `apply`、`discard` 和 `undo` 上的 harness 更改 id 回答 `409 HARNESS_ROUTE`（`routes.spec.ts`） |
| `a cross-site request cannot restart`, `a remote or locked session cannot restart` | 针对 `restart` 与 `restart-cancel` 的要求 23：请求体之前先 `CROSS_SITE`，不是已配对设备的会话为 `LOOPBACK_REQUIRED`，没有授权凭证或处于宽限期的设备为 `ELEVATION_REQUIRED`，并且 home 进程的重启从不被询问（`delorun/packages/plugin-changes/tests/restart-route.spec.ts`） |
| `a reloadable change takes effect without restart`、`a live file is served only to a request Connection admits`、`a non-reloadable change is never applied live`、`a failed live reload leaves previous code running and the change left out` | [实时更改与重启](#live-changes-and-restart)：对围栏拒绝的请求，实时文件的路由回答 `401` 或 `403` 且不返回任何字节（`delorun/packages/plugin-changes/tests/live-apply.spec.ts`） |
| `the studio turns protection off only after the second confirmation`, `a remote session cannot change protection`, `a cross-site request cannot change protection` | 要求 13 和 23：在 `confirmed` 之前为 `409 CONFIRM_PROTECTION`，日志中记录 `decidedFrom: "studio"`，没有授权凭证的设备被拒绝，处于宽限期的设备被拒绝，设备的更改留下设备无法清除的通知，以及请求体之前先 `CROSS_SITE`（`decisions.spec.ts`） |
| `the studio sets protection, and a paired device only with an unlock the person entered` | 要求 4 和 23：`attestDevice` 拒绝没有新解锁的设备，伪造的证明仍被拒绝（`delorun/packages/changes/tests/records.spec.ts`） |
| `lists the protection changes a phone made, and a list at a terminal dismisses them`、`protection off states what off means and asks twice; only y to both writes it, and the log records the weakening` | [保护设置](#the-protection-setting)和[命令](#commands)（`changes-command.spec.ts`） |
| `lists the changes to Delorun itself with Review, and Undo where one takes the change back`, `names the device that decided a change, in Recent and among the changes to Delorun itself`, `offers the release command, and no other terminal command, where Delorun can change its own files` | [studio 的 Changes 一节](#the-studios-changes-section)：已决定的更改显示其差异，或说明 Delorun 已不再保留它，Undo 只在 `undoable` 处出现，已配对设备的 `decidedOn`，以及 `delorun changes edit-harness --discard` 作为唯一的终端命令（`changes-section.client.spec.tsx`） |
| `shows a change waiting in the copy and applies exactly the version its review showed`, `asks a second confirmation before applying a flagged change to Delorun itself, and sends the confirmation with the reviewed version`, `discards a change waiting in the copy only after a confirmation` | 该节中的要求 18：Apply 提交 `harness-apply`，其 `to` 取自审查自己的读取，`confirmedRisk` 只在第二次确认之后发送，列表中的 Discard 在确认之前不提交任何内容（`changes-section.client.spec.tsx`） |
| `says what a restart interrupts, waits for the running chat, and shows Restarting until Delorun answers again without one`, `stops the running chats when asked, and cancels a restart still waiting for them`, `says the changes run at the next start where Delorun cannot restart itself, with no Restart` | [The studio's Changes section](#the-studios-changes-section)，重启：对话框写明正在运行的对话，Wait, then restart 提交 `restart {}`，Stop chats and restart 提交 `{ stopChats: true }`，读取失败时卡片保留，一次不含 `restart` 的读取以一个 toast 结束它，Cancel restart 提交 `restart-cancel {}`，不可用的重启不提供按钮（`changes-section.client.spec.tsx`） |
| `after a failed start says Delorun kept running and names the change left out, which Undo takes back after a confirmation`, `offers Try again when the chats were still running, without claiming how many` | [The studio's Changes section](#the-studios-changes-section)，重启：`failed` 的重启是一条带原因和失败的警示，确认后 Undo 为被略过的更改提交 `harness-undo`，Try again 的对话框不写明对话数量（`changes-section.client.spec.tsx`） |
| `keeps Restart at the computer without a grant, and asks a phone to confirm first` | 该节中的要求 23：Restart now 在已锁定的手机上以「Unlock this phone first」保持可用，按下它发出一次请求（`changes-section.client.spec.tsx`） |
| `offers to reload the page after a change to the studio's own files, and says when a change could not run live and is left out` | [The studio's Changes section](#the-studios-changes-section)：`page: true` 的 `live` 回答给该行加上 Reload the page，`left-out` 回答是一个附带失败的 toast（`changes-section.client.spec.tsx`） |
| `makes the person's copy of Delorun and shows where it is (created: %s)`, `says a copy of Delorun cannot be read, in the group, and lists nothing as waiting` | [studio 的 Changes 一节](#the-studios-changes-section)：Make my copy 提交 `harness-copy` 并显示文件夹，无法读取的副本是警示，不把任何内容列为等待中（`changes-section.client.spec.tsx`） |
| `is off when the home has no record` | 保护关闭：[保护设置](#the-protection-setting)的默认值（`records.spec.ts`；`changes-command.spec.ts` 有 `prints the setting with on\|off without a terminal, and off for a home without a protection record`） |
| `protection off states what off means and asks; only y writes it, and the log records the weakening`, `protection on states what on means and asks; only y writes it, and the log records no weakening`, `refuses the old settings warn and block, and anything else, as a usage error that asks nothing` | [命令](#commands)（`changes-command.spec.ts`） |
| `loads a changed folder and a new link without review, approves them and logs each as unreviewed`, `keeps the approved content when the folder is gone` | 保护关闭：启动时的要求 20（`enforce.integration.spec.ts`；`changes-command.spec.ts` 有 `a changed plugin folder loads at the next start without review, logged as an applied change list, show and undo reach` 和 `a plugin linked since the last start loads at the next start without review`） |
| `does not load content the person declined, and loads the folder again once it holds something else` | 保护关闭：启动时的要求 21（`enforce.integration.spec.ts`） |
| `a link moved before a reload loads without review and is logged, approving nothing at upgrade` | 保护关闭：重新加载之前的要求 20（`enforce.integration.spec.ts`；`reload-check.spec.ts` 中通过上游热重载的 `with protection off, a link:<folder> install while Delorun runs loads the folder, logged as unreviewed`，以及 `plugin-command.spec.ts` 中的 `with protection off, delorun plugin add link:<folder> loads the folder at once, logged as loaded without review`） |
| `with protection off, keeps the approved content of a folder that cannot be read, even without its installed packages`, `with protection off, keeps the approved content of a folder that changed while it was read`, `with protection off, loads a plugin too large to copy with its installed packages from where they are installed, and says where` | 保护关闭：要求 11 和[加载已批准的内容](#loading-approved-content)（`load-check.integration.spec.ts`） |
| `loads a saved folder, approves it, logs it as unreviewed, and list, show and undo reach it`, `keeps the approved content and logs it when Delorun is not running` | 保护关闭：针对实时重新加载的要求 20（`delorun/packages/changes/tests/unreviewed.integration.spec.ts`；`delorun/apps/cli/tests/changes-unreviewed-watch.spec.ts` 中通过监视器的 `reloads the Host and logs an applied change decided unreviewed with one history version`） |
| `goes back when the reload fails, logs the failure, and does not try the same content again` | 保护关闭：针对失败的实时重新加载的要求 21（`unreviewed.integration.spec.ts`；`changes-unreviewed-watch.spec.ts` 中的 `puts back what ran before and logs the change pending with the failure`） |
| `keeps a change a failed start left out while the folder still holds it, and loads new content`, `loads a plugin whose install was undone once its folder holds something else` | 保护关闭：要求 21（`unreviewed.integration.spec.ts`） |
| `loads nothing with protection on: turning it on takes effect at the next save`, `turning protection on stops the live loads without a restart, and turning it off again resumes them` | 要求 22：每次加载时读取该设置（`unreviewed.integration.spec.ts`、`changes-unreviewed-watch.spec.ts`） |
| `leaves a plugin in a work session, an unlinked one and one whose folder is gone to others`, `leaves out events inside .git and for other files of changes/`, `a burst of saves within the debounce loads once, with the last save` | [无需审查的加载](#loading-without-review)（`unreviewed.integration.spec.ts`、`changes-unreviewed-watch.spec.ts`） |
| `only the Host's folder watch and the start load content without review, and no route, tool or plugin names them` | 要求 22（`reach.spec.ts`） |
| `a start applies every edit of the copy without review, logs each as unreviewed, and undo takes it back`, `applies nothing with protection on, or without a copy`, `applies nothing from a copy that cannot be read, and says why` | 保护关闭：针对 harness 可写副本的要求 20 和 22（`harness.integration.spec.ts`；`changes-harness.spec.ts` 中通过启动的 `the start applies an edit of the writable copy without review, logs it, says so and runs the composed tree`） |
| `verify and doctor name a harness file that loaded without review, and say when protection was off`, `names content that loaded without review in either setting, pending changes, and a plugin waiting for review` | [verify 与 doctor 报告什么](#what-verify-and-doctor-report)（`changes-harness.spec.ts`、`doctor/changes.spec.ts`） |
| `runs every action the tool offers and records each in Changes as unreviewed, with the version before it, at protection off` (and `none`), `lets configure reach upstream's approval too`, `runs nothing and records nothing when the person does not give the full-access approval`, `records nothing for an action that left the profile as it was`, `a listener that allows the call without the plugin's listener is still overruled by its guard` | 保护关闭：[保护关闭时智能体的插件操作](#the-agents-plugin-actions-with-protection-off)（`plugin-changes.spec.ts`） |
| `reports an action it ran but could not record, and does not hide it`, `holds a call whose history Changes cannot read, as the action could not be recorded`, `reports an action that changed the profile when no history version was saved for it` | 同一节：失败的记录会被报告，无法记录的调用不会运行（`plugin-changes.spec.ts`） |
| `records the action before it runs, so a plugin it loads is already in Changes`, `keeps the entry when the action stops without a result, and says Delorun did not see how it ended`, `finishes the entry although an earlier post-execute listener blocks the result` | 同一节：围绕该工具的两个步骤（`plugin-changes.spec.ts`） |
| `leaves the change log byte for byte as a release without the agent log reads it`, `leaves log.json byte for byte as it was, with only what the release before the agent log reads`, `fails loud for Changes when it is corrupt, and never for what a start reads`, `refuses an entry kind or field the log has not declared` | [兼容性](#compatibility)：`log.json` 旁边的智能体操作日志（`plugin-changes.spec.ts`、`agent-actions.integration.spec.ts`） |
| `a protection record that cannot be read holds every call as with protection on`, `reads the setting at each call, so changing it takes effect in the running Host without a restart` | 要求 8 与[保护设置](#the-protection-setting)：无法读取的记录会拦住每个操作，而再次开启保护会在下一次调用时拦住安装并拒绝开启（`plugin-changes.spec.ts`） |
| `records each kind of action as applied and unreviewed with the version it wrote and the one before it`, `removes the entry written before the action when the action changed nothing`, `gives a repeated action a new entry each time`, `keeps an action whose version could not be saved, and says so`, `does not tell which version is whose when two actions wrote versions at once`, `records no version before it when the person's own change lies between` | 记录智能体的操作（`delorun/packages/changes/tests/agent-actions.integration.spec.ts`） |
| `brings the version before the action back, installs its dependencies, records a version and reloads`, `keeps an edit the person made by hand before the action`, `keeps the home patch the person edited since, and the profile's copy of it`, `keeps a plugin the safety record keeps disabled disabled`, `waits for the profile write lock`, `refuses once a later change of the profile follows, and an action already undone`, `puts the files back and keeps the change applied when the install fails`, `goes back and keeps the change applied with the failure when the Host fails to load the undo` | 撤销智能体的操作（`agent-actions.integration.spec.ts`） |
| `with protection off, the agent's write to an approved plugin's folder does not ask, and the active directories stay refused`, `reads the setting at each write, so changing it takes effect in the running Host without a restart`, `refuses a write when the protection setting cannot be read` | 保护关闭和要求 8（`plugin-folders.spec.ts`） |
| `the studio applies a queued install with protection on through the plugin operation, after a second confirmation`, `a removal asks the second confirmation too, a failed operation leaves the request waiting, and Discard declines one` | [路由与恢复屏幕](#routes-and-the-recovery-screen)（`routes.integration.spec.ts`） |
| `applies an agent's plugin request after a confirmation and the second confirmation that names what it installs`, `with protection off, says that changes load and linked plugins reload live on save without review, and shows the switch off` | [studio 的 Changes 一节](#the-studios-changes-section)（`changes-section.client.spec.tsx`） |
| `names the plugins and files that load without review before protection goes off, and turns it off with the confirmation`, `says nothing waits for review when protection goes off with nothing waiting, and Cancel sends nothing more` | 该节中的[保护设置](#the-protection-setting)：开关提交 `protection-off {}`，`409 CONFIRM_PROTECTION` 回答的 `willLoad` 填充那一次确认或说明没有内容等待，只有其确认才提交 `{ confirmed: true }`，Cancel 让该设置保持开启（`changes-section.client.spec.tsx`） |
| `shows a protection notice from a phone and dismisses it by its id` | 该节中的[保护设置](#the-protection-setting)：每条通知写明其设备，关闭通知说明该怎么做，Dismiss 以该通知的 id 提交 `notice-seen`（`changes-section.client.spec.tsx`） |
| `closes the owner's case: approved and previous release differ only by the build folder, the new release is signed`, `closes a change whose only difference is the previous release's own files, whichever protection` | [更新期间的插件包](#plugin-packs-across-an-update)（`delorun/packages/changes/tests/update-baseline.integration.spec.ts`） |
| `leaves an approved edit waiting: a file the release does not list`, `leaves an edit waiting in any other line of package.json or pnpm-lock.yaml`, `does not close a change that mixes release files with an edit, and the whole change keeps waiting` | [更新期间的插件包](#plugin-packs-across-an-update)：本人的编辑绝不会被并入基线 |
| `treats a folder that is not exactly the signed pack as a person's change`, `treats a pack whose digest the verified list does not give as a person's change`, `applies the build folder allowance to no other file`, `closes the build folder difference only for an update that leaves such a release`, `ends with the last release that shipped build folder names`, `counts only the packs files of the two releases of the update` | [更新期间的插件包](#plugin-packs-across-an-update)：只有已验证包文件所列出的内容才算数 |
| `never replaces content for a start without a baseline`, `never replaces content for a reload, even one that moves a link to the pack's folder`, `leaves a plugin that is not a pack of the home alone`, `leaves content the person declined waiting` | [更新期间的插件包](#plugin-packs-across-an-update)：没有其他启动或插件会推进基线 |
| `asks for the signed files of a pack only when a change waits on it, and still checks that pack fully`, `reads no pack until a waiting change asks for it, and each pack once`, `gives a pack that cannot be read no files and says so once, so its change waits`, `lists no files for a pack the release does not list` | [更新期间的插件包](#plugin-packs-across-an-update)：基线只读取等待中的更改所触及的包（`delorun/packages/changes/tests/update-baseline.integration.spec.ts`、`delorun/apps/cli/tests/changes-update-gate.spec.ts`、`delorun/packages/runtime-store/tests/packs-client.integration.spec.ts`） |
| `is an update to a newer semantic version`, `gives none for a downgrade or the same release, though both releases' packs files would verify`, `gives both releases' signed packs of the pack asked for, so the denial above is the guard's`, `is never a rollback's handover, a restart or a start without a handover`, `throws, so nothing is replaced, when the running release's packs file does not verify` | [更新期间的插件包](#plugin-packs-across-an-update)：降级或无法验证的包文件绝不会替换任何东西（`delorun/apps/cli/tests/changes-update-gate.spec.ts`） |
| `replaces nothing when no update left a release, and nothing at the pre-start step of a start, whatever it was given`, `applies the baseline once: a boot after a failed switch never does`, `leaves the changes waiting, and says so, when the signed files cannot be verified`, `leaves the changes waiting, and says so, when the packs environment cannot be read, and the boot goes on`, `replaces nothing in a process that is not an installed release`, `never advances the baseline: a person's rollback from a newer release leaves the pack's change waiting` | 同上（`delorun/apps/cli/tests/changes-update-baseline.spec.ts`） |
| `closes the pack's waiting change when the update's successor takes over, and logs it in the history`, `applies nothing in a fresh start of the home process` | 同上，经由 `startForeground` 与 `HomeProcess.takeOver`（`delorun/apps/cli/tests/changes-update-takeover.integration.spec.ts`） |
| `boots the predecessor again with nothing advanced and nothing lost`, `still refuses the boot of a Host that is not after a failed switch`, `lets the predecessor boot again: its active copies follow the approved record the rollback restored`, `changes nothing when the records agree, and leaves a work session's or left-out copy alone`, `resumes a predecessor that cannot follow the approved record, once the successor abandons its boot`, `refuses the same predecessor when the successor did not abandon`, `keeps what a person changed after the baseline, and puts back only what the baseline changed`, `puts back the approved and active entries the baseline changed, so a predecessor without followApprovedContent resumes`, `keeps an entry that changed after the start, and removes an entry the start added`, `leaves the records as the predecessor left them when the successor fails its health check, so a release without followApprovedContent resumes`, `applies nothing in the takeover of a rollback, whose signed packs files would both verify`, `a successor that fails its health check abandons what its boot changed before the predecessor rolls back, and a runner that cannot still reports the failure` | 基线推进之后的健康检查失败（`delorun/apps/cli/tests/changes-update-baseline.spec.ts`、`delorun/packages/changes/tests/update-baseline.integration.spec.ts`） |
| `fills the active directory of an entry the start added with nothing, so a predecessor that records none resumes`, `a successor whose boot does not finish in time undoes what it changed and reports the failure itself, before the predecessor would stop it`, `waits for the baseline, then undoes it, so a successor that gives up during it leaves nothing advanced`, `abandons without undoing when the baseline throws, which has undone itself` | 基线推进之后的健康检查失败，以及后继进程自己的期限（`delorun/packages/changes/tests/update-baseline.integration.spec.ts`, `delorun/packages/home-process/tests/home-process.integration.spec.ts`, `delorun/apps/cli/tests/changes-start.spec.ts`) |
| `gives no text from an installed pack that differs from its signed list, and no files without a packs file`, `refuses a stored packs file that no longer verifies`, `refuses a stored packs file whose signature has one character flipped, though its log record verifies` | 同上（`delorun/packages/runtime-store/tests/packs-client.integration.spec.ts`） |

### 本约定不能证明的内容

- 默认审查：除非本人开启，保护是关闭的，保护关闭时，这里没有任何东西审查所加载的内容。已链接插件的文件夹或 harness 可写副本的任何写入者（沙箱之外的进程），都会在下一次启动或保存时改变 harness 所运行的代码；关闭状态下的要求只证明每个这样的更改都被记录、可以被撤销，并且被拒绝的内容不会再次加载（[保护设置](#the-protection-setting)）。
- 本人用户在沙箱之外的进程：它可以写入运行时的已批准 harness 记录、内容存储以及 `changes/` 之下的更改日志（[C1](c01-home-layout.zh.md#the-home-tree)），下一次启动会在每项检查都通过的情况下，从组合树运行它所写入的内容；只有 `delorun verify` 和 `delorun changes list` 所写明的已批准文件才会显示它（[威胁模型](../security/threat-model.zh.md)）。`changes/store/` 之下已批准插件的内容同样如此。
- 在电脑上的 studio 中：这些路由根据请求从何处到达来决定，因此通过 SSH 端口转发到回环监听器的请求算作在电脑上，如同 [C5](c05-device-approval.zh.md) 对所有者认领所算的那样，持有 studio cookie 的本地程序也是如此；目前还不存在会话因子。
- 完全访问：具有完全访问权限的工作区以本人自己的权限运行命令，因此在那里工作的模型可以关闭保护并批准更改。Changes 防范的是受限的模型，而不是本人自己的访问权限。
- 注册表、`file:`、git 和 tarball 插件：只有从文件夹链接的插件受 Changes 管理；其他的按上游的安装方式加载。
- 插件未链接的依赖：已安装的包连同其 `package.json` 所列且安装在它旁边的依赖一起被复制。插件或被复制的包在没有这些的情况下导入的模块（例如被 pnpm 提升的包），由 Node 从活动目录的父目录一直解析到文件系统根目录，其中包括本人的主文件夹；放在那里的 `node_modules` 目录中、受限命令可能能够写入的包会被加载。保护关闭时，只因其已安装的包而超过内容上限的插件，会从这些包的安装位置加载它们，并且启动会说明这些位置何时位于主文件夹之下。
- 通过源监视而改变的运行中 Host 的模块：Delorun 不设置 `hmr.root`；其自身配置监视活动目录的 profile 会在没有该检查的情况下替换模块，不过只有 Delorun 才写入活动目录。
- 客户端插件代码：插件向 studio 的浏览器提供的代码不受 Changes 审查。
- 从源码运行：源码检出从检出处运行整个 harness，因此在仓库内工作的模型可以编辑 Host 所运行的代码。
- 插件代码一旦被批准，就可以做 Delorun 能做的任何事；风险摘要并不限制它。已批准的 harness 更改同样如此。
- 组合树中未编辑的文件是指向安装文件的硬链接，因此共享其 inode 和模式：以本人权限原地重写其中之一的进程，也会更改安装的文件，随后安装的启动检查会拒绝它。受限命令两者都不能写。
- `app/` 超过扫描上限（50,000 个条目或 512 MiB）的发布无法被编辑：`edit-harness` 在复制之前拒绝它。之后增长到超过上限的副本无法作为待处理的更改读取；`list` 写明它，`edit-harness --discard` 移除它。已发布闭包的 `app/` 是否保持在这些上限之内，并没有规格检查。
- 只要任何 profile 的 home 进程在运行，保留就会保持该运行时的每棵组合树，因此这些树会不断累积，直到某次启动发现没有运行中的进程。
- 只有 `delorun start` 和不带参数的 `delorun` 交接给组合树。`delorun headless` 和其他每个命令运行已签名的安装，因此本人已批准的 harness 更改不适用于它们。
- 源码检出是开发者模式，而不是已安装的发布：包括 Delorun 的 bundle 在内，Changes 不处理这些包。
- 只询问文件工具的写入；shell 命令向插件文件夹的写入不询问（[智能体与插件](#the-agent-and-plugins)）。应用智能体的请求不运行 `pluginAudit`，因为没有任何 Delorun 组合挂载它；其自身 bundle 提供了它的 profile，在请求被应用时不会被审计。
