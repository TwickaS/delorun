---
description: "只含类型的包，保存 Delorun 验证检查的注册表、结果、模式、阶段与报告类型，规格见约定 C15。"
---

# @delorun/contract-verification-checks

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本只含类型的包导出 Delorun 的验证检查注册表，以及检查与报告读取者所用的结果、模式、阶段与报告类型。完整性包、`delorun` 命令与 studio 的验证面板都导入这些定义，因此每个检查 id 及其在 `enforce` 模式下的效果只有一处定义。规格见[约定 C15](../../docs/contracts/c15-verification-checks.zh.md)。

## 导出

- `VERIFICATION_CHECKS` 与 `VERIFICATION_CHECK_IDS`：注册表与检查 id。
- `VERIFICATION_MODES`、`VERIFICATION_STAGES`、`VERIFICATION_RESULTS` 与 `VERIFICATION_BLOCKS`，以及由它们推导出的联合类型。
- `VerificationReport`、`VerificationCheckResult` 与 `MachineVerificationReport`：报告类型。
- `VERIFICATION_REPORT_SCHEMA_VERSION`、`VERIFICATION_NOTICE`、`VERIFICATION_DETAIL_MAX_LENGTH`、`VERIFICATION_MODE_SETTING` 与 `VERIFICATION_CHALLENGE_BYTES`：schema 版本、说明文字、详情长度上限、设置键与挑战长度。

## 限制

本包没有运行时代码，也没有依赖。对某项检查的变更，遵循该约定的兼容性一节。
