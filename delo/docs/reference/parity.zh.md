# 对等清单

[English](parity.md) | 中文

对等清单记录本树中 Delo 所对照的每个 stock DeepSeek Harness（DSH）区域，以及每项刻意差异的状态，并给出一项证据。每一行都标明其基线，即对等组合所回放的上游记录版本 `dsh-v0.2.2-rc.1`（[对等组合](../contracts/c16-parity-composition.zh.md)）。本页涵盖下列各区域、约定 C16 所列的开关与变更默认值，以及[对比页面](../guide/delo-vs-stock.zh.md)列出的差异。它不对每项 stock 功能作完整清点。

## 如何判定各行

状态列描述本树的实际状态。`built`（已构建）表示该变更在树中：该行写明其开关 ID；对于没有开关的 Delo 变更，该行写 `no switch` 并给出其台账条目。`planned`（计划中）表示该变更不在树中：该行写明注册表中的开关 ID 与工作包；若注册表没有对应条目，则写明定义它的 C16 变更默认值或约定。`stock` 表示该区域中上游在基线上的行为未经 Delo 改动。

每行给出一项证据。检查名（如 `parity-switches`）运行 `node_modules/.bin/tsx delo/apps/tools/src/parity/composition/check-parity-switches.ts`，该检查读取开关注册表、开关字段与对等覆盖层。规范路径指向断言该行的测试文件。以人工检查：开头的条目指出审阅者用来确认该行的源码行。

有四个已构建的开关，其开关开启场景仍待录制。`parity-switches` 将它们报告为待录制，而不是通过，因此本页对这些开关不声称任何回放结果。

## Liveshare

Liveshare 是上游的实验性共享功能。本树保留它，并带有一项 Delo 修改。

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 拒绝共享观看者访问仅 owner 可用的接口 | `dsh-v0.2.2-rc.1`：共享观看者被拒绝访问仅 owner 可用的接口，如 `pluginManager/listPlugins`；本树保留该列表 | stock | `packages/experimental/liveshare/tests/viewer-access-policy.spec.ts` |
| 插件管理器的历史、恢复与撤销 | `dsh-v0.2.2-rc.1`：端点分类中没有 `pluginManager/history`、`pluginManager/restore` 与 `pluginManager/undo`；本树将每一项分类为 `owner-only`，位于 `packages/experimental/liveshare/src/endpoint-classification.ts` 第 142、152 与 156 行 | 已构建：无开关；`security` 台账条目 | 人工检查：这三行在 `dsh-v0.2.2-rc.1` 中不存在而在本树中存在，且该台账条目记录了负责人的裁定。 |

## 桌面应用负载

桌面应用的 Python、Node 与 Office 负载在本树中没有 Delo 修改。

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| Python 运行时 | `dsh-v0.2.2-rc.1`：桌面负载包含 Python 解释器，并拒绝缺少 node 与 pnpm 的负载；本树在 `apps/desktop` 下没有 Delo 修改 | stock | `apps/desktop/tests/primary-runtime-preparation.spec.ts` |
| Node 运行时 | `dsh-v0.2.2-rc.1`：准备好的运行时包含 `bin/node` 与一份 pnpm 发行版；本树在 `apps/desktop` 下没有 Delo 修改 | stock | `apps/desktop/tests/runtime-preparation.spec.ts` |
| Office 引擎 | `dsh-v0.2.2-rc.1`：每个平台的负载只保留其所选的 Office 引擎；本树在 `apps/desktop` 下没有 Delo 修改 | stock | `apps/desktop/tests/runtime-file-policy.spec.ts` |

## SDK 运行时选择

Delo 保留上游的 SDK 及其文档化的运行时选择。

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 运行时选择 | `dsh-v0.2.2-rc.1`：Python SDK 启动随附的 `dsh --profile sdk` 运行时，除非调用方选择了另一个 `dsh` 可执行文件或 profile（[Python README](../../../python/README.zh.md)）；本树在 `python/` 或 `packages/sdk/` 中没有 Delo 修改 | stock | `python/sdk/tests/test_bundled_runtime.py` |

## 刻意的差异

下列每项差异都是 Delo 的文档所述或 C16 所列的差异。各行按主题分组。

