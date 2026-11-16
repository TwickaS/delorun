---
description: "只含类型的包，保存 delorun setup 回答文档的类型、默认值与上游 profile 行名称，规格见约定 C11。"
---

# @delorun/contract-setup-answers

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本只含类型的包导出 `delorun setup` 的回答文档：其类型、setup 提供的模型提供商、其默认值、早先文档携带而 setup 不再询问的键、「隐私」部分两项选择加入所写入的上游 profile 行，以及发布检查回答所写入的行。交互式 setup、`--yes` 与 `--config` 形式，以及 studio 的同意屏幕都导入这些定义，因此每个默认值只有一个来源。规格见[约定 C11](../../docs/contracts/c11-setup-answers.zh.md)。

## 导出

- `SetupAnswers`、`ModelProviderAnswer`、`ReachAnswer`、`ProfileAnswer`、`SectionRecord` 与 `ModelCredential`：回答类型。
- `SETUP_PROVIDER_IDS` 与 `SetupProviderId`：setup 提供的模型提供商，按 profile 选择每个提供商所用的路线 id 标识；`delorun/apps/cli` 中 setup 的提供商表保存每个提供商的适配器、密钥变量和密钥检查。
- `REACH_OPTIONS`、`IDENTITY_FACTORS`、`PROMPTS_OPTIONS` 与 `SECTION_STATUSES`，以及由它们各自推导出的联合类型；`PROMPTS_OPTIONS` 包含 `safer`、`stock` 和 `dangerous`，`DANGEROUS_PHRASE` 是本人为确认 `dangerous` 所输入的文字。
- `REMOVED_ANSWER_KEYS`：早先回答文档中 `--config` 按名称拒绝的键。
- `SETUP_DEFAULTS`：每个回答的默认值。
- `SETUP_OPT_IN_ROWS`：「隐私」部分的每项选择加入所写入的上游行。setup 不再询问这两项。`SETUP_UPDATE_CHECK_ROW`：`updateCheck` 回答与「隐私」部分的发布检查开关所写入的 `@delorun/bundle-local` 行。
- `SETUP_ANSWERS_SCHEMA_VERSION`、`SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS`、`SETUP_DEFAULT_PROVIDER_ID`、`SETUP_DEFAULT_CREDENTIAL_VARIABLE` 与 `SETUP_DEFAULT_PORT`：setup 写入的 schema 版本、它仍可读取的早先版本、交互式问题开始时所在的提供商、DeepSeek 的密钥变量，以及 studio 的默认端口。

## 限制

本包没有运行时代码，也没有依赖。对某项回答的变更，遵循该约定的兼容性一节。
