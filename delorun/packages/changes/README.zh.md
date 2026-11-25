---
description: "@delorun/changes 库：从文件夹链接的插件的已批准副本、变更日志、根据文件夹计算出的待处理变更及其 diff 和风险摘要、保护设置以及保护关闭时无需审阅即加载的内容、带实时重新加载的工作会话，以及加载已批准内容的启动步骤。"
---

# @delorun/changes

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本人的 harness 是已签名的发布版本加上他们所做的变更，每项变更都有记录；保护开启时，则只有他们在自己的电脑上批准过的变更。本包保存 profile 从文件夹链接的每个插件的已批准副本，计算文件夹相对该副本改变了什么，并使 profile 加载已批准的副本，而不是文件夹。保护关闭（默认）时，它在每次启动以及 Delorun 运行期间每次保存时，把文件夹的内容变成已批准副本，并记录为决定为 `unreviewed` 的变更。它还保存本人对 harness 本身的变更：他们已安装发布版本的可写副本、他们批准过的文件，以及启动时运行的、取代已签名安装的组合树（本包从不写入该安装）。约定见 [C21](../../docs/contracts/c21-changes.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [文件位置](#where-the-files-are)
- [profile 如何加载已批准内容](#how-the-profile-loads-approved-content)
- [待处理变更与风险摘要](#pending-changes-and-the-risk-summary)
- [记录及其写入者](#records-and-who-writes-them)
- [本人可对变更执行的操作](#what-a-person-does-with-a-change)
- [无需审阅即加载](#loading-without-review)
- [工作会话](#work-sessions)
- [启动失败时](#when-a-start-fails)
- [更新期间的 harness 变更](#harness-changes-across-an-update)
- [Plugin packs across an update](#plugin-packs-across-an-update)
- [导出与导入 setup](#setup-export-and-import)
- [不涵盖的内容](#not-covered)
- [开发](#development)

<a id="use-this-package"></a>

## 使用本包

```text
import { enforceApprovedContent, pluginChange, startNotice } from '@delorun/changes'

const changes = await enforceApprovedContent({ home, profile, profileDir })
output(startNotice(changes))
```

`delorun start` 和 `delorun headless` 在其启动前步骤 `changes` 中，经由 `delorun/apps/cli/src/changes/start.ts` 调用 `enforceApprovedContent`，时间早于上游准备 profile。`enforceApprovedContent` 最后检查链接和活动目录（`checkLoadedContent`），某一项不是「变更」所保存的内容时以 `LOAD_REFUSED` 拒绝，并回收存储（`collectStore`，[C21](../../docs/contracts/c21-changes.zh.md#collecting-the-store)）。`prepareReload` 是运行中 Host 每次重新组合之前的同一项检查，`@delorun/plugin-changes` 把它作为 `profileReconcileCheck` 提供给上游的热重载，`delorun plugin` 在上游的操作之后运行它：在 profile 写锁允许时，它把指向文件夹的链接移动到其活动目录，并拒绝其他任何不同之处。`checkChangesInvariants` 增加了「每个已批准版本都能从存储中读回」的检查，供 `delorun verify` 和 `delorun doctor` 使用，而组合中的「已批准插件内容」步骤在它返回任何不成立的不变量时拒绝启动。`changesStatus` 给出 `delorun verify` 和 `delorun doctor` 报告的内容，且不写入任何内容；`writeBootRecord` 和 `readBootRecord` 保存 `run/<profile>/changes-boot.json`，即上次启动时加载了哪些受「变更」管理的插件。

<a id="where-the-files-are"></a>

## 文件位置

所有内容都位于 Delorun home 的 `changes/` 之下，受限命令既不能读也不能写它（约定 C1）。`store/objects/` 按 SHA-256 保存文件内容，`store/versions/` 保存每个内容版本的文件列表，以其条目的 SHA-256 命名。`profiles/<profile>/active/<plugin>/` 是 profile 的 `link:` 依赖所指向的目录；`active.json` 说明每个目录保存了什么，`log.json` 是变更日志，`work-session.json` 是工作会话。`protection.json` 保存保护设置，`notices.json` 保存已配对设备所做的保护变更，`migration.json` 保存「变更」首次启动时 home 所持有的 profile。profile 的 `package.json` 在 `delorun.changes` 下记录每个已批准插件的文件夹和版本，所以 profile 历史的每个版本都包含它。插件写入自己活动目录的任何内容（例如缓存的令牌）都可被沙箱命令读取，所以插件应把它的密钥保存在凭据存储中。

<a id="how-the-profile-loads-approved-content"></a>

## profile 如何加载已批准内容

pnpm 每次操作都会重置 `link:` 依赖的 `node_modules` 链接，所以启动时由它自己移动记录的依赖：`package.json`、锁文件的 importer 条目以及链接名称都指向活动目录。活动目录保存已批准的版本；没有已批准版本的插件则为空，因此上游会跳过它；在工作会话中则保存文件夹的内容。保护关闭时，启动会先把文件夹的内容变成已批准版本（[无需审阅即加载](#loading-without-review)），除非本人拒绝了恰好这份内容。与目录应保存的内容不同的文件就地替换，所以上游的热重载恰好替换发生变化的模块。

「变更」启动时 home 所持有的每个 profile，在「变更」下的首次启动会按原样批准其所有链接的插件（`migratesAtUpgrade`），之后的启动会一直指名这些插件，直到某个终端展示过它们（`markShownAtUpgrade`）。之后链接的插件，或之后创建的 profile 所链接的插件，在保护开启时等待审阅，在保护关闭时无需审阅即加载。指向运行时存储的链接，以及指向运行中的安装为该包携带的目录的链接，属于 harness 而不是插件，保持不动：源码检出会从检出目录运行整个 harness。在插件文件夹内，若一个链接的真实路径（解析所有链接和 `..` 之后）位于活动运行时的已安装包（`runtimes/<current>/app/node_modules/`）中，它在副本中仍是指向该已签名包的链接，就像插件包链接发行版携带的包那样；不会复制任何运行时字节。版本记录的是该包在此文件夹下的路径，所以更新或回滚不会改变已批准的版本，下次启动时会把副本中的链接重新指向正在运行的发行版。插件指向兄弟工作区包的链接（在 `node_modules/<name>` 处链接的、含 `package.json` 的目录）和指向已安装包的链接（位于 `node_modules` 目录之下），按哈希计入它的内容，已安装的包连同安装在其旁的依赖一起计入，限制为 50,000 个文件、链接和目录以及 512 MiB，每个文件的读取不超过已统计的大小。文件夹之外的任何其他链接，以及任何其他指向 Delorun home（包括其他运行时版本）、`/proc`、`/sys` 或 `/dev` 的链接，都不会计入副本。文件夹缺失的链接与其他链接一样被移动到其空的活动目录，所以之后在那里创建的文件夹会等待审阅。超出限制的文件夹，或无法读取的文件夹，从不会使启动停止：已批准的内容继续运行，启动时会指名该插件；但在保护关闭时，仅因其已安装包而超出限制的文件夹，会从这些包安装的位置加载它们。

<a id="pending-changes-and-the-risk-summary"></a>

## 待处理变更与风险摘要

`pluginChange` 把文件夹的内容存为一个版本，并与已批准的版本比较：新增、修改和删除的文件，上限为 256 KiB 的统一 diff（大于 1 MiB 的文件和二进制文件只列出名称），以及风险摘要。变更 id 由插件、其文件夹以及两个版本派生，所以应用某个 id 就恰好应用了展示过的那份内容。`reviewChange(input, checks)` 运行九项内置检查，其中包括 `not-shown`，它列出 diff 未显示其行的每个新文件：Node 会加载的二进制文件、超出 diff 限制的文件，以及文件夹内某个依赖的文件；它是以后的扩展点添加已注册检查的唯一位置。该摘要是对读者的帮助，而不是一种保护：插件的代码能做 Delorun 能做的任何事。

<a id="records-and-who-writes-them"></a>

## 记录及其写入者

每条记录都是一个 0600 的文件，其读取器遇到未知字段、值或权限时以 `RECORD_UNREADABLE` 拒绝。`readProtection` 应答 `on` 或 `off`，没有 `protection.json` 的 home 为 `off`。`setProtection` 接受三个 attest 函数中任一个签发的证明，因此关闭保护依赖于终端的证明、studio 的证明，或者已配对设备的证明（需带有针对该请求的授权凭证）。`attestTerminal` 要求标准输入和输出是终端。`attestStudio` 为来自本机的请求（回环 `Host` 下的回环监听器，带 studio 的凭据，同源请求，而非远程会话）签发 studio 的证明。`attestDevice` 为持有针对该请求的授权凭证（从不是批准宽限期）的已配对设备签发 studio 证明，并指明该设备。只有 `@delorun/plugin-changes` 的路由调用 `attestStudio` 和 `attestDevice`，并且只在控件的类别允许设备操作时才调用 `attestDevice`（[C21](../../docs/contracts/c21-changes.zh.md#who-may-do-what-from-where)）。变更日志把两种 studio 证明都记录为 `decidedFrom: "studio"`，设备所做的决定还会在 `decidedOn` 中指明该设备，`withoutDecision` 会在之后的任何决定之前清除它。除非证明由某个 attest 函数签发，否则被拒绝。该证明无法区分人与模型（其终端工具有真实的伪终端）；受限的模型由沙箱挡在外面，沙箱不允许它在 home 之下写入任何内容。`pluginSlug` 在用名称构造任何路径之前，拒绝不是包名的名称。`noteLoaded` 和 `noteFailed` 在已打开的工作会话中记录 Host 加载或加载失败的内容，不需要证明。`writeWorkFailure` 和 `readWorkFailure` 保存 `run/<profile>/changes-work.json`，即工作会话中最近一次失败的重新加载。

`src/notices.ts` 保存 `changes/notices.json`，模式 `delorun.changes-notices/1`：最多 20 条由已配对设备所做的保护变更，按从旧到新排列，以便电脑告诉本人。`readNotices` 列出它们，`addProtectionNotice` 由 `changeProtection` 调用，`dismissNotice` 接收终端或电脑的证明，并拒绝指明设备的证明，因此手机无法清除它自己所做的变更。该记录与变更日志分开，变更日志保持其模式。

<a id="what-a-person-does-with-a-change"></a>

## 本人可对变更执行的操作

`src/actions.ts` 存放 `delorun changes` 和 studio 的「变更」路由所调用的操作。`listChanges` 计算每个插件的文件夹相对其已批准内容保存了什么，隐藏针对该内容已被丢弃的变更，并返回启动失败时被遗漏的变更（`leftOut`）和其他已记录的变更（最新的在前）、文件夹已不存在的插件、保护设置以及任何工作会话；`showChange` 返回一个变更或其日志条目。`recordedChanges`（`src/state.ts`）仅凭已批准的记录和变更日志，向 studio 的 `state` 路由提供受「变更」管理的插件及其文件夹，以及等待审阅的 agent 请求，不写入任何内容，也不读取任何文件夹。`applyChange`、`discardChange`、`undoChange`、`turnOff`、`turnOn` 和 `changeProtection` 接收 `AtComputer` 证明，并在读取任何内容之前拒绝不是 attest 函数签发的证明；`changeProtection` 把关闭保护记录为已应用的 `guard-weakening` 变更，其决定位置由证明说明；对于指明设备的证明，还会添加一条保护通知。`applyChange` 恰好批准 id 所指名的版本，文件夹保存的是其他内容时以 `CHANGED_SINCE_REVIEW` 拒绝；`turnOff` 和 `turnOn` 只编辑 `dsh.profile.bundles`，并拒绝 Delorun 自己的 bundle。

`src/install-actions.ts`（也是入口 `@delorun/changes/install`）存放 agent 的插件请求（[C21](../../docs/contracts/c21-changes.zh.md#the-agent-and-plugins)）。`recordPluginRequest` 由 `@delorun/plugin-changes` 在 agent 的 `plugin_manager` 要安装、更新或移除插件时调用，它写入一个待处理的 `plugin-install`、`plugin-update` 或 `plugin-remove` 条目，只带 `subject.spec`，别无其他内容。`applyInstallChange` 接收 `AtComputer` 证明，在 profile 写锁之下运行注入的上游插件操作（`add <spec>` 或 `remove <name>`，规格指明文件夹时会传入该文件夹，使操作检查其包），记录一个历史版本并重新加载 Host；操作失败或被拒绝之后，它还原 `package.json` 和 `pnpm-lock.yaml`，用上游的 `recordPendingBuilds` 记录 pnpm 拦下的构建脚本，并让请求带着失败原因保持待处理状态；指明文件夹的规格会被链接到插件的活动目录，该目录在本人应用文件夹内容之前为空，应用的内容会被记录为待处理的文件夹安装。`listChanges` 把等待中的请求作为 `requests` 返回；`applyChange` 拒绝它们，`undoChange` 拒绝已应用的请求。

每项操作都在上游的 profile 写锁之下运行，并记录一个指明变更 id 的 profile 历史版本；丢弃和保护设置不记录。更改 Host 运行内容的操作随后调用注入的 `ReloadHost`，`delorun changes` 用更新通道的 `changes.reload` 实现它，Delorun 未运行时它应答 `undefined`；home 进程对 `changes.reload` 的应答和 studio 的路由，都用 `reloadProfile(hmr)`（[reload](src/reload.ts)）重新加载，即在 Host 自己的进程中使用上游的热重载。重新加载失败时，操作被回退：已批准记录、活动目录和 `active.json`，或 bundle 列表，恢复为原来保存的内容，第二个历史版本记录这一点，该变更带着 `lastFailure` 重新变为待处理，Host 再重新加载一次。

<a id="loading-without-review"></a>

## 无需审阅即加载

`src/agent-actions.ts` 存放保护关闭时运行的智能体 `plugin_manager` 操作（[C21](../../docs/contracts/c21-changes.zh.md#the-agents-plugin-actions-with-protection-off)）。它们的条目位于 `log.json` 旁边的 `agent-log.json` 中（`src/records.ts` 中的 `readAgentLog`，schema 为 `delorun.changes-agent-log/1`），没有它的发布从不读取该文件，因此 `log.json` 保持为那个发布所读取的样子，回到它也仍能启动该 profile；启动只读取 `log.json`，而 `list`、`show`、`undo` 与 studio 的状态读取两者。`planAgentAction(ctx, call)` 在工具运行之前读取该调用将被记录为什么（带规格的安装、更新或移除，或 `plugin-setting-change`）、该 profile 最新的历史版本，以及插件管理所写文件的摘要，并检查两个日志都能读取。`beginAgentAction` 在工具运行之前写入条目，说明 Delorun 还没有看到它如何结束，因此该操作所加载的任何东西都不会未被记录。`finishAgentAction` 依据此后写入的历史版本补全它：`historyVersion` 与 `historyBefore`（紧在它之前的版本，因此本人亲手做的编辑得以保留），两个对话同时操作时没有版本，什么也没有改动时移除条目，文件已改动但历史没有保存版本时为 `unsaved`。`isAgentAction(entry)` 指名这样的条目。`undoAgentAction(ctx, id, presence, { reload, run })` 在给出插件操作时由 `undoChange` 对智能体操作日志所持有的 id 调用，它只恢复插件管理所写的文件（`@delorun/profile-safety` 中 `planRestore` 与 `applyRestore` 的 `scope: 'manager'`），让安全记录保持禁用的插件仍然禁用，在 profile 写锁之下经由 `run` 安装那套依赖（`install --ignore-scripts`，然后 `rebuild --pending`），记录一个历史版本并重新加载，而当安装或重新加载失败时回退并让条目保持已应用并带有 `lastFailure`。当那些文件已不再是该操作留下的样子时，它拒绝。当最新的决定就是这样一个条目时，启动失败不会把任何东西排除在外。

`src/unreviewed.ts` 存放保护关闭时无需审阅即加载的内容（[C21](../../docs/contracts/c21-changes.zh.md#loading-without-review)）。每个写入者都在 profile 写锁或 harness 锁之下再次读取该设置，保护开启时不写入任何内容；没有一个接收在场证明。`enforceApprovedContent` 和 `prepareReload` 把链接插件的新文件夹内容变成它的已批准内容，并记录一个决定为 `unreviewed` 的已应用 `plugin-edit` 或 `plugin-install`（`unreviewedEntry`），`startNotice` 为每一项打印 `unreviewedWords`。`unreviewedFolders(ctx)` 指名 home 进程监视的文件夹；`loadUnreviewed(ctx, plugin, reload)` 仅由 `delorun/apps/cli/src/changes/unreviewed-watch.ts` 调用，它在运行中的 Host 中批准并加载一个文件夹的内容：先在获取profile 写锁之前把文件夹读入存储，再在锁内重新读取记录并据此决定，记录一个历史版本，重新加载失败时还原已批准记录、活动目录和 `active.json`，并让该变更带着 `lastFailure` 保持待处理状态。`declinedByPerson(log, plugin, version)` 扣下那些最新的已决定内容变更被撤销或丢弃的内容。`src/harness.ts` 中的 `applyUnreviewedHarnessChanges(ctx)` 仅由 `delorun/apps/cli/src/changes/harness-start.ts` 调用，它在已签名的启动组合出树之前，应用 harness 可写副本中等待的每个变更，并在无法读取副本时报告该问题，而不应用任何内容。`changesStatus` 和 `harnessStatus` 为 `verify` 和 `doctor` 标记无需审阅即加载的内容（`unreviewed`）。

<a id="work-sessions"></a>

## 工作会话

`startWork(ctx, plugin, proof, { reload, minutes })` 在已批准的插件上打开一个持续 1 到 `WORK_SESSION_MAX_MINUTES`（480）分钟的工作会话，把它的结束时间记录为 `endsAt`，并立即加载其文件夹的内容。`reviewWork(ctx, plugin)` 存储文件夹的内容，并连同它与会话开始时的已批准内容的差异一起返回，供 `done` 展示；`finishWork(ctx, plugin, proof, { reload, approve })` 恰好批准 `approve` 所指名的内容，记录为一个已应用的 `plugin-edit` 变更和一个历史版本 `Work on <plugin>: <from> → <to>`，在 Host 尚未运行它时先加载它，文件夹保存的是其他内容时以 `CHANGED_SINCE_REVIEW` 拒绝。两者都拒绝不是 attest 函数签发的证明。会话持续期间，`loadWorkSession(ctx, reload)` 在文件夹内容对会话是新内容时加载它：把它复制到活动目录并重新加载 Host；重新加载失败时，它还原最后一次加载的内容，再次重新加载，记下失败并写入 `changes-work.json`，保持会话打开；`endsAt` 之后它不加载任何内容，而发现会话已超过 `endsAt` 的启动，会在加载任何内容之前，不经本人而结束该会话。`workSessionFact(home, profile)` 为 `delorun status` 和 studio 的徽章给出打开的会话、它的结束时间以及它最后一次失败的重新加载。

插件继续从其活动目录加载，所以 home 进程自己监视该文件夹（`delorun/apps/cli/src/changes/work-watch.ts`），而不是设置上游的 `hmr.root`，后者会监视并未加载的文件。Delorun 停止时、启动发现一个未正常停止的 home 进程留下打开的会话时，以及到达 `endsAt` 时，`finishWorkWithoutPerson(ctx, why, reload?)` 不经本人结束该会话且不批准任何内容：已批准的内容仍是会话开始时的版本，活动目录再次保存它，文件夹的内容则作为普通的待处理变更等待审阅。它不需要证明，所以只从 `@delorun/changes/stop` 导出，而只有 CLI 的启动模块导入它。

<a id="when-a-start-fails"></a>

## 启动失败时

`src/left-out.ts` 遗漏使启动失败的变更（[C21](../../docs/contracts/c21-changes.zh.md#when-a-start-fails)）。`newestLeavableChange(ctx)` 指名它：最新的、改变了运行内容的决定，条件是它把本人的 `plugin-edit`、`plugin-install`、`plugin-update` 或 `plugin-on` 应用到了一个链接到其活动目录、且该目录保存了该变更内容的插件；否则不指名任何变更，所以第二次失败不会再遗漏更多内容。`leaveOutNewestChange(ctx, failure)` 在 profile 写锁之下只写变更日志，用该失败把条目标记为 `left-out-at-start`；它不接收证明，只有 `delorun/apps/cli/src/changes/retry.ts` 调用它。此后 `enforceApprovedContent` 使该插件的活动目录保存该变更的 `from`（或什么都不保存），`active.json` 的种类为 `left-out`，并在 `startNotice` 中用 `leftOutWords` 指名它，直到 `applyChange` 再次加载它，或 `undoChange` 撤销它。`listChanges` 把这类变更作为 `leftOut` 返回；`leftOutFacts(home, profile)` 把它们交给 studio，`changesStatus` 把它们交给 `delorun doctor`。

## 对 harness 本身的变更

`src/harness.ts` 保存本人对已安装运行时的 `app/` 文件所做的编辑（[C21](../../docs/contracts/c21-changes.zh.md#harness-edits)）。每个函数都接收一个 `HarnessContext`：home、运行中的运行时版本和 `signed()`，后者是带有运行时存储的启动检查所验证的已签名文件列表的安装，仅在需要时读取；从安装读取的每个字节都对照该列表检查。`createHarnessCopy` 创建 `changes/harness/<runtime>/copy/app/`，在此之前 `checkHarnessCopySize` 会以 `CONTENT_TOO_LARGE` 拒绝其扫描无法读取的副本；`harnessChanges` 为副本中与运行内容不同的每个文件计算一个待处理的 `harness-edit` 变更，并以 `HARNESS_COPY_UNREADABLE` 拒绝不是目录、超出扫描限制或无法读取的副本；`showHarnessChange` 存储双方并审阅它们；`applyHarnessChange`、`discardHarnessChange`、`undoHarnessChange` 和 `discardAllHarnessChanges` 在 `withHarnessLock` 之下作出决定，每个都接收在场证明，并记录在 `changes/harness/log.json` 中；`applyHarnessChange` 接收可选的 `reviewedTo`，即某次审阅所显示的完整内容版本，对其他版本以 `CHANGED_SINCE_REVIEW` 拒绝。`ChangesHarnessHost` 是 home 进程交给 Host 的服务（`changesHarness`），使 studio 的路由依据 home 进程验证过的签名文件列表来决定。`listHarness` 把等待中、被遗漏的和已记录的变更提供给 `list`。`src/harness-tree.ts` 构建并检查组合树（`prepareComposedTree`、`checkComposedTree`），在 `TREE_RETENTION_GRACE_MS` 之内移除没有任何启动需要、也没有任何启动选择的树和目录（`retainHarness`），并为 `verify` 和 `doctor` 报告某个运行时的 harness 而不写入任何内容（`harnessStatus`）。`newestLeavableChange(ctx, runtime)` 和 `leaveOutNewestChange(ctx, failure, runtime)` 在某个 harness 变更是两份日志中最新的决定时遗漏它；`leaveOutNewestHarnessChange(home, runtime, failure)` 无论 profile 的日志保存什么，都遗漏该运行时最新的 harness 变更，适用于其 `delorun` 在启动运行之前就失败的组合树；`newestAppliedHarnessChange(home, runtime)` 指名第二次此类失败之后的提示文字所建议撤销的变更。

<a id="harness-changes-across-an-update"></a>

## 更新期间的 harness 变更

`src/harness-merge.ts` 决定更新如何处理 harness 的每个已批准文件（[C3](../../docs/contracts/c03-update-report.zh.md#reasons)）。`mergeHarnessFile({ base, mine, theirs })` 合并运行中发布版本的已签名文件、已批准的内容和目标的已签名文件，每一份都带有其可执行位，没有文件时为 `undefined`：目标已保存已批准内容时为 `same`；目标保持文件原样，或从基线到已批准文本的补丁（jsdiff 的 `structuredPatch`）在不模糊匹配、不转换行尾的情况下能应用到目标的文本时，为带有目标所运行内容的 `carried`；其他情况为带原因的 `conflict`。双方都修改了二进制、非 UTF-8 或大于 `DIFF_FILE_LIMIT` 的文件时是冲突，本人修改之后目标删除的文件、目标修改之后本人删除的文件，以及双方都添加但内容不同的文件也是冲突。`planHarnessCarry(home, record, readSigned)` 按记录的 `signed` 和 `version` 从存储读取每个文件的基线和已批准内容，向 `readSigned` 请求目标已验证的文件，并返回带有三方内容和按路径顺序排列的每个文件结果的 `HarnessCarryPlan`；它不写入任何内容。不是其路径的单文件版本的版本，以 `RECORD_UNREADABLE` 拒绝。`mergedDiffs(plan)` 为每个通过合并来携带的文件（`carried` 且 carry 为 `merged`）给出从目标文件到合并后内容的统一 diff，可执行位不同时带 `old mode` 和 `new mode` 行，每一侧以 `DIFF_FILE_LIMIT` 为界，整个计划以 `DIFF_TOTAL_LIMIT` 为界；二进制或过大的一侧，以及超出总量之后的每个 diff，不显示行并说明原因（`notShown`）。更新报告的 `harness` 条目由 `delorun/apps/cli/src/update/harness-items.ts` 根据该计划，基于 `runningHarnessRecord` 构建，后者会遗漏启动失败时被遗漏的变更。`carryHarness(request, switchRuntime)` 是更新在切换之前的唯一一次调用，全程持有 harness 锁：运行中运行时的副本里有变更在等待审阅时，它以 `HARNESS_CHANGES_PENDING` 拒绝；移除早先安装在 `changes/harness/<to>/` 下留下的一切；对照目标已验证的文件再次制定计划，并把计划交给请求的 `confirm`，后者将其与本人确认过的内容比较，并在写入任何内容之前抛出错误以拒绝；然后写入目标的记录，其中每个携带的文件（其 `signed` 为目标的文件）各带一条 `decidedFrom: "update"` 的已应用 `harness-edit` 日志条目；运行中的运行时有可写副本或有文件冲突时，用 `writeHarnessCopy` 写入目标的可写副本，把每个冲突文件中本人的内容保存在其旁，名为 `<file>.mine`（`keepBeside`）；最后运行切换。切换之前的失败会移除目标的目录；运行中运行时的记录、副本和日志条目从不被写入。

<a id="plugin-packs-across-an-update"></a>

## Plugin packs across an update

`src/update-baseline.ts` 让发布自己的包文件成为一次更新期间的基线（[C21](../../docs/contracts/c21-changes.zh.md#plugin-packs-across-an-update)）。`packs/` 下某个包的文件夹保存一个发布的已签名文件，因此更新之后，已批准的内容（上一个发布的文件）与该文件夹之间的差异，正是该发布所替换的内容。`enforceApprovedContent` 接受可选的 `updateBaseline`，即 `{ from, to, packsFor }`，只有一次更新的后继进程的第一次 Host 启动才会设置它（`delorun/apps/cli/src/changes/start.ts` 中的 `repointForSuccessor`，一次更新的后继进程会运行它，因为它没有启动前步骤），并且只针对向更新版本的更新。每个发布的包文件在构建基线时验证，但 `packsFor(name)` 只在某个等待中的更改触及该包时给出该包的已签名文件（`@delorun/runtime-store` 的 `openSignedPacks`；不对任何已安装文件计算哈希，`text(path)` 只在其字节与已签名摘要相符之后读取一个已安装的 `package.json` 或 `pnpm-lock.yaml`），每个包一次。只有当 `baselineMayApply` 找到一个从 `packs/` 链接、且两个发布之一把它列出的已批准插件时，`repointForSuccessor` 才构建基线并运行 Changes 的启动（`lists(name)` 只读取包文件），并给那次启动和重新指向一个 `createScanMemo()`：一份内存中的、每次启动的备忘，记录活动副本的文件所给出的摘要，只由是否重写的检查（`holdsVersion`、`holdContent`）使用，对一次启动所写入的内容则丢弃，而加载检查（`holdsVersionUnder`）与 `materialize` 在写入之后的检查从不使用它。扫描缓存文件按被扫描的文件夹保存条目（schema `/2`），因此两个插件文件夹的扫描不会互相替换。`supersededByUpdate` 只判定已批准内容与文件夹之间不同的条目：文件夹现在持有的每个条目必须是 `to` 签名的、具有相应摘要与可执行位的文件；已批准内容持有而文件夹不再按其原样持有的每个条目必须是 `from` 签名的文件；`to` 签名的文件不得从文件夹中缺失；已批准内容缺少的条目也不得由 `from` 签名；而其中的链接或未签名条目会让该更改等待；从 `LAST_RELEASE_WITH_BUILD_PATHS`（0.1.0-preview.2.1，一条安全不变量；离开任何更晚发布的更新必须逐字节相符）或更早发布批准下来的 `package.json` 或 `pnpm-lock.yaml`，在除去构建的临时文件夹名称（`withoutBuildFolder`）之后等于某个已安装、已签名文件的文本时也算数，其他任何文件都不允许这样。两项检查都通过的启动会把已批准的内容替换为文件夹的内容，作为决定为 `update` 的一项已应用 `plugin-edit`，带一个历史版本，并在启动所报告的内容中带有 `replacedByUpdate`；任何其他差异（包括与发布文件混在一起的本人编辑）都像以前那样等待审查。没有基线的启动、重新加载以及 `packs/` 之外的插件从不替换任何东西，回滚的后继进程也不替换，其交接行指名 `purpose: rollback`。后继进程每次更新只应用它一次：健康检查失败之后的启动从不应用。`followApprovedContent` 用于在健康检查失败之后再次启动的 Host：回滚恢复了已批准记录，但没有恢复 `active.json`，因此每个加载已批准内容的活动副本都在启动之前被设为恢复后的已批准版本，前任进程在没有任何推进的情况下继续。比该步骤更早的前任进程没有它，因此后继进程在报告健康检查失败之前，把基线改动过的已批准记录与 `active.json` 条目放回（`revertDecisions`，经由 Host 运行器的 `abandon` 运行），并保留此后被改动过的任何条目，把它放回的条目的每个活动目录再次填入该条目的内容（或对于启动所新增的条目填入空），以便那位前任进程继续时发现目录与 `active.json` 一致。

<a id="setup-export-and-import"></a>

## 导出与导入 setup

`@delorun/changes/setup-transfer`（[`src/setup-transfer/`](src/setup-transfer/index.ts)）在电脑之间迁移一个 profile 的 setup。`collectSetup` 读取此人添加的插件（确切版本与 lockfile 的 integrity，或已批准副本的文件），以及策略（[`policy.ts`](src/setup-transfer/policy.ts)）所携带的补丁条目：默认模型与模型提供方、studio 的外观，以及所携带插件的行。该策略从不携带 `@delorun/` 或 `@deepseek-ai/` 范围的包、属于某一台电脑的条目（沙箱、权限、网络、设备、reach、凭据）、`!!js` 表达式或非 https 的端点，并会停止一次会携带凭据的导出。`planSetupImport` 列出导入在本人的选择下将替换的内容：模型条目总是被替换；其他设置除非关闭，否则被替换（归档没有的设置恢复默认）；归档所列的插件；归档未列出的插件只有在本人选择移除时才被移除。导出可以略去设置、只携带所选插件、只写出本人自己编写的插件的名称而不带代码，并附上备注。`applySetupImport` 先保存版本“Before importing a setup”，再把每个移除与安装都当作 agent 的插件请求来记录并应用，因此上游的兼容性检查、安装检查、被扣留的构建脚本与对本地代码的审阅，都与手动安装时遇到的相同；本地插件的文件被写入 `archive/setup-plugins/<profile>/` 下的新文件夹并从该处链接，其内容因此等待审阅。lockfile 校验和与归档不一致、或无法检查的注册表包会使导入停止。设置最后写入，作为一个历史版本。[合约 C8](../../docs/contracts/c08-archive-and-trash.zh.md#the-setup-archive)陈述该归档；`delorun setup export` 与 `delorun setup import`（[`@delorun/cli`](../../apps/cli/README.zh.md)）使用它。

<a id="not-covered"></a>

## 不涵盖的内容

- 插件代码以 harness 的全部权限运行；这里没有任何东西限制它。
- 已签名安装中被修改的文件，在两种保护设置下都会被运行时存储的启动检查拒绝；本人的编辑一旦应用，只从组合树运行。
- 保护关闭时，没有任何东西在变更加载之前审阅它：任何写入链接插件文件夹或 harness 可写副本的人，都会改变运行的内容；本包记录这一点，由本人撤销。

<a id="development"></a>

## 开发

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/changes` 运行这些规格；`node_modules/.bin/tsc --noEmit -p delorun/packages/changes/tsconfig.json` 进行类型检查。