### home 与账户

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| home 目录 | `dsh-v0.2.2-rc.1`：主目录为 `~/.dsh`，由 `packages/util/home-paths/src/index.ts` 第 12 行的 `DSH_HOME_DIR_NAME` 命名；本树没有 `~/.delo` 的解析器，而 `delo/packages/contract-home-layout/src/index.ts` 第 15 行仅将 `~/.delo` 命名为约定常量 | 计划中：没有开关 ID 或工作包；约定 [C1](../contracts/c01-home-layout.zh.md) | 人工检查：两行均符合此描述，且 `packages/` 或 `apps/` 下没有代码读取 `.delo`。 |
| DeepSeek 账户与 Platform | `dsh-v0.2.2-rc.1`：`packages/credentials/deepseek-account`、`packages/credentials/deepseek-account-platform` 与 `packages/llm/llm-deepseek-account` 都在树中；本树保留这三者，而[对比页面](../guide/delo-vs-stock.zh.md)把移除它们列为 Delo 的差异 | 计划中：没有开关 ID 或工作包 | 人工检查：三个目录均存在，且都没有台账条目。 |

### 权限

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 每个工作区的完全访问同意 | `dsh-v0.2.2-rc.1`：完全访问不需要同意，C16 的对等列如此说明；本树没有按工作区的同意 | 计划中：`permission_defaults`（WP2.13） | `parity-switches` |
| 新工作区默认值 | `dsh-v0.2.2-rc.1` 与本树：新工作区从 `workspace-write` 开始，且除非模式为 `danger-full-access`，批准策略为 `ask`（`packages/bundle/base/cordis.patch.yml` 第 246 与 262 行） | stock | 人工检查：第 246 与 262 行设定了这些默认值，且该文件没有台账条目。 |
| sdk-minimal 沙箱模式 | `dsh-v0.2.2-rc.1` 与本树：`sdk-minimal` profile 将 `sandbox-policy` 模式设为 `danger-full-access`（`packages/bundle/sdk-minimal/cordis.patch.yml` 第 73 行） | stock | 人工检查：第 73 行设定该模式，且该文件没有台账条目。 |

### 对模型可见的工具

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| `preset_inspect` | `dsh-v0.2.2-rc.1`：没有 `preset_inspect` 工具。本树只在 `presetInspect` 开启时注册它，且该开关默认关闭。随附的 Standard、PTC 与 Cordis 预设在没有该开关的情况下挂载了工具行，因此本树中没有任何随附的预设会列出该工具 | 已构建：`preset_inspect` | `packages/preset/agent-preset-registry/tests/tools.spec.ts` |
| 唯一的新增模型可见 Delo 工具 | `dsh-v0.2.2-rc.1`：没有 `preset_inspect` 工具。本树中，在 Delo 的各项注册里，`preset_inspect` 是唯一带有新名称的工具；`plugin_manager` 的注册是修改而非新增 | 已构建：`preset_inspect` | 人工检查：`git diff --unified=0 dsh-v0.2.2-rc.1 -- packages apps scripts delo` 新增了一项带有新名称的工具注册，即 `packages/preset/agent-preset-registry/src/tools.ts` 中的 `preset_inspect`。 |

### 数据共享

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 桌面分析，当前值 | `dsh-v0.2.2-rc.1` 与本树：默认开启。`packages/client/product-analytics/src/index.ts` 第 36 行中 `product-analytics` 配置的 `enabled` 默认为 `true`，桌面 profile 在 `packages/bundle/web-app/cordis.patch.yml` 第 53 行将其设为 `true`。桌面外壳自身的标志在 Host 策略到达之前为 `false`（`apps/desktop/src/main.ts` 第 480 行） | stock | 人工检查：三处行号均符合此描述，且这些文件都没有台账条目。 |
| 桌面分析，计划默认值 | `dsh-v0.2.2-rc.1` 与本树：开启。计划中：在本人开启之前保持关闭，C16 的变更默认值 `product-analytics.config.enabled` 设为 `false` | 计划中：C16 变更默认值；没有开关 ID 或工作包 | 人工检查：C16 变更默认值表中关于桌面分析的行，以及[威胁模型](../security/threat-model.zh.md)的数据共享行。 |
| 会话日志上传，当前值 | `dsh-v0.2.2-rc.1` 与本树：默认开启。`packages/session/session-log-deepseek/src/index.ts` 第 60 行中 `session-log-deepseek` 的 `enabled` 默认为 `true`，基础 bundle 在 `packages/bundle/base/cordis.patch.yml` 第 43 行挂载该插件 | stock | 人工检查：这两行均符合此描述，且两个文件都没有台账条目。 |
| 会话日志上传，计划默认值 | `dsh-v0.2.2-rc.1` 与本树：开启。计划中：在本人开启之前保持关闭，C16 的变更默认值 `session-log-deepseek.config.enabled` 设为 `false` | 计划中：C16 变更默认值；没有开关 ID 或工作包 | 人工检查：C16 变更默认值表中关于会话日志上传的行，以及[威胁模型](../security/threat-model.zh.md)的数据共享行。 |
| 基于反馈的 OTel 会话上传 | `dsh-v0.2.2-rc.1` 与本树：基础 bundle 包含一项基于反馈的 OTel 会话上传，适用于所有人与提供方（[CLI 参考](../../../apps/cli/reference/README.zh.md)）；本树对它没有 Delo 修改 | stock | 人工检查：CLI 参考中关于基础 bundle 的段落与其 OTel 段落（第 137 与 139 行），且 `packages/session/session-telemetry-otel` 没有台账条目。 |

