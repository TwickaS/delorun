---
description: "模板的设计：一份已保存的、按内容寻址的、记录某人如何使用 harness 的记录（固定版本的插件、profile 行、预设、skill、harness 编辑和凭据名称）。一个人可以保留多个模板，其中一个在 profile 中处于活动状态，而切换、导入、导出、备份和恢复各自作为一次带重启的事务运行。以当前工作必须遵循的约束以及与之冲突的当前代码作结。"
---

# 模板

[English](templates.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

模板是一份记录某人如何使用 harness 的记录：他们运行的插件（固定版本并带有完整性校验）、他们选择的 profile 行和设置、他们的 agent 预设和 skill、他们对 harness 的编辑（作为针对某个指定发布版本的差异），以及这些所需凭据的名称。它从不包含密钥、chat 或信任决定。一个人在自己的 home 中保留多个模板，例如“work”和“experiments”，并且一个 profile 在同一时间恰好有一个模板处于活动状态。活动模板就是此人的配置：更改设置、安装插件或应用 harness 编辑，都会更改活动模板。切换到另一个模板时，会停止 Host，保存活动模板，把另一个模板作为一次事务加载，然后再次启动；启动失败则会回退。同一种格式用于分享（导入和导出）、备份，以及恢复到全新安装或另一台机器上。Delorun 会准确显示模板带来什么：harness 编辑逐个文件显示其差异，并且在任何东西运行之前，运行与插件相同的安装检查。模板在 0.1.0 之后构建。本页现在就确定它们的格式和规则，使在此之前构建的代码不会阻碍它们；[当前工作的约束](#constraints-for-current-work)和[与之冲突的当前代码](#current-code-that-conflicts)是今天适用的部分。

## 目录

- [术语](#terms)
- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
  - [模板文件](#the-template-file)
  - [活动模板就是此人的配置](#the-active-template-is-the-persons-configuration)
  - [哪些留在 home 和机器上](#what-stays-with-the-home-and-the-machine)
  - [库](#the-library)
  - [保存与切换](#save-and-switch)
  - [切换前后的 chat 与预设](#chats-and-presets-across-a-switch)
  - [模板、预设与 profile](#templates-presets-and-profiles)
  - [导入与导出](#import-and-export)
  - [备份与恢复](#backup-and-restore)
  - [更新](#updates)
  - [更改、保护与安装检查](#changes-protection-and-the-install-check)
  - [密钥与凭据](#secrets-and-credentials)
  - [命令与 studio](#commands-and-the-studio)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [当前工作的约束](#constraints-for-current-work)
- [与之冲突的当前代码](#current-code-that-conflicts)
- [尚待解决的问题](#open-questions)
- [实现状态](#implementation-status)

<a id="terms"></a>

## 术语

- **模板（Template）**：采用下面格式的一条记录，由其 manifest 的 SHA-256 标识。它的名称和版本是标签。
- **活动模板（Active template）**：profile 所运行的模板。它的内容就是 profile 自己的文件。
- **已保存的模板（Saved template）**：保存在 home 的库中的模板，在任何 profile 中都不活动，或在其中一个中活动。
- **切换（Switch）**：作为一次事务，让另一个已保存的模板成为 profile 中的活动模板。
- **机器选择（Machine choices）**：Delorun 根据 `delorun setup` 的答案和隐私部分（[C11](../contracts/c11-setup-answers.zh.md)）以及 reach 行所写入的行。它们属于这台机器上的 profile，而不属于模板。

<a id="what-exists-today"></a>

## 今天已有的内容

- profile 按固定顺序组合上游的层：`dsh.profile.bundles` 的 bundle、profile 的 `cordis.patch.yml`、home 的 `cordis.patch.yml`，然后是启动时的 `--patch` 覆盖层（见[架构](../../../docs/architecture.zh.md#profiles-and-bundles)）。按 id 指向某一行的补丁会替换该行完整的 `config`。
- 上游的设置是 profile 补丁中的行，由配置编辑器写入（`packages/boot/config-editor/src/index.ts:150-157`）。Delorun 的 setup 答案是同一个文件中的行（`delorun/apps/cli/src/setup/writes.ts:124-171`）。
- 一些上游插件有角色为 `secret` 的字段，“设置”会把它们的值以明文写入 profile 补丁（`packages/web/web-deepseek-api/src/index.ts:50`、`packages/web/web-search-deepseek/src/index.ts:69`）；基础 bundle 组合了这两行。profile 历史把该文件保存在 git 中。
- agent 预设是 `@deepseek-ai/dsh-agent-preset` 的行，所以它们属于一个 profile。chat 按 id 记录它的预设（`packages/preset/agent-preset-registry/src/session.ts:31`）；恢复的 chat 会再次解析该 id，而没有任何东西定义的 id 会以 `agent-preset/not-found` 失败（`index.ts:220-224`）。
- skill 从工作区、从 `customSkillDirs`、从 home 的 `skills/` 和 `~/.agents/skills`，以及从内置 skill 加载（`packages/skill/skill-filesystem/src/index.ts:52-90`）。home 的 `skills/` 和 `AGENTS.md` 由每个 profile 共享。
- 凭据的值保存在 home 的 `.credentials.yaml` 中；配置通过角色为 `credential-ref` 的字段来指名它们。
- chat、工作区和附件是整个 home 范围的，由每个 profile 共享。
- profile 历史是上游基于 git 的、针对一份固定的 profile 文件列表的历史，Delorun 用它自己的记录和 home 补丁的副本扩展了该列表（`delorun/packages/profile-safety/src/files.ts:52-58`）。
- `delorun export` 写入 chat 和工作区，其定制文档为空，而 `delorun import` 列出定制行但不应用其中任何一个（[C8](../contracts/c08-archive-and-trash.zh.md#customisation-schema)）。`delorun import-home` 导入 stock DeepSeek Harness 的 home，并把它的允许列表中的行写入 profile 补丁。
- 在尚未合并到 `main` 的分支上：Changes（[设计](changes.zh.md)）把已批准的插件保存在 profile 的 `package.json` 中，但把已批准的 harness 文件按每个运行时一份、整个 home 范围的记录保存；插件安装检查为每个插件写一条安装记录。
- 不存在模板文件、库或命令。

<a id="the-rules"></a>

## 规则

<a id="the-template-file"></a>

### 模板文件

1. **容器。**模板文件是一个 zip，用 [C8](../contracts/c08-archive-and-trash.zh.md#limits) 的读取器和限制来读取。它的顶层条目是 `template.json`（manifest）；`signature.json`（仅在已签名时存在）；`rows.patch.yml`；`plugins/`（打包的插件）；`skills/`；以及 `harness/`（harness 编辑）。其他任何顶层条目都无效。
2. **Manifest。**`template.json` 有 `schema`，为 `delorun.template/1`；`name`，由 1 到 32 个小写字母、数字和连字符组成，以字母开头；`version`，一个语义化版本；`title` 和 `description`，不含控制字符的纯文本；`author`，带有 `name` 和可选的 `url`；`requires`，带有按插件的 `engines.delorun`（[C17](../contracts/c17-plugin-versions.zh.md)）那样检查的 `delorun` 范围；`origin`，即它被导入时所来自的模板的 id、名称和版本；`plugins`；`credentials`；可选的 `harness`；以及 `files`，列出每个其他条目的 `path`、`sha256` 和 `size`。schema 没有定义的字段会被拒绝。
3. **标识。**模板的 id 是 `template.json` 确切字节的 SHA-256。因为 manifest 列出了每个其他条目的摘要，所以任何一个字节的更改都会得到新的 id。名称和版本相同但 id 不同的两个模板是两个模板，第二个到达时 Delorun 会这样说明。
4. **版本。**`schema` 是格式的版本：读取方会拒绝它不认识的 schema，新的 schema 是一个相邻的后继，绝不是对 `delorun.template/1` 的编辑。`version` 对于已发布的模板由作者给出；对于此人自己的模板，每次保存会给出下一个补丁版本。
5. **签名。**`signature.json` 遵循 [C8 的签名](../contracts/c08-archive-and-trash.zh.md#signature)：对 `template.json` 确切字节的 Ed25519 签名，状态相同。home 为它自己的密钥以及此人通过输入指纹确认过的密钥作担保；未签名的模板只有在此人输入 `unverified` 时才被接受。签名说明是谁发布了模板，而不说明它是安全的。
6. **插件。**`plugins` 的每个条目有 `name`、确切的 `version`、`integrity`（子资源完整性 SHA-512 值）和 `from`：`registry`，从 profile 的插件管理器所用的注册表安装并对照 `integrity` 检查；或 `file`，即 `plugins/` 下打包的 tarball。此人从文件夹链接的插件，是根据 Changes 存储中它已批准的内容打包的，绝不是根据实时文件夹。范围、标签、`link:`、`file:` 或 `git` 引用以及 `@delorun/` 作用域内的包都会被拒绝。发布版本自己的 bundle 和插件不会被列出；模板只包含此人添加的内容。
7. **行。**`rows.patch.yml` 是 Cordis 补丁列表：此人的行，包括他们的设置和他们的 agent 预设。它从不包含机器选择。当模板的行包含 `!!js` 表达式、插入既不在模板的 `plugins` 中也不在正在运行的发布版本中的插件、设置角色为 `secret` 的字段的值、指向 [C19 的 Host 不变式](../contracts/c19-home-process.zh.md#host-invariants)所保护的行（`sandbox` 行、每个 Delorun 行、提示行和防护行）、`plugin-manager` 行或 `hmr` 行，或设置沙箱模式、reach 选项或出站限制时，这些行会被拒绝。代码属于插件，而安装检查能看到插件。
8. **skill。**`skills/<name>/` 各保存一个 skill，采用上游的 skill 布局。这些是模板的 skill；home 的 `skills/` 位于每个模板之外（见[规则 15](#what-stays-with-the-home-and-the-machine)）。
9. **harness 编辑。**`harness` 通过 Delorun 版本和其已签名发布 manifest 的 SHA-256（[C2](../contracts/c02-release-manifest.zh.md)）指出编辑所针对的发布版本，并为每个文件列出一个条目：`app/` 之下的路径、编辑所起始的已签名文件的 SHA-256，以及 `harness/` 下的统一差异。
10. **凭据。**`credentials` 按 `credential-ref` 字段所保存的名称，列出行所指名的每个凭据，并附一行用途说明。它从不包含值。

<a id="the-active-template-is-the-persons-configuration"></a>

### 活动模板就是此人的配置

11. **每个 profile 一个活动模板。**profile 运行发布版本的组合和恰好一个模板。模板不叠加。
12. **此人的编辑保存在活动模板中。**此人自己的更改没有单独的层。活动模板的行是去掉机器选择之后的 profile 的 `cordis.patch.yml`，它的插件是 profile 在发布版本之外的依赖项和 bundle，它的 skill 是 `profiles/<profile>/skills/`（发布版本的组合把它作为 skill 来源提供），它的 harness 编辑是 profile 已批准的 harness 文件。更改设置、安装或移除插件、编辑预设或应用 harness 编辑，都会更改活动模板，下一次保存或切换会记录它。
13. **为什么只有一处。**活动模板之上另设一层此人的层，会让“这个 profile 运行什么”变成此人必须在脑中组合的两件事，并且切换不会切换一切：在 “experiments” 处于活动状态时添加的插件或设置，会跟着此人进入 “work”。它还需要自己的组合机制，而今天的 profile 文件已经是上游的配置编辑器、插件管理器和 profile 历史写入的唯一位置。把此人的编辑保存在活动模板中，就是原样使用这些：模板是 profile 自己文件的内容，切换会替换它，profile 历史为它保存版本。应当在每个模板下都适用的选择，属于 home 补丁，它适用于每个 profile，并且不在任何模板中。
14. **Delorun 对活动模板的记录。**`profiles/<profile>/delorun-template.json` 指出活动模板的名称、它上次被保存或加载时所属版本的 id，以及它的 `origin`。profile 历史会跟踪它。

<a id="what-stays-with-the-home-and-the-machine"></a>

### 哪些留在 home 和机器上

15. **整个 home 范围的文件不在任何模板中。**home 补丁、home 的 `skills/` 和 `AGENTS.md` 适用于每个 profile 和每个模板；切换让它们保持原样，备份会携带它们。
16. **机器选择在切换前后保持不变。**机器选择的行按 id 列在一个导出的列表中。保存、导出和切换会把这些行排除在模板之外，并在切换前后把它们保留在 profile 中，所以提示答案、隐私、更新检查、studio 的地址和 reach 不会在此人切换时改变。
17. **信任决定留在 home。**权限和完全访问授权、MCP 和其他同意、保护设置、设备批准、版本豁免（`compatibility.json`、`delorun-compatibility.json`）和构建批准（`pnpm-workspace.yaml` 中的 `allowBuilds`）都不在任何模板中。加载其插件需要构建或豁免的模板，会在预览中要求做出这一决定。
18. **绝不在模板中。**chat、工作区、附件、凭据的值，以及 `secrets/`、`trust/` 和 `run/` 的文件。

<a id="the-library"></a>

### 库

19. **它在哪里。**home 顶层的 `templates/`，模式为 0700：`templates/store/<id>/` 保存每个模板版本的条目，绝不重写；`templates/library.json` 列出每个已保存模板的名称、按 id 排列的版本及其时间和来源（`saved`、`imported` 或 `restored`）、它的 `origin` 和签名者状态，以及哪个 profile 将它作为活动模板。模板在 `templates/staging/` 下暂存，并在验证通过后通过一次重命名发布。
20. **名称与版本。**一个名称标识一个已保存的模板；它的版本一直保留到此人移除为止。当有 profile 将某个模板或版本作为活动模板时，移除它会被拒绝。profile 的某个历史版本如果指名了库中已不再保存的模板版本，则会连同它所保存的 profile 文件一起恢复，而库不会增加任何东西。

<a id="save-and-switch"></a>

### 保存与切换

21. **保存。**`delorun template save [<name>]` 把活动模板的当前内容记录为库中的新版本。带有新名称时，它把当前内容保存为一个新模板，并使其成为活动模板。保存除了 `delorun-template.json` 之外不写入任何 profile 文件。
22. **只在 home 所在的电脑上。**保存、切换、导入、导出、备份或恢复，只能通过 home 所在电脑上终端中的 `delorun` 命令，或通过其回环地址上带有 studio 凭据的 studio 来运行。远程会话、模型的工具和插件路由都不能开始、确认或撤销其中任何一项。
23. **切换之前此人看到什么。**预览列出切换改变什么：添加、移除或移到另一个版本的插件，附带来源、完整性、安装检查的发现以及它们要求运行的任何构建；添加、移除或更改的行，其中有预设和 skill；harness 编辑，逐个文件并附带其差异；目标指名的凭据，以及 home 是否拥有它们；以及正在运行的发布版本不满足的要求。在此人确认之前，不会安装、导入或运行任何东西。
24. **Host 已停止。**切换像 `delorun update` 那样停止 Host：chat 门拒绝新的轮次，运行中的轮次结束，Host 停止；`--cancel` 在此人确认之后取消运行中的轮次而不是等待。chat 运行期间不会改变任何东西。
25. **一次事务。**在 home 锁之下，切换会在活动模板的内容与其最后一个版本不同时保存它，写入历史版本 “Before switching to <name>”，把目标的行与机器选择一起写入 profile 补丁，写入它的依赖项和 bundle、它的 skill、它已批准的 harness 文件和 `delorun-template.json`，安装插件并写入它们的安装记录，写入历史版本 “Switched from <old> to <new>” 和一个其 `historyVersion` 指向它的 Changes 条目，并启动 Host。
26. **失败的启动会回退。**切换之后的启动运行 [C3 的健康检查](../contracts/c03-update-report.zh.md#health-check) H4：新模板的每一行都能加载。失败会通过 profile-safety 的恢复来恢复 “Before” 版本，重新安装，再次启动，并把 Changes 条目标记为失败并附上错误。撤销该 Changes 条目就是切换回去。
27. **日志。**每次启动都把活动模板的名称和 id 写入 home 的运行日志（[C20](../contracts/c20-operational-logs.zh.md)）。

<a id="chats-and-presets-across-a-switch"></a>

### 切换前后的 chat 与预设

28. **历史保留。**切换不改变任何 chat。每个 chat 都保留它的历史，它的下一轮在切换所启动的 Host 下运行。
29. **chat 跟随它的预设 id。**chat 在下次运行时解析它所记录的预设 id，与上游今天所做的一样，并使用活动模板给予该 id 的定义。以不同方式定义同一个预设 id 的两个模板，会依次给 chat 各自的定义。
30. **已不存在的预设。**当活动模板没有定义 chat 的预设 id 时，chat 不会在另一个预设下运行。studio 显示该 chat 并附上 “Its preset <id> is not in the template <name>”，并提供两个操作：切换到拥有它的模板（如果库中知道有这样一个），或为这个 chat 选择另一个预设，这会向它的 session 追加 `agent-preset/selected`。向该 chat 的计划投递会以同样的原因被拒绝并被记录。

<a id="templates-presets-and-profiles"></a>

### 模板、预设与 profile

31. **预设按 chat，模板按 profile。**agent 预设组合一个 agent：它自己 `config.plugins` 中的插件、它的指令和它的模型。chat 选择一个，session 记录它，多个预设在同一个 Host 中共存，更改 chat 的预设无需重启。模板决定 Host 加载哪些插件、各行的 config、存在哪些预设、提供哪些 skill 以及运行哪些 harness 编辑。它适用于该 profile 的每个 chat，切换它会重启 Host。
32. **模板以行的形式携带预设。**它的预设是 `rows.patch.yml` 中的预设行，并且它可以设置预设注册表的默认值。
33. **切换在一个 profile 之内。**切换保持同一个 profile，所以此人保有同一个 studio 地址、同一份历史和他们的机器选择。profile 仍然是同时运行两种组合的方式：每个都有自己的 Host、锁、运行目录、历史和已安装的包，并且每个都有来自同一个库的自己的活动模板。chat 像今天一样在各个 profile 之间共享，当 chat 在它们之间移动时适用规则 29 和 30。

<a id="import-and-export"></a>

### 导入与导出

34. **导出。**`delorun template export <name> <file>` 把已保存的模板写成模板文件，在此人选择时用 home 密钥签名。角色为 `secret` 的字段的值绝不在模板中；包含这台机器上绝对路径的值会在写入之前被指出，这样此人可以做决定。
35. **导入。**`delorun template import <file>` 验证文件（C8 的读取器和限制、manifest 摘要、签名、[模板文件](#the-template-file)的规则），为将在这个 profile 中加载的模板显示规则 23 的预览（harness 编辑逐个文件并附带其差异），并将其添加到库中。导入不会激活模板；切换才会。
36. **导入的模板的新版本。**导入 `name` 和签名者与某个已保存模板的 `origin` 匹配的模板时，会把它作为该模板的更新提供。预览是按条目的三方比较：基准是此人导入的版本，“theirs” 是新版本，“ours” 是带有此人编辑的已保存模板。行按 id 比较，插件按名称比较，harness 编辑按文件比较。只有一方更改的条目采用该方；双方都更改的条目会连同两个值一起显示，由此人选择其一，所以没有任何条目会被悄悄合并。结果是已保存模板的新版本。
37. **stock home 的导入。**`delorun import-home` 把 stock home 的允许列表中的行写入活动模板，与它今天写入 profile 补丁时一样；下一次保存会记录它们。

<a id="backup-and-restore"></a>

### 备份与恢复

38. **备份。**`delorun template backup <file>` 写出一个用 home 密钥签名的文件，其中包含每个已保存的模板及库所保留的每个版本、每个 profile 的活动模板、每个 profile 的机器选择、home 补丁、home 的 `skills/` 和 `AGENTS.md`。harness 编辑始终包含在内。它不包含 chat、凭据的值或信任决定，并列出模板所指名的凭据。备份 chat 是 [C8 的导出](../contracts/c08-archive-and-trash.zh.md)，一个单独的功能。
39. **恢复。**`delorun template restore <file>` 验证文件，为它带来的一切显示一个预览，对每个活动模板的每个插件运行安装检查，询问规则 17 留给 home 的构建和版本决定，然后在全新安装或另一台机器上填充库，并按每个 profile 一次事务加载其活动模板。恢复从不覆盖同名但内容不同的已保存模板：它把恢复的版本添加在它旁边。

<a id="updates"></a>

### 更新

40. **活动模板就是 profile。**[C3 的报告](../contracts/c03-update-report.zh.md#items)和 `@delorun/profile-safety` 的保留检查，像今天对 profile 文件求值那样对活动模板求值。它的 harness 编辑通过 C21 的三方合并来保留，运行的是目标的内容，`<file>.mine` 为有冲突的文件保存此人的内容。
41. **不活动的已保存模板。**更新不改变任何已保存的模板。切换到其 `requires.delorun` 排除正在运行的发布版本、其插件被正在运行的发布版本关闭、或其 harness 编辑指向另一个发布版本的模板，会在它的预览中显示这一点：harness 编辑以其所述发布版本的已签名文件为基准做三方合并，该文件由运行时存储或已验证的下载提供，不能干净合并的文件会连同两方一起显示，由此人在应用任何东西之前选择。

<a id="changes-protection-and-the-install-check"></a>

### 更改、保护与安装检查

42. **每次事务一个 Changes 条目。**保存、切换、导入、恢复以及导入模板的更新，是 Changes 的 `template-save`、`template-switch`、`template-import`、`template-restore` 和 `template-update` 这几种类型。每个条目把它所更改的插件和 harness 文件作为子项列出。
43. **已批准的内容。**加载模板就批准了它的内容。它带来的插件和 harness 文件是 Changes 存储中已批准的版本，保护设置在每次启动时像对任何已批准的内容一样适用于它们。存储的回收保留已保存模板所引用的每个版本。
44. **对整个集合的安装检查。**安装检查在写入任何东西之前，把切换、导入或恢复所带来的每个插件作为一个集合来检查。任何插件中的阻断性发现都会使整个事务停止。
45. **模型与远程会话。**agent 不能保存、切换、导入、导出、备份或恢复模板，也不能写入 `templates/`。

<a id="secrets-and-credentials"></a>

### 密钥与凭据

46. **只有名称。**模板指名凭据；home 把它们的值保存在 `.credentials.yaml` 中，由每个模板共享。需要不同值的模板使用不同的名称，例如 `WORK_GITHUB_TOKEN`。加载其凭据 home 没有的模板会成功；预览和 studio 会指出每个缺失的凭据以及如何添加。
47. **profile 文件中没有密钥。**角色为 `secret` 的字段的值不会被写入补丁文件、模板或 profile 历史所跟踪的任何文件。Delorun 的“设置”提供这样一行的 `credential-ref` 字段，而不提供它的 `secret` 字段。

<a id="commands-and-the-studio"></a>

### 命令与 studio

48. **命令。**`delorun template list`；`show <name | file>`，不改变任何东西的预览；`save [<name>]`；`switch <name>[@<version>]`；`import <file>`；`export <name> <file>`；`backup <file>`；`restore <file>`；`remove <name>[@<version>]`。每条都接受 `--profile`。每条会更改 profile 的命令都打印预览并询问；`--yes` 只确认没有发现、冲突或未满足要求的预览，并且从不接受未知的签名者。
49. **studio。**Changes 旁边的 Templates 部分显示库、带有其内容的活动模板、预览界面和切换。远程会话看到活动模板的名称，而看不到任何改变它的东西。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **插件代码拥有 harness 的权限。**模板的插件与任何插件一样以相同的权限运行。预览和安装检查显示插件是什么以及已知的信息，而不是它的代码做什么。
- **签名者不是评审者。**有效的签名证明哪个密钥发布了模板。
- **削弱某项选择的行。**模板无法触及受保护的行或机器选择，但它的其他行可以关闭工具、更改模型或替换预设。预览会列出它们；由此人决定。
- **预设和 skill 中的指令。**预设的指令和模板的 skill 在加载之后会到达模型。预览让此人阅读它们；没有任何东西检查它们的内容。
- **harness 编辑以 harness 的身份运行。**已发布模板的 harness 编辑会改变 harness 自己的代码。预览显示每个差异；没有任何东西检查代码做什么。
- **未标记的字段中的密钥。**把密钥保存在没有 `secret` 角色的字段中的插件（例如普通的 `apiKey` 字符串）不会被检测到，它的值会随这一行去往任何地方。
- **同一用户的进程。**以此人身份在沙箱之外运行的程序可以更改库和 profile 的文件，如[威胁模型](../security/threat-model.zh.md#other-local-processes-under-the-same-user)对整个 home 所陈述的那样；保护 Block 会在下次启动时指出该更改。

<a id="denial-tests"></a>

## 拒绝测试

- `a template that differs by one byte from its manifest is refused before anything is written`
- `a template with a !!js expression, a protected row, a machine-choice row, a secret value or an unpinned plugin is refused`
- `nothing of a template is installed or imported before the person confirms the preview`
- `the import preview shows every harness edit's diff before anything applies`
- `no route, tool or remote session can save, switch, import, export, back up or restore a template`
- `a failed start after a switch leaves the profile byte-identical to the version before`
- `a switch keeps every machine-choice row and leaves the home patch, skills and AGENTS.md byte-identical`
- `a chat whose preset the active template lacks does not run under another preset without the person choosing it`
- `export and backup carry no credential value, chat or trust decision`
- `an update of an imported template never merges an item both sides changed without the person's pick`
- `the store's collection keeps every version a saved template refers to`
- `Settings never writes a secret-role value into the profile patch`

<a id="constraints-for-current-work"></a>

## 当前工作的约束

Delorun 不包含模板（见[路线图](../guide/roadmap.zh.md)）。由 0.1.0 创建的 home 保留它所写入的格式和文件，这些规则使模板无需迁移就保持可能。它们适用于每一项更改，包括 Changes、安装检查和插件编写这几条线。

1. **profile 自己的文件就是此人的全部配置。**此人对 harness 运行什么所做的每个选择（行、插件、已批准的插件内容、harness 编辑）都记录在 profile 目录中，并由 profile 历史跟踪。整个 home 范围的存储只保存按内容寻址的对象、信任决定以及发生过什么的记录。
2. **profile 文件中没有密钥。**没有任何代码把凭据的值写入 `cordis.patch.yml` 或 profile 历史所跟踪的任何文件；这样的值是通过 `credential-ref` 字段指名的凭据。
3. **profile 文件中没有特定于机器的临时状态。**由一条命令或一次启动组合出来的状态（例如插件开发会话所监视的文件夹），要放入 `run/<profile>/` 之下的覆盖层，就像沙箱和安全模式的覆盖层那样。
4. **机器选择是有列表的。**Delorun 根据 setup 答案、隐私部分或 reach 所写入的每一行，其 id 都在写入它的代码旁边的一个导出列表中，这样模板就可以按 id 把这些行排除在外。
5. **信任决定保留在它们自己的文件中。**授权、同意、豁免和构建批准绝不作为 `cordis.patch.yml` 的行，或存放在此人的插件列表旁边，这样模板就可以按文件把它们排除在外。
6. **发布版本的 bundle 来自一个列表。**区分发布版本的 bundle 与此人的 bundle 的代码，读取发布版本的 bundle 列表。`@delorun/` 作用域仍保留给发布版本自己的包。
7. **一个停止、写入和启动的例程。**需要停止 Host 的整个 profile 事务（更新、回退、恢复，以及模板切换或恢复）使用同一个例程：chat 门、home 锁、“Before” 历史版本、写入、启动、健康检查以及失败时的恢复。
8. **安装检查在写入之前决定一个集合。**安装检查可以接收一组插件，并在写入任何记录之前返回每一个决定。
9. **存储的回收接受更多引用方。**Changes 存储的回收从一个其他功能可以扩展的列表中读取它的引用方，这样已保存的模板就能保留它们所引用的版本。
10. **C8 的定制 schema 不再增长。**导出继续不写入定制行，也不添加新的行类型；由模板格式取代其位置。

<a id="current-code-that-conflicts"></a>

## 与之冲突的当前代码

“Format”标记的是这样一种冲突：其修复会更改 0.1.0 的 home 所保留的文件或格式，所以以后修复它需要迁移。“Code”标记的是在构建模板时可以更改而不触及已发布文件的代码。

| 位置 | 冲突 | 最小的修复 | 修复的类型 |
| --- | --- | --- | --- |
| `packages/web/web-deepseek-api/src/index.ts:50`、`packages/web/web-search-deepseek/src/index.ts:69`（两行都在基础 bundle 中） | “设置”把角色为 `secret` 的值保存到 profile 补丁中，而 profile 历史把它保存在 git 中；profile 的模板、导出或备份会携带它们。无论模板将发生什么，都必须修复。 | 在 Delorun 的“设置”中隐藏这些行的 `secret` 字段，使其只提供 `credential-ref` 字段，并在启动时拒绝 profile 补丁中的 `secret` 值；已经在那里的值会被指出，并附带将其移入 `.credentials.yaml` 的命令。 | Format |
| `delorun/packages/changes/src/types.ts:150-171` 和 `paths.ts`（分支 `lane/changes`） | 已批准的 harness 文件是 `changes/harness/<runtime>/approved.json` 下每个运行时一份的记录，由每个 profile 共享且位于 profile 历史之外，所以它们无法属于某个模板或随它切换。 | 在该记录发布之前，把已批准的文件映射保留在 profile 中，放在 `package.json` 的 `delorun.changes` 下已批准的插件旁边，或放在被跟踪的 `delorun-harness.json` 中；内容保留在存储中，复制和运行目录仍按摘要作键。 | Format |
| `delorun/apps/cli/src/plugin-dev.ts:51-142`（分支 `feat/plugin-authoring`） | `addDevRoot` 把带有绝对文件夹路径的 `hmr` 行写入此人的 `cordis.patch.yml`，只靠 `writes.ts` 会擦除的一条注释来识别，并且在崩溃之后会被遗留；保存或备份会携带它。 | 把开发根写入启动所传入的 `run/<profile>/` 下的覆盖层，如安全模式所做的那样。 | Format |
| `delorun/apps/cli/src/setup/writes.ts:124-171` 及其调用方 `setup/sections.ts:425`、`setup/prompt-switches.ts:48`、`setup/update-check.ts:34`、`reach/row.ts:96` | 机器选择被写入与此人的行相同的文件，而没有它们的 id 列表。 | 把这些写入方所设置的 id 导出为一个列表（约束 4）。 | Code |
| `delorun/packages/changes/src/collect.ts:1-20`、`:54-72`（`lane/changes`） | 存储的回收只保留当前 profile 和 harness 记录所指名的版本。 | 把引用方作为其他功能可以扩展的列表（约束 9）。 | Code |
| `delorun/packages/plugin-install-check/src/check.ts:288-299`（未提交的 `feat/plugin-supply-chain`） | `reconcileProfile` 边处理边写入每条记录。 | 拆分为一个返回每个决定的遍历，和一个写入记录的提交。 | Code |
| `delorun/packages/profile-safety/src/files.ts:52-58` | 历史的文件列表不包含 `delorun-template.json`。 | 在构建模板时添加它；上游的 `admitManagedFiles` 会把新名称准入现有的历史。 | Code |
| `packages/preset/agent-preset-registry/src/index.ts:220-224` 及 `packages/api/session-controller/src/agent.ts:271-283` | 预设 id 没有任何定义的 chat 会以 `agent-preset/not-found` 失败，并且 studio 不提供任何选择。 | 显示该 chat 并带有规则 30 的两个操作；不回退到默认预设。 | Code |
| `delorun/packages/contract-archive-and-trash/src/index.ts:26-32` | C8 的定制行拒绝凭据引用，而模板按名称需要它们，并与模板格式重叠。 | 冻结定制 schema（约束 10）；构建模板时，归档指向模板。 | Code |

<a id="open-questions"></a>

## 尚待解决的问题

1. **“template” 一词的冲突。**没有任何 `delorun` 命令叫 `template`，所以这个命令是空闲的。这个词有两种用法：上游把它自己发布的 profile（`web`、`headless`、`sdk`、`acp`）称为 “profile templates”，见 `dsh --from-default-profile <name>` 以及 Delorun 自己的页面（“upstream's headless template”）；而 `delorun template import` 和 `export` 位于 `delorun import` 和 `export`（它们移动 chat 归档）以及 `delorun import-home` 旁边。建议：把 “template” 保留给这个功能，并在 Delorun 的页面现在写 “upstream's template” 的地方写 “upstream's shipped profile”，这样此人遇到的只有一个含义；保留两个导入命令，并在各自的帮助中说明它移动的是什么。请确认。
2. **切换时自动保存。**规则 25 在活动模板自上次保存以来发生变化时，把它保存为新版本，所以切换从不丢失编辑。请确认，或者切换应当询问？
3. **未签名的共享模板。**规则 5 在此人输入 `unverified` 之后接受未签名的模板，与 C8 对归档所做的一样。来自他人的模板是否应当要求签名，而把未签名的限制在此人自己的导出和备份文件？

已决定的默认值，在此记录以供评审：备份涵盖每个已保存的模板、home 的 `skills/` 和 `AGENTS.md` 以及 home 补丁（规则 38）；stock home 的导入写入活动模板（规则 37）；共享模板中的 harness 编辑在应用任何东西之前，逐个文件并附带其差异显示（规则 23 和 35）；切换在一个 profile 之内（规则 33）。

<a id="implementation-status"></a>

## 实现状态

本页的任何内容都尚未构建。这些规则所重用的 profile 文件及其带恢复的历史、安全模式的覆盖层以及 C8 的归档读取器已构建，并由它们自己的约定描述。
