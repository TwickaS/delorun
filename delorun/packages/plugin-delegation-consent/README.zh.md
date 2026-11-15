---
description: "Delorun 外部 agent 开关背后的同意，面向维护者：何时可以启动 Claude Code 或 Codex 这类外部 agent、它可以运行多久，以及本人如何允许和撤销它。"
kind: "package-bundle"
---

# @delorun/plugin-delegation-consent

[English](README.md) | 中文

## 摘要

`@delorun/plugin-delegation-consent` 提供 `delegationConsent` 服务，即 [`@deepseek-ai/dsh-subagent`](../../../packages/subagent/subagent) 外部委派同意 seam 的 Service Provider。外部 agent（智能体）是没有本地子会话的 subagent 提供方，例如 Claude Code（`claude-code`）或 Codex（`codex`）：它作为自己的程序在 Delorun 的沙箱和审批提示之外运行，可以在其自身设置允许的任何位置读取和更改文件（包括 Delorun 的 home），并使用本人自己的登录和账户。运行时在每次外部启动之前询问该服务，只有在它答复 `allow` 时才启动提供方。本插件还为模型的 `plugin_manager` 提供一道防护，防止引入这类 agent，并提供 studio 审批卡片操作及其外部 agent部分背后的仅回环路由。`enabled` 关闭时——这是 schema 的默认值，也是 C16 开关 `external_agent_consent` 的对等值——它不挂载任何内容，外部提供方以与上游一致的方式启动。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [界面](#surfaces)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **审查顺序。** `review` 按以下顺序决定每次外部启动：沙箱策略解析为 `read-only` 的 chat 无论被授予过什么都会被拒绝，在没有组合沙箱策略期间每个 chat 都会被拒绝；没有工作区文件夹的 chat 会被拒绝，位于 chat 工作区之外的运行目录也会被拒绝；无法读取的授权文件会拒绝，因此任何授权都不算数；chat 工作区中针对该提供方的授权会允许；否则通过组合的 `approval` 服务询问本人。没有审批服务时，该启动被拒绝。
- **询问。** 审批携带 `external-agent` 授权标记、作为工具名称的提供方，以及 [`askText`](src/copy.ts) 的英文和中文文本：运行的是什么、它运行所在的文件夹（工作区，或工作区内以其工作区命名的文件夹）、它能触及什么、由谁的账户付费，以及如何为该工作区允许它或撤销该允许。`@delorun/home-auth` 拒绝远程访问设备对 `external-agent` 询问的答复，因此只有 home 自己电脑上的 studio 能答复它。只有 `allowed-once` 会允许，且它不记录任何内容：下一次启动会再次询问。
- **拒绝。** 每次拒绝都是一句话，模型通过 subagent 运行时的 `DELEGATION_CONSENT_REFUSED` 错误读到它，其中写明原因以及本人可以做什么。审批策略为 `never`（完全访问预设的策略）的 chat 中，每次询问都会被审批服务直接拒绝而不询问任何人，因此在那里 agent 只有在存在工作区授权时才会启动，拒绝会说明这一点；Auto chat 的策略是 `ask`，因此在那里会像在其他任何 chat 中一样询问本人。
- **运行时间上限。** 每次被允许的启动都携带 `runTimeoutMinutes`；运行时在达到上限时停止该运行，并把它报告为错误结果。
- **工具描述。** `describe` 用 [`describeAgent`](src/copy.ts) 替换外部提供方委派工具的开头几句：只在被要求或明显有用时使用它，它在沙箱之外以本人的账户运行，除非该 agent 已为该工作区获得允许，否则每次运行都等待本人在其电脑上批准，而在无人被询问的完全访问 chat 或无界面运行中，除非已获得允许，否则会被拒绝。
- **关闭它。** 只有在 home 自己电脑前的本人才能关闭 `enabled`：在“设置 → 外部 agent”中，或在那里编辑 profile。插件挂载期间，它向 `@delorun/home-auth` 把 `enabled` 注册为只有电脑才能关闭的开关（`EXTERNAL_AGENT_CONSENT_SWITCH`），因此远程访问会拒绝远程访问设备可能关闭它的设置写入，无论是否持有提权，原因为 `loopback-required: turning the external-agent consent off`；持有提权的设备更改运行时间上限或打开它仍是普通的设置写入。远程访问还会拒绝设备执行其列表未列出的每个斜杠命令，以及针对受保护配置项的每个 `setPluginEnabled`。该配置项位于 `@delorun/bundle-local` 的 `protectedPlugins` 中，因此模型的 `plugin_manager` 无法禁用或重新配置它，也无法撤销或恢复到会这样做的版本，且没有其他模型工具写入设置；setup 提示的答案不写入它。完全访问 chat 仍可以用命令编辑 profile 的文件。
- **授权。** 一条授权是 Delorun home 之下 `secrets/delegation-consent/grants.json`（约定 C1 的受保护状态）中的一个工作区键和一个提供方名称，版本 1，严格解析，并在 permission-defaults 存储锁下更改。服务在每次启动时读取该文件，因此 `delorun workspace external-agents` 和 studio 无需重启即可改变下一次启动。`allowWorkspace` 只有在带 `confirmed` 时，才为本 studio 注册的外部提供方、在文件夹已被 Delorun 添加为工作区的打开 chat 中记录授权；`revoke` 删除一条授权。
- **插件管理。** 工具防护（[`src/guard.ts`](src/guard.ts)）拒绝安装或启用外部 agent 包之 bundle 的 `plugin_manager` 调用，以及启用或配置其模块属于外部 agent 包的 Loader 配置项的调用。外部 agent 包是除两个进程内包（`fork-in-process`、`spawn-in-process`，其提供方在本进程中运行子会话）之外的任何 `@deepseek-ai/dsh-subagent-*` 或 `@deepseek-ai/dsh-experimental-subagent-*` 包：其中包括 Claude Code、Codex、DSH SDK 子进程以及 ACP（其 `command` 可运行任何程序）。目标按插件管理读取它的方式读取（`@deepseek-ai/dsh-plugin-manager` 的 `specPackageName`，结合 profile 已保存的依赖），经过大小写折叠和去除首尾空白，通过 npm 别名（`x@npm:…`、`npm:…`）解析，本地路径则通过其清单及其最后几个包路径段解析。禁用和移除会放行。本人从“插件”页面或首次运行的设置中添加这些 agent，这些途径不经过模型的工具。

<a id="configuration"></a>

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | false | 挂载服务、防护和路由；即 C16 开关 `external_agent_consent`。`@delorun/bundle-local` 打开它；本人在“设置 → 外部 agent”中关闭它，远程访问设备无法写入这一项，setup 提示的答案不改动它。 |
| `runTimeoutMinutes` | 30 | 一次外部运行可以持续多久，1 到 1440 分钟；“设置 → 外部 agent”可更改它，从下一次运行起生效。 |

两个字段都是 schemastery `Config`，因此上游的设置服务会描述并写入它们；更改无需重启即可生效（[字段](src/wire.ts)）。

<a id="surfaces"></a>

## 界面

- **审批卡片。** `@delorun/bundle-local` 在 home 电脑上的 `external-agent` 卡片中添加“为此工作区允许”；它通过 `POST /api/delorunDelegationConsent.allow` 记录授权，然后答复卡片。卡片已答复或不再接受答复后，该操作被禁用；卡片的 `canAnswer` 在点击开始时读取，因此此时的点击不记录任何内容，并在卡片被答复之前再读取一次。手机上显示“请在你的电脑上批准。”
- **外部 agent。** “设置 → 外部 agent”包含开关 **外部 agent运行前询问** 和运行时间上限，它们作为实时字段通过上游的设置服务写入此配置项，因此保存的更改无需重启该配置项即可生效：关闭 `enabled` 会释放服务、防护和路由，打开它会再次挂载它们，新的运行时间上限从下一次运行起生效。它还列出每条授权及其撤销（`GET .grants`、`POST .revoke`）。
- **终端。** `delorun workspace external-agents [<folder> <agent> on|off]` 列出授权，在终端确认后添加授权，并撤销授权。

每条路由只答复 home 自己的电脑，对其他调用方以 `LOOPBACK_REQUIRED` 拒绝（[路由](src/routes.ts)、[消息](src/wire.ts)）；危险模式持续期间，持有解锁的设备也会被准入（[`@delorun/home-auth`](../home-auth/README.zh.md#dangerous-mode)）。

<a id="known-limitations"></a>

## 已知限制

- 服务决定外部 agent 是否启动，而不决定它做什么：一旦启动，它就在自己的设置下、在 Delorun 的沙箱之外行动，直到结束或达到时间上限。
- 审查只在该配置项运行期间存在。本模块把 `providesDelegationConsent` 导出为 `true`，因此当本插件的某个已启用配置项未在运行时（例如启动失败之后），运行时不启动任何外部 agent（`DELEGATION_CONSENT_UNAVAILABLE`）；开关关闭时，该配置项运行但不提供服务，外部 agent 以与上游一致的方式启动。`delorun` 也会在启动时检查：开关打开的 profile 以已启用且已启动的状态挂载该配置项，与 Delorun 的其他同意配置项相同。
- 防护不覆盖 `plugin_manager` 对较早 profile 状态的撤销和恢复，而 profile 尚未保存的 git 或 tarball spec 只有在安装之后才会指明其包，因此防护无法读取它；审查仍会在它注册的提供方每次启动之前询问。完全访问 chat 可以运行任何命令，包括 `pnpm`。
- 预设自己的插件配置项（例如 agent 团队预设的配置项）位于 bundle 补丁之外；它们注册的外部提供方仍会被审查，因为审查位于 subagent 运行时之中。

<a id="tests"></a>

## 测试

[`tests/consent.spec.ts`](tests/consent.spec.ts) 针对服务和真实的 `SubagentRuntime` 证明每种拒绝与同意：没有同意时不启动任何提供方，只读 chat 和没有沙箱策略的组合会在任何授权算数之前被拒绝，没有文件夹的 chat、工作区之外的文件夹和无法读取的授权文件会拒绝，询问写明工作区内的运行文件夹，策略为 `never`（配置的或 chat 自己的）的真实审批服务除非工作区持有授权否则不询问即拒绝，而在 `ask` 下会询问，allow-once 不记录任何内容，撤销在下一次启动时生效，防护在每种写法（版本、npm 别名、相对和绝对路径、前导空格、大写、已保存的 git spec）下拒绝外部 agent 包的每条安装、启用和配置路径，并放行进程内 subagent 及其余包，已禁用的挂载不提供任何内容，任一字段保存的更改无需重启即被跟随，每条路由都拒绝非回环调用方。通过上游设置服务保存两个字段的情形由 `apps/cli/tests/consents/delegation-settings.integration.spec.ts` 覆盖。远程访问设备的设置写入、斜杠命令、撤销和恢复在 `apps/cli/tests/denial/reach/reach-access.spec.ts` 中被拒绝，`plugin_manager` 对该配置项的配置、撤销和恢复在 `packages/boot/plugin-manager/tests/delorun-protected-plugins.spec.ts` 中被拒绝。运行时一侧（包括时间上限）由 `packages/subagent/subagent/tests/external-consent.spec.ts` 覆盖。

<a id="when-the-service-fails"></a>

## 服务失败时

同意服务在 `enabled` 开启期间启动失败时，该行保持激活，并挂载一个拒绝每次外部 agent 启动的服务。拒绝信息会指名行 `delorun-delegation-consent` 和失败原因，并提示重启 Delorun、查看日志或以安全模式启动。`enabled` 关闭时不挂载任何内容，外部 agent 按 stock 方式启动。

替身服务只在该行加载且其服务失败时挂载。插件从未加载的行，或其 `inject` 从未解析的行，会在 Host 运行期间让该接缝缺失；对这些情形，`delorun start` 的启动检查是唯一的保障。
