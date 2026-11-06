---
description: "只含类型的包，保存 delorun setup 回答文档的类型、默认值与上游 profile 行名称，规格见约定 C11。"
---

# @delo/contract-setup-answers

[English](README.md) | 中文

## 摘要

本只含类型的包导出 `delorun setup` 的回答文档：其类型、默认值，以及两项选择加入回答所写入的上游 profile 行。交互式 setup、`--yes` 与 `--config` 形式，以及 studio 的同意屏幕都导入这些定义，因此每个默认值只有一个来源。规格见[约定 C11](../../docs/contracts/c11-setup-answers.zh.md)。

## 导出

- `SetupAnswers`、`RuntimeAnswer`、`ReachAnswer` 与 `ModelCredential`：回答类型。
- `REACH_OPTIONS`、`IDENTITY_FACTORS`、`DOCKER_SHAPES` 与 `RESOURCE_PRESETS`，以及由它们推导出的联合类型。
- `SETUP_DEFAULTS`：每个回答的默认值。
- `SETUP_OPT_IN_ROWS`：每项选择加入回答所写入的上游行。
- `SETUP_ANSWERS_SCHEMA_VERSION`、`SETUP_DEFAULT_PROVIDER_ID` 与 `SETUP_DEFAULT_CREDENTIAL_VARIABLE`：schema 版本、默认 provider id 与默认凭据变量。

## 限制

本包没有运行时代码，也没有依赖。对某项回答的变更，遵循该约定的兼容性一节。
