---
description: "Host 的插件安装队列：把插件的下载和安装放进同一个列表，按配置的数量同时运行，重新加载后依然保留，并在队列清空时只让 Host 重新加载一次。"
---

# @delorun/install-queue

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

此包是 Host 安装队列的逻辑（所有者决定 A404）。每一次插件下载和安装，无论是来自发行渠道的包还是已有插件的安装，都是同一个列表中的一项。列表先到先得，按配置的数量同时运行若干项，同一个插件只保留一次，并允许用户取消排队中或正在进行的项。一项失败只影响它自己。当列表中没有排队中或进行中的项时，Host 会为每个需要重新加载的已完成安装重新加载一次，并且绝不会在对话运行时重新加载。

此包不含网络、包管理器或 Cordis 代码。调用方提供下载、验证并安装单个插件的运行器、重新加载的方法、正在运行的对话数（[`ChatGate.running`](../home-process/README.zh.md)），以及保存列表的存储。

## 目录

- [状态](#states)
- [使用此包](#use-this-package)
- [测试](#tests)

<a id="states"></a>

## 状态

一项处于 `queued`、`downloading`（带已下载字节数和总数）、`verifying`、`installing`、`needs-reload`、`ready`、`failed` 或 `cancelled` 之一。失败的项带有一个代码（因没有网络连接而无法开始下载时为 `offline`，下载期间 Host 停止时为 `interrupted`，其余为 `failed`）和一句给用户看的话。排队中的项带有它在队列中的位置。

<a id="use-this-package"></a>

## 使用此包

用运行器、`reload`、`runningChats`、`load` 和 `save` 创建一个 `InstallQueue`，启动时调用一次 `restore()`，用 `subscribe` 把每次变化发送给 studio，并在对话结束时调用 `chatsChanged()`，让等待对话结束的重新加载得以执行。`concurrency` 是调用方一个经过验证的 `Config` 字段；小于 1 或不是整数的值会在构造时被拒绝。重启之后，`restore()` 会把当时正在进行的项标为失败（`interrupted`），并重新开始排队中的项。

<a id="tests"></a>

## 测试

`tests/queue.spec.ts` 覆盖队列及其编号、去重、进度、失败隔离、取消、唯一一次重新加载、对运行中对话的等待、重新加载失败、重启后的恢复以及持久化。
