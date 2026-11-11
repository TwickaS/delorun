---
description: "Delo 的本地组合包，供维护者修改 Delo 的 CLI profile 在上游 web 模板之上所组合的内容：组合包列表、上游两个选择加入项的隐私默认值、设置中的“隐私”分区，以及使组合与上游保持一致的 spec 测试。"
kind: "package-bundle"
---

# @delo/bundle-local

[English](README.md) | 中文

## 摘要

`@delo/bundle-local` 是 Delo 的 CLI profile 在上游的 `web` profile 模板之后加入的组合包。它的 patch 保存 Delo 的本地集成行，每一行的理由都列在 [`LOCAL_ROWS`](src/rows.ts) 中，因此 Delo 的 CLI profile 在组合上游的 web profile 时，只改变或新增这些行，其他一概不变。它关闭上游的两个选择加入项，即 DeepSeek 的会话日志上传与桌面端分析，并新增设置中的“隐私”分区；本人在该分区中经同意对话框后打开每一项，也可以再次关闭（[C11](../../docs/contracts/c11-setup-answers.zh.md)）。它以开启状态挂载 Delo 的同意与防护插件——指令层写入同意、MCP 添加时同意、带一次完全访问同意的按工作区权限默认值、定时任务同意，以及抓取防护——挂载更新闸门（在 `delorun update` 或 `delorun stop` 等待运行中的对话期间拒绝新回合），并在上游的 sandbox 行上设置 C1 的主目录保护，因此在 Linux 与 macOS 上受限命令无法读取主目录 `secrets/` 下的同意存储；Windows 运行器不限制读取。它在上游的 `workspace-controller` 行上把 studio 首次使用的工作区文件夹设为 `delorun start` 解析出的文件夹，因此在上游的文档文件夹查找找不到文件夹时，studio 也有一个默认工作区。只有 CLI profile 加载本组合包：`delorun headless` 加载 [`@delo/bundle-headless`](../bundle-headless/README.md)，它挂载同样的同意与防护插件、以同样的方式保护它们并关闭会话日志上传；`delorun plugin` 与桌面应用运行上游自己的 profile，其中这些行都不适用，会话日志上传保持开启。它还打开上游的一次性启动令牌，因此 studio 的登录链接只能在一分钟内使用一次。

## 目录

