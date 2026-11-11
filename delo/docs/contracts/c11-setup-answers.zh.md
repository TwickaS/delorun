---
description: "约定 C11：setup 所问的问题、回答的 schema、每个回答产生的 profile 写入、--yes 与 --config 形式，以及 setup 所作的说明。"
---

# 约定 C11：setup 回答

[English](c11-setup-answers.md) | 中文

<a id="summary"></a>
## 摘要

setup 回答是 `delorun setup` 所问的问题、保存每个回答的 schema、每个回答产生的 profile 写入，以及在没有终端时给出相同回答的 `--yes` 与 `--config` 形式。setup 以“快速”或“完整”开始。“快速”询问隐私说明、存在 stock home 时的 stock home 导入、模型密钥以及提示问题；“完整”还会询问是否检查新版本，并加入会改变这台电脑的各个部分。每个问题要么生效，要么不问。Delo 自身没有遥测，隐私说明会说明上游的两项选择加入为关闭、在设置 → 隐私中更改（由 studio 的同意屏幕负责），以及发布检查请求什么。在 setup 中关闭的发布检查在 Delorun 首次启动之前就已关闭，因此它不发出任何请求。

<a id="status"></a>
## 状态

`delorun setup` 及其“快速”与“完整”流程、`--yes` 与 `--config` 形式以及下列 profile 写入均已构建；stock home 的 `import` 部分也已构建；远程访问、身份因子与运行时部分尚未构建，且选择加入项只在 CLI profile 中保持关闭。

- **已构建且已接入：** `privacy`、`import`、`key`、`prompts`、`background` 与 `profile` 部分；schema 及其对已移除键、文档中非 `none` 的远程访问选项与未知字段的拒绝；向提供方源发送且拒绝重定向的实时密钥检查；在 CLI profile 中让上游两项选择加入保持关闭的写入；`updateCheck` 回答，由“完整”setup 询问、`delorun setup privacy` 更改，在首次启动之前写为 `delo-update-check` 行的开关。
- **未构建：** 远程访问与身份因子部分以及登记请求；运行时部分；检查 `modelProvider.id` 是否为上游提供的提供方（目前接受任何非空 id）；反馈对话框及其发送，因为 CLI profile 禁用了上游的反馈行，而 setup 的隐私说明仍会打印反馈说明；不打印密钥检查失败原因的规则，因为 setup 会打印它（该原因写明源与 HTTP 状态，不含密钥的任何部分）。
- **Delo 的写入未覆盖：** `delorun headless` 运行上游的 headless profile，其中不包含这些写入，因此按上游默认值，DeepSeek 的会话日志上传在那里为开启，选择加入项为关闭的要求对它不成立。

