---
description: "只含类型的包，保存归档格式 v1 的类型、定制行 kind、错误代码、上限与回收站保留期，规格见约定 C8。"
---

# @delorun/contract-archive-and-trash

[English](README.md) | 中文

## 摘要

本只含类型的包导出归档格式 v1：manifest 与定制内容的类型、schema 允许与拒绝的行 kind、错误代码、上限与回收站保留期。归档、回收站与导入代码以及 studio 的回收站屏幕都导入这些定义，因此每个上限与每个错误代码只有一处定义。规格见[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md)。

## 导出

- `ARCHIVE_FORMAT_VERSION`、`ARCHIVE_CUSTOMISATION_SCHEMA_VERSION` 与 `ARCHIVE_SIGNATURE_ALGORITHM`：格式版本、schema 版本与签名算法。
- `ARCHIVE_LIMITS`、`TRASH_RETENTION_DAYS` 与 `PURGE_RESIDUE_MAX_DAYS`：归档上限、回收站保留期与运行日志残留的上限。
- `ARCHIVE_ENTRY_KINDS`、`ARCHIVE_ROW_KINDS`、`ARCHIVE_DENIED_ROW_KINDS` 与 `ARCHIVE_ERROR_CODES`，以及由它们推导出的联合类型。
- `ArchiveManifest`、`ArchiveCustomisation`、`ArchiveCustomisationRow`、`ArchiveSignature`、`ArchiveOrigin`、`ArchiveEntry` 与 `ArchiveWorkspace`：文档类型。

## 限制

本包没有运行时代码，也没有依赖。对某项上限或错误代码的变更，遵循该约定的兼容性一节。
