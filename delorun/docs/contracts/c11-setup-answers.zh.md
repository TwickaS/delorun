---
description: "约定 C11：setup 所问的问题、回答的 schema、每个回答产生的 profile 写入、--yes 与 --config 形式，以及 setup 所作的说明。"
---

# 约定 C11：setup 回答

[English](c11-setup-answers.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

setup 回答是 `delorun setup` 所问的内容、存储每个回答的 schema、每个回答产生的 profile 写入，以及无需终端即可给出相同回答的 `--yes` 与 `--config` 形式。setup 以「How will you use Delorun?」开场。该回答 `useCase` 设定默认值，并决定主流程询问哪些问题：隐私说明；存在 stock home 时的 stock home 导入；所有人都会遇到的模型提供方及其密钥，以及提示问题；手机使用场景下的远程访问；以及位于审查屏幕「More settings」之下的发布检查、后台运行、profile 名称和端口。每个问题要么生效，要么不被询问。Delorun 没有自己的遥测，隐私说明会说明上游的两项选择加入项处于关闭状态，并在 Settings → Safety → Privacy 中更改（由 studio 的同意屏幕负责），还会说明发布检查发出什么请求。在 setup 中关闭的发布检查在 Delorun 首次启动之前就已关闭，因此不发出任何请求。

<a id="status"></a>
## 状态

`delorun setup` 及其使用场景流程、`--yes` 与 `--config` 形式以及下文的 profile 写入均已构建；stock home 的 `import` 一节以及针对本人自己 tailnet 上 Tailscale 的 `reach` 一节也已构建；其他远程访问方式、通行密钥与 OIDC 身份因子以及运行时一节尚未构建，并且选择加入项只在 CLI profile 中保持关闭。

- **已构建并已使用：** `privacy`、`import`、`key`、`prompts`、`background`、`reach`、`changes-protection` 和 `profile` 各节，其中 `reach` 只提供 `none` 或带 `tailnet-membership` 因子的 `tailscale-private`；[模型提供方](#model-providers)中的十一家模型提供方，各带其实时密钥检查和 profile 行；schema 及其对已移除键、setup 不提供的提供方、提供方已安装目录未列出的模型、文档中 `none` 以外的远程访问方式以及未知字段的拒绝；向提供方的源发出、拒绝重定向的实时密钥检查；使上游的两项选择加入项在 CLI profile 中保持关闭的写入；`updateCheck` 回答（More settings 询问它，`delorun setup privacy` 更改它），在首次启动之前写为 `delorun-update-check` 行的开关。
- **尚未构建：** 远程访问方式 `tailscale-funnel` 和 `self-hosted-relay`，`passkey`、`oidc` 和 `tailnet` 身份因子以及注册请求；运行时一节；反馈对话框及其发送，因为 CLI profile 禁用了上游的反馈行，而 setup 的隐私说明仍会打印反馈说明；密钥检查失败的原因不被打印这一规则，因为 setup 会打印它（该原因写明源和 HTTP 状态，不含密钥的任何部分）。
- **Delorun 的写入未涉及：** `delorun headless` 运行上游的 headless profile，它不带这些写入，因此 DeepSeek 的会话日志上传在那里按上游默认值开启，选择加入项处于关闭状态的要求对它不成立。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [使用场景与各节](#modes-and-sections)
  - [问题](#questions)
  - [模型提供方](#model-providers)
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
### 使用场景与各节

第一个屏幕询问「How will you use Delorun?」，有三个选项，每个选项都以平实的几行说明它做什么、适合谁以及之后如何更改；推荐选项标有「(recommended)」：

| `useCase` | 选项 | 它设定的默认值 |
| --- | --- | --- |
| `local` | Just me, on this computer (recommended) | 后台运行开启，远程访问关闭。 |
| `remote` | Also from my phone or another device | 与 `local` 相同，并在主流程中询问远程访问问题，预选为 Yes。 |
| `automation` | For scripts and automation | 后台运行关闭，密钥起初来自环境变量。 |

每个主题是一个已注册的节，带有 id、标题、每种使用场景的方案、判断它是否适用于这台计算机的测试、其问题、其写入和一行审查文字。方案为 `asked`（主流程询问它）、`note`（主流程显示其说明，而「More settings」询问该问题）、`more`（只有「More settings」询问它）或 `never`。审查屏幕列出该使用场景保留的每个回答、句子「Nothing is saved until you choose Save and set up」，并提供 Save and set up、More settings（仍有剩余的节时）和 Cancel。「More settings」询问每个剩余的节，然后回到审查。`delorun setup <section>` 在已设置好的 profile 上再次运行一个节，`delorun setup --list` 列出它们。之后的包通过 `delorun/apps/cli/src/setup/sections.ts` 中的注册表添加节，每个节带有把它排在其他节之间的顺序。

| 节 | `local` | `remote` | `automation` | 它做什么 |
| --- | --- | --- | --- | --- |
| `privacy` | `note` | `note` | `note` | 显示隐私说明。「More settings」和 `delorun setup privacy` 询问是否检查新发布；主流程什么也不问，并说明在 Delorun 首次启动之前在哪里可以到达该问题。 |
| `import` | `asked` | `asked` | `never` | 只有当 `~/.dsh` 是目录而不是链接，且 Delorun home 不含任何 chat 时才显示：显示 stock home 导入预览的数据部分，然后询问「Copy your DeepSeek Harness chats, attachments and workspace list?」。 |
| `key` | `asked` | `asked` | `asked` | 询问模型提供方（DeepSeek、More providers 或 Choose later）、其密钥来自哪里（已知时附带提供方的密钥页面，以及一行关于环境变量是什么的说明），以及新 chat 开始时使用的模型（[模型提供方](#model-providers)）。输入的密钥在存储之前用一次实时请求检查。在终端中未设置的密钥变量会立即产生一条带补救办法的警告。DeepSeek 的模型只由 `delorun setup key` 询问。 |
| `prompts` | `asked` | `asked` | `asked` | Ask me first（`safer`）、Ask less（`stock`），或 Never ask（dangerous）；后者始终列在最后，打印一条警告，询问一个起始为 No 的是或否问题，然后要求输入确切短语 `full access everywhere`；其他任何输入都保留之前的回答。从确认步骤选择「← Back」会回到提示问题。 |
| `background` | `more` | `more` | `never` | 终端关闭后 Delorun 是否继续运行。 |
| `reach` | `more` | `asked` | `never` | 是否可以从本人的手机通过本人自己的 tailnet 访问 studio。回答是会运行 `delorun reach on tailscale` 的 Tailscale 检查（包括 Funnel），并显示信任说明；检查失败则让远程访问保持关闭，并写明需要修复什么。应用它会写入带固定监听器端口的 reach 行。 |
| `changes-protection` | `more` | `more` | `more` | 用一行说明更改保护（[C21](c21-changes.zh.md)）在其当前设置下的含义，然后询问本人插件和 Delorun 自身的更改是否要在加载之前等待审查。每种使用场景都只在「More settings」下询问它，回答默认为否。 |
| `profile` | `more` | `more` | `more` | profile 的名称和 studio 的端口。 |

第一个问题之后的每个问题都可以回到最近一个被询问过的前面的问题，包括从第一个「More settings」问题回到审查：选择题或是否题提供「← Back」，文本或密钥问题把空输入当作「返回」。审查屏幕在写入任何内容之前列出各个回答。

每种形式都以同样的方式结束且不启动任何东西：它打印「Delorun is set up. Nothing is running yet.」，以及针对该使用场景的编号后续步骤。对于 `local` 和 `remote`：用 `delorun` 启动 Delorun 并打开 studio，以及安装指南的首个 chat 一节（`https://docs.delorun.com/guide/get-started/install#the-studio-and-your-first-chat`）。对于 `remote`，还有 `delorun devices approve`，或在 Tailscale 检查失败时如何开启远程访问。对于 `automation`：`delorun headless "your task"`。需要时，某一步会排在最前：当 `npx` 启动了这次运行时，按启动器的版本（`DELORUN_LAUNCHER_VERSION`）安装 `delorun` 命令，在没有选择任何密钥时添加模型密钥，或设置未设置的密钥变量。最后几行说明如何更改某个回答（`delorun setup <section>`、`delorun setup --list`）并指出 `delorun doctor`。在任何问题处的中断（Ctrl-C）都以代码 130 退出，并打印「Setup cancelled. Nothing was saved. Run delorun to start again.」；在保留着先前运行的回答期间发生的中断则说明这一点。

<a id="questions"></a>
### 问题

setup 按此顺序询问这些问题。本人接受默认值时，默认值生效，`--yes` 形式对其没有另行设定的每个问题使用默认值。

| 问题 | 节 | 回答 | 默认值 |
| --- | --- | --- | --- |
| How will you use Delorun? | 无 | `local`、`remote` 或 `automation`。 | `local`；`--yes` 保留它。 |
| Check for new releases | `privacy` | 是或否。在「More settings」下询问，附带每个选择的几行说明。 | 是 |
| Copy your DeepSeek Harness chats, attachments and workspace list? | `import` | 预览之后的是或否。 | 否。 |
| Model provider | `key` | DeepSeek、More providers 之后的[模型提供方](#model-providers)中的其他提供方之一，或 Choose later。 | 在终端中为 DeepSeek；使用 `--yes` 时为无。 |
| Base URL and model id | `key` | 只为 `openai-compatible` 端点询问。 | 无。 |
| Model key | `key` | 在提示处输入，或在每次启动时从提供方的变量读取。 | 在提示处输入。 |
| Model | `key` | 提供方已安装目录中的一个模型。为除 DeepSeek 之外的每家提供方询问，DeepSeek 的默认值是 profile 的，由 `delorun setup key` 询问。 | setup 的提供方表中提供方的推荐模型，即其目录列出的当前通用 chat 模型；对于 DeepSeek，为 profile 的默认值。 |
| Prompts | `prompts` | Ask me first（`safer`）、Ask less（`stock`），或 Never ask（dangerous）；`--yes` 从不选择 dangerous。 | Ask me first |
| Keep running in the background | `background` | 是或否。 | 是；`automation` 为否，且不询问。 |
| Open Delorun from your phone or another device over Tailscale? | `reach` | 是或否。 | 否；对于 `remote`，该问题起始为是。 |
| Hold changes to your plugins and to Delorun itself for your review before they load? | `changes-protection` | 是或否。否保持 home 的设置不变，setup 从不关闭保护。 | 否；保护已开启时为是。 |
| Profile name and port | `profile` | profile 名称和 1024 至 65535 中的一个空闲端口。 | 所选的 profile 和 3080。 |

超出本人 tailnet 的远程访问、通行密钥或 OIDC 身份因子以及运行时都不被询问；Delorun 的 setup 不包含它们（[路线图](../guide/roadmap.zh.md)）。setup 读取 stock home 只是为了从中复制，且从不修改它。setup 的导入只复制数据：不复制 profile、设置层、指示、技能或已存密钥，它们会改变 Delorun 运行的内容或智能体所得的指示；`delorun import-home` 在各自获得确认之后复制其中每一项。

实时密钥检查向提供方的源（且仅向该源）发送一次带身份验证的元数据端点 `GET`；重定向会失败。DeepSeek 的检查通过上游的模型列表客户端进行，它会解析响应体；其他每个检查都只依据状态作出结论，从不读取响应体。没有任何检查打印响应体，也没有任何检查请求补全。失败的检查会打印其原因，该原因写明源和 HTTP 状态，从不含密钥，并让本人重新输入密钥，或在没有成功检查的情况下继续。`--yes`、`--config` 以及从环境读取的密钥会跳过检查，除非给出 `--check-key`；使用 `--check-key` 时，提供方不接受的密钥会使无人值守的运行停止。

<a id="model-providers"></a>
### 模型提供方

setup 提供下列提供方，按名称排列，不让任何一家排在另一家之前。DeepSeek 运行在上游的 DeepSeek 适配器上，即 profile 的 `llm-deepseek` 行，无需安装。其余每家提供方都是上游 pi-ai 适配器（`llm-pi-ai` 行）的一条路由：要么是 pi-ai 已安装目录中的一条路由，其端点与模型由该目录提供，要么是 `openai-compatible` 路由，由 setup 以本人给出的基础 URL 与模型声明。profile 的适配器所支持而 setup 不提供的提供方，包括 pi-ai 目录中的其余提供方，在 studio 的设置 → 模型中设置。

| 提供方 | Id | 密钥变量 | 密钥检查 |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | 带 `x-api-key` 与 `anthropic-version` 的 `GET /v1/models?limit=1` |
| DeepSeek | `deepseek-official` | `DEEPSEEK_API_KEY` | 在 `https://api.deepseek.com` 或 `DEEPSEEK_BASE_URL` 的源上，通过上游的模型列表客户端发送带 `x-api-key` 的 `GET /models` |
| Google Gemini | `google` | `GEMINI_API_KEY` | 带 `x-goog-api-key` 的 `GET /models?pageSize=1` |
| Groq | `groq` | `GROQ_API_KEY` | 带 bearer 令牌的 `GET /models` |
| Mistral | `mistral` | `MISTRAL_API_KEY` | 带 bearer 令牌的 `GET /v1/models` |
| Moonshot AI | `moonshotai` | `MOONSHOT_API_KEY` | 带 bearer 令牌的 `GET /models` |
| OpenAI | `openai` | `OPENAI_API_KEY` | 带 bearer 令牌的 `GET /models` |
| OpenAI 兼容端点 | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | 在本人给出的基础 URL 下，带 bearer 令牌的 `GET /models` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | 带 bearer 令牌的 `GET /key` |
| Together AI | `together` | `TOGETHER_API_KEY` | 带 bearer 令牌的 `GET /models` |
| xAI | `xai` | `XAI_API_KEY` | 带 bearer 令牌的 `GET /models` |

每家目录内提供方的路径，都附加在 pi-ai 已安装目录为它提供的端点之后。输入的密钥存放在密钥变量之下，该变量就是适配器读取的凭据引用；从环境读取的密钥，读自密钥变量，或读自 `--key-env` 或文档所指定的变量。不需要任何密钥即可返回其模型列表的端点，也能通过 `openai-compatible` 检查。

密钥变量是各家提供方自己的工具所读取的名称，其中一些与设置 → 模型在保存密钥时从路由推导出的引用不同：setup 使用 `GEMINI_API_KEY`，而 studio 推导为 `GOOGLE_API_KEY`；setup 使用 `MOONSHOT_API_KEY`，而 studio 推导为 `MOONSHOTAI_API_KEY`。路由的 `apiKeyEnv` 记录 setup 所用的变量，因此适配器与 studio 都从它读取密钥。

基础 URL 是不含用户名、密码、查询或片段的 `http` 或 `https` URL，因此不携带凭据；setup 拒绝任何其他形式，且不重复它。通过明文 `http` 访问这台电脑的回环地址（`localhost`、`127.0.0.0/8`、`::1`）以外主机的基础 URL 会被接受并给出警告（在终端中是一条说明，否则是标准错误上的一行），因为密钥与每条提示随后会不加密地穿过网络。模型 id 只包含字母、数字与 `. _ : / @ ~ + -`，最多 200 个字符。

<a id="answer-schema"></a>
### 回答 schema

回答文档是带有下列字段的 JSON 对象。交互式 setup 填写它，`--config` 读取它，两者使用同一个 schema。

```json
{
  "schemaVersion": 5,
  "useCase": "local",
  "modelProvider": { "id": "anthropic", "credential": { "source": "environment", "name": "ANTHROPIC_API_KEY" }, "baseURL": null, "model": "claude-sonnet-5" },
  "prompts": "safer",
  "background": true,
  "profile": { "name": null, "port": null },
  "reach": { "option": "none", "identityFactor": null },
  "importStockHome": false,
  "protectChanges": false,
  "updateCheck": true,
  "sections": [{ "id": "privacy", "status": "seen" }, { "id": "key", "status": "answered" }]
}
```

| 字段 | 类型与取值 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `schemaVersion` | 整数 `5`，对于更早写入的文档为 `2`、`3` 或 `4`。 | `5` | setup 拒绝任何其他值。含有 `phonePowers` 的版本 2、版本 3 或版本 4 的文档，读取时忽略该键，并在标准错误上输出一行说明；含有它的版本 5 的文档则作为未知字段被拒绝（`@delorun/contract-setup-answers` 中的 `IGNORED_ANSWER_KEYS`）。版本 2 的文档没有 `updateCheck`，读作 `true`，带有它时被拒绝。版本 2 或版本 3 文档的 `modelProvider` 只含 `id` 和 `credential`，读作 `deepseek-official`，带有其凭据和 profile 的默认模型，因为这些版本的 setup 只应用 DeepSeek 的密钥而不应用任何其他提供方。指名其他 id 的文档会被拒绝，并提示它需要 schema 版本 4。 |
| `useCase` | `local`、`remote` 或 `automation`。 | `local` | 本人如何使用 Delorun。交互形式据此设定默认值和问题；`--yes` 和 `--config` 存储它而不问任何问题。`remote` 文档不能启用 reach，因此远程访问用 `delorun setup reach` 开启。在使用场景问题之前写入的记录没有它，读作 `local`；其 `mode` 键（询问过 Quick 或 Full 的 setup 所写的 `quick` 或 `full`）被读取并忽略，任何其他 `mode` 值会被拒绝。 |
| `modelProvider` | 带有下面四个字段的对象，或表示没有提供方的 `null`。 | 在终端中为带有各字段默认值的对象；使用 `--yes` 时为 `null`，除非给出 `--provider`。 | `null` 不写入任何提供方行，并保留已有的行，因此新 chat 保持 profile 所选的模型；setup 会说明这一点。 |
| `modelProvider.id` | [模型提供方](#model-providers)中的一个 id。 | `deepseek-official` | 任何其他 id 都被拒绝，并写明 setup 接受的 id。 |
| `modelProvider.credential` | `{ "source": "prompt" }` 或 `{ "source": "environment", "name": "<variable>" }`。 | `{ "source": "prompt" }` | `prompt` 只在交互形式中被接受。 |
| `modelProvider.baseURL` | `http` 或 `https` URL，或 `null`。 | `null` | 为 `openai-compatible` 设置，其他每家提供方为 `null`，遵循[模型提供方](#model-providers)的基础 URL 规则。 |
| `modelProvider.model` | 模型 id，或 `null`。 | `null` | 只有 `deepseek-official` 为 `null`，此时保留 profile 的默认模型。其他每家提供方都要写明一个模型，除非提供方是 `openai-compatible`，否则该模型必须在提供方已安装的目录中。不是模型 id 或不在目录中的模型会被拒绝，拒绝信息写明字段而不是它的值。 |
| `prompts` | `safer`、`stock` 或 `dangerous`；`dangerous` 要求文档中有 `acceptDangerousMode: true`（使用 `--yes` 时为 `--prompts dangerous --accept-dangerous-mode`），对 root 用户被拒绝，并且 `acceptDangerousMode` 被读取而从不存储。 | `safer` | 设置对等注册表的提示开关。 |
| `background` | 布尔值。 | `true` | 由启动命令读回。 |
| `profile.name` | profile 名称，或表示命令行所选 profile 的 `null`。 | `null` | 上游的 profile 名称规则；`desktop` 被拒绝。 |
| `profile.port` | 1024 至 65535 的整数，或表示 3080 的 `null`。 | `null` | 交互形式检查该端口是否空闲。 |
| `reach.option` | `none`、`tailscale-private`、`tailscale-funnel` 或 `self-hosted-relay`。 | `none` | `none` 以外的任何值只在交互形式中被接受。 |
| `reach.identityFactor` | `passkey`、`oidc`、`tailnet`、`tailnet-membership` 或 `null`。 | `null` | 方式为 `none` 时为 `null`。已构建的 `reach` 节为 `tailscale-private` 记录 `tailnet-membership`。`tailscale-funnel` 和 `self-hosted-relay` 为 `passkey` 或 `oidc`。`tailscale-private` 为 `passkey`、`oidc` 或 `tailnet`。`tailnet` 只在 C7 的套接字变体下可用（[C7](c07-reach-providers.zh.md#tailscale-serve-target)）；否则 setup 以 `TAILNET_IDENTITY_UNAVAILABLE` 拒绝它。`ts.net` 地址上的 `passkey` 只在 C14 使通行密钥在那里可用时才可用（[C14](c14-oidc-passkeys.zh.md#relying-party-ids)）；否则 setup 以 `PASSKEY_UNAVAILABLE` 拒绝它。 |
| `importStockHome` | 布尔值。 | `false` | 由 import 节设置。`--config` 拒绝 `true`，因为导入先显示其预览再询问。 |
| `protectChanges` | 布尔值。 | `false` | 由 `changes-protection` 节设置；缺失的字段读作 `false`。`--config` 拒绝 `true`，因为只有终端证明才能更改保护设置（[C21](c21-changes.zh.md)）。 |
| `updateCheck` | 布尔值；可选。 | `true` | Delorun 是否向发布通道检查更新的发布。`--no-update-check` 在每种形式中为整次 setup 运行将其设为 `false`；`delorun setup <section>` 拒绝它，而 `delorun setup privacy` 改为询问该问题。 |
| `sections` | `{ "id", "status" }` 的列表，按流程顺序。 | `[]` | 由 setup 写入，从不由文档写入。`seen` 是已显示的说明，`answered` 是已回答的问题，`skipped` 是未被询问而采用其默认值的节。studio 的新手引导略过终端已涵盖的内容。 |

早先版本曾询问运行时、studio 附加功能、对其他模型的帮助、桌面分析以及 DeepSeek 的会话日志上传。setup 记录了这些回答但没有应用其中任何一个，因此它不再询问这些问题。带有 `studioAdditions`、`runtime`、`helpSetUpModels`、`sessionLogUpload` 或 `desktopAnalytics` 的回答文档会被拒绝，拒绝信息写明已移除的键。两项选择加入项保持关闭，studio 的 Settings → Safety → Privacy 一节更改它们。

回答文档从不包含凭据取值。凭据要么在提示处输入并通过上游的凭据存储保存，要么从 `credential.name` 所指名的环境变量读取。

<a id="profile-writes"></a>
### profile 写入

每个回答产生下面的写入。配置写入进入回答所适用的 profile 的 `cordis.patch.yml`，上游在 bundle 之后应用该文件。

| 回答 | 写入 | 目标 |
| --- | --- | --- |
| `modelProvider` | 输入的密钥以模式 0600、在提供方的密钥变量之下，写入上游的凭据存储，即 home 下的 `.credentials.yaml`。从环境读取的密钥不存储在任何地方。 | home。 |
| `modelProvider` | 采用 Settings → Agent → Models 和模型选择器保存它们的形式的行：带 `DEEPSEEK_API_KEY` 和 profile 默认模型的 DeepSeek 不写入任何行，因为 stock DeepSeek Harness 就是这样组合 profile 的；另一个变量会在 `llm-deepseek` 上设置 `apiKeyEnv`。pi-ai 提供方在 `llm-pi-ai` 的 `providers` 下设置其路由，保留已在那里的路由：目录路由设置 `apiKeyEnv`，`openai-compatible` 还设置 `displayName`、`api: openai-completions`、`baseURL` 以及 `models` 中的模型。指名的模型把 `agent-default-model` 设为该提供方和模型，不带推理强度。`null` 不写入这些行中的任何一行。 | profile 的 `cordis.patch.yml`。 |
| `prompts` | 行 `delorun-permission-defaults`、`delorun-instruction-consent`、`delorun-mcp-consent` 和 `delorun-schedule-consent` 的 `config.enabled`，设为约定 C16 注册表中每个开关的 Delorun 默认值（`safer`，Ask me first）或对等值（`stock`，Ask less）。使用 `safer` 时，本人在 home 的电脑上允许工作区的完全访问和新的 stdio MCP 服务器：在 studio 的 Settings、Permissions 中，或使用 `delorun workspace full-access` 和 `delorun mcp`；使用 `stock` 时两种同意都不挂载，这些界面会说明该 profile 不询问。fetch 防护是拒绝而不是提示，没有任何回答会改变它；也没有任何回答会改变外部智能体同意（`delorun-delegation-consent`），本人在 Settings、Permissions 中切换它。使用 `dangerous` 时，三个同意行取其对等值，`delorun-permission-defaults` 保持开启，并且每个回答都把它的 `fullAccessEverywhere` 设为该回答是否为 `dangerous`；`dangerous` 还在这些行之后、在权限存储的锁之下写入授权文件 `<home>/secrets/permission-defaults/full-access-everywhere.json`（模式 0600，`{ "v": 1, "grantedAt", "warning": 1 }`），而 `safer` 和 `stock` 会移除它。只有行设置和有效的授权文件同时成立时，完全访问才在每处可用。 | profile 的 `cordis.patch.yml`，授权文件则是 home 的 `secrets/permission-defaults/`。 |
| `background` | 记录在回答记录 `setup-answers.json` 中；启动命令读取它。 | profile 目录。 |
| `profile.name` | CLI profile 以此名称创建。 | home。 |
| `profile.port` | 带端口的 `webserver` 行，重述 Web bundle 的其他键。默认端口不写入。 | profile 的 `cordis.patch.yml`。 |
| `reach.option` | 远程访问约定的 reach 行。`none` 不写入任何行。 | profile。只在交互形式中写入。 |
| `reach.identityFactor` | 针对远程访问地址的注册请求。没有配置行。 | home-auth 状态，遵循身份约定。 |
| `importStockHome` | [C8](c08-archive-and-trash.zh.md#the-stock-home-import) 的 stock home 导入的数据：恰好是该节的预览所显示的计划，在每个 profile 的 home 锁之下执行。此后已更改的 stock 文件、此后新增了 chat 的 Delorun home，或没有显示预览的运行都会使其被拒绝。 | home。 |
| `protectChanges` | `true` 写入级别为 `on` 的 `changes/protection.json`，模式 0600，位于模式 0700 的 `changes/` 之下，经由 `delorun changes protection on` 使用的终端证明，该证明取自 setup 自己的标准输入和输出。保护已开启或回答为 `false` 时不写入任何内容。当任一流不是终端时，setup 在写入之前停止并写明如何完成：在终端中运行 `delorun setup` 会恢复这一步，或运行 `delorun changes protection on` 开启它。 | home。 |
| `updateCheck` | `false` 按 Settings → General → Updates 保存的方式写入 `delorun-update-check` 行：其 id、其插件名称，以及带 `enabled: false` 的 bundle 配置。`true` 在该行上不留任何配置，因此应用 bundle 的 `enabled: true`。 | profile 的 `cordis.patch.yml`，在 Delorun 首次启动之前。 |
| `sections` | 记录在 `setup-answers.json` 中。 | profile 目录。 |

上游的会话遥测行 `session-telemetry-otel` 不是回答。在上游的 profile 中，它只在本人提交反馈之后才发送会话日志前缀。CLI profile 把它连同上游的反馈命令和消息反馈行一起禁用，因此那里不发送任何反馈。

<a id="yes-and-config-forms"></a>
### --yes 与 --config 形式

`--yes` 保持 `local` 使用场景，接受除提供方之外的每个默认值，并且除默认值、提供方标志、`--prompts` 和 `--no-update-check` 之外不应用任何回答。没有 `--provider` 时，无论环境中有什么密钥，它都不设置任何提供方，并打印如何添加：在终端中或带提供方标志的 `delorun setup key`，或 studio 的 Settings → Agent → Models。`--provider <id>` 指名[模型提供方](#model-providers)中的一家提供方，`--model <id>` 指名其模型（除 DeepSeek 之外的每家提供方都需要），`--base-url <url>` 指名 `openai-compatible` 的端点且不用于任何其他提供方，`--key-env <NAME>` 指名每次启动时读取密钥的变量，默认为提供方的密钥变量。命令行从不接受密钥，不是变量名的 `--key-env` 值会被拒绝且不回显。变量未设置时，setup 以写明它的带类型错误停止。`delorun setup key` 在已设置好的 profile 上接受相同的标志，然后什么也不问。没有提供方的 `--check-key` 以用法代码被拒绝。

`--config <file>` 读取符合上述 schema 的回答文档，并按与 `--yes` 相同的规则应用其回答；其提供方是 `modelProvider` 所指名的那一个，提供方标志在它旁边被拒绝；无论文档怎么说，`--no-update-check` 都会关闭发布检查。`reach.option` 不是 `none` 的文档，以及 `importStockHome` 或 `protectChanges` 为 `true` 的文档，都会被拒绝，并返回写明该字段的带类型错误。两种形式都不更改保护设置。带有已移除键的文档会被拒绝，拒绝信息写明已移除的键。任何字段中带有凭据取值的文档会被拒绝，且不回显该取值。

回答相同时，交互形式与 `--yes` 或 `--config` 形式写入相同的 profile 文件。

setup 从第一个未完成的步骤恢复被中断的运行。再次运行的步骤写入相同的值。

<a id="statements"></a>
### 说明

setup 在每次终端运行开始时显示隐私说明，并在无人值守的运行之前打印它。

- Delorun 没有自己的遥测。
- 上游的桌面分析和 DeepSeek 的会话日志上传除非你开启，否则处于关闭状态，Settings → Safety → Privacy 更改它们。
- 上游的反馈发送包含会话日志前缀，并且只在你发送反馈时发生。CLI profile 没有反馈发送，因此这条说明只描述上游的 profile。
- Delorun 每天检查一次是否存在更新的发布，说明它从哪些主机获取，它不发送任何关于安装及其插件的信息，这些主机能看到这台计算机的地址，并说明 Settings → General → Updates 可将其关闭。

关于恢复和 Docker 的说明属于添加这些主题的各节。

<a id="consumers"></a>
## 消费方

- `delorun/apps/cli/src/setup/`：setup 流程、它的各个节及其 `--yes` 与 `--config` 形式。
- `delorun/packages/bundle-local`：上游选择加入项的行及其在 studio 中的同意屏幕，以及提示回答所设置的行。
- `delorun/packages/plugin-onboarding`，由 `@delorun/bundle-studio` 挂载：studio 的新手引导从 `setup-answers.json` 读取 `sections`；其余规则见[首次运行设计](../design/first-run.zh.md)。
- `delorun/packages/contract-setup-answers/`：回答类型、默认值与 profile 行名称。

<a id="compatibility"></a>
## 兼容性

回答 schema 通过 `schemaVersion` 标记版本，其值为 `5`。若新增的问题带有安全的默认值，且忽略该新字段的旧读取者写入的 profile 相同，则该变更保持版本不变；`useCase` 就是这样的字段，因为它所设定的回答与它一起存储，而 profile 文件并不依赖它。改变既有回答含义，或删除字段，都会递增版本；版本 2 删除了五个字段。版本 3 增加了 `updateCheck`：忽略 `false` 的读取者会让发布检查保持开启，因此版本递增。版本 4 赋予 `modelProvider.id` 含义，并增加了 `baseURL`、`model` 和 `null`：版本 3 的读取者忽略该 id，会把 Anthropic 的密钥存储为 DeepSeek 的，因此版本递增。版本 5 删除了 `phonePowers`，因此版本递增。setup 如[回答 schema](#answer-schema) 所述，把版本 2、版本 3 或版本 4 的文档读作版本 5，并将其记录为版本 5。setup 拒绝其版本它不认识的回答文档。

上游新增的选择加入项，以默认关闭的问题形式加入，并在同一次变更中把其 profile 行加入映射表。

<a id="security"></a>
## 安全

要求：

- `--yes` 与 `--config` 永远不会开启远程访问或凭据转发。
- setup 只在有终端证明时更改保护设置，并且只用于将其开启。
- 上游的选择加入项不由 setup 询问，默认关闭。只有本人在同意屏幕上开启，它们才会生效。
- 实时密钥检查只把密钥发往提供方的源，密钥与检查原因都不会被打印或记录到日志。
- Delorun 不发送任何自身遥测。
- 凭据取值永远不会出现在回答文档、profile 文件、进程参数或日志中。提供方标志只携带变量名。
- setup 不写入任何开启凭据转发的行。转发依据运行时约定按工作区设定。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | `--yes` 之后，profile 中没有远程访问行，也没有转发行。 |
| `config file cannot enable reach` | `reach.option` 不是 `none` 的文档，会被拒绝，并返回写明 `reach.option` 的带类型的错误。 |
| `refuses --prompts dangerous without --accept-dangerous-mode, and a document without acceptDangerousMode` | 标志形式以写明 `--accept-dangerous-mode` 的用法代码被拒绝，`prompts` 为 `dangerous` 的文档以写明 `acceptDangerousMode` 的带类型错误被拒绝；不写入任何内容。 |
| `declining dangerous mode at either step writes no grant` | 对第一步回答 No，或输入 `full access everywhere` 之外的任何内容，都保留之前的回答，不写入授权文件，也不写入 `fullAccessEverywhere: true` 的行。 |
| `yes keeps safer and a root user is refused` | 单独的 `--yes` 写入 `safer`；当进程以 root 运行时，dangerous 回答在问题、标志和文档中都被拒绝，且在写入任何内容之前。 |
| `refuses a document that asks for the stock-home import, which shows its preview in a terminal first` | `importStockHome` 为 `true` 的文档，会被拒绝，并返回写明该字段的带类型的错误。 |
| `refuses a document that turns changes protection on, which only a terminal changes, and reads an absent answer as no` | `protectChanges` 为 `true` 的文档，会被拒绝，并返回写明该字段的带类型的错误。 |
| `stops a yes before it writes, naming how to finish, and a run at a terminal resumes it` | 标准输出不是终端的 yes 不写入保护记录。 |
| `config file with a removed key is refused` | 带有已移除键的文档会被拒绝，并返回写明已移除的键且不含任何取值的带类型的错误。 |
| `config file carrying a credential value is refused` | 任何字段中带有凭据取值的文档会被拒绝，且不回显该取值。 |
| `live key check sends the key to the provider origin only` | 对每家提供方，检查的请求只发往一个源，拒绝重定向，且密钥不出现在任何 URL、消息或输出中；重定向到另一个源会失败，且该源什么也收不到。 |
| `--key-env carrying a key is refused` | 不是变量名的 `--key-env` 值以用法代码被拒绝，且该值不被回显。 |
| `refuses a base URL with a user name, password, query or fragment, and a model that is not an id, without echoing either` | 基础 URL 含有凭据、查询或片段，或模型不是模型 id 的文档会被拒绝，拒绝信息写明字段，且不回显其值。 |
| `settles on the status alone: an endpoint that sends its headers and then holds the body does not keep the check waiting` | 在响应体永不结束时，非 DeepSeek 的检查依据响应状态得出结果。 |
| `typed key is never printed` | 对于 DeepSeek 和 pi-ai 提供方，一次运行的录制屏幕中不含输入密钥的任何部分，并且 home 下除 `.credentials.yaml` 之外没有任何文件含有它。 |
| `default-profile run sends no analytics or upload` | 在默认 profile 中，网络夹具不记录任何发往分析端点的请求，也没有会话日志上传。 |
| `default-profile model request carries no dsh_session_log` | 默认 profile 发出的模型请求不包含 `dsh_session_log` 字段。 |
| `update-notice-off-at-first-start` | 在 More settings 下回答 No 的 setup 之后，以及在 `--yes --no-update-check` 之后，首次启动所组合的 profile 带有 `enabled: false` 的 `delorun-update-check` 行，且该行不挂载任何检查服务。 |

验收测试：

- `setup states the telemetry statement and that both opt-ins are off`（setup 陈述遥测说明，并说明两项选择加入均为关闭）。
- `each use case asks the questions its plan names, and the review lists every answer`（每种使用场景询问其方案所指名的问题，审查列出每个回答）。
- `an interrupt at any question exits 130 and saves nothing`（在任何问题处的中断以 130 退出且不保存任何内容）。
- `a record with a Quick or Full mode and no use case still reads`（带有 Quick 或 Full 模式而没有使用场景的记录仍可读取）。
- `Ask less (like DeepSeek Harness) sets every prompt switch to its parity value`（Ask less 把每个提示开关设为其对等取值）。
- `interactive and --yes runs write identical profile files`（交互运行与 `--yes` 运行写入相同的 profile 文件）。
- `interrupted setup resumes without a repeated write`（被中断的 setup 恢复时不重复写入）。
- `consent screen turns each upstream opt-in on alone and off again from the same screen`（同意屏幕可单独开启每一项上游选择加入项，并在同一屏幕上再次关闭）。
- `a way back returns to the previous question with the earlier answers kept`（返回操作回到前一个问题，并保留之前的回答）。
- `sits between the privacy note and the key in the main flow, and copies the chats before the key is asked for`（在主流程中位于隐私说明与密钥之间，并在询问密钥之前复制 chat）。
- `delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row`（`delorun setup privacy` 显示说明、关闭检查，并通过移除该行再次开启它）。

<a id="decided-values"></a>
## 决定的取值

- 回答 schema 的版本是 `5`；setup 也读取版本 2、3 和 4。
- 提供方问题在终端中起始为 `deepseek-official`，`--yes` 不设置任何提供方，除非 `--provider` 指名一家。
- 使用场景默认为 `local`；`remote` 和 `automation` 由本人选择，从不作为默认值。
- 默认值为：「Ask me first」提示，后台运行开启，端口 3080，远程访问 `none`，stock home 导入关闭（导入节显示时也预选为否），发布检查开启。
- 每家提供方的密钥变量是[模型提供方](#model-providers)所列出的那个；DeepSeek 的是 `DEEPSEEK_API_KEY`。
- setup 的远程访问选项为 `none`、`tailscale-private`、`tailscale-funnel` 与 `self-hosted-relay`。
- 反馈发送不是一个回答，setup 会对其作出说明。
