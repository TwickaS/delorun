---
description: "只含类型的包，保存 Delo 对等组合的开关注册表、其基线标签与覆盖层路径，规格见约定 C16。"
---

# @delo/contract-parity-composition

[English](README.md) | 中文

## 摘要

本只含类型的包导出 Delo 对等组合的开关注册表、它所回放的上游基线标签，以及其覆盖层的路径。每个注册了对模型可见开关的包与回放工具，都从这里导入注册表，因此每个开关 id 与对等取值只有一处定义。规格见[约定 C16](../../docs/contracts/c16-parity-composition.zh.md)。

## 导出

- `PARITY_SWITCHES`：注册表，每项对模型可见的 Delo 变更对应一条记录。
- `ParitySwitch` 与 `ParitySwitchId`：记录类型，以及由注册表推导出的 id 联合类型。
- `PARITY_REGISTRY_VERSION`、`PARITY_BASE_TAG` 与 `PARITY_OVERLAY_PATH`：注册表版本、上游基线标签与覆盖层路径。

## 限制

本包没有运行时代码，也没有依赖。对记录的任何变更，遵循该约定的兼容性一节。