- [使用本组合包](#use-this-bundle)
- [行](#rows)
- [“隐私”分区](#the-privacy-section)
- [同意界面](#the-consent-surfaces)
- [测试](#tests)
- [限制](#limits)

<a id="use-this-bundle"></a>
## 使用本组合包

- **组合包列表。**[`DELO_PROFILE_BUNDLES`](src/profile.ts) 从 `@delo/bundle-local/profile` 导出，是 Delo CLI profile 有序的 `dsh.profile.bundles` 列表：先是上游的 `web` 模板，从 `@deepseek-ai/dsh-official-bundles` 读取，然后是 `@delo/bundle-local`，再然后是挂载 studio 附加内容的 [`@delo/bundle-studio`](../bundle-studio/README.md)（`STUDIO_BUNDLE`）。上游自身的模板并不列出本组合包，因此 `dsh --profile web` 与录制会话的回放只组合上游的组合包。
- **`delorun` 的职责。**`delorun` 负责创建 `~/.delo/profiles/` 之下的 CLI profile（[C1](../../docs/contracts/c01-home-layout.zh.md#profiles)），把 `DELO_PROFILE_BUNDLES` 写入其创建的每个 CLI profile；当上游的 profile 加载器在 `skippedBundles` 中报告本组合包时，它拒绝启动该 CLI profile，因为隐私默认值只在本组合包加载时才成立。本包两件事都不做。
- **层顺序。**本组合包在每个上游组合包之后、profile 自身的 `cordis.patch.yml`、home patch 与 `--patch` overlay 之前生效，因此本人在 profile 中的设置仍然优先于此处的行（[上游的 profile 层](../../../apps/cli/README.zh.md#profiles)）。“隐私”分区写入 profile 的 `cordis.patch.yml`。
- **读取组合结果。**`dsh --profile <name> --dump-config` 会在每个 `# ==` 行之下打印全部组合后的行。该标注写明插入此行的组合包，以及修补此行的每个组合包；本组合包写入的行，在该标注中写有 `@delo/bundle-local`。
- **加载。**本组合包未声明 `engines.dsh` 范围，也没有上游的对等依赖，因此版本变更之后，上游的兼容性检查从不会跳过它；若 profile 的组合包列表中列出了它却无法解析，则会把该组合包报告为已跳过。
- **更新检查。**`delo-update-check` 行挂载 [`@delo/bundle-local/update-check`](src/update-check.ts)，即 C16 开关 `update_check`，它提供 `deloUpdateCheck` 服务，并在 `GET /api/deloUpdateCheck.notice` 提供其提示（[C3](../../docs/contracts/c03-update-report.zh.md#update-check)）。`delorun` 的 Host 以 `attach(source)` 挂接该检查，其返回的销毁器会解除挂接；随后，当上一次检查距今至少 `intervalHours`（默认 24）时，该行立即运行一次检查，此后每个间隔再运行一次，期限为 `timeoutSeconds`（默认 15），且从不等待检查完成。同一时间只挂接一个检查。开关关闭（插件的默认值）时，它不提供服务、不注册路由，也不运行任何检查；设置 → 隐私会在 profile 自己的 patch 中关闭它。
- **更新闸门。**`delo-update-gate` 行挂载 [`@delo/bundle-local/update-gate`](src/update-gate.ts)，即 C16 开关 `update_turn_refusal`，它提供 `deloTurnGate` 服务。`delorun` 的 Host 以 `attach(isHeld)` 挂接其对话闸门的保持状态，其返回的销毁器会解除挂接；只要任一已挂接的来源处于保持状态，插件的 `agent/pre-step` 监听器（先于其他所有监听器运行）就会通过抛出 `UpdatePendingError`（代码 `UPDATE_PENDING`）拒绝每个新回合的第一步。循环以 `error` 结束该回合，附带该错误的消息，说明消息未发送、请在 Delo 恢复后重新发送，且不发出任何模型请求；已在运行的回合的后续步骤照常进行。开启 `holdUntilChecked` 时，每个回合的第一步还会等待 `release()`（`delorun` 在其对已启动 Host 的检查通过后调用），最多等待 `checkWaitSeconds`（1 到 3600 的整数，默认 60）：届时仍在等待的回合以 `error` 结束，附带 `StartCheckPendingError`（代码 `START_CHECK_PENDING`），其消息说明启动检查未完成、请用 `delorun start` 启动 Delo，第一个等待的回合会在 Host 日志中以 warn 级别记录一次。开关关闭（插件的默认值）时，它不提供服务，也不拒绝任何内容（[C19](../../docs/contracts/c19-home-process.zh.md)）。
- **版本行。**Host 部分把 Delo 的版本（来自 `delorun` 的 `DELO_VERSION`）与上游报告的 DeepSeek Harness 版本作为全局 `deloVersions` 打印到每个页面中；浏览器部分校验它，然后以库存行的 id `current-version`、排序 -1 注册设置中的版本行，因此它取代该行，显示“Delo 版本”与“DeepSeek Harness 版本”。不是由 `delorun` 启动的 harness 不打印任何内容，保留库存行。
- **提示服务。**浏览器部分提供 `ctx.deloNotice`（`acknowledged()`、`acknowledge()`），因此自行显示预览提示文案的流程（例如 `@delo/plugin-onboarding` 的第一个屏幕）会记录确认，本组合包的提示步骤随之完成，不会再次显示。
- **声明文字。**`./statements` 导出即隐私分区的英文词典（[`src/client/locales.ts`](src/client/locales.ts)），CLI 的 setup 读取它，使提问与该分区陈述相同的句子。
- **构建。**`pnpm --filter @delo/bundle-local run build` 写出 `lib/index.js`（即 `delo-privacy` 行的 Host 部分）与 `lib/client.js`（即“隐私”分区）。上游的 `pnpm run build:artifacts` 不构建 Delo 的包。

<a id="rows"></a>
## 行

[`LOCAL_ROWS`](src/rows.ts) 列出 Delo CLI profile 与上游 web profile 有所不同的每一行，以及该行在 C16 对等组合中的形式：

| 行 | 类型 | 在 Delo CLI profile 中 | 在上游的 web profile 中 | 在对等组合中 |
| --- | --- | --- | --- | --- |
| `session-log-deepseek` | 改变 | `config.enabled: false`：模型请求不携带 `dsh_session_log` 字段 | 插件的默认值，即 `true` | 沿用上游的组合：覆盖层省略该行，因为它跟随每次回放的根配置，而根配置按语料库设定上传 |
| `deepseek-account` | 改变 | `disabled: true`：没有 DeepSeek 账户登录、Platform、用量或充值页面；`llm-deepseek-account` 在没有账户的情况下保持不可用 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `product-analytics` | 改变 | `config.enabled: false`，重申上游的 `appVersion`，并保留上游的 `disabled` 条件，因此该行只在桌面 profile 中挂载，并且在那里不接受任何事件 | `config.enabled: true` | 与此处所写相同；回放不挂载桌面端 Host |
| `session-telemetry-otel` | 改变 | `disabled: true`：反馈时没有会话日志前缀离开本机；上游的反馈导出器会把它发往 DeepSeek 的收集端 | 已启用，`FEEDBACK_ONLY` | 沿用上游的组合：覆盖层省略该行 |
| `sandbox` | 改变 | `config.protectedHome` 是 harness 主目录（C1 对每个运行时进程都把它设为 Delo 主目录），并带上 C1 的读取豁免（`runtimes`、`skills`、`dsh-runtimes`）：在 bwrap、Landlock 与 Seatbelt 下，受限命令无法读取 `<home>/secrets` 下的同意存储，而 Windows 运行器不限制读取；挂载 `read`、`read_image`、`apply_patch`、`glob` 与 `grep` 的每一行（包括每个 agent 预设中的行）都拒绝相同的路径 | 该行以裸配置挂载，因此提供方不保护任何主目录，这些工具也不拒绝任何路径 | 沿用上游的组合：覆盖层省略该行，因此回放运行上游的限闭，这些工具按上游的方式搜索 |
| `command-feedback` | 改变 | `disabled: true`：没有 `/feedback` 命令 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `ui-message-feedback` | 改变 | `disabled: true`：没有赞、踩以及反馈对话框；上游没有打开外部页面的行 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `ui-settings-account` | 改变 | `disabled: true`：没有账户菜单项、登录对话框与账户分区 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `account-controller` | 改变 | `disabled: true`：账户服务之上的 API 控制器需要 `deepseekAccount`，而 `deepseek-account` 禁用后没有任何已启用的行提供它，因此它永远不会激活 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `connection` | 改变 | `config.oneTimeLaunchTokens: true`，即 C16 开关 `one_time_launch_tokens`，重申 web 组合包的 `trustedHosts` 表达式，并把 `reopenHint` 设为 `run delorun open to open the studio`：每个 studio 登录链接只能在 60 秒内使用一次，且只有 `delorun open` 与启动过程会签发链接（[C4](../../docs/contracts/c04-admission.zh.md#launch-tokens)） | 在 Host 的整个生命周期内使用一个可重复使用的启动令牌 | 沿用上游的组合：覆盖层省略该行，因此回放以可重复使用的令牌登录 |
| `workspace-controller` | 改变 | `config.defaultWorkspaceDirectory` 为 `!!js process.env.DELO_DEFAULT_WORKSPACE`（[`src/profile.ts`](src/profile.ts) 中的 `DEFAULT_WORKSPACE_ENV`），由 `delorun start` 在启动之前在 Host 的进程中设置：当平台的查找报告了一个不同于主目录的文档文件夹时，为 `<documents>/Delo/default-workspace`，否则为 `<home>/Delo/default-workspace`，两者都避开 Delo 主目录、库存主目录与临时文件夹（[`default-workspace.ts`](../../apps/cli/src/default-workspace.ts)）。由其他方式启动时该键不设置，因此适用上游的查找；本人在 profile 自己的 `cordis.patch.yml` 中重述该行即可选择另一个文件夹 | 该行不设置文件夹：首次使用的工作区放在 `<Documents>/deepseek-harness/default-workspace`，而在平台不报告文档文件夹时（例如没有 XDG Documents 文件夹的 Linux 与 WSL）不放在任何文件夹 | 沿用上游的组合：覆盖层省略该行，这是 C16 存在开关 `default_workspace_directory` 的对等取值 |
| `ui-settings-models` | 改变 | `config.welcomeNotice: false`：上游的预览提示关闭；`credentialOnboarding` 保持上游的值 | `welcomeNotice: true` | 沿用上游的组合：覆盖层省略该行 |
| `delo-privacy` | 新增 | “隐私”分区（位于设置中）、Delo 侧栏品牌（产品名称的文字形式，不显示标志）、作为文档标题的产品名称，以及 Delo 自己的预览提示 | 无 | 存在且已禁用，因为录制的 Web 场景比较的是上游的界面输出、品牌、标题与提示 |
| `delo-instruction-consent` | 新增 | `@delo/plugin-instruction-consent`，`config.enabled: true`：模型通过文件工具对技能、预设或 `AGENTS.md` 的写入会先说明影响并展示 diff，然后才提交；shell 命令的写入不经审查 | 无 | 存在且已禁用：开关的对等取值为关闭，因此写入路径不经询问直接执行 |
| `delo-mcp-consent` | 新增 | `@delo/plugin-mcp-consent`，`config.enabled: true`：stdio MCP 服务器命令只有在接受存储中存有对应接受之后才会启动，本人在 home 的电脑上于设置的“MCP 服务器”部分或使用 `delorun mcp accept` 给出该接受 | 无 | 存在且已禁用：开关的对等取值，因此每个已配置的服务器都按上游的方式启动 |
| `delo-permission-defaults` | 新增 | `@delo/plugin-permission-defaults`，`config.enabled: true`：新工作区从更安全的预设起步，而该插件是该 seam 唯一的 `sandboxModeGuard`，它拒绝在没有已记录同意的工作区切换到完全访问；本人在 home 的电脑上给出该同意——在对话中选择完全访问时、在设置的“工作区访问”部分，或使用 `delorun workspace full-access`——按调用的升级仍然经过上游自己的审批 | 无 | 存在且已禁用：开关的对等取值，因此部署默认值作用于每个新对话，且每次模式切换都被记录 |
| `delo-schedule-consent` | 新增 | `@delo/plugin-schedule-consent`，`config.enabled: true`：批准时会指明重复规则与目标，并且当目标对话离开了批准时指定的预设，到期投递会被拒绝 | 无 | 存在且已禁用：开关的对等取值，因此批准与投递保持上游的文本与行为 |
| `delo-fetch-guard` | 新增 | `@delo/plugin-fetch-guard`，`config.enabled: true`：`web_fetch` 以带类型的原因拒绝回环、链路本地、私有网络与唯一本地目的地 | 无 | 存在且已禁用：开关的对等取值，因此录制的抓取场景按原样调用其回环 fixture |
| `delo-update-check` | 新增 | `@delo/bundle-local/update-check`，`config.enabled: true`、`intervalHours: 24` 与 `timeoutSeconds: 15`：在启动时与每个间隔校验渠道的最新发布，较新时 studio 显示提示 | 无 | 存在且已禁用：库存版本不发出这样的请求 |
| `delo-update-gate` | 新增 | `@delo/bundle-local/update-gate`，`config.enabled: true`：`delorun` 的对话闸门处于保持状态时，每个新回合的第一步都以 `UPDATE_PENDING` 被拒绝 | 无 | 存在且已禁用：开关的对等取值，因此每个回合都按上游的方式开始 |

[对等覆盖层](../../apps/tools/src/parity/composition/parity.overlay.yml) 以该形式重述本组合包的 patch，从而挂载本组合包；[`parityPatches`](src/rows.ts) 从本组合包的 `cordis.patch.yml` 推导出该形式，覆盖层与之不一致时，`parity-switches` 失败。Delo 的组合不向 DeepSeek 的反馈收集端发送任何内容：反馈导出器、`/feedback` 命令与反馈界面均已禁用或隐藏，因为 Delo 目前还没有反馈的去处。上游自己的组合保留它们，对等组合沿用上游的行。没有任何行指明 Delo 主机。

<a id="the-privacy-section"></a>
## “隐私”分区

浏览器端部分（[`src/client/index.ts`](src/client/index.ts)）还注册 Delo 自己的预览提示（[`src/client/DeloNotice.tsx`](src/client/DeloNotice.tsx)），位于 `settings.onboarding` 插槽中、模型提供方的引导之前。它的文案在 locale 字典中，每个提示版本在每个浏览器只显示一次（`NOTICE_VERSION`），记录在本地存储中，仅作为每个查看者的便利。它还在上游的“插件”分区之后注册 `settings.section` `delo-privacy`（[`PRIVACY_SECTION_ID`](src/client/index.ts)），并注册侧栏品牌的 occupant `sidebar.brand.name` 与 `sidebar.brand.mark`（[`src/client/brand.tsx`](src/client/brand.tsx)），以文字形式显示产品名称，不显示标志。两者都来自同一个 `delo-privacy` 行，因此禁用该行的对等组合保持上游的品牌。同一行在 locale 服务列出的每种语言中，用产品名称覆盖通用词典的 `brand.localBuild` 文本（[`src/client/title.ts`](src/client/title.ts)）。在不含 `DSH_CLIENT_TITLE` 的构建（例如源码检出的构建）中，上游的框架以该文本作为页面标题；在设置了该变量的构建中则使用该变量，Delo 的发布与 `delo/apps/tools/src/build-web.ts` 都把它设为 `Delo`，因此框架渲染之后，标签页在两种情况下都显示“Delo”；在此之前，启动页保留构建写入页面的 `<title>`，未设置该变量的构建把它留作“DSH Local Build”。该分区展示 C11 的声明（Delo 没有自己的遥测；两个选择加入项在本人打开之前均为关闭；发送反馈时会附带会话日志前缀，且只在发送反馈时发送；Delo 每天获取一次发布渠道的签名文件，不发送任何标识符，并可在此关闭），然后为每个开关各列一行。反馈声明描述的是上游的反馈发送，而本组合包的行移除了它，因此 CLI profile 不发送任何反馈：

- **DeepSeek 会话日志上传**编辑 `session-log-deepseek`，**桌面端分析**编辑 `product-analytics`，**检查新版本**编辑 `delo-update-check`，均通过上游为该行提供的配置表单进行（[`OPT_IN_ROWS`](src/client/index.ts)；选择加入项的行来自 `@delo/contract-setup-answers`）。一次写入只改变该行的 `config.enabled`。在 Delo 的组合中，发布检查为开启，选择加入项为关闭。
- **打开时**会弹出一个对话框，写明发送或请求什么内容以及发往何处；在本人选择“打开”之前不写入任何内容，选择“取消”同样不写入。**关闭时**立即写入。
- 开关显示 Host 接受的值。被拒绝或失败的写入会使其保持不变，并在该行中予以说明。
- 未提供某开关所对应行的 profile，不会为该项显示开关；对于桌面端分析，该行会说明只有桌面应用会收集它，对于发布检查，则说明该 profile 不检查新版本。

初始设置流程与其他界面通过 `ctx.settingsShell.openSection('delo-privacy')` 打开该分区。上游自身的 **设置 → 通用** 中的会话日志上传开关编辑同一行，且不经对话框；[`@delo/plugin-settings-layout`](../plugin-settings-layout/README.md) 在 Delo 的外观中隐藏它，库存外观则显示它。该分区的文案同时提供英文与中文。

同一行还注册 **设备** 分区（`delo-devices`，紧随“隐私”之后，[`src/client/DevicesSection.tsx`](src/client/DevicesSection.tsx)）：远程访问状态、带确认移除的已批准设备，以及“添加设备”——它打开 home 的批准窗口，并在窗口打开期间每两秒读取一次待处理的请求，全部通过同源请求进行（[`src/client/devices-api.ts`](src/client/devices-api.ts)，引导流程导入其中的 `readReachStatus`）。没有远程访问的 profile 改为显示一行说明；远程 studio 收到的每个 `LOOPBACK_REQUIRED` 拒绝都就地显示为“这需要你在自己的电脑上操作”并附带该操作。该行还注册一个 `shell.overlay` 提示（[`src/client/RemoteNotice.tsx`](src/client/RemoteNotice.tsx)），每当 home 以 `LOOPBACK_REQUIRED` 拒绝页面对转发提示的答复时显示，例如从远程 studio 答复的完全访问授权：上游的 Client Remote 服务把该拒绝报告为 `remote/answer-refused`，提示写明“这需要你在自己的电脑上操作”并附带被拒绝的操作。

<a id="the-consent-surfaces"></a>
## 同意界面

同一行承载它所挂载的两个同意插件在 studio 中的界面，每个都通过同源请求使用其插件的路由（[`src/client/consents-api.ts`](src/client/consents-api.ts)，建立在共享的 [`src/client/host-api.ts`](src/client/host-api.ts) 之上）。开关关闭的 profile——以“与库存相同”设置的 profile，或不含该插件的组合——不挂载任何路由，因此该分区只说明该 profile 不询问，权限控件按上游的方式切换。每条路由只回答 home 自己的电脑：远程 studio 看到的分区显示“这需要你在自己的电脑上操作”以及在那台电脑上使用的命令，且无法作答。文案同时提供英文与中文（[`src/client/consents-locales.ts`](src/client/consents-locales.ts)）。

- **完全访问同意**（[`src/client/FullAccessConsent.tsx`](src/client/FullAccessConsent.tsx)）是一个 `shell.overlay` 对话框，它写明工作区的文件夹，说明此后其对话可以在沙箱外运行命令并写入任何位置，这些命令可以读取本人在工作区之外的文件、Delo 的 home 及其密钥与令牌，并连接 Docker 监管器与 Delo 的更新通道，且它只覆盖该工作区。“开启完全访问”以对话框所显示的审查记录授权；“取消”、Escape 与关闭按钮不记录任何内容，对期间已发生变化的工作区的答复会让对话框保持打开，并写明过期的审查。
- **权限控件。**该行提供上游的 `permissionSwitchConsent` 客户端服务（[`@deepseek-ai/dsh-client-ui-permission-presets`](../../../packages/client/ui-permission-presets/README.zh.md)）：当本人在对话的权限控件或 `/permission` 选择器中选择完全访问时，在上游自己的风险确认之后，工作区没有授权的对话会先显示该同意，只有在授权记录之后才提交切换。其他每种切换，以及在已持有授权的工作区中的每次切换，都立即提交。
- **工作区访问**（`delo-workspace-access`，位于“设备”之后，[`src/client/WorkspaceAccessSection.tsx`](src/client/WorkspaceAccessSection.tsx)）列出 home 知道的每个工作区及其完全访问状态与起始时间；“开启完全访问”打开该同意，“关闭完全访问”立即撤回授权，并说明有多少个打开的对话回到了更安全的预设。
- **MCP 服务器**（`delo-mcp-servers`，位于“工作区访问”之后，[`src/client/McpServersSection.tsx`](src/client/McpServersSection.tsx)）列出添加时同意让其保持停止的每个 stdio MCP 服务器：它的命令、参数、工作目录、环境变量的名称（不含其值），以及它等待的原因。“接受”会打开一个确认，说明该命令以本人的权限在沙箱外运行；“接受并启动”记录该确认所显示的审查，随后服务器启动；“拒绝”把该审查搁置，服务器保持停止。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/bundle-local` 运行本包的 spec，它们导入上游已构建的包，因此需要 `pnpm run build:artifacts`；构建产物缺失时，Delo 的检查运行器会启动它。

- [`composition.integration.spec.ts`](tests/composition.integration.spec.ts) 在临时的 `DSH_HOME` 下构建一个 Delo CLI profile，并通过上游真实的 `dsh --profile <name> --dump-config` 读取它：列表中的每个组合包都已加载，且没有一个被跳过；转储结果中，每一行都位于一个标注之下，该标注的写入者是列表中的组合包，第一个标注之前不打印任何内容，stderr 上也没有任何输出，并且列出的恰是本组合包所写入的 `LOCAL_ROWS` 各行；组合结果与上游的 `web` profile 逐行相同，但 `LOCAL_ROWS` 中的行例外，它们按各项的说明，或就地改变，或添加在上游各行之后。它还把每个已启用行所指明的 DeepSeek 主机限定为：只有 `api.deepseek.com`（使用本人自己密钥的模型提供方 API）可以出现，反馈导出器、账户界面与反馈界面均不被组合。
- [`privacy-defaults.spec.ts`](tests/privacy-defaults.spec.ts) 使用各 profile 所组合的行挂载上游自身的插件，并针对本地网络 fixture（测试前置数据）运行。在 Delo CLI profile 的各行下，发往 mock DeepSeek API 的任何模型请求体都不携带 `dsh_session_log`，本地 OTLP 收集器也收不到任何分析记录；在上游 web profile 的各行下，同样的 fixture 会收到两者。组合中没有任何字符串（包括 `!!js` 表达式）指向 Delo 主机，且指明 Delo 包的行只有本组合包自身的浏览器半边、它挂载的五个同意与防护插件、它的更新闸门以及回收站。
- [`confinement.integration.spec.ts`](tests/confinement.integration.spec.ts) 读取组合后的 `sandbox` 行，并用它配置上游的本地沙箱提供方：该行的 `protectedHome` 是 Delo 主目录，`protectedHomeReadable` 是 C1 的读取豁免，并且由该提供方限闭的工作区命令无法读取 `<home>/secrets` 下的金丝雀文件；同一命令不受限时能读到它，读取豁免下的文件也仍然可读。主目录位于操作系统临时目录之外（上游的 profile 会把该目录替换为私有的 `/tmp`），因此拒绝来自受保护的主目录，而不是来自那个私有目录。
- [`update-check.spec.ts`](tests/update-check.spec.ts) 以桩 Connection 与假计时器运行更新检查的行：关闭时，它不挂载服务也不挂载路由；开启时，尚未运行过检查时已挂接的检查立即运行，从上一次检查起等满间隔，来源失败时保持其间隔，解除挂接后停止，拒绝第二次挂接，且路由以不缓存的方式提供提示。
- [`update-gate.spec.ts`](tests/update-gate.spec.ts) 以脚本化模型在上游的生产 agent 循环上运行更新闸门：已挂接的来源处于保持状态时，新回合在任何模型请求之前、在任何其他 `agent/pre-step` 监听器之前以 `UPDATE_PENDING` 结束，来源释放后下一个回合照常运行；工具持有闸门的回合继续其下一步；开启启动保持时，回合等待释放，超过上限后以 `START_CHECK_PENDING` 结束（假计时器），在上限之前释放则继续，在等待期间被中止时仍会结束，而 1 到 3600 之外、带小数或非有限值的 `checkWaitSeconds` 在加载时失败；任一已挂接来源处于保持状态时闸门即保持，已解除挂接的来源不再计入；开关关闭时不提供服务，也不拒绝任何回合。
- [`rows.spec.ts`](tests/rows.spec.ts) 从 `LOCAL_ROWS` 推导 patch 列表的对等形式，并拒绝既不是 id patch 也不是插入的 patch、不是映射的插入行，以及未列出的行。
- [`consents.client.spec.tsx`](tests/consents.client.spec.tsx) 在一个假 home 上驱动同意界面：权限控件的询问放行除完全访问之外的每种切换，在不含该插件的 profile、已授权的工作区与没有文件夹的对话中也放行，其他情况下显示同意；同意以其审查与本人的答复记录授权，在被取消、被取代、已过期或显示在远程 studio 时不记录任何内容；“工作区访问”在开启之前询问同意，并以答复关闭；“MCP 服务器”显示服务器的启动但不显示任何环境值，只在确认之后接受它；每个分区都告诉远程 studio 到电脑上作答。
- [`remote-notice.client.spec.tsx`](tests/remote-notice.client.spec.tsx) 为每个 `remote/answer-refused` 拒绝显示被拒绝答复的提示，写明完全访问升级、以标识符写明其他操作，或不写操作，提供英文与中文，直到它被关闭或其保持结束。
- [`notice.client.spec.tsx`](tests/notice.client.spec.tsx) 渲染 Delo 的预览提示：它陈述 Delo 自己的状态，在每个浏览器上每个提示版本只显示一次，确认后报告其引导步骤已完成。
- [`privacy-section.client.spec.tsx`](tests/privacy-section.client.spec.tsx) 渲染该分区：每个开关只有在对话框中点击“打开”之后才会打开，且只写入自己的行，并可通过同一开关再次关闭；发布检查默认显示为开启，关闭时不经对话框；“取消”与对话框的关闭按钮不写入任何内容；另一次写入在传输途中时发起的写入会被丢弃；写入失败时保留已接受的值；未提供的分析或发布检查行会显示其原因；该插件注册该分区与 Delo 侧栏品牌 occupant，在被销毁之前以产品名称作为页面标题，并把每个开关写入其行。
- [`title.client.spec.tsx`](tests/title.client.spec.tsx) 在上游的 locale 服务上运行标题覆盖：标题文本在英文、中文、日文以及之后添加的一种语言中都显示“Delo”，覆盖释放后恢复为上游的文本。
- `apps/web/tests/delo-privacy-consent.e2e.ts` 构建本包，以它作为 profile 组合包启动 studio，针对 mock DeepSeek API 运行，并在 Chromium 中操作该分区：第一次模型请求不携带会话日志；桌面端分析与会话日志上传各自在同意后单独打开；下一次请求携带会话日志；再从该分区关闭上传后，其后的请求便不再携带会话日志。

<a id="limits"></a>
## 限制

- 组合包列表是供 `delorun` 写入的常量；没有任何已发布的上游模板列出它，因此录制会话的回放只经由对等覆盖层挂载本组合包。
- 在 `DELO_PROFILE_BUNDLES` 变更之前创建的 profile，保留其创建时的列表。
- 只有 `delorun` 启动的 CLI profile 加载本组合包。`delorun headless` 改为加载 `@delo/bundle-headless`，它携带同样的同意、抓取防护、回合闸门以及它们免受插件管理的保护，但不含“隐私”分区。
- 隐私默认值只有在 profile 加载本组合包时才成立。上游会把无法加载的组合包报告为已跳过，并在不含它的情况下启动，此时会话日志上传处于开启状态；`delorun` 拒绝启动此类 profile，正是它保住了这些默认值。
- 桌面端分析只挂载于上游的 `desktop` profile，而 `delorun` 不运行该 profile，因此 Delo CLI profile 的“隐私”分区显示该行的原因，而不显示开关。
