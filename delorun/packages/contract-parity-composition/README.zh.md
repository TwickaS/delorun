---
description: "只含类型的包，保存 Delorun 对等组合的开关注册表、其基线标签与覆盖层路径，规格见约定 C16。"
---

# @delorun/contract-parity-composition

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本只含类型的包导出 Delorun 对等组合的开关注册表、它所回放的上游基线标签，以及其覆盖层的路径。每个注册了对模型可见开关的包与回放工具，都从这里导入注册表，因此每个开关 id 与对等取值只有一处定义。规格见[约定 C16](../../docs/contracts/c16-parity-composition.zh.md)。

## 导出

- `PARITY_SWITCHES`：注册表，每项对模型可见的 Delorun 变更对应一条记录，另有一条记录对应 doctor 的功能开关。已构建的记录给出其 Config 字段，以及它所关闭的对模型可见贡献所在的源文件；计划中的记录给出构建它的工作包。
- `ParitySwitchEntry`、`BuiltParitySwitch`、`PlannedParitySwitch` 与 `ParitySwitchField`：记录类型，以及已构建开关的字段，即布尔 Config 字段（`ParityBooleanField`），或模块所在行上某个键的存在（`ParityPresenceField`）。
- `ParitySwitch` 与 `ParitySwitchId`：声明的记录类型，以及由注册表推导出的 id 联合类型。
- `PARITY_REGISTRY_VERSION`、`PARITY_BASE_TAG`、`PARITY_OVERLAY_PATH` 与 `PARITY_OVERLAY_ENV`：注册表版本、上游基线标签、覆盖层路径，以及把覆盖层交给快照适配器的变量。

`@delorun/tools` 中的 `parity-switches` 检查把注册表与本仓库中的开关字段相核对；其规则见 [tools README](../../apps/tools/README.zh.md) 的对等组合一节。

## 限制

本包没有运行时代码，也没有依赖。对记录的任何变更，遵循该约定的兼容性一节。
