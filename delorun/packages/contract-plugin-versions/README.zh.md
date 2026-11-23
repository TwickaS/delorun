---
description: "Delorun 插件版本约定（C17）的类型与固定值，供 app-boot 兼容性检查、CLI 的版本输出、更新报告与插件索引语料库使用：两条版本轴、它们的结果与豁免文件。"
kind: "package-library"
---

# @delorun/contract-plugin-versions

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/contract-plugin-versions` 定义插件接受检查的两条版本轴（上游的 `engines.dsh` 与 Delorun 的 `engines.delorun`）、一次评估的按轴结果、每条轴的豁免文件与选项，以及 `delorun --version` 的输出。本包只包含导出的类型与只读常量，没有运行时代码，因此从不改变任何进程的行为；约定页面 [C17 插件版本要求](../../docs/contracts/c17-plugin-versions.zh.md) 是权威，本包遵循它。其入口为 `src/index.ts`，导出为 `.`。

## 目录

- [使用本包](#use-this-package)
- [已知限制](#known-limitations)

<a id="use-this-package"></a>

## 使用本包

上游 app-boot 的兼容性差异块、`delorun/apps/cli/src/version.ts`、更新前报告与插件索引语料库使用本包。用 `import type` 导入类型，用值导入从 `@delorun/contract-plugin-versions` 导入常量；读取或写入本约定所定义文件的包仍须在其解析器中校验这些文件，因为这些类型描述的是有效文件，并不检查它们。

<a id="known-limitations"></a>

## 已知限制

- 范围匹配本身由上游的 `evaluatePluginCompatibility` 借助 `semver` 完成；本包为两条轴的结果提供类型，并不评估范围。
