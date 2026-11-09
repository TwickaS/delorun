---
description: "Delo 的安装路径：启动器通过 HTTPS 获取的发布文件、约定 C2 的客户端校验第 1 至 5 步、约定 C18 的 bundle 与在线日志检查，以及把已校验的运行时归档解压到运行时存储的暂存目录。"
---

# @delo/install

[English](README.md) | 中文

## 摘要

`@delo/install` 是 [`@delo/npm-launcher`](../npm-launcher/README.zh.md) 的 `delorun` 启动器背后的安装路径。它从约定 C1 列出的主机通过 HTTPS 获取某个发布的文件，在解压任何内容之前逐一校验它们，并把运行时归档写入运行时存储的暂存目录。运行时存储发布此包准备好的内容：这里从不切换 `current`，被拒绝的安装也不会在 `~/.delo/runtimes/` 下留下任何目录。

## 目录

- [下载](#downloads)
- [校验](#verification)
- [发布日志](#the-release-log)
- [解压](#extraction)
- [home 记住的内容](#what-a-home-remembers)
- [失败](#failures)
- [开发](#development)

<a id="downloads"></a>

## 下载

`Downloader` 即约定 C1 的下载规则，一个实例服务于一次安装。它通过 HTTPS 从约定 C1 列出的发布主机获取文件，仅在跳转到这些主机时跟随跳转且最多五次，连接最多允许 30 秒、无字节最多允许 60 秒，并在响应体到达过程中就按限额拒绝超限文件，而不是读完再判断。`bytes` 把小体积元数据文件读入内存；`file` 把归档写入一个新文件（权限 0600），在写入过程中计算哈希，一旦任何环节失败就删除该文件；无法创建、无法完整写入（磁盘写满为 `ENOSPC`，文件大小上限为 `EFBIG`）或无法关闭的文件也包含在内——写入失败同样是 `DOWNLOAD_FAILED` 拒绝，而绝不会是原始的文件系统错误。

<a id="verification"></a>

## 校验

`verify.ts` 执行约定 C2 的客户端校验，在解压归档之前不跳过其中任何一步：

1. 从启动器内置的根开始的根链，每个根都由前一个版本校验，最新的根还要满足自身的阈值与有效期。
2. 时间戳的签名、生存期、有效期，以及它相对于本 home 已存储版本的版本号，从而拒绝重放。
3. 频道清单：新时间戳指定的摘要与 targets 阈值的签名，以及当有人指定版本时该人的版本号。
4. 平台的清单文件，需满足清单中的长度与 SHA-256，以及该文件自身的签名。
5. 归档本身，在从磁盘读取时满足清单中的长度与 SHA-256。

`LauncherChannel` 是启动器驱动的组合：`resolve` 命名并校验一个发布，把校验通过的事实记录到 `trust/` 下；`fill` 下载该发布的归档与文件清单，将两者对照清单检查，并解压到存储创建的暂存目录。

<a id="the-release-log"></a>

## 发布日志

`runOnlineCheck` 是约定 C18 针对当前日志的检查。它读取日志的最新检查点，要求有日志自身的签名，以及根所列见证者中达到阈值的联署，且联署时间不超过 24 小时。随后它证明一致性：从已校验 bundle 携带的检查点（或本 home 存储的更新的检查点）到最新检查点，并存储最新检查点。日志不可达会把该发布记为 `unchecked`，可验证的失败记为 `failed`；`requireVerifiedLog` 在这两种状态下都拒绝安装，因此无法对照日志检查的发布永远不会被安装。`createTilesLogService` 通过下载器读取 tlog-tiles 分片，但使用自己的主机清单：`hosts` 列出日志的 origin 与见证者网络的检查点分发器，发布文件的主机规则仍属于约定 C1，两份清单都不必列出对方的主机。origin 不在自己的主机清单中，或应答重定向到清单之外，都会以 `DOWNLOAD_REFUSED` 拒绝。

<a id="extraction"></a>

## 解压

`extractArchive` 只接受签名文件清单所列的文件，并且要符合清单中的长度、SHA-256 与权限位。归档格式禁止的条目类型、清单未列出的路径、会落到暂存目录之外的路径、重复的路径，以及长度或摘要与清单矛盾，都会中止解压；归档缺少清单列出的文件同样中止。暂存目录留给调用方删除，目录之外不会写入任何内容。

<a id="what-a-home-remembers"></a>

## home 记住的内容

`trust/` 下的三个文件是安装过程保留的回滚保护，每个都通过临时文件以权限 0600 写入：最近校验通过的根、最近校验通过的时间戳，以及最近校验通过的日志检查点。之后的安装会拒绝低于已存储版本的时间戳和低于已存储检查点的检查点；无法读取、属于其他用户或权限宽于 0600 的文件会让安装以 `TRUST_STATE_INVALID` 失败，而不会被替换。

已存储的根同时是启动的锚点，因此由 `readStoredRootBytes` 把它读回，并由 `verifyStoredRoot` 按启动器随包携带的根核对它：在启动器携带的某个版本上，存储的根必须正是该根（键与角色一致），比携带的最旧根更旧的存储根会被拒绝。比携带的所有根都新的存储根，是经校验的轮换走到的最新版本，且只有安装会写入它。除此之外，已存储的根的任何内容都不被直接相信。

<a id="failures"></a>

## 失败

每种拒绝都是 `InstallError`，可用 `isInstallError` 判断：

| 代码 | 含义 |
| --- | --- |
| `DOWNLOAD_REFUSED` | URL 不是 HTTPS、指向约定 C1 列表之外的主机，或跳转到这样的主机 |
| `DOWNLOAD_FAILED` | 连接未建立或停滞、应答不是 200、文件超过限额，或文件无法创建、无法完整写入或无法关闭 |
| `INSTALL_VERIFY_FAILED` | 签名、摘要、长度或版本检查失败 |
| `ARCHIVE_REFUSED` | 归档含有其格式禁止、或签名清单未列出的条目 |
| `RELEASE_LOG_FAILED` | 约定 C18 的 bundle 或在线检查出现了可验证的失败 |
| `RELEASE_LOG_UNCHECKED` | 在线检查无法运行，而安装需要它 |
| `RELEASE_NOT_OFFERED` | 有人指定的版本不是新时间戳指定的发布 |
| `RELEASE_METADATA_INVALID` | 某个发布文件完全无法读取 |
| `TRUST_STATE_INVALID` | `trust/` 下的某个文件无法读取 |
| `NO_TRUSTED_ROOT` | 启动器未提供任何根，因此什么都无法校验 |

<a id="development"></a>

## 开发

此包的测试位于 `tests/`，它们用本地字节而非网络来提供所校验的发布。用仓库的 Vitest 配置运行：`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/install`。
