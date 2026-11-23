---
description: "Delorun 发布 manifest 约定（C2）的类型与固定值，供发布构建、安装程序、运行时仓库与桌面更新器使用：签名信封、根、时间戳与 manifest 文件、运行时文件列表、重建记录与安全公告接受记录。"
kind: "package-library"
---

# @delorun/contract-release-manifest

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/contract-release-manifest` 定义 Delorun 发布的文件：Ed25519 签名信封、根与时间戳元数据及其密钥角色、发布 manifest（元数据清单）、运行时文件列表、重建记录与安全公告接受记录，并以常量形式给出有效期与大小上限。本包只包含导出的类型与只读常量，没有运行时代码，因此它从不改变进程的行为；约定页面 [C2 发布 manifest 与签名](../../docs/contracts/c02-release-manifest.zh.md)是权威依据，本包遵循它。其入口是 `src/index.ts`，导出为 `.`。

## 目录

- [使用本包](#use-this-package)
- [已知限制](#known-limitations)

<a id="use-this-package"></a>

## 使用本包

`delorun/apps/release/` 中的发布构建、安装脚本与 npm 启动器、运行时仓库（runtime store）的启动检查以及桌面更新器使用它，其他发布与插件索引约定包导入它的摘要、版本与信封类型。从 `@delorun/contract-release-manifest` 导入时，类型用 `import type`，常量用值导入；读取或写入本约定所定义文件的包仍须在其解析器中验证这些文件，因为这些类型描述的是有效文件，并不检查它们。

<a id="known-limitations"></a>

## 已知限制

- 规范 JSON 序列化与 Ed25519 验证交由各消费方自选的库完成；本包只指明算法，不实现它们。
