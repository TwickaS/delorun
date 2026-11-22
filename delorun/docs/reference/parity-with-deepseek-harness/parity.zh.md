# 对等清单

[English](parity.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

对等清单记录本树中 Delorun 所对照的每个 stock DeepSeek Harness（DSH）区域，以及每项刻意差异的状态，并给出一项证据。每一行都标明其基线，即[对等组合](../../contracts/c16-parity-composition.zh.md)所回放的上游记录标签 `dsh-v0.2.2-rc.3`。本页涵盖下列各区域、对等组合约定所列的开关与已变更的默认值，以及[切换页面](../../guide/get-started/switching.zh.md)所指名的差异。它并不盘点 stock 的每一项功能。

## 如何判定各行

状态列描述本树的实际状态。`built`（已构建）表示该变更在树中：该行写明其开关 ID；对于没有开关的 Delorun 变更，该行写 `no switch` 并给出其台账条目。`planned`（计划中）表示该变更不在树中：该行写明注册表中的开关 ID 与工作包；若注册表没有对应条目，则写明定义它的 C16 已变更的默认值或约定。`stock` 表示该区域中上游在基线上的行为保持不变。

每行给出一项证据。检查名（如 `parity-switches`）运行 `node_modules/.bin/tsx delorun/apps/tools/src/parity/composition/check-parity-switches.ts`，该检查读取开关注册表、开关字段与对等覆盖层。规格路径指向断言该行的测试文件。以「Manual check:」开头的条目指出审阅者用来确认该行的源码行。

有十二个已构建的开关，其开关开启场景仍待录制：`browser_additions`、`main_chat`、`rename_workspace_tool`、`permission_defaults`、`fetch_guard`、`scheduled_task_consent`、`instruction_layer_consent`、`mcp_add_consent`、`external_agent_consent`、`sandbox_protected_reads`、`update_turn_refusal` 和 `default_workspace_directory`。`parity-switches` 将它们报告为待录制，而不是通过，因此本页对这些开关不声称任何回放结果。对模型可见的开关 `preset_inspect`、`plugin_manager_read_exemption`、`profile_history`、`container_denial_marker`、`tool_failure_guard` 和 `use_my_browser` 在 `snapshots/` 之下有已录制的场景，对等回放在覆盖层之下运行它们。

## Liveshare

Liveshare 是上游的实验性共享功能。本树保留它，并带有一项 Delorun 修改。

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 拒绝共享观看者访问仅 owner 可用的接口 | `dsh-v0.2.2-rc.3`：共享观看者被拒绝访问仅 owner 可用的接口，如 `pluginManager/listPlugins`；本树保留该列表 | stock | `packages/experimental/liveshare/tests/viewer-access-policy.spec.ts` |
| 插件管理器的历史、恢复与撤销 | `dsh-v0.2.2-rc.3`：端点分类中没有 `pluginManager/history`、`pluginManager/restore` 与 `pluginManager/undo`；本树将每一项分类为 `owner-only`，位于 `packages/experimental/liveshare/src/endpoint-classification.ts` 第 145、155 与 159 行 | 已构建：无开关；`security` 台账条目 | Manual check：这三行在 `dsh-v0.2.2-rc.3` 中不存在而在本树中存在，并且台账条目记录了 lead 的结论。 |

## 桌面应用负载

桌面应用的 Python、Node 与 Office 负载在本树中没有 Delorun 修改。

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| Python 运行时 | `dsh-v0.2.2-rc.3`：桌面负载包含 Python 解释器，并拒绝缺少 node 与 pnpm 的负载；本树在 `apps/desktop` 下没有 Delorun 修改 | stock | `apps/desktop/tests/primary-runtime-preparation.spec.ts` |
| Node 运行时 | `dsh-v0.2.2-rc.3`：准备好的运行时包含 `bin/node` 和一个 pnpm 发行版；本树在 `apps/desktop` 下没有 Delorun 修改 | stock | `apps/desktop/tests/runtime-preparation.spec.ts` |
| Office 引擎 | `dsh-v0.2.2-rc.3`：每个平台的负载只保留其选定的 Office 引擎；本树在 `apps/desktop` 下没有 Delorun 修改 | stock | `apps/desktop/tests/runtime-file-policy.spec.ts` |

## SDK 运行时选择

Delorun 保留上游的 SDK 及其有文档记载的运行时选择。

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 运行时选择 | `dsh-v0.2.2-rc.3`：除非调用方选择另一个 `dsh` 可执行文件或 profile，Python SDK 启动随附的 `dsh --profile sdk` 运行时（[Python README](../../../../python/README.zh.md)）；本树在 `python/` 或 `packages/sdk/` 中没有 Delorun 修改 | stock | `python/sdk/tests/test_bundled_runtime.py` |

## 刻意的差异

下列每项差异都是 Delorun 的文档所述或 C16 所列的差异。各行按主题分组。

setup 的提示回答设定下面四个开关：`permission_defaults`、`instruction_layer_consent`、`mcp_add_consent` 和 `scheduled_task_consent`。默认的「Ask me first」在 profile 中开启它们，而「Ask less (like DeepSeek Harness)」在那里关闭它们，这就是每一个的对等取值。无论给出哪个回答，`fetch_guard` 和 `external_agent_consent` 都保持开启（`apps/cli/src/setup/prompt-switches.ts`）。

### home 与账户

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| home 目录 | `dsh-v0.2.2-rc.3`：主目录为 `~/.dsh`，由 `packages/util/home-paths/src/index.ts` 第 12 行的 `DSH_HOME_DIR_NAME` 命名。本树：`delorun` 通过 [`@delorun/home`](../../../packages/home/README.zh.md) 从 `DELORUN_HOME` 或 `~/.delorun` 解析其主目录，拒绝 `~/.dsh` 及其内部的路径，并为它启动的每个运行时进程把 `DSH_HOME` 设为 Delorun 的 home；上游自己的 `dsh` 命令仍使用 `~/.dsh` | 已构建：约定 [C1](../../contracts/c01-home-layout.zh.md)，无开关 ID | `delorun/packages/home/tests/home.integration.spec.ts` |
| DeepSeek 账户与 Platform | `dsh-v0.2.2-rc.3`：`packages/credentials/deepseek-account` 与 `packages/llm/llm-deepseek-account` 都在树中，并且 `deepseek-account` 本身提供 Platform 登录、Usage 和 Top-up 页面，因为 rc.3 移除了单独的 `packages/credentials/deepseek-account-platform` 包。本树的 Delorun CLI profile 将 `deepseek-account` 组合为禁用，这由 [`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 作为 C16 已变更的默认值设定，因此不提供 Platform 登录、Usage 或 Top-up 页面，并且 `llm-deepseek-account` 保持不起作用；对等组合保留上游的行，覆盖层不涉及它 | 已构建：C16 已变更的默认值，无开关 ID | `delorun/packages/bundle-local/tests/composition.integration.spec.ts`（没有已启用的 `deepseek-account` 行） |

### setup 与模型提供方

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 首次运行时的模型提供方 | `dsh-v0.2.2-rc.3`：没有终端 setup。studio 的 Settings → Agent → Models 页面列出适配器所支持的每家提供方，而当没有提供方能处理请求时，首次运行对话框只询问 DeepSeek 密钥（`packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx`）。本树：`delorun setup` 询问使用十一家提供方中的哪一家（按名称列出），或不使用，并写入 Models 页面和模型选择器所保存的行（[C11](../../contracts/c11-setup-answers.zh.md#model-providers)）；带 `DEEPSEEK_API_KEY` 和其默认模型的 DeepSeek 不写入提供方行，因此 profile 的组合方式与 stock 相同，而没有 `--provider` 的 `--yes` 不写入任何行。提示回答「Ask less (like DeepSeek Harness)」只涵盖提示开关，不涵盖这个问题。对等组合不运行 setup | 已构建：无开关；没有台账条目，因为该修改位于 `delorun/` 之下 | `delorun/apps/cli/tests/setup/providers.spec.ts` |

### 权限

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 每个工作区的完全访问同意 | `dsh-v0.2.2-rc.3`：完全访问不需要同意，C16 的对等列如此说明。本树：[`@delorun/plugin-permission-defaults`](../../../packages/plugin-permission-defaults/README.zh.md) 拒绝在没有已记录同意的工作区切换到完全访问，本人在 home 的电脑上给出该同意：在 studio 中（在 chat 中选择完全访问、审批卡片上的「Allow for this chat」，或 Settings → Safety → Permissions），或使用 `delorun workspace full-access`；按调用的提权仍然经过上游的批准。在 Delorun 的 CLI profile 和 `delorun headless` 所启动的 profile 中开启挂载，在后者中，对没有已记录授权的工作目录请求完全访问，也会在启动之前被拒绝 | 已构建：`permission_defaults` | `delorun/packages/plugin-permission-defaults/tests/permission-defaults.spec.ts`、`delorun/packages/plugin-permission-defaults/tests/surfaces.spec.ts` 和 `parity-switches` |
| 新工作区默认值 | `dsh-v0.2.2-rc.3` 与本树：新工作区从 `workspace-write` 开始，且除非模式为 `danger-full-access`，批准策略为 `ask`（`packages/bundle/base/cordis.patch.yml` 第 246 与 262 行） | stock | Manual check：第 246 与 262 行设定了这些默认值，且该文件没有台账条目。 |
| sdk-minimal 沙箱模式 | `dsh-v0.2.2-rc.3` 与本树：`sdk-minimal` profile 将 `sandbox-policy` 模式设为 `danger-full-access`（`packages/bundle/sdk-minimal/cordis.patch.yml` 第 73 行） | stock | Manual check：第 73 行设定该模式，且该文件没有台账条目。 |
| 工作区网络 | `dsh-v0.2.2-rc.3` 与本树的上游 profile：模型在沙箱中运行的命令和 `web_fetch` 都能访问宿主的网络。本树：[`@delorun/plugin-permission-defaults`](../../../packages/plugin-permission-defaults/README.zh.md) 为每个工作区提供一个网络设置：`open`（默认，与 stock 相同）、`allowlist` 或 `off`，由 studio 在 home 的电脑上更改；它是 `permission_defaults` 开关的一部分，因此 Delorun 的 CLI profile 带有它，而 setup 提示中的「Ask less (like DeepSeek Harness)」会关闭它 | 已构建：`permission_defaults` | `delorun/packages/plugin-permission-defaults/tests/command-network.spec.ts`、`egress-proxy.spec.ts` 和 `network.spec.ts` |

### 对模型可见的工具

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| `preset_inspect` | `dsh-v0.2.2-rc.3`：没有 `preset_inspect` 工具。本树只在 `presetInspect` 开启时注册它，而该开关默认关闭。随附的 Standard、PTC 和 Cordis 预设在没有该开关的情况下挂载工具行，因此本树中没有任何随附预设列出该工具 | 已构建：`preset_inspect`，带已录制的场景 | `packages/preset/agent-preset-registry/tests/tools.spec.ts` |
| 唯一新的对模型可见的 Delorun 工具 | `dsh-v0.2.2-rc.3`：没有 `preset_inspect` 工具。在本树中，`preset_inspect` 是 Delorun 的注册中唯一带有新名称的工具；`plugin_manager` 的注册是被编辑而不是被添加 | 已构建：`preset_inspect` | Manual check：`git diff --unified=0 dsh-v0.2.2-rc.3 -- packages apps scripts delorun` 在 `packages/preset/agent-preset-registry/src/tools.ts` 中添加了一个带新名称 `preset_inspect` 的工具注册。 |
| 工具失败守卫 | `dsh-v0.2.2-rc.3`：一个轮次中失败的工具调用没有上限；`repeat-tool-reminder` 只就完全相同的重复调用提醒模型。本树：[`@delorun/plugin-tool-failure-guard`](../../../packages/plugin-tool-failure-guard/README.zh.md) 在连续 3 次调用失败后提醒模型，在连续 6 次或最近 12 次中有 8 次失败时停止轮次；`@delorun/bundle-local` 和 `@delorun/bundle-headless` 将它挂载为开启；上游的 profile 不挂载它 | 已构建：`tool_failure_guard` | `delorun/packages/plugin-tool-failure-guard/tests/guard.spec.ts`、`snapshots/session/delorun-tool-failure-guard` 和 `parity-switches` |

### 数据共享

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 桌面分析，上游的默认值 | `dsh-v0.2.2-rc.3` 与本树的上游 profile：默认开启。`product-analytics` 配置在 `packages/client/product-analytics/src/index.ts` 第 36 行把 `enabled` 默认为 `true`，桌面 profile 在 `packages/bundle/web-app/cordis.patch.yml` 第 53 行把它设为 `true`。桌面外壳自己的标志起始为 `false`，直到 Host 的策略到达（`apps/desktop/src/main.ts` 第 480 行） | stock | Manual check：这三行与此描述相符，且这些文件都没有台账条目。 |
| 桌面分析，Delorun 的默认值 | `dsh-v0.2.2-rc.3`：开启。本树：在 Delorun 的 CLI profile 中关闭，[`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 把 C16 已变更的默认值 `product-analytics.config.enabled` 设为 `false`，其隐私一节在征得同意后将其开启；上游自己的 profile 保持 `true` | 已构建：C16 已变更的默认值，无开关 ID | `delorun/packages/bundle-local/tests/privacy-defaults.spec.ts` 和 `privacy-section.client.spec.tsx` |
| 会话日志上传，上游的默认值 | `dsh-v0.2.2-rc.3` 与本树的上游 profile：默认开启。`session-log-deepseek` 在 `packages/session/session-log-deepseek/src/index.ts` 第 60 行把 `enabled` 默认为 `true`，基础 bundle 在 `packages/bundle/base/cordis.patch.yml` 第 43 行挂载该插件 | stock | Manual check：这两行与此描述相符，且这两个文件都没有台账条目。 |
| 会话日志上传，Delorun 的默认值 | `dsh-v0.2.2-rc.3`：开启。本树：在 Delorun 的 CLI profile 中关闭，[`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 把 C16 已变更的默认值 `session-log-deepseek.config.enabled` 设为 `false`，其隐私一节在征得同意后将其开启；`@delorun/bundle-headless` 在 `delorun headless` 所启动的 profile 中设置同样的值；上游自己的 profile，因而录制会话回放，保留该插件的默认值 `true` | 已构建：C16 已变更的默认值，无开关 ID | `delorun/packages/bundle-local/tests/privacy-defaults.spec.ts`、`privacy-section.client.spec.tsx` 和 `apps/web/tests/delorun-privacy-consent.e2e.ts` |
| 由反馈触发的 OTel 会话上传 | `dsh-v0.2.2-rc.3` 与本树的上游 profile：基础 bundle 对每个人和每家提供方都包含一个由反馈触发的 OTel 会话上传（[CLI 参考](../../../../apps/cli/reference/README.zh.md)）。本树的 Delorun CLI profile 将 `session-telemetry-otel`、`command-feedback`、`ui-message-feedback` 组合为禁用或隐藏，因此没有反馈离开这台机器；[`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 把它们设为 C16 已变更的默认值 | 已构建：C16 已变更的默认值，无开关 ID | `delorun/packages/bundle-local/tests/composition.integration.spec.ts`（没有已启用的反馈导出器或反馈界面） |

### web_fetch

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 回环与非公共目标 | `dsh-v0.2.2-rc.3` 与本树：`web_fetch` 抓取回环和其他非公共目的地，没有防护 | stock | `packages/web/web-fetch-http/tests/fetch-http.spec.ts` |
| 抓取防护 | `dsh-v0.2.2-rc.3`：没有防护。本树：[`@delorun/plugin-fetch-guard`](../../../packages/plugin-fetch-guard/README.zh.md) 让 HTTP 抓取提供方在连接之前拒绝回环、链路本地、私有网络和云元数据目标；`@delorun/bundle-local` 在 Delorun 的 CLI profile 中开启挂载它，`@delorun/bundle-headless` 在 `delorun headless` 所启动的 profile 中挂载它；上游的 profile 不挂载它 | 已构建：`fetch_guard` | `delorun/packages/plugin-fetch-guard/tests/guard.spec.ts`、`provider-guard.spec.ts` 和 `parity-switches` |

### 同意

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 计划任务同意 | `dsh-v0.2.2-rc.3`：一次获批的调用就能创建无人值守、反复运行的轮次。本树：[`@delorun/plugin-schedule-consent`](../../../packages/plugin-schedule-consent/README.zh.md) 使创建或编辑任务时写明重复规则、目标及其预设并询问，并在目标 chat 离开了批准所指名的预设时拒绝到期的投递；在 Delorun 的 CLI profile 和 `delorun headless` 所启动的 profile 中开启挂载，后者的模板不挂载计划任务运行时或 MCP 客户端，因此在那里它只保护本人自己的 profile patch 添加的那一个 | 已构建：`scheduled_task_consent` | `packages/schedule/tool-schedule/tests/consent.spec.ts`、`packages/schedule/schedule/tests/consent.spec.ts` 和 `parity-switches` |
| 指令层同意 | `dsh-v0.2.2-rc.3`：模型对 skill、预设或 `AGENTS.md` 的写入，即使需要批准，也只作为文件写入批准。本树：[`@delorun/plugin-instruction-consent`](../../../packages/plugin-instruction-consent/README.zh.md) 使通过文件工具的这类写入需要询问，写明其效果并显示差异；shell 命令的写入不经审查；在 Delorun 的 CLI profile 和 `delorun headless` 所启动的 profile 中开启挂载，在后者中该写入被拒绝，因为没有人能回答 | 已构建：`instruction_layer_consent` | `delorun/packages/plugin-instruction-consent/tests/consent.spec.ts`、`packages/fs/tool-fs/tests/tools.spec.ts` 和 `parity-switches` |
| 已批准插件的写入同意 | `dsh-v0.2.2-rc.3`：智能体向已安装插件的文件夹写入，与向任何其他文件写入一样；本树的 `@delorun/plugin-instruction-consent` 的 `approvedPluginWrites` 开关在 Delorun 的 CLI profile 中开启，并在智能体于一个 chat 中首次向本人已在 Changes 下批准的插件的文件夹写入之前询问，写明该插件并附上差异 | 已构建：`approved_plugin_write_consent`（开关开启场景待录制） | `delorun/packages/plugin-instruction-consent/tests/plugin-folders.spec.ts` |
| MCP 添加时同意 | `dsh-v0.2.2-rc.3`：每个 MCP 服务器命令都作为可信代码在 agent 沙箱之外运行。本树：[`@delorun/plugin-mcp-consent`](../../../packages/plugin-mcp-consent/README.zh.md) 让 stdio 服务器保持停止，并给出写明其命令和参数的拒绝，直到接受存储持有该启动（命令、其参数、文件夹和环境变量名称，以及它们所解析到的可执行文件和文件夹，因此被更改的文件会再次询问），本人在 home 的电脑上通过 studio 或 `delorun mcp accept` 接受它；在 Delorun 的 CLI profile 和 `delorun headless` 所启动的 profile 中开启挂载，后者的模板不挂载计划任务运行时或 MCP 客户端，因此在那里它只保护本人自己的 profile patch 添加的那一个 | 已构建：`mcp_add_consent` | `packages/mcp/mcp-client/tests/consent.spec.ts`、`delorun/packages/plugin-mcp-consent/tests/consent.spec.ts`、`delorun/packages/plugin-mcp-consent/tests/reviews.spec.ts` 和 `parity-switches` |
| 外部智能体同意 | `dsh-v0.2.2-rc.3`：模型可以不经询问就启动 Claude Code 或 Codex 之类的外部智能体，它在沙箱之外以本人的账户运行。本树：[`@delorun/plugin-delegation-consent`](../../../packages/plugin-delegation-consent/README.zh.md) 在每次运行之前于 home 的电脑上询问，提供「Allow once」和「Allow for this workspace」，拒绝处于 Read Only 的 chat，限制每次运行（默认 30 分钟），并拒绝带入这种智能体的 `plugin_manager` 调用；在 Delorun 的 CLI profile 和 `delorun headless` 所启动的 profile 中开启挂载，无论 setup 的提示问题得到什么回答 | 已构建：`external_agent_consent`（开关开启场景待录制） | `delorun/packages/plugin-delegation-consent/tests/consent.spec.ts` 和 `parity-switches` |

### 浏览器

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 浏览器附加功能 | `dsh-v0.2.2-rc.3`：Playwright 浏览器提供方以 Playwright 自己的措辞报告未安装的浏览器版本，并且不给 `.playwright-mcp` 放 `.gitignore`。本树：提供方的 `browserAdditions` 开关由 [`@delorun/bundle-browser`](../../../packages/bundle-browser/README.zh.md) 开启，它把该报告替换为一条消息，告诉模型停止尝试，并请本人在“插件”中完成 Browser 设置 | 已构建：`browser_additions`（开关开启场景待录制） | `packages/experimental/browser-use-playwright-mcp/tests/provider.spec.ts` |
| 你自己的浏览器 | `dsh-v0.2.2-rc.3`：没有任何浏览器工具能用到本人自己的浏览器及其登录状态。本树：[`@delorun/browser-use-browse`](../../../packages/browser-use-browse/README.zh.md) 为智能体提供 `use_my_browser` 工具，每个 chat 询问本人一次，并且只为本人已允许的 chat 启动 browse 及其工具；它的 `enabled` 开关由 [`@delorun/bundle-real-browser`](../../../packages/bundle-real-browser/README.zh.md) 开启，关闭时该行不挂载任何内容 | 已构建：`use_my_browser` | `delorun/packages/browser-use-browse/tests/plugin.spec.ts`、`snapshots/session/delorun-use-my-browser` 和 `parity-switches` |
| 浏览器工具拒绝与文件夹防护 | `dsh-v0.2.2-rc.3`：Playwright 提供方提供 `browser_run_code_unsafe`，它在服务器进程中运行模型编写的代码，而服务器按文本把文件参数同它的文件夹比较。本树：MCP 客户端从不注册被拒绝的工具，`browser_run_code_unsafe` 始终被拒绝；提供方拒绝对被拒绝工具的调用，也拒绝 `filename` 或 `paths` 的真实位置在 chat 文件夹之外的调用；服务器被告知该文件夹为它唯一的 MCP root。这些是安全不变量：在所有开关关闭时依然成立，包括 `browser_additions` | 已构建：无开关；`security` 台账条目 | `packages/experimental/browser-use-playwright-mcp/tests/provider.spec.ts` |

### 限制与容器

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 限制规则 | `dsh-v0.2.2-rc.3`：沙箱限制文件写入，而读取、Unix 套接字和网络保持开放。本树：上游的本地沙箱提供方接受受保护的 home、其可读条目和被拒绝的套接字，而 Delorun 的 CLI profile 设定它们（[C1](../../contracts/c01-home-layout.zh.md)）：bwrap 和 Seatbelt 拒绝在 home 下读取和写入以及连接被拒绝的套接字，Landlock 拒绝在 home 下读取和写入而不拒绝任何套接字连接，Windows 运行器只限制写入。上游的 profile 不设定其中任何一项；`delorun headless` 通过沙箱 overlay 设定它们 | 已构建：`sandbox_protected_reads`，位于 `@deepseek-ai/dsh-sandbox-local` 的 `protectedHome` 上（开关开启场景待录制） | `packages/sandbox/sandbox-local/tests/protected-home.spec.ts`、`delorun/packages/bundle-local/tests/confinement.integration.spec.ts` |
| 容器拒绝标记 | `dsh-v0.2.2-rc.3`：容器内的拒绝不携带环境标记；本树 `packages/sandbox/sandbox-policy/src/index.ts` 第 155 行的 `containerDenialMarker` 默认关闭，且没有随附的行设置它 | 已构建：`container_denial_marker`，带已录制的场景 | `packages/sandbox/sandbox-policy/tests/policy.spec.ts` |

### Studio 与其他 C16 开关

| 项目 | 基线与本树 | 状态 | 证据 |
| --- | --- | --- | --- |
| 预览说明 | `dsh-v0.2.2-rc.3`：上游的 Web 预览说明写明 DeepSeek Harness。本树的 Delorun CLI profile 将其关闭（`welcomeNotice`），并显示来自 [`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 的 Delorun 自己的说明，该说明陈述 Delorun 是预发布的社区分叉 | 已构建：C16 已变更的默认值 `ui-settings-models.config.welcomeNotice` 和组合行 `delorun-privacy`，无开关 ID | `delorun/packages/bundle-local/tests/notice.client.spec.tsx` 和 `composition.integration.spec.ts` |
| 侧栏品牌 | `dsh-v0.2.2-rc.3`：侧栏的默认品牌是上游的标志和名称（`DSH Local Build`，附构建版本）。本树的 Delorun CLI profile 通过 [`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 的 `delorun-privacy` 行显示 hex jack 标志和产品名称，对等组合让该行保持禁用；文档标题是构建设置（`DSH_CLIENT_TITLE`），由 Delorun 的构建设定，对等构建不设定 | 已构建：C16 组合行 `delorun-privacy`，无开关 ID | `delorun/packages/bundle-local/tests/privacy-section.client.spec.tsx`（占位者注册）和 `parity-switches`（该行保持禁用） |
| studio 附加功能 | `dsh-v0.2.2-rc.3`：stock 外观，没有 Delorun studio 包；本树在每个 Delorun CLI profile 中通过 `@delorun/bundle-studio` 挂载主题、侧栏、chat 状态、设置布局和新手引导，开关开启，而回放不挂载其中任何一个 | 已构建：`studio_additions`，`@delorun/plugin-theme` 上的功能开关 | `parity-switches` |
| 默认工作区文件夹 | `dsh-v0.2.2-rc.3`：首次使用的工作区位于 `<Documents>/deepseek-harness/default-workspace`，在平台没有报告文档文件夹处（如没有 XDG Documents 文件夹的 Linux 和 WSL）则没有文件夹。本树：`delorun start` 解析 `<documents>/Delorun/default-workspace`，在平台没有报告文档文件夹处为 `<home>/Delorun/default-workspace`，并由 [`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 的 `workspace-controller` 行将其设为 `defaultWorkspaceDirectory`；回放把该行留给上游 | 已构建：`default_workspace_directory`，`@deepseek-ai/dsh-api-workspace-controller` 上的存在性开关（开关开启场景待录制） | `delorun/apps/cli/tests/default-workspace.spec.ts` 和 `parity-switches` |
| 工作区重命名工具 | `dsh-v0.2.2-rc.3`：没有 `rename_workspace` 工具；`@delorun/bundle-local` 通过其 `delorun-workspace-rename` 行挂载它 | 已构建：`rename_workspace_tool`（开关开启场景待录制） | `delorun/packages/bundle-local/tests/workspace-rename.spec.ts` |
| 主 chat | `dsh-v0.2.2-rc.3`：没有主 chat；本树有 `@delorun/plugin-main-chat`，这是没有任何 bundle 挂载的实验性插件 | 已构建：`main_chat`（开关开启场景待录制） | `parity-switches` |
| 新手引导预设 | `dsh-v0.2.2-rc.3` 与本树：`standard` 是默认预设（`packages/bundle/web-app/cordis.patch.yml` 第 620 行）。计划中：`ptc`，作为 C16 已变更的默认值 `agent-preset-registry.config.default` | 计划中：C16 已变更的默认值；无开关 ID 或工作包 | Manual check：第 620 行设定 `standard`，而 C16 的已变更默认值表写明了计划中的取值。 |
| `plugin_manager` 的读取豁免 | `dsh-v0.2.2-rc.3`：每个 `plugin_manager` 动作都需要 `danger-full-access` 提权；本树的 `readActionsExempt` 开关默认关闭，标准和 Creator 预设的工具行将其打开 | 已构建：`plugin_manager_read_exemption`，带已录制的场景 | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| `profile_history` | `dsh-v0.2.2-rc.3`：没有 `history`、`read_config`、`configure`、`undo` 或 `restore` 动作；本树的 `profileHistory` 开关默认关闭，且没有随附的行设置它 | 已构建：`profile_history`，带已录制的场景 | `packages/boot/plugin-manager/tests/tools.spec.ts` |
| 被暂缓等待审查的插件更改 | `dsh-v0.2.2-rc.3`：智能体的 `plugin_manager` 的 `install_bundle` 或 `remove_bundle` 在其完全访问批准给出后运行；本树的 `@delorun/plugin-changes` 开关默认关闭，开启时它把该调用作为待处理更改记录在 profile 的更改日志中并拒绝它，因此在本人用 `delorun changes` 应用它之前不会安装或移除任何内容 | 已构建：`plugin_changes_pending`（开关开启场景待录制） | `delorun/packages/plugin-changes/tests/plugin-changes.spec.ts` |
| Doctor | `dsh-v0.2.2-rc.3`：没有 doctor 应用；本树的 `doctor` 开关默认关闭，因此该应用不运行任何检查，也没有模型能看到它。`delorun doctor` 是单独的 Delorun 命令，它运行自己的检查，且不触及任何模型 | 已构建：`doctor`（功能开关；无开关开启场景） | `packages/boot/doctor/tests/app.spec.ts` |
| 更新闸门 | `dsh-v0.2.2-rc.3`：没有更新握手；本人发送轮次时轮次就会开始。本树的 Delorun CLI profile 挂载 [`@delorun/bundle-local`](../../../packages/bundle-local/README.zh.md) 的 `delorun-update-gate`，它在更新或停止等待运行中的 chat 期间，以 `UPDATE_PENDING` 拒绝新轮次的第一步，并保持每个轮次的第一步，直到 `delorun` 检查了已启动的 Host；`delorun headless` 只为该检查而挂载它 | 已构建：`update_turn_refusal`（开关开启场景待录制） | `delorun/packages/bundle-local/tests/update-gate.spec.ts` 和 `parity-switches` |
| 更新检查 | `dsh-v0.2.2-rc.3`：不请求更新的发布。本树的 Delorun CLI profile 挂载 `delorun-update-check`，它默认每 24 小时获取并验证发布通道的最新发布，并显示说明；Settings → General → Updates 可将其关闭 | 已构建：`update_check`（功能开关；无开关开启场景） | `delorun/packages/bundle-local/tests/update-check.spec.ts` |
| studio 登录链接 | `dsh-v0.2.2-rc.3`：studio 的启动令牌可以重复使用。本树的 Delorun CLI profile 在 `connection` 行上设置 `oneTimeLaunchTokens`，因此每个链接在 60 秒后过期，第一次使用即被消耗 | 已构建：`one_time_launch_tokens`（功能开关；无开关开启场景） | `packages/client/connection/tests/browser-auth.host.spec.ts` 和 `parity-switches` |
| 远程访问 | `dsh-v0.2.2-rc.3`：没有 reach 服务，使用上游自己的 authenticator。本树的 Delorun CLI profile 挂载 `delorun-home-auth` 和 `delorun-reach`；每个远程访问方式都保持关闭，直到本人用 `delorun reach on tailscale` 开启其中一种 | 已构建：`reach`（功能开关；无开关开启场景） | `delorun/packages/reach/tests/service.spec.ts` 和 `parity-switches` |

## 下一步

[术语表](../glossary.zh.md)定义本页使用的术语。[差异索引](divergence/README.zh.md)列出每项差异背后的上游文件，[对等基线](parity-baseline.zh.md)记录上游自身的测试结果。想用平实的话了解同样的差异，请阅读 [从 DeepSeek Harness 切换](../../guide/get-started/switching.zh.md)。
