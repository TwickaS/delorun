---
description: "约定 C16：对等组合的规格，它使上游录制的场景原样回放；包括其开关注册表、回放通道如何选择该组合、通过规则与开关扫描。"
---

# 约定 C16：对等组合

[English](c16-parity-composition.md) | 中文

<a id="summary"></a>
## 摘要

对等组合是 Delo 在基线标签 `dsh-v0.2.2-rc.1` 上回放上游录制场景、并使其预期输出逐字节一致所用的配置。它是安装了 studio 包的 Delo 运行时，关闭了每一项影响模型的 Delo 变更，并把每一项列明的 Delo 默认值设为其上游取值（前提是回放会行使该默认值）。Delo 的默认组合不受本约定约束，由 Delo 自己录制的场景来证明。本页定义该组合、使每项影响模型的变更可开关的开关注册表、回放通道如何选择该组合、通过规则以及开关扫描。

<a id="contents"></a>
## 目录

- [摘要](#summary)
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
- 挂载 Delo 的 bundle `@delo/bundle-studio` 与 `@delo/bundle-local`，这两个 bundle 由 studio 包交付，并打开 studio bundle 的 stock 外观开关。
- [开关注册表](#switch-registry)中的每个开关都处于其对等取值。关闭的开关不注册任何影响模型的内容：不注册工具、工具 schema、工具描述、工具结果文本、system prompt context 或运行时 context。
- [下表](#changed-defaults)中的每项已变更默认值都处于其对等取值。

对等覆盖层是一个 Cordis patch 文件 `delo/apps/tools/src/parity/composition/parity.overlay.yml`，用于设定上述开关与默认值。回放通道按[回放通道](#replay-lane)所述把它传给每个 snapshot 进程。

<a id="changed-defaults"></a>
### 已变更的默认值

Delo 有意变更了以下上游默认值。对等组合把每一项设为其对等取值。若回放不行使某项默认值，对等组合保留 Delo 的取值，因此该行说明回放并不需要撤销该变更。

| 默认值 | Delo 默认组合 | 对等组合 | 对等取值的理由 |
| --- | --- | --- | --- |
| studio 附加功能（`studio_additions`） | 开启，并有一个用于 stock 外观的开关 | 关闭，即 stock 外观 | 录制的 web 场景会比对上游的界面输出。 |
| studio 新手引导中选中的 agent 预设（`agent-preset-registry.config.default`） | `ptc` | `standard`，即上游的组合默认值 | 未指定预设的场景运行在组合默认值上，因此回放需要上游的取值。 |
| 每个工作区的权限预设（`permission_defaults`） | 新工作区从 `workspace-write` 开始。为某个工作区选择 `danger-full-access` 需要该工作区一次同意。 | 上游的组合默认值（`sandbox-policy.config.mode` 为 `workspace-write`，`approval.config.policy` 为 `ask`），没有同意要求 | 生效的权限策略通过 system prompt context 进入每次模型请求，录制的场景 `permission-policy-context` 会回放它。 |
| 桌面分析（`product-analytics.config.enabled`） | `false` | `false`，保留 Delo 的取值 | 不需要：回放不挂载桌面 Host，因为 `sdk-desktop` 组合运行的是 `sdk` profile。 |
| DeepSeek 会话日志上传（`session-log-deepseek.config.enabled`） | `false` | `true`，即上游的取值 | 录制的场景在上传开启时运行，除非其回放层将其设为 `false`；覆盖层位于这些回放层之前。 |
| `web_fetch` 防护（`fetch_guard`） | 开启 | 关闭 | 录制的抓取场景会调用回环夹具，而防护会拒绝这些目标。 |
| `preset_inspect`（`preset_inspect`） | 开启，且可切换 | 关闭 | 该工具对模型可见，并且不存在于基线标签中。 |
| doctor（`doctor`） | 开启，且可切换 | 关闭 | doctor 是由人运行的命令，而非对模型可见的工具；它不存在于基线标签中。 |

<a id="switch-registry"></a>
### 开关注册表

每一项对模型可见的 Delo 变更以及每一项功能开关，在开关注册表中恰好注册一条记录。记录给出开关的 `id`、注册它的包或上游编辑、其默认取值、对等取值、证明它的场景，以及它所开关的、对模型可见的内容。带有 `featureSwitch: true` 的功能开关不开关任何对模型可见的内容；doctor 即是其一。注册表是 `@delo/contract-parity-composition` 中的常量 `PARITY_SWITCHES`，其版本为 `PARITY_REGISTRY_VERSION`。开关 id 使用小写蛇形命名，且永不复用。

注册表包含以下条目。

| 开关 id | 注册方 | 默认值 | 对等取值 | 它所开关的、对模型可见的内容 |
| --- | --- | --- | --- | --- |
| `studio_additions` | `@delo/bundle-studio`（由 studio 包交付），其中的主 chat 位于 `@delo/plugin-main-chat` | 开 | 关 | 主题、侧边栏、chat 状态、新手引导，以及主 chat（包括其写入类工具）。关闭即 stock 外观。 |
| `permission_defaults` | `@delo/plugin-permission-defaults` | 开 | 关 | 工作区默认预设，以及完全访问的一次性同意要求。 |
| `fetch_guard` | `@delo/plugin-fetch-guard` | 开 | 关 | `web_fetch` 与 HTTP 抓取提供方对回环、链路本地与私有网络目标的拒绝，附带带类型的原因。 |
| `preset_inspect` | Delo 对上游预设工具的编辑 | 开 | 关 | `preset_inspect` 工具。 |
| `doctor` | `packages/boot/doctor`，由 `apps/cli` 启动 | 开 | 关 | 无：doctor 命令的功能开关。 |
| `plugin_manager_read_exemption` | Delo 对上游 `plugin_manager` 工具的编辑 | 开 | 关 | 只读动作 `list_plugins`、`list_bundles`、`list_version_exemptions`、`history` 与 `read_config` 的提权豁免，以及说明该豁免的工具描述。 |
| `profile_history` | Delo 对上游 `plugin_manager` 工具的编辑 | 开 | 关 | 动作 `history`、`read_config`、`configure`、`undo` 与 `restore`，以及 `undo` 与 `restore` 带回的插件、构建与豁免的审计。 |
| `scheduled_task_consent` | Delo 对上游 schedule 工具的编辑 | 开 | 关 | `schedule_create` 与 `schedule_edit` 的同意，它写明重复规则、目标会话及其权限预设。 |
| `instruction_layer_consent` | Delo 对指令层文件的审批 | 开 | 关 | 模型发起的、对 skill、预设或 `AGENTS.md` 的写入所需的审批，它写明效果并展示差异。 |
| `mcp_add_consent` | Delo 的 MCP 服务器添加流程 | 开 | 关 | 同意书，写明添加的 MCP 服务器将运行的命令。 |
| `container_denial_marker` | Delo 对上游容器拒绝报告的编辑 | 开 | 关 | 容器内拒绝时的环境拒绝标记。 |

注册表条目的 `defaultValue` 适用于 Delo 的默认组合，`parityValue` 适用于对等组合。由配置设定每个开关的取值。由上游编辑注册的开关，是上游新增的 hook 或配置字段，其所控制的行为位于 `delo/` 之下。

<a id="replay-lane"></a>
### 回放通道

回放通道通过环境变量 `DSH_SNAPSHOT_PATCH` 选择对等组合，该变量的值是对等覆盖层的路径。`scripts/session-snapshot-corpus.corpus.ts` 中 `snapshotAdapters` 列出的每个 snapshot 适配器都读取该变量，并将覆盖层作为 `--patch` 参数传入。覆盖层位于每个进程的第一个 patch（即根配置文件）之后，并位于每个场景层之前，因此场景自己的回放层保留最后的决定权。

检查 `parity-replay` 在设置该变量的情况下运行 `pnpm run test:snapshot`，其覆盖 session、SDK 与 ACP 的回放，以及 web 场景的语料检查。完整的 web 回放是另一项运行：`DSH_SNAPSHOT=replay DSH_SNAPSHOT_PATCH=delo/apps/tools/src/parity/composition/parity.overlay.yml pnpm run test:web:built`，它在每次 green-base 出口运行，且不属于 `parity-replay`。该通道不编辑任何 `snapshot.yml`、回放层、夹具或预期输出。若适配器在 `DSH_SNAPSHOT=record` 或 `DSH_SNAPSHOT=refresh` 模式下收到该变量，它在启动任何进程之前失败。

<a id="switch-sweep-and-pass-rule"></a>
### 开关扫描与通过规则

每条注册表记录在 Delo 的 snapshot 树中都有一个开关开启场景。其目录为 `snapshots/<profile>/delo-<id>`，其中 `<id>` 是把下划线替换为连字符后的开关 id；该场景的 `runtime.cordis.yml` 只把该开关设为非对等取值，并加上一条场景本地的 `agent-default-model` 配置，用以固定语料库模型 `deepseek-v4-flash`。Web 开关开启场景没有 `runtime.cordis.yml`；其 `apps/web/tests` 下的 e2e 驱动用 `launchWebScaffold` 的选项开启该开关，并在回放时通过智能体默认模型选择同一模型。扫描在对等覆盖层下运行每个开关开启场景，其覆盖范围由[回放通道](#replay-lane)定义，因此被测开关是对等组合中唯一的行为差异。

检查 `parity-switches` 分两部分运行。静态部分扫描 `delo/`，查找 `systemPrompt.context` 的贡献、工具注册与工具 schema 的变更。匹配项若不属于任何注册表记录，则检查失败。回放部分运行上述的开关开启场景。

对等运行在以下各项都满足时通过：在覆盖层下，`pnpm run test:snapshot` 对基线标签语料中的每个 session、SDK 与 ACP 场景退出码为 0；web 场景的语料检查通过；且之后 `git diff --exit-code snapshots/` 没有变化。Delo 的默认组合在 Delo 自己录制的场景无覆盖层通过时通过。

<a id="consumers"></a>
## 消费方

- `delo/packages/contract-parity-composition/`：注册表、其版本与开关类型。
- `delo/apps/tools/src/parity/composition/`：对等覆盖层、回放通道、静态扫描与开关扫描。
- `delo/apps/tools/src/run-checks.ts`：检查 `parity-replay` 与 `parity-switches`。
- `delo/apps/tools/src/parity/release/`：由发布工具交付的、对构建好的发布产物进行的对等运行。
- `@delo/bundle-studio`、`@delo/plugin-main-chat`、`@delo/plugin-permission-defaults` 与 `@delo/plugin-fetch-guard`：注册开关的包，由 studio 包交付。
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
- 在对等组合中，`fetch_guard`、`scheduled_task_consent`、`instruction_layer_consent`、`mcp_add_consent` 与 `container_denial_marker` 处于关闭状态，其保护在该组合中不存在。Delo 的默认组合会让每一项保持开启。
- `plugin_manager_read_exemption` 只豁免五个只读动作。每个写入动作仍需要 `danger-full-access` 提权。
- 容器内的拒绝永远不会附带提权指引，`bwrap` 的策略拒绝永远不会被标为 `environment`。
- 模型发起的、对指令层文件的写入、将定时任务投递到完全访问工作区，以及添加 MCP 服务器，都须先等待其同意，才会产生任何效果。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `parity-switches refuses an unregistered model-visible contribution` | 一个向 `systemPrompt.context` 贡献内容却没有注册表记录的夹具 Delo 插件，会使静态扫描失败。 |
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

回放证明，用以表明关闭开关会恢复上游的输出，它们不是拒绝测试：

- `parity replay passes the base tag's scenarios with every switch off`（对等回放在所有开关关闭时通过基线标签的场景）。
- `fetch guard off replays the base tag's fetch scenarios unchanged`（抓取防护关闭时，基线标签的抓取场景原样回放）。

<a id="decided-values"></a>
## 决定的取值

- 基线标签为 `dsh-v0.2.2-rc.1`。
- 注册表版本为 `1`。
- 回放通道的变量为 `DSH_SNAPSHOT_PATCH`，覆盖层路径为 `delo/apps/tools/src/parity/composition/parity.overlay.yml`。
- 开关开启场景的目录为 `snapshots/<profile>/delo-<id>`。
- 对等取值即[已变更的默认值](#changed-defaults)表与[开关注册表](#switch-registry)表中的取值。
- 对等组合中会话日志上传保持开启，且在所有组合中桌面分析都保持关闭。
