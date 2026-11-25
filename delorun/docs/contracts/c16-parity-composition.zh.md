---
description: "约定 C16：对等组合的规格，它使上游录制的场景原样回放；包括其开关注册表、回放通道如何选择该组合、通过规则与开关扫描。"
---

# 约定 C16：对等组合

[English](c16-parity-composition.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

对等组合是 Delorun 在基线标签 `dsh-v0.2.2-rc.1` 上回放上游录制场景、并使其预期输出逐字节一致所用的配置。它是关闭了 studio bundle（由 studio 包交付）的 Delorun 运行时，关闭了每一项影响模型的 Delorun 变更，并把每一项列明的 Delorun 默认值设为其上游取值（前提是回放会行使该默认值）。Delorun 的默认组合不受本约定约束，由 Delorun 自己录制的场景来证明。本页定义该组合、使每项影响模型的变更可开关的开关注册表、回放通道如何选择该组合、通过规则以及开关扫描。

<a id="status"></a>

## 状态

对等组合、overlay、注册表和重放通道均已构建；四个注册表默认值和一个已更改的默认值没有被任何发布的 profile 应用。

- **已构建并已使用：** 只有重放通道通过 `DSH_SNAPSHOT_PATCH` 选择的 overlay；注册表 `PARITY_SWITCHES`；以及 CLI profile 中针对同意与防护开关、更新闸门、受保护的 home、一次性启动令牌和默认工作区文件夹的行，每个开关均为开启。
- **未应用：** 没有任何发布的行设置 `preset_inspect`、`plugin_manager_read_exemption`、`profile_history` 或 `container_denial_marker`，因此 CLI profile 按其 Config 默认值（即对等值，关闭）运行它们，尽管注册表的默认值是开启；也没有任何发布的行选择 `ptc` 作为引导预设，因此 CLI profile 保持上游的 `standard`。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [组成](#composition)
  - [已变更的默认值](#changed-defaults)
  - [开关注册表](#switch-registry)
  - [回放通道](#replay-lane)
  - [开关扫描与通过规则](#switch-sweep-and-pass-rule)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="composition"></a>
### 组成

对等组合由以下部分组成。

- 基线标签上上游的 profile、bundle 与场景层，不作任何改动。场景的 profile 与 composition 来自其 `snapshot.yml`。其回放层按上游的方式生效：composition 的 `cordis.snapshot.yml`、基础 composition 的 `model.cordis.yml`，以及场景的 `runtime.cordis.yml`（如存在）。
- `@delorun/bundle-local`，由对等覆盖层以其对等形式重述。不挂载 `@delorun/bundle-studio`：开关 `studio_additions` 保持其 Config 默认值，即关闭，也就是 stock 外观。同样不挂载 `@delorun/bundle-headless`：对等组合保留上游的 `headless` profile 原样，不带 Delorun 的防护。
- [开关注册表](#switch-registry)中的每个开关都处于其对等取值。关闭的开关不注册任何影响模型的内容：不注册工具、工具 schema、工具描述、工具结果文本、system prompt context 或运行时 context。
- [下表](#changed-defaults)中的每项已变更默认值都处于其对等取值。

对等覆盖层是一个 Cordis patch 文件 `delorun/apps/tools/src/parity/composition/parity.overlay.yml`，用于设定上述开关与默认值。回放通道按[回放通道](#replay-lane)所述把它传给每个 snapshot 进程。

<a id="changed-defaults"></a>
### 已变更的默认值

Delorun 有意变更了以下上游默认值。对等组合把每一项设为其对等取值。若回放不行使某项默认值，对等组合保留 Delorun 的取值，因此该行说明回放并不需要撤销该变更。

| 默认值 | Delorun 默认组合 | 对等组合 | 对等取值的理由 |
| --- | --- | --- | --- |
| studio 附加功能（`studio_additions`） | 开启，并有一个用于 stock 外观的开关 | 关闭，即 stock 外观 | 录制的 web 场景会比对上游的界面输出。 |
| studio 新手引导中选中的 agent 预设（`agent-preset-registry.config.default`） | 注册表中为 `ptc`；没有任何交付的行设置它，因此 CLI profile 保持 `standard` | `standard`，即上游的组合默认值 | 未指定预设的场景运行在组合默认值上，因此回放需要上游的取值。 |
| 每个工作区的权限预设（`permission_defaults`） | 新工作区从 `workspace-write` 开始。为某个工作区选择 `danger-full-access` 需要该工作区一次同意。每个工作区沙箱中的命令与 `web_fetch` 能到达其设置允许的网络，默认为 `open`。 | 上游的组合默认值（`sandbox-policy.config.mode` 为 `workspace-write`，`approval.config.policy` 为 `ask`），没有同意要求 | 生效的权限策略通过 system prompt context 进入每次模型请求，录制的场景 `permission-policy-context` 会回放它。 |
| 桌面分析（`product-analytics.config.enabled`） | `false` | `false`，保留 Delorun 的取值 | 不需要：回放不挂载桌面 Host，因为 `sdk-desktop` 组合运行的是 `sdk` profile。 |
| DeepSeek 会话日志上传（`session-log-deepseek.config.enabled`） | `false` | `true`，即上游的取值 | 录制的场景在上传开启时运行，除非其回放层将其设为 `false`；覆盖层位于这些回放层之前。 |
| `web_fetch` 防护（`fetch_guard`） | 开启 | 关闭 | 录制的抓取场景会调用回环夹具，而防护会拒绝这些目标。 |
| `preset_inspect`（`preset_inspect`） | 注册表中开启；没有任何交付的行设置它，因此 CLI profile 将其关闭运行 | 关闭 | 该工具对模型可见，且不存在于基线标签中。 |
| doctor（`doctor`） | 开启，且可切换 | 关闭 | doctor 是由人运行的命令，而非对模型可见的工具；它不存在于基线标签中。 |
| 远程访问（`reach`） | 开启：reach 服务挂载，所有方式保持关闭，直到本人开启其中一种 | 关闭：`@delorun/home-auth` 与 reach 服务都不挂载 | 录制的场景运行在上游自己的 authenticator 上，不打开任何远程访问监听器。 |

DeepSeek 会话日志上传在每个挂载了 `@delorun/bundle-local` 的 profile 中都处于关闭状态：`delorun` 的 CLI profile，以及任何添加了该 bundle 的其他 profile。未挂载它的 profile 保留插件自身的默认值，即开启：Delorun 同样交付的上游裸 `dsh` 启动器运行 `web` profile 时仍会上传会话日志，录制会话回放对回放层未将其关闭的那部分语料也保留上游的取值。差异在入口点，而不在开关——Delorun 从自己交付的 bundle 写入该行，不为它不运行的 profile 修改任何上游默认值。

<a id="switch-registry"></a>
### 开关注册表

每一项对模型可见的 Delorun 变更以及每一项功能开关，在开关注册表中恰好注册一条记录。记录给出开关的 `id`、注册它的包或上游编辑、其默认取值、对等取值、证明它的场景，以及它所开关的、对模型可见的内容。带有 `featureSwitch: true` 的功能开关不开关任何对模型可见的内容；doctor 即是其一。注册表是 `@delorun/contract-parity-composition` 中的常量 `PARITY_SWITCHES`，其版本为 `PARITY_REGISTRY_VERSION`。开关 id 使用小写蛇形命名，且永不复用。

注册表包含以下条目。

| 开关 id | 注册方 | 默认值 | 对等取值 | 它所开关的、对模型可见的内容 |
| --- | --- | --- | --- | --- |
| `studio_additions` | `@delorun/plugin-theme`，由 `@delorun/bundle-studio` 在开关开启时挂载 | 开 | 关 | 无：主题、侧边栏、chat 状态、设置布局和新手引导的功能开关。关闭即 stock 外观。 |
| `rename_workspace_tool` | `@delorun/bundle-local`，其 `delorun-workspace-rename` 行 | 开 | 关 | `rename_workspace` 工具，它在本人允许之后，通过工作区注册表重命名工作区。 |
| `main_chat` | `@delorun/plugin-main-chat`，没有任何 Delorun profile 挂载的实验性插件 | 凡有行挂载它之处均为开 | 关 | 主 chat 的工具（包括其写入类工具）、其防护和其报告。 |
| `permission_defaults` | `@delorun/plugin-permission-defaults` | 开 | 关 | 工作区默认预设、完全访问的一次性同意要求，以及每个工作区沙箱中命令与 `web_fetch` 的网络。 |
| `fetch_guard` | `@delorun/plugin-fetch-guard` | 开 | 关 | `web_fetch` 与 HTTP 抓取提供方对回环、链路本地与私有网络目标的拒绝，附带带类型的原因。 |
| `preset_inspect` | Delorun 对上游预设工具的编辑 | 开 | 关 | `preset_inspect` 工具。 |
| `doctor` | `packages/boot/doctor`，由 `apps/cli` 启动 | 开 | 关 | 无：doctor 命令的功能开关。 |
| `reach` | `@delorun/reach` | 开 | 关 | 无：本人 tailnet 上远程访问的功能开关；每种方式保持关闭，直到本人开启它。 |
| `plugin_manager_read_exemption` | Delorun 对上游 `plugin_manager` 工具的编辑 | 开 | 关 | 只读动作 `list_plugins`、`list_bundles`、`list_version_exemptions`、`history` 与 `read_config` 的提权豁免，以及说明该豁免的工具描述。 |
| `profile_history` | Delorun 对上游 `plugin_manager` 工具的编辑 | 开 | 关 | 动作 `history`、`read_config`、`configure`、`undo` 与 `restore`，以及 `undo` 与 `restore` 带回的插件、构建与豁免的审计。 |
| `scheduled_task_consent` | Delorun 对上游 schedule 工具的编辑 | 开 | 关 | `schedule_create` 与 `schedule_edit` 的同意，它写明重复规则、目标会话及其权限预设。 |
| `instruction_layer_consent` | Delorun 对指令层文件的审批 | 开 | 关 | 模型发起的、对 skill、预设或 `AGENTS.md` 的写入所需的审批，它写明效果并展示差异。 |
| `approved_plugin_write_consent` | Delorun 对已批准插件写入的审批，位于 `@delorun/plugin-instruction-consent` | 开 | 关 | 智能体在一个 chat 中首次写入本人已在 Changes 下批准的某个插件的文件夹之前所请求的审批，它写明该插件、说明此更改将等待本人在 Changes 中评审并展示差异，以及对被拒绝写入的带类型拒绝。 |
| `mcp_add_consent` | Delorun 的 MCP 服务器添加流程 | 开 | 关 | 同意书，写明添加的 MCP 服务器将运行的命令。 |
| `browser_additions` | Delorun 对上游 Playwright 浏览器提供方的修改，`@delorun/bundle-browser` 以开启该开关的方式设置其行 | 开 | 关 | 替换 Playwright 对未安装浏览器版本之报告的 Browser 设置消息，以及提供方输出文件夹的 `.gitignore`。工具拒绝（`browser_run_code_unsafe` 始终被拒绝）、chat 文件夹防护以及把 chat 文件夹作为服务器唯一 MCP root，都是安全不变量，在所有开关关闭时依然成立。 |
| `use_my_browser` | `@delorun/browser-use-browse`，`@delorun/bundle-real-browser` 以开启该开关的方式插入其行 | 开 | 关 | `use_my_browser` 工具、只在可使用该 chat 授权的轮次中放行每次 browse 调用的防护，以及为本人已允许的 chat 启动的 browse 服务器及其工具和系统提示词段落。关闭时，该行只校验其字段，不挂载任何内容。 |
| `external_agent_consent` | `@delorun/plugin-delegation-consent` | 开；本人可以在 Settings、External agents 中关闭它，setup 的提示回答不会改变它 | 关 | Claude Code 或 Codex 之类外部智能体启动之前的同意、其运行时限、其工具描述，以及对其包的 `plugin_manager` 拒绝。 |
| `live_agents` | `@delorun/plugin-agent-seats`，其行由 `@delorun/bundle-local` 在开关开启时插入 | 开 | 关 | 每个运行中智能体（`claude_code`、`codex`）的交接工具、席位提供方、执行器、一次性 subagent 工具的限制，以及智能体问题的中继。关闭时，该行声明其预览开关且不挂载任何东西；开关开启时，`externalAgents.liveAgents` 预览开关仍然决定运行中智能体是否运行。 |
| `model_prompt` | Delorun 对上游系统提示词服务、`harness-dev-context`、`tool-terminal` 与 `tool-workflow` 的编辑，其措辞由 `@delorun/bundle-local` 的 `delorun-prompt-wording` 行开启 | 开 | 关 | 系统提示词的检出与 Web GUI 段落及其运行时上下文（Delorun 的措辞，而检出文本只在真实检出中），以及工作流与终端段落（只在步骤提供该工具时）。关闭时，每一段都保留上游的文本，并且无论检出是否真实、工具是否提供都会发送。身份行不被切换。 |
| `container_denial_marker` | Delorun 对上游容器拒绝报告的编辑 | 开 | 关 | 容器内拒绝时的环境拒绝标记。 |
| `update_turn_refusal` | `@delorun/bundle-local`，其 `delorun-update-gate` 行 | 开 | 关 | 当 `delorun` 的 chat 闸门被持有时，每个新轮次的第一步以 `UPDATE_PENDING` 被拒绝（[C19](c19-home-process.zh.md)），因此该轮次以这条消息结束，且没有模型请求；并且，在 `holdUntilChecked` 下，每个轮次的第一步要等到 `delorun` 检查完已启动的 Host 的行与服务，最长 `checkWaitSeconds`，之后该轮次以 `START_CHECK_PENDING` 结束。 |
| `update_check` | `@delorun/bundle-local`，其 `delorun-update-check` 行 | 开 | 关 | 无：更新检查的功能开关，即向发布通道请求最新发布，这是 stock DSH 不做的请求（[C3](c03-update-report.zh.md#update-check)）。关闭时，该行不提供服务也不注册路由，不运行任何检查。 |
| `plugin_changes_pending` | `@delorun/plugin-changes` | 开 | 关 | 智能体以动作 `install_bundle` 或 `remove_bundle` 发起的 `plugin_manager` 调用不会运行：它作为待处理更改记录在 profile 的更改日志中，模型读到的拒绝写明 `delorun changes show <id>` 并说明没有安装任何内容。 |
| `sandbox_protected_reads` | Delorun 对上游 `glob`、`grep` 与 `present` 工具的编辑 | 开：`@delorun/bundle-local` 的 `sandbox` 行设置 `protectedHome` | 关：对等覆盖层把 `sandbox` 行留给上游，而上游不设置 `protectedHome` | 搜索工具与 `present` 是否遵循沙箱提供方的受保护读取：以 Delorun 主目录为根的搜索被拒绝，其路径从范围更大的搜索中略去，主目录下的文件不会被呈现，与 `read`、`read_image` 已有的拒绝一致。 |
| `one_time_launch_tokens` | Delorun 对上游连接的编辑，`@delorun/bundle-local` 在开关开启时设置其 `connection` 行 | 开 | 关：对等覆盖层把 `connection` 行留给上游的 web bundle | 无：一次性 studio 登录链接的功能开关（[C4](c04-admission.zh.md#launch-tokens)）。关闭即上游可重复使用的启动令牌。 |
| `default_workspace_directory` | `@delorun/bundle-local`，其 `workspace-controller` 行，它读取 `delorun start` 解析出的文件夹 | 开：该行把 `defaultWorkspaceDirectory` 设为 `<documents>/Delorun/default-workspace`，在平台没有报告文档文件夹时为 `<home>/Delorun/default-workspace`；由 `delorun start` 之外的方式启动时，该键保持未设置 | 关：对等覆盖层把 `workspace-controller` 行留给上游，上游不设置 `defaultWorkspaceDirectory`，而是按自己的文档查找来放置首次使用的工作区 | studio 首次使用的工作区的文件夹，它作为该工作区中 chat 的工作目录，以及其工具结果中的绝对路径，到达模型。 |

注册表条目的 `defaultValue` 是注册表给予 Delorun 默认组合的取值，`parityValue` 适用于对等组合。`permission_defaults`、`fetch_guard`、`instruction_layer_consent` 和 `update_turn_refusal` 也通过 `@delorun/bundle-headless` 的行，以与 CLI profile 相同的取值，应用于 `delorun headless` 启动的 profile（[C19](c19-home-process.zh.md#host-invariants)）；需要询问人的防护在那里拒绝，因为该 profile 不组合任何批准应答器。headless profile 不是回放 profile，因此这四项在对等组合中仍保持其对等取值。CLI profile 应用每个已构建开关的 `defaultValue`，但 `preset_inspect`、`plugin_manager_read_exemption`、`profile_history` 和 `container_denial_marker` 除外，没有任何交付的行设置它们，因此每一项都按其 Config 默认值（关闭）运行。已构建开关的字段，要么是布尔 Config 字段，其 schema 默认值即对等取值；要么是存在性字段：一个 JSDoc 写明该开关的 Config 键，Delorun 的默认组合在该模块的行上设置它，对等组合则不设置。存在性开关默认开启、在对等组合中关闭，`parity-switches` 及其测试检查两个组合的行。由配置设定每个开关的取值。由上游编辑注册的开关，是上游新增的 hook 或配置字段，其所控制的行为位于 `delorun/` 之下。

<a id="replay-lane"></a>
### 回放通道

回放通道通过环境变量 `DSH_SNAPSHOT_PATCH` 选择对等组合，该变量的值是对等覆盖层的路径。`scripts/session-snapshot-corpus.corpus.ts` 中 `snapshotAdapters` 列出的每个 snapshot 适配器都读取该变量，并将覆盖层作为 `--patch` 参数传入。覆盖层位于每个进程的第一个 patch（即根配置文件）之后，并位于每个场景层之前，因此场景自己的回放层保留最后的决定权。

检查 `parity-replay` 在设置该变量的情况下运行 `pnpm run test:snapshot`，其覆盖 session、SDK 与 ACP 的回放，以及 web 场景的语料检查。完整的 web 回放是另一项运行：`DSH_SNAPSHOT=replay DSH_SNAPSHOT_PATCH=delorun/apps/tools/src/parity/composition/parity.overlay.yml pnpm run test:web:built`，它在每次 green-base 出口运行，且不属于 `parity-replay`。该通道不编辑任何 `snapshot.yml`、回放层、夹具或预期输出。若适配器在 `DSH_SNAPSHOT=record` 或 `DSH_SNAPSHOT=refresh` 模式下收到该变量，它在启动任何进程之前失败。

<a id="switch-sweep-and-pass-rule"></a>
### 开关扫描与通过规则

每条注册表记录在 Delorun 的 snapshot 树中都有一个开关开启场景。其目录为 `snapshots/<profile>/delorun-<id>`，其中 `<id>` 是把下划线替换为连字符后的开关 id；该场景的 `runtime.cordis.yml` 只把该开关设为非对等取值，并加上一条场景本地的 `agent-default-model` 配置，用以固定语料库模型 `deepseek-v4-flash`。Web 开关开启场景没有 `runtime.cordis.yml`；其 `apps/web/tests` 下的 e2e 驱动用 `launchWebScaffold` 的选项开启该开关，并在回放时通过智能体默认模型选择同一模型。扫描在对等覆盖层下运行每个开关开启场景，其覆盖范围由[回放通道](#replay-lane)定义，因此被测开关是对等组合中唯一的行为差异。

检查 `parity-switches` 分两部分运行。静态部分扫描 `delorun/`，查找 `systemPrompt.context` 的贡献、工具注册与工具 schema 的变更。匹配项若不属于任何注册表记录，则检查失败。回放部分运行上述的开关开启场景。

对等运行在以下各项都满足时通过：在覆盖层下，`pnpm run test:snapshot` 对基线标签语料中的每个 session、SDK 与 ACP 场景退出码为 0；web 场景的语料检查通过；且之后 `git diff --exit-code snapshots/` 没有变化。Delorun 的默认组合在 Delorun 自己录制的场景无覆盖层通过时通过。

<a id="consumers"></a>
## 消费方

- `delorun/packages/contract-parity-composition/`：注册表、其版本与开关类型。
- `delorun/apps/tools/src/parity/composition/`：对等覆盖层、回放通道、静态扫描与开关扫描。
- `delorun/apps/tools/src/run-checks.ts`：检查 `parity-replay` 与 `parity-switches`。
- `delorun/apps/tools/src/parity/release/`：由发布工具交付的、对构建好的发布产物进行的对等运行。
- `@delorun/plugin-theme`、`@delorun/plugin-main-chat`、`@delorun/plugin-permission-defaults` 与 `@delorun/plugin-fetch-guard`：注册开关的包；`@delorun/bundle-studio` 在 Delorun 的默认组合中设置 `studio_additions`，Delorun 的 CLI profile 所添加的 `@delorun/bundle-local` 注册它自己的开关。`@delorun/bundle-headless` 在 `headless` profile 中挂载这些开关的同意与防护插件，自身不注册任何开关。
- `packages/boot/doctor`，由 `apps/cli` 启动：doctor 命令的注册。
- 上游的 `vitest.snapshot.config.ts`、`snapshotAdapters` 中列出的 snapshot 适配器，以及每个场景的 `snapshot.yml` 与回放层文件；回放通道读取它们，但不改动它们。

<a id="compatibility"></a>
## 兼容性

注册表只增不减。新增开关的变更须在同一次改动中同时添加其记录、对等取值与开关开启场景；开关扫描会拒绝缺少场景的记录。删除记录或复用 id 属于注册表变更，须递增 `PARITY_REGISTRY_VERSION`。

改变对等取值会改变回放所断言的内容，因此须与证明该改动的回放通过一并进行。移动基线标签时，`parity-replay` 与完整的 web 回放都要在新基线标签的场景上重新运行，因为上游的预期输出就是该基线标签的预期输出。

对等组合是测试组合。正式 profile 不选择它，它也不对人的配置承担兼容性承诺。

<a id="security"></a>
## 安全

要求：

- 只有回放通道设置 `DSH_SNAPSHOT_PATCH` 时，对等覆盖层才会加载。任何正式 profile、人的配置与命令行选项都不会选择它。
- 在对等组合中，`permission_defaults`、`fetch_guard`、`scheduled_task_consent`、`instruction_layer_consent`、`approved_plugin_write_consent`、`mcp_add_consent`、`external_agent_consent`、`update_turn_refusal`、`plugin_changes_pending` 与 `container_denial_marker` 处于关闭状态，其保护在该组合中不存在。
- 人实际运行的组合会挂载这些同意插件：`@delorun/bundle-local`（CLI profile 唯一添加的 Delorun 层）插入 `delorun-instruction-consent`、`delorun-mcp-consent`、`delorun-permission-defaults`、`delorun-schedule-consent`、`delorun-fetch-guard`、`delorun-plugin-changes`、`delorun-workspace-rename` 与 `delorun-update-gate` 各行并开启其开关，对等覆盖层把这八行原样重述为 disabled，因此对等组合一个都不挂载。`delorun-instruction-consent` 行带有两个开关，即 `instruction_layer_consent` 与 `approved_plugin_write_consent`。它还插入开启更新检查的 `delorun-update-check`，对等覆盖层把它重述为 disabled，因此对等组合不会请求更新的发布。`container_denial_marker` 是上游 `sandbox-policy` 行的字段，没有任何交付层设置它，因此两种组合都运行其 Config 默认值，即关闭。
- 交付的 sandbox 行保护 Delorun 主目录：`@delorun/bundle-local` 把它的 `protectedHome` 设为 harness 主目录（对每个运行时进程而言即 Delorun 主目录），并带上 C1 的读取豁免，因此受限命令无法读取 `<home>/secrets` 下的同意存储；`delorun start` 再把该 profile 的通道套接字加入 `deniedSockets`。对等覆盖层把该行留给上游的组合，因此回放运行的是上游的限闭。
- `plugin_manager_read_exemption` 只豁免五个只读动作。每个写入动作仍需要 `danger-full-access` 提权。
- 容器内的拒绝永远不会附带提权指引，`bwrap` 的策略拒绝永远不会被标为 `environment`。
- 模型发起的、对指令层文件的写入、将定时任务投递到完全访问工作区，以及添加 MCP 服务器，都须先等待其同意，才会产生任何效果。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `parity-switches refuses an unregistered model-visible contribution` | 一个向 `systemPrompt.context` 贡献内容却没有注册表记录的夹具 Delorun 插件，会使静态扫描失败。 |
| `parity replay refuses a model-visible switch left on` | 一个在对等组合中仍开启某项对模型可见开关的夹具，会使回放通道失败。 |
| `parity replay refuses record and refresh modes` | 在 record 或 refresh 模式下收到 `DSH_SNAPSHOT_PATCH` 的适配器，在启动任何进程前失败，且不写入夹具。 |
| `fetch guard refuses loopback, link-local and private targets` | 在默认组合中，`web_fetch` 访问 `127.0.0.1`、`169.254.169.254` 与 `fe80::1` 会被拒绝，并返回模型可读的带类型原因。 |
| `scheduled task delivery into a full-access workspace is refused without consent` | 投递被拒绝并返回带类型的原因，该任务显示为已暂停，且不运行任何轮次。 |
| `instruction-layer write without approval changes nothing` | 模型发起的、对 skill、预设或 `AGENTS.md` 的写入，在写明效果与差异的审批被授予之前，不改变该文件。 |
| `MCP server add without consent starts no command` | 在同意被授予之前，同意书中写明的命令不会启动。 |
| `plugin_manager write actions keep the escalation under the read exemption` | `set_plugin`、`set_bundle`、`install_bundle`、`remove_bundle`、`set_version_exemption`、`undo` 与 `restore` 各自都需要 `danger-full-access` 提权。 |
| `plugin_manager history records no version` | 在豁免路径上，`history` 列出版本但不记录任何版本。 |
| `plugin_manager read_config withholds values of a non-native Config` | 对于不是原生 schema 的 Config，`read_config` 不返回任何取值。 |
| `container denial carries no escalation guidance` | 在默认组合的每种权限模式下，容器内的拒绝都返回环境标记，且不附带提权指引。 |
| `bwrap policy denial is never labelled environment` | 来自 `bwrap` 的 `Read-only file system` 拒绝不会被标为 `environment`。 |
| `parity overlay is not selected by a person's configuration` | 在存在覆盖层文件但未设置 `DSH_SNAPSHOT_PATCH` 的情况下启动的正式 profile，不会加载该覆盖层。 |
| `update gate refuses a new turn while held` | 在附着于 `delorunTurnGate` 服务的来源被持有时，默认组合中的新轮次会在任何模型请求之前以 `UPDATE_PENDING` 结束，已在运行的轮次则继续其下一步。 |
| `confined command cannot read the home's secrets` | 在默认组合交付的 sandbox 行之下，工作区命令无法读取 `<home>/secrets` 下的金丝雀文件；同一命令不受限时能读到它，且读取豁免下的文件仍然可读。 |

回放证明，用以表明关闭开关会恢复上游的输出，它们不是拒绝测试：

- `parity replay passes the base tag's scenarios with every switch off`（对等回放在所有开关关闭时通过基线标签的场景）。
- `fetch guard off replays the base tag's fetch scenarios unchanged`（抓取防护关闭时，基线标签的抓取场景原样回放）。

<a id="decided-values"></a>
## 决定的取值

- 基线标签为 `dsh-v0.2.2-rc.1`。
- 注册表版本为 `1`。
- 回放通道的变量为 `DSH_SNAPSHOT_PATCH`，覆盖层路径为 `delorun/apps/tools/src/parity/composition/parity.overlay.yml`。
- 开关开启场景的目录为 `snapshots/<profile>/delorun-<id>`。
- 对等取值即[已变更的默认值](#changed-defaults)表与[开关注册表](#switch-registry)表中的取值。
- 对等组合中会话日志上传保持开启，且在所有组合中桌面分析都保持关闭。
