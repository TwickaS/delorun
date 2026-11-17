---
description: "Delorun 在 Host 上的插件包：安装队列、packs 远程接口，以及其他插件调用它的位置。"
---

# @delorun/plugin-packs

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

**插件包**（pack）是不在默认安装中的插件。每个发行版把它的插件包作为单独的已签名文件发布，而此插件负责开启其中一个：它从发行渠道下载该插件包，对照发行版已签名的 packs 文件检查它，把它安装进 home，并通过插件管理器加载它。每一次下载和安装，无论是插件包还是已有插件，都是 Host 安装队列（`@delorun/install-queue`）中的一项，所以安装很多个时，用户看到的是一个列表，并且最后只有一次 Host 重新加载。

## 目录

- [一次安装如何运行](#how-an-install-runs)
- [`packs` 远程接口](#the-packs-remote)
- [读取进度](#reading-progress)
- [配置](#configuration)
- [手机](#phones)
- [Host 在哪里接入它](#where-the-host-connects-it)
- [限制](#limits)
- [测试](#tests)

<a id="how-an-install-runs"></a>

## 一次安装如何运行

1. 运行器读取已安装发行版的 packs 文件（`delorun-<version>.packs.json`），在锚定的根之下对照已存储的清单及其发行日志记录进行验证，并找到该插件包。
2. 它下载该插件包的压缩包和所有外部 npm 包，每个都只通过 packs 文件所签名的名称或 URL 下载，不跟随重定向，并在达到已签名的长度时停止。
3. 运行时存储在 `store.lock` 之下安装它们，封存目录树并记录下来；启动检查和 `delorun verify` 会再次对每个已安装的插件包文件计算哈希。
4. 插件管理器在请求 id `pack:<name>` 之下安装 `link:<pack directory>`。

一项处于 `queued`、`downloading`、`verifying`、`installing`、`needs-reload`、`ready`、`failed` 或 `cancelled` 之一。失败带有一个代码：`offline`（第一次下载需要网络连接）、`interrupted`（下载期间 Host 停止）或 `failed`。

<a id="the-packs-remote"></a>

## `packs` 远程接口

| 动作 | 参数 | 返回 |
| --- | --- | --- |
| `packs/list` | 无 | `PacksSnapshot`：`supported`、`reason`、`release`、`packs`（`PackInfo`：名称、版本、`experimental`、`downloadBytes`、`availability`）和 `queue`（`InstallItem[]`） |
| `packs/enqueue` | `{ names }` | `PacksResult` |
| `packs/cancel` | `{ name }` | `PacksResult` |
| `packs/dismiss` | `{ name }` | `PacksResult` |
| `packs/remove` | `{ name }`（已完成、失败或已取消的项） | `PacksResult` |
| `packs/retry` | `{ name }` | `PacksResult` |

`PacksResult` 是 `{ ok: true, value: PacksSnapshot }` 或 `{ ok: false, error: { code: 'unsupported' | 'unknown-pack' | 'unavailable-pack', message } }`。这些类型以及 `packView(pack, item)`（把一个插件包及其队列项映射成界面所绘制的内容）位于 `@delorun/plugin-packs/wire`，它不导入 Cordis。

<a id="reading-progress"></a>

## 读取进度

每次变化之后，该服务会在插件管理器的 `plugin-manager/install-state` 事件上，以请求 id `pack:<name>` 通告列表中的每一项。界面监听该事件，并调用 `packs/list` 获取字节数、百分比、状态和队列位置；它在连接时也会读取整个列表。

<a id="configuration"></a>

## 配置

`concurrency`（默认 2，至少为 1）是同时运行的安装数量。队列保存在 Delorun home 中的 `run/<profile>/installs.json`，权限为 0600，因此页面重新加载或 Host 重启后仍能找到它；重启会把正在进行的项标为失败（`interrupted`），并重新开始排队中的项。

<a id="phones"></a>

## 手机

`packs/list` 是每台已配对手机都可以执行的读取动作，`packs/cancel`（停止排队中或下载中的安装）和 `packs/dismiss`（清除失败或已取消的行，只是队列记录）也是；两者都不会触及已安装的插件包（A408）。`packs/enqueue`、`packs/remove` 和 `packs/retry` 是契约 C14 的提升权限动作：手机只有在持有解锁时才能执行它们（A408）。

<a id="where-the-host-connects-it"></a>

## Host 在哪里接入它

- `delorunChatGate` 服务从 `delorun` 的 Host 接线中获取 Host 的对话闸（`ChatGate.running`），因此唯一的一次重新加载会等到没有对话运行时才进行。
- `packInstallTargets` 服务让插件管理器的官方安装把已安装的插件包解析为它的 `link:` 规格。
- `delorun update` 在切换之前，会安装新发行版中每个已添加插件包的版本；`delorun recover packs` 会再次对已安装的插件包计算哈希，并重新获取有变化的那个。回滚会保留 `packs/<previous>/`。

<a id="limits"></a>

## 限制

- 对下载请求返回重定向的发行渠道（如 GitHub Releases）会让插件包下载失败。发布之前，请在每个渠道上各试一次真实下载。
- 没有已安装发行版的 Host（源码检出）不会列出任何插件包，并会说明原因。

<a id="tests"></a>

## 测试

`tests/hub.integration.spec.ts` 基于已签名的发行版测试夹具，覆盖列出、安装、唯一一次重新加载、离线、取消和恢复。存储、传输、更新、回滚和修复的测试位于 `packages/runtime-store/tests/`，手机规则位于 `packages/home-auth/tests/reach-access.spec.ts`。
