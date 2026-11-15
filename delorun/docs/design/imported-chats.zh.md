---
description: "打开导入的 chat 与应用归档定制的设计：带有横幅的不受信任状态，在人信任某个 chat 之前其历史记录被排除在模型上下文之外，差异界面，导入的 skill、预设和插件声明的规则，以及 stock DeepSeek Harness home 的导入。"
---

# 导入的 chat 与定制

[English](imported-chats.md) | 中文

## 摘要

`delorun import` 会验证归档、检查其签名，并把它的工作区存储在 home 之下，而没有任何东西读取它存储的内容。本页给出 Delorun 为使用导入内容所采纳的规则：在 studio 中把导入的 chat 作为不受信任的 chat 打开，在人信任它们之前其历史记录不进入模型上下文；在差异界面之后应用归档的定制行；以及导入 stock DeepSeek Harness 的 home。归档格式和导入的验证见[约定 C8](../contracts/c08-archive-and-trash.zh.md)。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- `delorun import` 把每个导入的工作区的 manifest 文档和对象发布在 home 中的 `archive/imported/<id>/` 之下。它不创建任何 session，CLI profile 的任何行都不读取 `archive/imported/`，所以没有导入的 chat 会到达 studio、Host 插件或模型请求。
- 导入的 chat 没有信任状态、没有横幅，也没有把它标记为受信任的操作，并且它没有通往回收站或清除的路径。
- `delorun import` 打印每个定制行的类型和目标，但不应用其中任何一个：不会写入来自归档的 bundle、profile 行、预设、skill、主题或插件声明。`delorun export` 不写入定制行。
- `delorun import-home` 和 setup 的 `import` 部分导入 stock DeepSeek Harness 的 home（[C8](../contracts/c08-archive-and-trash.zh.md#the-stock-home-import)）。它的 chat 落在 `sessions/` 中，studio 把它们作为此人自己的 chat 打开：它们没有信任状态或横幅。每个复制的 chat 都记录在 `archive/stock-import/imports.json` 中，由 `@delorun/archive/dsh-import` 的 `readImportedChats` 读回，并且不携带停在某一轮之中的 chat。

<a id="the-rules"></a>

## 规则

### 不受信任的导入 chat

1. 每个导入的 chat 在 studio 中都以不受信任的状态打开，直到此人把它标记为受信任。不受信任的 chat 显示一个指出其来源的横幅，来源即归档的出处或文件名，以及归档是由 home 担保的密钥签名的，还是作为未经验证的而被接受的。
2. 不受信任的 chat 的历史记录被排除在模型上下文之外：在此人把该 chat 标记为受信任之前，没有任何模型请求携带它的任何事件。把 chat 标记为受信任，是此人在 studio 中的操作，记录在该 chat 的会话日志中，任何工具、插件路由或远程会话都不能执行它。
3. 删除不受信任的 chat 会把它移到回收站，清除它会把它从[C8](../contracts/c08-archive-and-trash.zh.md#trash-and-purge) 所列的每个存储中移除。

### 应用定制

4. 只有在此人看过差异之后才应用定制。差异界面在写入更改之前显示每一行及其类型和目标。
5. 导入的 skill 初始为关闭状态。
6. 导入的预设不能把权限提高到此人自己的预设之上。
7. 导入的插件声明和 bundle 会被列出，但绝不会被自动安装。
8. C8 所陈述的被拒绝的行类型，以及对 `!!js` 表达式和 `insert` 行的拒绝，适用于所应用的每一行。

### stock home

9. 导入 stock DeepSeek Harness 的 home 绝不修改该 stock home。它的 session 是上述规则之下的导入 chat；把它们标记为不受信任、带有横幅并把历史记录排除在模型上下文之外，是尚待为它们构建的部分。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **此人信任的文字。**一旦此人把 chat 标记为受信任，它的历史记录就像其他任何 chat 一样成为模型上下文，包括注入其中的任何指令。
- **此人确认过的签名者。**签名表明是哪个密钥为归档签名，而不表明它的内容是安全的。
- **此人应用的定制。**已应用的行会像此人自己写的一样生效。

<a id="denial-tests"></a>

## 拒绝测试

| 测试 | 证明什么 |
| --- | --- |
| `imported chat stays out of model context until trusted` | 不受信任的 chat 显示它的横幅，并且在此人把它标记为受信任之前，它的历史记录不出现在任何模型请求中。 |
| `no tool or remote session marks a chat trusted` | 试图把导入的 chat 标记为受信任的工具调用、插件路由和远程会话都会被拒绝，并且该 chat 保持不受信任。 |
| `imported skills start disabled` | 每个导入的 skill 在其行被应用之后都是关闭的。 |
| `imported presets do not raise permissions` | 导入的预设不能授予高于此人自己的预设的权限。 |
| `imported plugin declarations are listed and never installed` | 定制被应用之后，归档声明的任何插件都没有被安装。 |
| `no row applies before its diff is shown` | 在差异界面显示它并且此人接受之前，不会写入任何定制行。 |
| `a stock home is never modified` | 在 stock home 导入之后，fixture stock home 的每个文件都是逐字节相同的。 |

<a id="implementation-status"></a>

## 实现状态

归档格式、验证、签名检查、对 `!!js` 表达式、`insert` 行和被拒绝的行类型的拒绝，以及在 `archive/imported/` 之下的发布，都已构建，并由 [C8](../contracts/c08-archive-and-trash.zh.md) 描述。上述规则均未构建。