### web_fetch

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 回环与非公开目标 | `dsh-v0.2.2-rc.1` 与本树：`web_fetch` 在没有防护的情况下抓取回环及其他非公开目标 | stock | `packages/web/web-fetch-http/tests/fetch-http.spec.ts` |
| 抓取防护 | `dsh-v0.2.2-rc.1`：没有防护。本树没有由 `web_fetch` 拒绝回环、链路本地或私有网络目标的功能 | 计划中：`fetch_guard`（A100） | `parity-switches` |

### 同意

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 计划任务同意 | `dsh-v0.2.2-rc.1`：一次获批的调用会创建无人值守重复运行的轮次；本树没有同时写明重复规则与目标会话的同意 | 计划中：`scheduled_task_consent`（WP2.19） | `parity-switches` |
| 指令层文件同意 | `dsh-v0.2.2-rc.1`：模型对 skill、预设或 `AGENTS.md` 的写入，即使需要批准，也只作为文件写入批准；本树没有写明效果并展示差异的批准 | 计划中：`instruction_layer_consent`（A101） | `parity-switches` |
| MCP 添加时同意 | `dsh-v0.2.2-rc.1`：每个 MCP 服务器命令都作为可信代码在 agent（智能体）沙箱之外运行；本树没有写明所添加服务器命令的同意 | 计划中：`mcp_add_consent`（A101） | `parity-switches` |

### 限制与容器

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 限制规则 | `dsh-v0.2.2-rc.1`：沙箱限制文件写入，读取、Unix 套接字与网络保持开放；本树的沙箱代码中没有 C1 的五条规则（`home-write`、`home-read`、`token-read`、`home-connect` 与 `docker-connect`） | 计划中：约定 [C1](../contracts/c01-home-layout.zh.md)；没有开关 ID 或工作包 | 人工检查：在 `packages/` 与 `apps/` 中搜索这五条规则名没有结果；在 `delo/` 下，它们只出现在约定页面、home 布局约定包、威胁模型与本页中。 |
| 容器拒绝标记 | `dsh-v0.2.2-rc.1`：容器内的拒绝不带环境标记；本树中 `packages/sandbox/sandbox-policy/src/index.ts` 第 152 行的 `containerDenialMarker` 默认关闭 | 已构建：`container_denial_marker`（开关开启场景待录制） | `packages/sandbox/sandbox-policy/tests/policy.spec.ts` |

### Studio 与其他 C16 开关

| 项目 | `dsh-v0.2.2-rc.1` 与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| Studio 附加功能 | `dsh-v0.2.2-rc.1`：stock 外观，没有 Delo 的 studio 包；本树有 `@delo/plugin-main-chat`，其 `studioAdditions` 开关默认关闭，且没有任何 bundle 挂载它，同时没有 `@delo/bundle-studio` | 已为主对话构建：`studio_additions`（开关开启场景待录制）；其他 studio 包仍为计划中 | `parity-switches` |
| 入门预设 | `dsh-v0.2.2-rc.1` 与本树：`standard` 是默认预设（`packages/bundle/web-app/cordis.patch.yml` 第 593 行）。计划中：`ptc`，即 C16 的变更默认值 `agent-preset-registry.config.default` | 计划中：C16 变更默认值；没有开关 ID 或工作包 | 人工检查：第 593 行设定 `standard`，且 C16 变更默认值表列出了计划值。 |
| `plugin_manager` 读取豁免 | `dsh-v0.2.2-rc.1`：`plugin_manager` 的每个操作都需要 `danger-full-access` 提权；本树的 `readActionsExempt` 开关默认关闭 | 已构建：`plugin_manager_read_exemption`（开关开启场景待录制） | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| `profile_history` | `dsh-v0.2.2-rc.1`：没有 `history`、`read_config`、`configure`、`undo` 或 `restore` 操作；本树的 `profileHistory` 开关默认关闭 | 已构建：`profile_history`（开关开启场景待录制） | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| doctor | `dsh-v0.2.2-rc.1`：没有 doctor 应用；本树的 `doctor` 开关默认关闭，因此该应用不运行任何检查，且没有模型能看到它 | 已构建：`doctor`（功能开关；没有开关开启场景） | `packages/boot/doctor/tests/app.spec.ts` |
