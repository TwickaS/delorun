---
description: "只含类型的包，保存 studio 的 host id 类型、host 限定键的形式，以及已持久化浏览器键的清单，规格见约定 C10。"
---

# @delorun/contract-host-qualified-keys

[English](README.md) | 中文

## 摘要

本只含类型的包导出 host id 类型、host 限定键的形式，以及 studio 写入的已持久化浏览器键清单。studio 的连接状态、各个 store、回收站屏幕与枚举规格都导入这些定义，因此每个持久化名称及其作用域只有一处定义。规格见[约定 C10](../../docs/contracts/c10-host-qualified-keys.zh.md)。

## 导出

- `HostId` 与 `HostQualifiedScope`：带品牌的 host id，以及 host 限定键的作用域。
- `HOST_ID_LENGTH` 与 `HOST_KEY_SEPARATOR`：host id 的长度，以及 host id 与上游 id 之间的分隔符。
- `PERSISTED_KEYS`：固定的已持久化浏览器条目，附有每项的归属与作用域。
- `PERSISTED_SCOPE_KINDS`、`PersistedKeyEntry` 与 `PersistedKeyName`：作用域种类、条目类型与名称联合类型。
- `PERSISTED_DYNAMIC_KEYS`：由归属方命名的条目，清单按种类列出它们。
- `ORIGIN_SCOPED_COOKIE_PREFIX`：清单之外的 cookie 的前缀。

## 限制

本包没有运行时代码。它只依赖工作区的 brand 包，用于带品牌的 host id 类型。对清单条目的变更，遵循该约定的兼容性一节。
