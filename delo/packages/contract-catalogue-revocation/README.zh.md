---
description: "Delo 插件索引约定（C13）的类型与固定值，供插件索引仓库、撤销检查与 Discover 使用：索引条目、徽章记录、列出的发现、已签名的撤销列表，以及其状态与限制。"
kind: "package-library"
---

# @delo/contract-catalogue-revocation

[English](README.md) | 中文

## 摘要

`@delo/contract-catalogue-revocation` 定义插件索引文件及其条目、徽章记录与列出的发现，已签名的撤销列表，撤销列表的客户端状态，以及一条发现的接受台账记录，并把缓存时长、有效期、重试间隔与文本上限定义为常量。本包只包含导出的类型与只读常量，没有运行时代码，因此它从不改变任何进程的行为；约定页面 [C13 插件索引文件与撤销列表](../../docs/contracts/c13-catalogue-revocation.zh.md) 是权威依据，本包遵循它。其入口为 `src/index.ts`，以 `.` 导出。

## 目录

- [使用本包](#use-this-package)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

插件索引仓库的 schema 检查与发布任务、`delo/packages/catalogue/` 中的加载时撤销检查，以及 Discover 集成会使用本包。使用 `import type` 导入类型，并以值导入的方式从 `@delo/contract-catalogue-revocation` 导入常量；读取或写入本约定所定义文件的包仍须在其解析器处校验这些文件，因为这些类型描述的是有效的文件，并不检查它们。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 徽章与发现的显示措辞规则写在约定页面上；本包只携带任何界面都不得用于描述插件的措辞列表。
