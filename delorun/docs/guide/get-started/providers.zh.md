---
description: "Delorun 的 setup 支持的模型提供方：DeepSeek、Anthropic、Google Gemini、Groq、Mistral、Moonshot AI、OpenAI、OpenRouter、Together AI、xAI 以及任何兼容 OpenAI 的端点，每家需要什么，setup 如何检查密钥，以及之后如何更换提供方。"
---

# 模型提供方

[English](providers.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页帮助你选择 Delorun 对接哪家 AI 模型服务、把你的密钥交给它，以及之后如何更换。你需要先安装 Delorun（见[安装与首次运行](install.zh.md)），并在某家提供方拥有账户。[模型提供方](../../reference/glossary.zh.md#provider)是运行 AI 模型的公司或服务器；密钥是让 Delorun 使用你在那里的账户的秘密文本。Delorun 会使用你选择的提供方。setup 会询问使用哪一家，接收它的密钥，对大多数提供方还会询问新 chat 所用的模型。下面的每家提供方都以同样的方式设置，并按 setup 列出的顺序（按名称）排列。DeepSeek 的支持是内置的，不需要额外安装；其他所有提供方都运行在 DeepSeek Harness 自带的多提供方适配器上，所以它们同样不需要安装。studio 比 setup 列出更多的提供方，以及每家提供方的更多设置，在“设置”→“Agent”→“模型”中。

## 目录

- [在 setup 中选择提供方](#choose-a-provider-in-setup)
- [提供方一览](#the-providers)
- [兼容 OpenAI 的端点](#an-openai-compatible-endpoint)
- [setup 如何检查密钥](#how-setup-checks-a-key)
- [密钥保存在哪里](#where-the-key-is-kept)
- [无需回答问题的 setup](#set-up-without-questions)
- [之后更换提供方](#change-the-provider-later)
- [在 studio 中设置的提供方](#providers-set-up-in-the-studio)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="choose-a-provider-in-setup"></a>

## 在 setup 中选择提供方

setup 的模型提供方问题是 `Which model provider should Delorun use?`，选项为 DeepSeek（推荐）、More providers 和 Choose later。每种使用场景都会问这个问题，然后：

1. 对于兼容 OpenAI 的端点，询问 base URL 和模型 id。
2. `How should Delorun get the <provider> API key?`：**Paste it now**，把密钥存入你的 home 的凭据文件；或 **Use `<VARIABLE>`**，每次启动时读取该环境变量。setup 会指出该提供方的密钥页面，并在变量未设置时立即警告。
3. 对于手工输入的密钥，询问密钥本身，setup 会在存储之前检查它。
4. 新 chat 所用的模型，来自提供方的模型列表，默认选中该提供方当前的通用模型。除 DeepSeek 以外的每家提供方 setup 都会询问这一项，DeepSeek 则从 profile 的默认模型 DeepSeek-V4.1-Flash 开始；`delorun setup key` 对 DeepSeek 也会询问。

**Choose later** 不更改任何提供方设置：新 chat 保持 profile 已在使用的模型（新 profile 上是 DeepSeek-V4.1-Flash），setup 会告诉你那是哪个模型以及如何添加提供方。你可以在 studio 的模型选择器中更改任何 chat 的模型。

<a id="the-providers"></a>

## 提供方一览

| 提供方 | 用于 `--provider` 的 id | 密钥变量 | setup 询问什么 |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | 密钥和模型 |
| DeepSeek | `deepseek-official` | `DEEPSEEK_API_KEY` | 密钥；`delorun setup key` 还会询问模型 |
| Google Gemini | `google` | `GEMINI_API_KEY` | 密钥和模型 |
| Groq | `groq` | `GROQ_API_KEY` | 密钥和模型 |
| Mistral | `mistral` | `MISTRAL_API_KEY` | 密钥和模型 |
| Moonshot AI | `moonshotai` | `MOONSHOT_API_KEY` | 密钥和模型 |
| OpenAI | `openai` | `OPENAI_API_KEY` | 密钥和模型 |
| 兼容 OpenAI 的端点 | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | base URL、模型 id 和密钥 |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | 密钥和模型 |
| Together AI | `together` | `TOGETHER_API_KEY` | 密钥和模型 |
| xAI | `xai` | `XAI_API_KEY` | 密钥和模型 |

每家提供方的模型列表，是随 Delorun 一起安装的列表。有些密钥变量与 studio 的“设置”→“Agent”→“模型”为其存储的密钥所起的名称不同：Google Gemini 使用 `GEMINI_API_KEY`，Moonshot AI 使用 `MOONSHOT_API_KEY`，这是这些提供方自己的工具所读取的名称。setup 会记录它所用的变量，所以 studio 会从同一处读取密钥。除兼容 OpenAI 的端点外，每家提供方都使用该提供方公布的地址。当你设置了 `DEEPSEEK_BASE_URL` 时，DeepSeek 也会读取它，与 DeepSeek Harness 相同。

<a id="an-openai-compatible-endpoint"></a>

## 兼容 OpenAI 的端点

对于任何支持 OpenAI Chat Completions API 的服务器，请选择 **OpenAI-compatible endpoint**：网关、列表中没有的托管服务，或你自己电脑上的服务器，例如 Ollama、LM Studio 或 vLLM。setup 会询问：

- **端点的 base URL**：位于 `/chat/completions` 之前的地址，例如 `http://127.0.0.1:11434/v1`。它不能包含用户名、密码、查询字符串或片段；密钥请放在密钥问题中。使用纯 `http` 访问另一台电脑也可以，但 setup 会警告你，因为这样密钥和你的提示词会在网络上未经加密地传输。
- **端点提供的模型 id**：服务器所知的该模型的名称，例如 `qwen3:8b`。
- **密钥**。不需要密钥的服务器，这里仍然需要填一些文本，因为适配器总会发送一个；填任何文本即可。

再次运行 `delorun setup key` 可以为同一个端点添加另一个模型；setup 会保留它之前添加的模型。

<a id="how-setup-checks-a-key"></a>

## setup 如何检查密钥

setup 在存储手工输入的密钥之前，会向提供方发出一次请求来检查它。该请求索要的是提供方的模型列表（对 OpenRouter 则是其密钥的详情），绝不索要补全。请求只发往提供方自己的地址，不会发到别处：发生重定向会让检查失败。被提供方拒绝的密钥不会被存储，除非你选择 **Continue without a successful check**；此时审阅界面会说明密钥未经验证以及原因。原因会指出地址和 HTTP 状态，绝不包含密钥。

从环境变量读取的密钥不会被检查，除非你用 `--check-key` 运行 setup。无需任何密钥就能返回模型列表的兼容 OpenAI 的服务器，无论你输入什么密钥都能通过检查。

<a id="where-the-key-is-kept"></a>

## 密钥保存在哪里

手工输入的密钥存放在你的 Delorun home 的 `.credentials.yaml` 中，只有你能读取，使用该提供方的密钥变量名。从环境变量读取的密钥不会被存储：Delorun 每次启动时都会读取该变量，来源是它启动时所在的环境、你启动它时所在文件夹的 `.env` 文件，或你的 home 的 `.env` 文件。setup 的答案、profile 和日志中都不会保存密钥。`delorun doctor` 会检查新 chat 所用提供方的密钥是否已设置且格式正确，不会把它发往任何地方。

<a id="set-up-without-questions"></a>

## 无需回答问题的 setup

除非你指定一家，否则 `delorun setup --yes` 不会设置任何提供方，并会告诉你如何添加。用 `--provider` 指定它，并把密钥放在该提供方的变量中：

```sh
ANTHROPIC_API_KEY=... delorun setup --yes --provider anthropic --model claude-sonnet-5
DEEPSEEK_API_KEY=... delorun setup --yes --provider deepseek-official
delorun setup --yes --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --model qwen3:8b --key-env LOCAL_LLM_KEY
```

除 DeepSeek 外，每家提供方都需要 `--model`，且必须在该提供方的模型列表中。`--base-url` 只用于兼容 OpenAI 的端点。`--key-env <NAME>` 从另一个变量读取密钥。命令行上从不接受密钥。添加 `--check-key` 可在写入任何内容之前检查密钥。供 `delorun setup --config` 使用的答案文件在 `modelProvider` 中指明同样的选择，见[约定 C11](../../contracts/c11-setup-answers.zh.md#answer-schema)的描述。

<a id="change-the-provider-later"></a>

## 之后更换提供方

运行 `delorun setup key` 重新选择；它会问提供方部分的每一个问题。带上 `--provider` 及其标志时它什么都不问，因此脚本可以运行它。之后用 `delorun stop` 再 `delorun start` 重启 Delorun。studio 的“设置”→“Agent”→“模型”显示 setup 写入的内容，也可以在那里更改。再次选择 DeepSeek 会让新 chat 回到 DeepSeek 的默认模型，并保留你设置过的其他提供方，所以它们的模型仍留在模型选择器中。

<a id="providers-set-up-in-the-studio"></a>

## 在 studio 中设置的提供方

多提供方适配器认识的提供方比 setup 列出的更多，其中有 Amazon Bedrock、Azure OpenAI、Cerebras、Cloudflare、Fireworks、GitHub Copilot、Google Vertex AI、Hugging Face、MiniMax、NVIDIA、Z.AI 和 Xiaomi。可以在 studio 的“设置”→“Agent”→“模型”中添加其中任何一家，那里也可以登录使用账户而不是密钥的提供方，并编辑任何提供方的地址、模型和请求设置。

Claude Code 和 Codex 不是 Delorun 的 chat 所用的模型提供方：它们是 chat 可以把工作交给的 agent，作为各自独立的程序、使用各自的登录运行。studio 的新手引导会提议添加它们。

<details>
<summary>边界情况</summary>

- 如果你选择 **Choose later**，那么在你添加提供方之前，chat 无法回答。新 chat 保持 profile 的模型，`delorun doctor` 会显示一行以 `!` 开头的 `key`。
- 如果 setup 无法连到提供方，那么密钥检查会失败，并给出地址和 HTTP 状态。选择 **Continue without a successful check** 可以无论如何都存储密钥，或先修复网络。
- 如果你的端点不需要密钥，那么输入任何文本即可；适配器总会发送一个。
- 如果你使用纯 `http` 访问另一台电脑，那么 setup 会警告你，密钥和提示词会在网络上未经加密地传输。
- 如果你在 Delorun 运行时更换提供方，那么请停止后再启动：先 `delorun stop`，再 `delorun start`。
- 如果你在没有终端的情况下运行 setup，那么除非你用 `--provider` 指定一家，否则 `--yes` 不会设置任何提供方。

</details>

<details>
<summary>进一步了解</summary>

- 使用多家提供方：用另一家提供方再次运行 `delorun setup key`。setup 会保留你之前设置的提供方，所以它们的所有模型都留在模型选择器中。
- 通过 Ollama、LM Studio 或 vLLM，用兼容 OpenAI 的端点在你自己的电脑上运行模型。
- 添加 setup 没有列出的提供方、用账户而不是密钥登录，或在“设置”→“Agent”→“模型”中编辑提供方的地址和请求设置。
- 从 chat 把工作交给 Claude Code 或 Codex：新手引导的 Agents 步骤会添加它们（见[安装与首次运行](install.zh.md#the-studio-and-your-first-chat)）。

</details>

<a id="next"></a>

## 接下来

- 开始 chat：[日常使用](../everyday-use/daily-use.zh.md)。
- 查看一次 chat 的花费：[查看一次 chat 的花费](../everyday-use/cost-meter.zh.md)。
- 如果密钥被拒绝：[setup 与模型密钥](../help/troubleshooting.zh.md#setup-and-the-model-key)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[约定 C11](../../contracts/c11-setup-answers.zh.md) 定义了 setup 的答案，包括 `modelProvider`。
