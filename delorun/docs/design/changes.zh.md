---
description: "对人的 harness 的更改的设计：已签名的发布版本加上他们所做的更改，每一项都有记录，保护开启时只有他们批准过的才会运行；Changes 界面、用于实时重载的开发会话、唯一的保护设置、verify 和 doctor 报告什么、重新应用已批准编辑的更新，以及更改造成问题时的恢复。"
---

# 对你的 harness 的更改

[English](changes.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

一个人对自己的 harness 拥有完全的控制权：通过插件（这是首选），或者直接编辑 harness 本身。更改 harness 是人们使用它时会做的事，所以 Delorun 记录每一项更改，并把审阅留给此人：他们的 harness 就是已签名的发布版本加上他们所做的更改，每一项都有记录。保护关闭时（默认），更改不经审阅就加载，此人可以列出、显示和撤销它；保护开启时，除非此人在自己的电脑上批准了更改，否则没有任何东西会改变 harness 运行的内容。有一个地方，即 Changes，显示每项更改及其差异和风险摘要，并应用、丢弃或撤销它。此人批准过的更改是预期之内的，所以在保护开启时编辑自己 harness 的人仍然保有完整的保护。当某项更改破坏了启动或 studio 时，Delorun 会略去那项更改、说明这一点，并提议再次应用它或撤销它。

## 目录

- [stock 今天做什么](#what-stock-does-today)
- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [当更改造成问题时](#when-a-change-breaks-something)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-stock-does-today"></a>

## stock 今天做什么

Delorun 原样运行上游的插件加载，所以这也是 Delorun 今天所做的。

- 从本地文件夹安装的插件会被链接到 profile 的依赖项中，并从该文件夹加载。来自注册表的插件从 profile 的 `node_modules` 加载。
- 上游有热重载（`@deepseek-ai/dsh-hmr`），只要加载了 profile，它就在基础 bundle 中处于开启状态。对 profile 的 bundle 列表或补丁文件的更改，以及插件管理器的每一项操作，都会重新组合 profile，并替换其在 profile 目录之下的文件在磁盘上发生了变化的每个已加载的插件，包括已链接的包的目标。除非 profile 补丁设置了 `hmr.root`，否则监视源文件夹是关闭的。加载失败的替换会让插件处于停止状态并被报告为失败；它不会被回滚。
- agent 可以用普通的文件工具编写插件，并用 `plugin_manager` 的 `install_bundle` 对它的文件夹进行安装。`plugin_manager` 的每个写入操作都需要 `danger-full-access` 或此人对该次调用的批准。之后对该文件夹的编辑会在下一次重新组合时加载，而无需再次批准。
- 热重载只比较文件的 inode、大小和修改时间，以决定是否重新加载它。没有任何东西比较改变了什么，并且 Delorun 的指令同意涵盖指令文件、skill 和预设，而不涵盖插件的源代码。
- 插件管理器保存 profile 文件的历史，其中每项更改都是 `undo` 和 `restore` 可以返回的一个版本。

<a id="what-exists-today"></a>

## 今天已有的内容

- `delorun recover safe-mode` 标记下一次启动在没有其第三方 bundle 和此人为它们所设的行的情况下启动 profile，且不写入任何 profile 文件；`delorun recover exit-safe-mode` 结束它。`delorun recover`（或 `recover status`）还会报告 profile 的状态，`recover rollback` 回退最近一次记录的更新，`recover restore <version>` 恢复某个 profile 历史版本。
- `delorun doctor` 检查 Docker、DeepSeek API 密钥的格式、home 和 studio 的端口，并打印 Changes 的行。对于 CLI profile 的插件，它报告每个已安装的包的来源及其是否启用、正在运行的发布版本不满足的版本范围、被同名的已发布包隐藏的包、未安装的已启用 bundle、安全模式，以及根据 home 进程的日志得出的、在最近一次启动时未激活的插件行。它不报告关于已批准的内容或引入故障的更改的任何信息。
- 针对从文件夹链接的插件的 Changes、此人对 harness 本身的编辑、`delorun changes`、开发会话、保护设置、agent 的同意和待处理的插件请求，以及 `delorun verify` 和 `delorun doctor` 中的 Changes，均已构建；[C21](../contracts/c21-changes.zh.md) 对它们作了陈述。

<a id="the-rules"></a>

## 规则

1. **一个界面，Changes。**已作为用于插件和 harness 自己文件的 `delorun changes` 构建（[C21，命令](../contracts/c21-changes.zh.md#commands)）；studio 也能决定它们，可以在电脑上，也可以在本人在手机权限下解锁的已配对手机上（[C21，谁可以在哪里做什么](../contracts/c21-changes.zh.md#who-may-do-what-from-where)）。
2. **运行的是已批准的内容，而不是文件夹。**已构建（[C21，加载已批准的内容](../contracts/c21-changes.zh.md#loading-approved-content)）。
3. **开发会话提供实时重载。**已在终端中构建（[C21，开发会话](../contracts/c21-changes.zh.md#work-sessions)）；Delorun 自己的监视器把文件夹复制到插件的活动目录中，而不是用上游的源代码监视，因为文件夹中的文件并不是已加载的那些。studio 的按钮和徽章尚未构建。
4. **批准。**已构建（[C21，风险摘要](../contracts/c21-changes.zh.md#the-risk-summary)）。
5. **agent 与插件。**已构建（[C21，agent 与插件](../contracts/c21-changes.zh.md#the-agent-and-plugins)）。
6. **一个保护设置，默认关闭。**已构建（[C21，保护设置](../contracts/c21-changes.zh.md#the-protection-setting)）：保护关闭时，插件文件夹和 harness 的可写副本不经审阅就加载，每项更改都被记录为这样；保护开启时，每一项都等待此人。已签名安装中被更改的文件，在两种设置下都会被拒绝：harness 编辑只有作为已应用的 harness 更改才会运行（[C21，harness 编辑](../contracts/c21-changes.zh.md#harness-edits)）。
7. **被扣住的插件。**保护开启时，当插件的文件不再与已批准的版本匹配，该插件不会被加载，harness 的其余部分继续工作，并向此人提供两个操作：放回已批准的版本，或把当前文件作为一项更改来审阅并批准它们。
8. **编辑 harness 本身。**已构建（[C21，harness 编辑](../contracts/c21-changes.zh.md#harness-edits)）：`delorun changes edit-harness` 制作此人自己的、已安装发布版本 `app/` 目录的可写副本。每次保存的编辑都是针对已签名文件的一项待处理更改，像其他任何更改一样被应用，已应用的更改从与已签名安装并排的一棵组合树中运行，只有已签名的代码才会启动它。已签名的原件从不被编辑，丢弃每一项 harness 更改就回到它。副本的扫描缓存只在文件的设备、inode、大小、修改时间和状态更改时间都没有变化时才重用它的摘要，所以状态更改时间发生了移动的文件（`chmod`、新的硬链接、保留其字节的恢复）会被再次读取和哈希；对于整个发布版本的副本，这可能意味着再次读取它的每一个文件。
9. **`verify` 和 `doctor` 报告什么。**已构建（[C21，verify 和 doctor 报告什么](../contracts/c21-changes.zh.md#what-verify-and-doctor-report)）；doctor 的 `release-log` 行说明发布日志检查已经多久没有被检查。
10. **更新会重新应用已批准的编辑。**更新报告列出每项已批准的 harness 更改，以及它是否适用于新的发布版本。应用是按文件进行的三方合并；有冲突的文件采用新发布版本的内容，此人的版本作为 `<file>.mine` 保留在旁边并在报告中指出。已批准的插件版本原样保留。更新的健康检查和回退涵盖这一结果（见[更新与回退](update-and-rollback.zh.md)）。
11. **用词。**此人看到的是更改、审阅、应用、丢弃、撤销和正在开发。代码和约定保留技术术语。

<a id="when-a-change-breaks-something"></a>

## 当更改造成问题时

12. **糟糕的启动会略去最后一项更改。**当启动失败，或未通过更新的健康检查，并且 Changes 中最新的条目是插件或 harness 更改时，Delorun 会在没有该条目的情况下再试一次。该条目被标记为 “left out at start” 并附上故障，终端和 studio 会指出它并提供 Apply again 和 Undo。重试不写入任何 profile 文件：该更改是通过安全模式所使用的同一个覆盖层被略去的。第二次失败会停止，并给出完整的安全模式命令。不会删除任何东西。
13. **不需要任何插件的恢复界面。**studio 的页面带有一个小型的内置界面，它是启动页面的一部分而不属于任何插件，在 studio 渲染失败时、并在固定的回环地址上显示：什么失败了、最近的更改，以及 Turn off、Undo 和 Safe mode 这些操作。它的路由是 Host 自己的，仅限所有者和回环；远程会话会得到 “This needs you at your computer”。
14. **失败的重载会回到原来的版本。**已构建（[C21，命令](../contracts/c21-changes.zh.md#commands)和[开发会话](../contracts/c21-changes.zh.md#work-sessions)）。
15. **两种规模的安全模式。**`delorun recover safe-mode` 在没有每一个第三方插件的情况下启动；`delorun changes off <plugin>` 和 `on <plugin>`，以及恢复界面，则在没有其中一个插件的情况下启动。两者都是 Changes 中的条目，所以它们是可见的，并且以同样的方式撤销。
16. **`doctor` 指出原因。**对于失败的启动或失败的渲染，`delorun doctor` 会指出其代码失败的插件，以及引入它的更改。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **插件代码拥有 harness 的权限。**已批准的插件可以做 harness 能做的任何事，而风险摘要是根据更改的文件计算的，不是根据代码在运行时做什么。
- **开发会话运行未经审阅的代码。**在开发会话期间，每次编辑都不经审阅就实时加载。agent 第一次写入之前额外的询问和徽章是保护措施；在会话结束、其结果成为已批准的版本之前，没有任何东西会提示审阅 agent 写入的内容。
- **保护关闭，这是默认值。**在更改加载之前没有任何东西审阅它：任何能写入已链接插件的文件夹、或在沙箱之外写入 harness 的可写副本的人，都会改变下次启动或保存时运行的内容。日志、`verify` 和 `doctor` 事后会指出每一项这样的更改，`undo` 会撤回它。
- **同一用户的进程。**以此人身份在沙箱之外运行的程序，可以更改已批准的存储和设置本身，如[威胁模型](../security/threat-model.zh.md#other-local-processes-under-the-same-user)对整个 home 所陈述的那样。

<a id="denial-tests"></a>

## 拒绝测试

- `a changed harness file is refused in both protection settings`
- `a changed plugin does not load with protection on`
- `no tool can apply a change, start or end a work session, or change the protection setting`
- `a phone uses a control only where Phone powers lets it, and only with an unlock it entered`
- `the agent's first write to an approved plugin asks`
- `a plugin outside a work session never loads from its folder`
- `a work session's badge is shown while it lasts`
- `verify never prints passed with content that loaded without review`
- `a conflicted file never silently keeps either side`
- `a start that fails on a new plugin starts without it and names it`
- `the retry writes nothing to the profile`
- `the recovery screen renders with every plugin's client code failing`
- `a remote session cannot use the recovery actions`
- `a failed reload leaves the previous version running`

<a id="implementation-status"></a>

## 实现状态

规则 1 到 6、9，以及针对插件的 14，还有规则 15 的 `delorun changes off` 和 `on`，均已构建（[C21](../contracts/c21-changes.zh.md)）；F15 和 F16 仍为已设计状态，在保护开启时适用（见[基本原则](../security/fundamentals.zh.md)）。整个 profile 的安全模式，以及 `delorun recover` 的 profile 回退和恢复，均已构建。