下面的要求与拒绝测试中，凡此列表标为未构建或未被任何内容接入的，在某次变更构建并接入它们之前都不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [模式与部分](#modes-and-sections)
  - [问题](#questions)
  - [回答 schema](#answer-schema)
  - [profile 写入](#profile-writes)
  - [--yes 与 --config 形式](#yes-and-config-forms)
  - [说明](#statements)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="modes-and-sections"></a>
### 模式与部分

第一个屏幕询问选择 **快速**（预选）还是 **完整**。每个主题都是一个已注册的部分，带有 id、标题、判断它在这台电脑上是否适用的检查、它的问题、它的写入以及可选的审阅行。“快速”运行标为 `quick` 的部分；“完整”运行每个部分。`delorun setup <section>` 在已完成 setup 的 profile 上再次运行一个部分，`delorun setup --list` 列出所有部分。后续的包通过 `delo/apps/cli/src/setup/sections.ts` 中的注册表加入部分，每个部分带有决定其在其他部分之间位置的顺序。

| 部分 | 模式 | 作用 |
| --- | --- | --- |
| `privacy` | 快速 | 显示隐私说明。在“完整”与 `delorun setup privacy` 中询问是否检查新版本；在“快速”中不询问任何内容，并说明如何在 Delorun 首次启动之前到达该问题。 |
| `import` | 快速 | 仅当 `~/.dsh` 是目录而非链接、且 Delo home 不含任何对话时显示：显示 stock home 导入预览中的数据部分，然后询问“复制你的 DeepSeek Harness 对话、附件和工作区列表吗？”。 |
| `key` | 快速 | 询问模型密钥来自何处。输入的密钥在保存之前以一次实时请求检查。 |
| `prompts` | 快速 | 更安全的提示，或与 stock 相同。 |
| `background` | 完整 | 关闭终端后 Delorun 是否继续运行。 |
| `profile` | 完整 | profile 的名称与 studio 的端口。 |

第一个问题之后的每个问题都可以回到前一个：选择题或是否题提供“← 返回”，文本或密钥问题把空输入当作“返回”。审阅屏幕在写入任何内容之前列出所有回答。

终端运行结束时，先提议安装 `delorun` 命令（它以启动器在 `DELO_LAUNCHER_VERSION` 中指明的版本运行 `npm install -g delorun@<version>`，本人拒绝或安装失败时打印这一行；不是由启动器启动的运行不提议安装），然后按 `background` 回答在后台或在终端中启动 Delorun，并打开 studio。它会打印终端关闭后 Delorun 是否继续运行、studio 的地址，以及 `delorun status`、`delorun logs --follow` 与 `delorun stop`。在没有显示器的计算机上或在 SSH 会话中，它打印地址与 SSH 端口转发命令，而不打开浏览器。`--yes` 与 `--config` 不启动任何内容，只打印要运行的命令。

<a id="questions"></a>
### 问题

setup 按以下顺序提出这些问题。本人接受默认值时即采用该默认值，`--yes` 形式对未另行设定的每个问题使用默认值。

| 问题 | 部分 | 回答 | 默认值 |
| --- | --- | --- | --- |
| 检查新版本 | `privacy` | 是或否。在“完整”中询问，以说明中的事实作为提示。 | 是 |
| 复制你的 DeepSeek Harness 对话、附件和工作区列表吗？ | `import` | 是或否，在预览之后。 | 否。 |
| 模型密钥 | `key` | 在提示处输入，或在每次启动时从 `DEEPSEEK_API_KEY` 读取。 | 在提示处输入。 |
| 提示 | `prompts` | 更安全的提示，或与 stock 相同。 | 更安全的提示 |
| 在后台继续运行 | `background` | 是或否。 | 是 |
| profile 名称与端口 | `profile` | 一个 profile 名称，以及 1024 到 65535 之间的一个空闲端口。 | 所选的 profile，以及 3080。 |

从任何地方远程访问、身份因子与运行时尚未询问；它们的包会加入这些部分。setup 读取 stock home 只是为了从中复制，且从不修改它。setup 的导入只复制数据：不复制 profile、设置层、指令、技能或已保存的密钥，因为这些会改变 Delo 运行的内容或告诉 agent 的内容；`delorun import-home` 在各自单独确认后复制其中每一项。

实时密钥检查向提供方的源发送一次经过认证的模型列表请求，即 `https://api.deepseek.com` 或 `DEEPSEEK_BASE_URL` 的源，不发往其他任何地方；重定向会导致失败。检查失败时打印其原因，原因写明源与 HTTP 状态，从不写出密钥，并让本人重新输入密钥，或在没有成功检查的情况下继续。`--yes`、`--config` 与从环境读取的密钥跳过检查，除非给出 `--check-key`；给出 `--check-key` 时，提供方不接受的密钥会让无人值守的运行停止。

<a id="answer-schema"></a>
### 回答 schema

回答文档是一个 JSON 对象，包含下列字段。交互式 setup 填写它，`--config` 读取它，二者使用同一 schema。

```json
{
  "schemaVersion": 3,
  "modelProvider": { "id": "deepseek-official", "credential": { "source": "environment", "name": "DEEPSEEK_API_KEY" } },
  "prompts": "safer",
  "background": true,
  "profile": { "name": null, "port": null },
  "reach": { "option": "none", "identityFactor": null },
  "importStockHome": false,
  "updateCheck": true,
  "sections": [{ "id": "privacy", "status": "seen" }, { "id": "key", "status": "answered" }]
}
```

| 字段 | 类型与取值 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `schemaVersion` | 整数 `3`，或对在发布检查问题之前写入的文档为 `2`。 | `3` | setup 拒绝任何其他值。版本 2 的文档没有 `updateCheck`，读作 `true`，带有该字段时被拒绝。 |
| `modelProvider.id` | 一个 provider id。 | `deepseek-official` | 接受任何非空字符串；不针对上游提供的提供方进行检查。 |
| `modelProvider.credential` | `{ "source": "prompt" }`，或 `{ "source": "environment", "name": "<variable>" }`。 | `{ "source": "prompt" }` | `prompt` 只在交互形式中接受。 |
| `prompts` | `safer` 或 `stock`。 | `safer` | 设置对等注册表中的提示开关。 |
| `background` | 布尔值。 | `true` | 由启动命令读回。 |
| `profile.name` | 一个 profile 名称，或 `null` 表示命令行选择的 profile。 | `null` | 遵循上游的 profile 名称规则；`desktop` 被拒绝。 |
| `profile.port` | 1024 到 65535 之间的整数，或 `null` 表示 3080。 | `null` | 交互形式会检查端口是否空闲。 |
| `reach.option` | `none`、`tailscale-private`、`tailscale-funnel` 或 `self-hosted-relay`。 | `none` | 非 `none` 的取值只在交互形式中接受。 |
| `reach.identityFactor` | `passkey`、`oidc`、`tailnet` 或 `null`。 | `null` | 选项为 `none` 时为 `null`。`tailscale-funnel` 与 `self-hosted-relay` 只能为 `passkey` 或 `oidc`。`tailscale-private` 可为 `passkey`、`oidc` 或 `tailnet`。`tailnet` 只在 C7 的套接字变体下可用（[C7](c07-reach-providers.zh.md#tailscale-serve-target)），否则 setup 以 `TAILNET_IDENTITY_UNAVAILABLE` 拒绝它。`ts.net` 地址上的 `passkey` 只在 C14 使通行密钥在该处可用时才可用（[C14](c14-oidc-passkeys.zh.md#relying-party-ids)），否则 setup 以 `PASSKEY_UNAVAILABLE` 拒绝它。 |
| `importStockHome` | 布尔值。 | `false` | 由导入部分设置。`--config` 拒绝 `true`，因为导入在询问之前要先显示预览。 |
| `updateCheck` | 布尔值；可选。 | `true` | Delo 是否在发布渠道中检查更新的版本。`--no-update-check` 在每种形式中都把它设为 `false`。 |
| `sections` | `{ "id", "status" }` 的列表，按流程顺序。 | `[]` | 由 setup 写入，从不由文档写入。`seen` 表示显示过的说明，`answered` 表示回答过的问题，`skipped` 表示未经询问即采用默认值的部分。studio 的新手引导会略去终端已覆盖的内容。 |

早期版本会询问运行时、studio 附加功能、设置其他模型、桌面分析与 DeepSeek 的会话日志上传。setup 记录了这些回答却一个都没有应用，因此不再询问它们。带有 `studioAdditions`、`runtime`、`helpSetUpModels`、`sessionLogUpload` 或 `desktopAnalytics` 的回答文档会被拒绝，消息中写明已移除的键。两项选择加入保持关闭，由 studio 的设置 → 隐私分区更改。

回答文档从不包含凭据的取值。凭据要么在提示处输入并存入上游的凭据存储，要么从 `credential.name` 所指定的环境变量读取。

<a id="profile-writes"></a>
### profile 写入

每个回答产生下列写入。配置写入进入其所属 profile 各自的 `cordis.patch.yml`，上游在 bundle 之后应用该文件。

| 回答 | 写入 | 目标 |
| --- | --- | --- |
| `modelProvider` | 输入的密钥进入上游的凭据存储，即 home 下的 `.credentials.yaml`，模式 0600。从环境读取的密钥不保存在任何地方。 | home。 |
| `prompts` | `delo-permission-defaults`、`delo-instruction-consent`、`delo-mcp-consent` 与 `delo-schedule-consent` 各行的 `config.enabled`，按约定 C16 的注册表设为每个开关的 Delo 默认值（`safer`）或对等取值（`stock`）。选择 `safer` 时，本人在 home 的电脑上允许工作区的完全访问与新的 stdio MCP 服务器：在 studio 的设置的“权限”部分，或使用 `delorun workspace full-access` 与 `delorun mcp`；选择 `stock` 时两项同意都不挂载，这些界面说明该 profile 不询问。抓取防护是拒绝而非提示，任何回答都不改变它。 | profile 的 `cordis.patch.yml`。 |
| `background` | 记录在回答记录 `setup-answers.json` 中；启动命令读取它。 | profile 目录。 |
| `profile.name` | CLI profile 以此名称创建。 | home。 |
| `profile.port` | 带有该端口的 `webserver` 行，重述 Web bundle 的其他键。默认端口时不写入。 | profile 的 `cordis.patch.yml`。 |
| `reach.option` | 远程访问约定中的远程访问行。`none` 不写入任何行。 | profile。仅在交互形式中写入。 |
| `reach.identityFactor` | 针对远程访问地址的登记请求。无配置行。 | home 认证状态，遵循身份约定。 |
| `importStockHome` | [C8](c08-archive-and-trash.zh.md#the-stock-home-import) 中 stock home 导入的数据：正是该部分预览所显示的计划，在每个 profile 的 home 锁之下进行。此后发生变化的 stock 文件、此后新增了对话的 Delo home，或未显示预览的运行，都会拒绝它。 | home。 |
| `updateCheck` | `false` 按设置 → 隐私保存的方式写入 `delo-update-check` 行：它的 id、插件名称，以及带 `enabled: false` 的 bundle 配置。`true` 不在该行留下任何配置，因此适用 bundle 的 `enabled: true`。 | profile 的 `cordis.patch.yml`，在 Delorun 首次启动之前。 |
| `sections` | 记录在 `setup-answers.json` 中。 | profile 目录。 |

上游的会话遥测行 `session-telemetry-otel` 不是一个回答。在上游的 profile 中，只有本人提交反馈后它才会发送会话日志前缀。CLI profile 把它与上游的反馈命令及消息反馈行一同禁用，因此那里没有任何内容发送反馈。

<a id="yes-and-config-forms"></a>
### --yes 与 --config 形式

`--yes` 接受每个默认值。它不应用默认值与 `--no-update-check` 之外的任何回答，并从 `credential.name` 所指定的环境变量读取模型凭据，该名称默认为 `DEEPSEEK_API_KEY`。该变量未设置时，setup 以一个带类型的错误停止，并写明变量名。

`--config <file>` 读取符合上述 schema 的回答文档，并按与 `--yes` 相同的规则应用其回答；无论文档如何写，`--no-update-check` 都会关闭发布检查。`reach.option` 不是 `none` 的文档会以写明该字段的带类型错误被拒绝，`importStockHome` 为 `true` 的文档同样如此。带有已移除键的文档被拒绝，消息中写明已移除的键。任何字段中带有凭据取值的文档会被拒绝，且不回显该取值。

对于相同的回答，交互形式与 `--yes` 或 `--config` 形式写入的 profile 文件完全相同。

setup 会在未完成的第一步处恢复被中断的运行。被重新执行的步骤写入相同的取值。

<a id="statements"></a>
### 说明

setup 在每次终端运行开始时显示隐私说明，并在无人值守的运行之前打印它。

- Delo 自身没有遥测。
- 上游的桌面分析与 DeepSeek 的会话日志上传除非您开启，否则均为关闭，由设置 → 隐私更改。
- 上游的反馈发送包含会话日志前缀，且仅在您发送反馈时发生。CLI profile 没有反馈发送，因此这条说明只描述上游的 profile。
- Delo 每天检查一次是否存在更新的版本，说明它从哪些主机获取、不发送任何关于本次安装及其插件的信息、这些主机能看到这台电脑的地址，以及设置 → 隐私可以关闭它。

关于恢复与 Docker 的说明属于加入这些主题的部分。

<a id="consumers"></a>
## 消费方

- `delo/apps/cli/src/setup/`：setup 流程、它的各个部分及其 `--yes` 与 `--config` 形式。
- `delo/packages/bundle-local`：上游选择加入项的行及其在 studio 中的同意屏幕，以及提示回答所设置的行。
- `delo/packages/plugin-onboarding`，由 `@delo/bundle-studio` 挂载：studio 的新手引导从 `setup-answers.json` 读取 `sections`；其余规则见[首次运行设计](../design/first-run.md)。
- `delo/packages/contract-setup-answers/`：回答类型、默认值与 profile 行名称。

<a id="compatibility"></a>
## 兼容性

回答 schema 通过 `schemaVersion` 标记版本，其值为 `3`。若新增的问题带有安全的默认值，且忽略该新字段的旧读取者写入的 profile 相同，则该变更保持版本不变。改变既有回答含义，或删除字段，都会递增版本；版本 2 删除了五个字段。版本 3 加入了 `updateCheck`：忽略 `false` 的读取者会让发布检查保持开启，因此版本递增。setup 把版本 2 的文档读作带 `updateCheck: true` 的版本 3，并以版本 3 记录。setup 拒绝其不认识版本的回答文档。

上游新增的选择加入项，以默认关闭的问题形式加入，并在同一次变更中把其 profile 行加入映射表。

<a id="security"></a>
## 安全

要求：

- `--yes` 与 `--config` 永远不会开启远程访问或凭据转发。
- setup 不询问上游的选择加入项，它们默认关闭。只有本人在同意屏幕上开启，它们才会生效。
- 实时密钥检查只把密钥发往提供方的源，密钥与检查原因都不会被打印或记录到日志。
- Delo 不发送任何自身遥测。
- 凭据取值永远不会出现在回答文档、profile 文件、进程参数或日志中。
- setup 不写入任何开启凭据转发的行。转发依据运行时约定按工作区设定。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | `--yes` 之后，profile 中没有远程访问行，也没有转发行。 |
| `config file cannot enable reach` | `reach.option` 不是 `none` 的文档，会被拒绝，并返回写明 `reach.option` 的带类型的错误。 |
| `refuses a document that asks for the stock-home import, which shows its preview in a terminal first` | `importStockHome` 为 `true` 的文档，会被拒绝，并返回写明该字段的带类型的错误。 |
| `config file with a removed key is refused` | 带有已移除键的文档会被拒绝，并返回写明已移除的键且不含任何取值的带类型的错误。 |
| `config file carrying a credential value is refused` | 任何字段中带有凭据取值的文档会被拒绝，且不回显该取值。 |
| `live key check sends the key to the provider origin only` | 检查的请求只发往一个源，拒绝重定向，且密钥不出现在任何 URL、消息或输出中。 |
| `typed key is never printed` | 一次运行的录制屏幕中不含输入密钥的任何部分。 |
| `default-profile run sends no analytics or upload` | 在默认 profile 中，网络夹具不记录任何发往分析端点的请求，也没有会话日志上传。 |
| `default-profile model request carries no dsh_session_log` | 默认 profile 发出的模型请求不包含 `dsh_session_log` 字段。 |
| `update-notice-off-at-first-start` | 在回答“否”的“完整”setup 之后，以及在 `--yes --no-update-check` 之后，首次启动所组合的 profile 带有 `enabled: false` 的 `delo-update-check` 行，且该行不挂载任何检查服务。 |

验收测试：

- `setup states the telemetry statement and that both opt-ins are off`（setup 陈述遥测说明，并说明两项选择加入均为关闭）。
- `the Quick flow reads as the transcript in the specs, top to bottom`（“快速”流程从上到下与 spec 中的记录一致）。
- `Same as stock sets every prompt switch to its parity value`（“与 stock 相同”把每个提示开关设为其对等取值）。
- `interactive and --yes runs write identical profile files`（交互运行与 `--yes` 运行写入相同的 profile 文件）。
- `interrupted setup resumes without a repeated write`（被中断的 setup 恢复时不重复写入）。
- `consent screen turns each upstream opt-in on alone and off again from the same screen`（同意屏幕可单独开启每一项上游选择加入项，并在同一屏幕上再次关闭）。
- `a way back returns to the previous question with the earlier answers kept`（返回操作回到前一个问题，并保留之前的回答）。
- `sits between the privacy note and the key in a Quick setup, and copies the chats before the key is asked for`（在“快速”setup 中位于隐私说明与密钥之间，并在询问密钥之前复制对话）。
- `delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row`（`delorun setup privacy` 显示说明、关闭检查，并通过移除该行再次开启它）。

<a id="decided-values"></a>
## 决定的取值

- 回答 schema 的版本为 `3`；setup 也读取版本 2。
- 默认值为：提供方 `deepseek-official`，更安全的提示，后台运行开启，端口 3080，远程访问 `none`，stock home 导入关闭（导入部分显示时也预选为否），发布检查开启。
- 默认凭据变量为 `DEEPSEEK_API_KEY`。
- setup 的远程访问选项为 `none`、`tailscale-private`、`tailscale-funnel` 与 `self-hosted-relay`。
- 反馈发送不是一个回答，setup 会对其作出说明。
