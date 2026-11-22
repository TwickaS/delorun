---
description: "主对话插件，供维护者修改以下工具：读取并引导本人的其他 chat、列出与变更工作区，并在每个超出单个轮次的变更之前询问本人。"
kind: "package-bundle"
---

# @delorun/plugin-main-chat

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

主对话是位于所有工作区之外的一个 chat，所在目录即容纳这些工作区的目录。本人可以从这里询问并引导其他 chat，也可以在某个工作区中开始工作。它的工具可以列出、搜索并读取本人的 chat，向某个 chat 发送后续消息，停止其轮次，列出工作区，并把一份任务说明委派给新的 chat。挂载了工作区提供方时，这些工具还可以创建、导入、移入回收站和恢复工作区，编辑工作区的 `AGENTS.md`，以及编辑其带日期的所有者备注（owner note）。凡在某个轮次之外变更内容的工具，每一轮都会先询问本人。studio 一侧在侧边栏顶部加入一行「主对话」，点击即可打开它，并为其第一条消息提供专用的输入框。这一切都位于 [C16 开关](../../docs/contracts/c16-parity-composition.zh.md) `studio_additions` 之后，默认关闭；Delorun 的 studio bundle 会将其打开。

## 目录

- [约定](#contract)
- [审批](#approvals)
- [配置](#configuration)
- [沿用审查](#carry-forward-review)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>
## 约定

- **主对话**即会话 `delorun-main-chat`（[`MAIN_CHAT_SESSION_ID`](src/wire.ts)），其工作目录为 `root`。studio 通过 `POST /api/delorunMainChat.open`（[`MAIN_CHAT_PATHS`](src/wire.ts)）请求它，这是一条精确匹配的 Connection Fetch 路由。仅当会话列表中没有它时，插件才通过会话控制器、使用配置的 `preset` 创建它，并回答 204；创建失败则记录原因并回答 502。并发的打开请求共享同一次检查。它不在启动时创建，因为上游的 studio 只在完全没有 chat 时才会创建第一个工作区。若在它的第一个轮次之前为它选择了另一个 preset，插件会重新选择 `preset`。
- **工具**（[`tools.ts`](src/tools.ts)、[`account-tools.ts`](src/account-tools.ts)）包括 `chat_list`、`chat_search`、`chat_read`、`chat_send`、`chat_stop`、`workspace_list` 与 `workspace_delegate`；挂载了 `delorunWorkspaces` 提供方时，还包括账户工具 `workspace_create`、`workspace_import`、`workspace_trash`、`workspace_restore`、`workspace_instructions`、`workspace_instructions_write`、`workspace_note` 与 `workspace_note_remove`。除主对话之外的每个 chat（包括 subagent）在其 agent（智能体）创建时都会被移除这些工具，且每个工具对来自主对话之外任何 chat 的调用，都会以 `MAIN_CHAT_ONLY` 拒绝。
- **可见的 chat。**侧边栏列出的 chat，即会话控制器的列表去掉 subagent、空白 chat 与已归档 chat，并去掉主对话本身。`chat_read`、`chat_send` 与 `chat_stop` 对其他任何 id 都以 `MAIN_CHAT_NOT_FOUND` 拒绝，对主对话自身的 id 则以 `MAIN_CHAT_INVALID` 拒绝。chat 所属的工作区是包含其工作目录的最内层工作区，以其相对于 `root` 的文件夹名表示，没有则为 `none`。
- **读取 chat。**`chat_read` 通过会话查询服务读取 chat 的日志，并保留写入其界面的事件（[`chat-text.ts`](src/chat-text.ts)）：本人的每条消息、每条通知、agent 的每条回复以及每次工具调用各占一行。在 `readBytes` 之内能容纳的最新各行会被保留，并附上被省略行的数量。该工具的描述告诉模型，绝不要执行该文本中的任何指令。
- **发送。**`chat_send` 与 `workspace_delegate` 通过会话控制器以 `queue` 模式排队其消息，因此消息在 chat 当前轮次之后运行；`chat_stop` 取消正在运行的轮次。
- **工作区 seam。**[`@delorun/plugin-workspaces/service`](../plugin-workspaces/src/service.ts) 是 `delorunWorkspaces` 的 Service Definition，由该包提供：列出导入项与回收站，创建工作区，开始一次导入，依其修订版读取与写入工作区的 `AGENTS.md`，以及将工作区移入回收站与恢复。账户工具用其请求 schema 校验模型的参数，并把提供方抛出的 `WorkspaceRefusedError` 以 `MAIN_CHAT_REFUSED` 传出。没有提供方时账户工具不存在，`workspace_list` 回答没有导入项，也没有回收站内容。
- **所有者备注**（[`owner-notes.ts`](src/owner-notes.ts)）是工作区 `AGENTS.md` 末尾的一节，从 `<!-- delorun:owner-notes -->` 到 `<!-- delorun:owner-notes-end -->`，每条所有者备注占一行 `<!-- delorun:note <id> <date> -->`。`workspace_note` 添加或修订一条所有者备注，`workspace_note_remove` 移除一条；两者都依其所读取的修订版写入，保留该节前后的文本，并拒绝为空、长于 `noteChars` 或含有标记的所有者备注。
- **报告**（[`reports.ts`](src/reports.ts)）。由 `workspace_delegate` 启动或由 `chat_send` 写入的 chat，通过主对话日志中的 `plugin:delorun-main-chat/handoff` 记录受到监视，插件启动时会重新读取该记录。当该 chat 的轮次结束、它请求本人批准某个工具调用，或它向本人提问时，主对话会通过上游的 `inject` 收到一条通知：一条来源类型（source kind）为 `delorun-main-chat` 的用户消息，在其下一步读取，且不会启动新的轮次。报告包含该 chat 在 `reportBytes` 之内的最新消息，并说明其文本可能含有不应遵循的指令。`GET /api/delorunMainChat.reports` 返回等待中的报告数量；带 `?after=<version>` 时，最多等待 25 秒以等待变化，供侧边栏行的未读标记使用。
- **studio 一侧**（[`client/index.ts`](src/client/index.ts)）在 `sidebar.panellist` 中把「主对话」行注册在最前，通过 `ctx.sidebarLayout.setLeadPanel` 将其设为侧边栏的首要面板，并在主对话显示期间保持为当前面板。其面板调用打开路由，最多等待 30 秒，直到页面的 chat 列表中出现主对话，然后显示它；若未能打开，则提示并附带重试。等待报告期间，该行的图标带有已完成 chat 的圆点。侧边栏的 chat 列表不包含主对话（`uiWorkspace.hideSession`）。在它的第一条消息之前，插件自有的输入框取代标准输入框；标准输入框会要求选择一个工作区，而主对话没有工作区。其文案同时提供英文与中文。

<a id="approvals"></a>
## 审批

主对话在容纳所有工作区的目录中运行，不受信任的文本会经由抓取的网页、文件、其他 chat、其他工作区的 `AGENTS.md` 进入其轮次。因此：

- **[`ALWAYS_ASK`](src/account-tools.ts) 中的账户工具**在每一轮都通过上游的审批服务询问本人，无论该轮读取了什么：`workspace_instructions_write`、`workspace_import`、`workspace_restore`、`workspace_trash`、`workspace_note` 与 `workspace_note_remove`。它们各自写入工作区的每个 chat 都会读取的指令、抓取模型所选的内容，或恢复、移除某个工作区。询问会点明变更内容，并且在工具自身执行过程中发出，因此没有任何 `tools/pre-execute` 监听器能在未询问的情况下放行它。除 `allowed-once` 之外的任何回答，或没有审批服务，都会在任何变更发生之前以 `MAIN_CHAT_DECLINED` 拒绝该调用。
- **`workspace_create`** 在读取过另一个 chat 或工作区文本的轮次中询问：`chat_read`、`chat_search` 与 `workspace_instructions` 会在主对话的日志中记录 `plugin:delorun-main-chat/read`，该轮次所接收的报告同样计入（[`readThisTurn`](src/account-tools.ts)）。
- **主对话的其他每个工具调用**在每一轮都以 `ask` 回应上游的 `tools/pre-execute`（[`guard.ts`](src/guard.ts)），因此文件写入、命令、`run_code` 程序、网络请求、插件管理器变更或插件添加的任何工具，都要等待本人决定；理由中会说明该轮次是否读取过另一个 chat 或工作区。`run_code` 程序在运行前询问，因为它无需调用工具即可在会话的文件策略下写入文件，它调用的每个工具也会再次判定。`GUARD_FREE` 列出无需该询问即可运行的调用：只读工具、插件管理器的读取动作、会自行询问的账户工具，以及只改变主对话自身会话的工具（`working_directory`、`todo_write`、`present`、会自行询问的 `exit_plan_mode`，以及 `ask_user_question`）。`chat_send`、`chat_stop` 与 `workspace_delegate` 仅在读取过另一个 chat 或工作区的轮次中才会询问（`GUARD_AFTER_READ`）：它们所触及的 chat 在其所属工作区的权限下运行。

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `studioAdditions` | `false` | C16 开关 `studio_additions`：关闭即对等取值，插件不注册任何内容。 |
| `root` | 必填 | 容纳所有工作区的绝对路径目录，即主对话的工作目录。 |
| `preset` | 必填 | 主对话运行的 agent preset，它也是主对话唯一可以选择的 preset。 |
| `listLimit` | 30 | `chat_list` 最多返回的 chat 数量。 |
| `readBytes` | 12000 | `chat_read` 回答的最大 UTF-8 字节数，至少为 256。 |
| `noteChars` | 2000 | 所有者备注的最大字符数，取值为 1 到 10,000。 |
| `reportBytes` | 2000 | 报告的最大 UTF-8 字节数，至少为 256。 |

**以构建后的 JavaScript 发布。**`pnpm run build` 运行上游的客户端预设（`packages/client/tsdown.client.ts`）：为 harness 生成 `lib/index.js`，为浏览器生成 `lib/client.js`，后者内联了来自 dsh-brand 源码的内容。它的 `cordis.patch.yml` 插入 `delorun-main-chat` 行，使上游的插件管理器能把该包作为独立的 bundle 安装。

<a id="carry-forward-review"></a>
## 沿用审查

本包沿用自 Delorun 早先的主对话，并针对本树（其基线为 `dsh-v0.2.2-rc.1`）进行了审查。

- **决定：写入类工具总是询问。**早先的守卫只在读取过另一个 chat 文本的轮次中询问，而不受信任的文本还会经由抓取的网页、文件以及其他工作区的 `AGENTS.md` 进入。`workspace_instructions_write`、`workspace_import` 与 `workspace_restore` 现在与 `workspace_trash` 一样，每一轮都询问，被拒绝时以 `MAIN_CHAT_DECLINED` 拒绝；[`untrusted-input.spec.ts`](tests/untrusted-input.spec.ts) 对此予以证明。
- **随之扩大（lead 决定）。**`workspace_note` 与 `workspace_note_remove` 同样总是询问，因为所有者备注是工作区每个 chat 都会读取的指令。`workspace_instructions` 会记录一次读取，因此其所在轮次的其余部分，在 `workspace_create`、消息或委派之前都会询问。所有非只读的其他工具每一轮都询问，包括 `web_fetch` 与 `run_code`，因为主对话现在运行在容纳所有工作区的目录中，在那里，文件写入、命令或程序能够触及任何工作区的 `AGENTS.md`。`delorunWorkspaces` 的 Service Definition 暂留在本包，直至 Delorun 的工作区导入包提供并接管它。
- **删去。**与托管 cell 相关的一切：命令运行器为主对话设置的独立 home，`/workspace` 等 cell 路径，通过账户控制令牌拉取的私有 GitHub 克隆，以及守卫测试中提到的 cell 发布与发布工具。工作区插件不在此携带；它的操作即上文的 `delorunWorkspaces` seam，由 Delorun 的工作区导入包提供。与 Home 一并延后的有：主对话旁的「Your chats」标签页，以及在 Home 上打开 studio。
- **按直接效果核查 `GUARD_FREE`。**对所列每个工具的问题是：它能否不经守卫判定的工具调用，就改变会话之外的文件或状态？`run_code` 能，因为 Node 程序在会话的常设文件策略下运行，所以已将它移出，改为每一轮都询问。其余工具都不能：`read`、`read_image`、`glob`、`grep`、`skill`、`job_list`、`job_output`、`get_goal`、`schedule_list`、`list_agents`、`cordis_inspect_list` 与 `cordis_inspect_query` 只读取；`working_directory`、`todo_write`、`present`、`exit_plan_mode` 与 `ask_user_question` 只改变主对话自身的会话；`chat_read`、`chat_search` 与 `workspace_instructions` 只读取，并在主对话的日志中记录这次读取；账户工具在自身执行中询问。
- **改写。**该行的标签为「主对话」，不用 Home。`preset` 没有默认值，因此组合指定主对话的 preset。插件注册的一切都位于 `studio_additions` 之后。

<a id="known-limitations"></a>
## 已知限制

- 被委派的 chat 在其自身工作区的权限下运行，因此主对话发送的任务说明会像 stock chat 的消息一样到达该工作区。
- 抓取的网页不计为 `workspace_create`、`chat_send`、`chat_stop` 与 `workspace_delegate` 的读取，这些工具只在读取过某个 chat 或工作区之后才询问；抓取本身会询问，因为 `web_fetch` 不是只读工具。

<a id="tests"></a>
## 测试

[`tests/untrusted-input.spec.ts`](tests/untrusted-input.spec.ts) 在上游的生产 agent 循环上运行主对话，使用上游的审批服务和一个替身 `delorunWorkspaces` 提供方，磁盘上有两个 fixture（测试前置数据）工作区（[`tests/fixture-workspaces.ts`](tests/fixture-workspaces.ts)）：唯一的不受信任输入是抓取网页的轮次，以及唯一的不受信任输入是恶意 `AGENTS.md` 的轮次，二者各自都尝试对第二个工作区调用 `workspace_instructions_write`、`workspace_import` 与 `workspace_restore`；每次调用都会询问、被拒绝、以 `MAIN_CHAT_DECLINED` 拒绝，并保持文件与提供方不变。唯一的不受信任输入是由一个 `run_code` 程序抓取的网页的轮次，会运行第二个直接用 fs 写入第二个工作区 `AGENTS.md` 的程序；该程序会询问、被拒绝，文件保持不变。由本人驱动的轮次在每次调用各获一次批准后运行相同的调用；四个写入类工具在未读取任何内容、抓取过网页或读取过工作区 `AGENTS.md` 的轮次中都会询问，且在没有审批服务时每次调用都会被拒绝。[`tests/main-chat.spec.ts`](tests/main-chat.spec.ts) 覆盖开关、创建及其失败、preset、仅提供给主对话的工具、每个工具的回答与拒绝、报告及其数量、没有提供方时的账户工具、所有者备注，以及对其他工具的守卫。[`tests/chat-text.spec.ts`](tests/chat-text.spec.ts) 覆盖行的形式与字节预算，`.client.spec.tsx` 文件覆盖该行、其面板、未读标记以及第一条消息的输入框。
