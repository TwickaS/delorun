---
description: "@delo/runtime-store 库：约定 C1 在 ~/.delo/runtimes 下的运行时仓库，其 current 与 previous 指针通过原子重命名切换，并使用 store.lock、从暂存目录安装、保留策略、回滚，以及约定 C2 对每个已安装文件的启动检查。"
---

# @delo/runtime-store

[English](README.md) | 中文

## 摘要

本包是 [约定 C1](../../docs/contracts/c01-home-layout.zh.md#the-runtime-store) 所定义运行时仓库（runtime store）的唯一实现。它将经过校验的运行时发行包（runtime closure）安装到 `~/.delo/runtimes/<version>/` 之下，以原子重命名切换 `current` 与 `previous` 指针文件，使切换过程中被终止的进程只会留下一个完整的当前版本；它保留上一版本以供回滚，并删除其余版本。每次启动 CLI 运行时之前，它都会执行[约定 C2](../../docs/contracts/c02-release-manifest.zh.md#client-verification)的启动检查，以可信根校验已存储的发布 manifest 与文件列表，并在每种校验模式下校验每个已安装文件的长度与 SHA-256。签名由 [`@delo/release`](../../apps/release/README.zh.md) 的 C2 校验器校验。

## 目录

- [使用本包](#use-this-package)
- [指针与切换](#pointers-and-switching)
- [回滚](#rollback)
- [安装](#installing)
- [保留策略](#retention)
- [启动检查](#the-start-check)
- [启动](#launching)
- [错误](#errors)
- [崩溃安全](#crash-safety)
- [未涵盖的范围](#not-covered)
- [开发](#development)

<a id="use-this-package"></a>

## 使用本包

```text
import { readStoredRoot, RuntimeStore, SUPPORTED } from '@delo/runtime-store'

const store = new RuntimeStore({ home, platform: 'linux-x64', logger })
const plan = await store.prepareLaunch({ launcher: SUPPORTED, root: await readStoredRoot(home), mode: 'warn', profile: 'default', args })
```

`home` 是来自 [`@delo/home`](../home/README.zh.md) 的已解析 Delo home，`platform` 是本机的运行时平台（C2 的 `process.platform` 与 `process.arch` 以连字符相连），`logger` 是供保留策略记录失败的 [`@delo/logs`](../logs/README.zh.md) 日志器。每个失败都是一个 `RuntimeStoreError`，携带 `code`、其涉及的 `path`、`detail`，以及启动器提供的 `remedies`。

<a id="pointers-and-switching"></a>

## 指针与切换

`pointers()` 完整读取 `current` 与 `previous`。若 `current` 缺失、为空、超过 65 字节、内容不是恰好一个版本号加换行符、是符号链接，或其版本没有已安装目录，则以 `NO_ACTIVE_RUNTIME` 失败；`previous` 若属于上述任一情况，则读作不存在。

- **写入指针。** 新值写入 `<pointer>.tmp-<16 hex>`，以模式 0600 独占创建并刷新，然后重命名覆盖该指针；在 Linux 与 macOS 上随后刷新 `runtimes/`。在 Windows 上，若重命名报告 `EPERM`、`EBUSY` 或 `EACCES`，则最多重试 2,000 ms，之后以 `POINTER_REPLACE_FAILED` 失败，并保留旧指针。
- **`switchTo(from, to)`** 获取 `store.lock`，要求 `current` 记录的版本为 `from`（否则为 `POINTER_CHANGED`），并要求 `to` 已安装（否则为 `NOT_INSTALLED`），然后以 `from` 写入 `previous`，以 `to` 写入 `current`。它不删除任何内容。
- **`restore(before)`** 将两个指针写回更新前读取的值，先写 `previous`；若 `previous` 原先不存在，则将其删除。
- **`store.lock`** 保存 `{"v":1,"pid":…,"id":…}`，模式为 0600，通过硬链接整体创建。遇到存活的持有者时等待 30 秒，之后以 `STORE_BUSY` 失败；进程已不存在的锁，则在以其随机 id 命名的接管守卫之下删除，算法与 `@delo/home` 的 home 锁相同。

<a id="rollback"></a>

## 回滚

`rollback()` 在 `store.lock` 之下互换 `current` 与 `previous`（先写 `previous`），供没有 home 进程运行时的 `delorun recover --runtime previous` 使用；调用方持有该 profile 的 home 锁。若没有已安装的 `previous`，则以 `NO_PREVIOUS` 失败。与每次指针写入一样，回滚不改变 `runtimes/` 之外的任何文件。

<a id="installing"></a>

## 安装

`install({ version, root, fill })` 在整个安装过程中获取 `store.lock`，并以模式 0700 创建 `staging/<16 hex>/`。`fill` 下载发行包，执行约定 C2 客户端校验的第 1 至第 5 步，将归档解压到该目录，然后返回发布 manifest、文件列表与发布日志（release log）捆绑包。随后仓库执行以下步骤：

1. 以 `root` 校验发布 manifest 与文件列表的 targets 签名，并校验二者描述的是 `version` 与本平台；
2. 按文件列表检查每个暂存条目：普通文件必须与列表中的文件完全一致，其长度与 SHA-256 须相符，且不存在其他类型的条目；
3. 设置安装后的模式（文件为 0444，可执行文件为 0555，目录为 0555），在安装目录旁写入三个发布文件；若为首次安装，还写入 `store.json`；
4. 将同一版本已有的安装副本移出，将暂存目录重命名为 `runtimes/<version>/`，并将其设为 0555；
5. 若为首次安装，且 `current` 缺失或格式错误，则写入 `current`。

任何失败都以 `INSTALL_VERIFY_FAILED` 或底层错误失败，删除暂存目录，并使每个指针与安装保持原状。若 `store.json` 记录的布局不是 1，则以 `RUNTIME_INCOMPATIBLE` 拒绝该仓库。

<a id="retention"></a>

## 保留策略

`retain()` 在切换提交后以及每次启动时运行。它在 `store.lock` 之下保留 `current` 与 `previous` 所记录版本及其发布文件，并删除其他所有安装（先将其移出 `runtimes/`，使其立即不再被视为已安装），连同其发布文件、`staging/` 之下的每个目录，以及被中断写入的临时文件。其他条目保持不动。删除失败时，以 `warn` 级别记录日志，并由下一次运行重试。若无法读取 `current`，则不删除任何内容。

<a id="the-start-check"></a>

## 启动检查

`checkRuntime(version, root)` 以 `root` 校验已存储的发布 manifest 与文件列表，然后将安装内容与列表比对：缺失、被改动、多出或非普通的条目会使其以 `RUNTIME_CHANGED` 失败，并列出至多十个条目及其类型。补救措施为 `reinstall`；若 `previous` 记录的是另一个已安装版本，则还提供 `rollback`。若 root 撤销了为运行时签名所用的 targets 密钥，则与签名无效的情形相同，同样导致检查失败。

`readStoredRoot(home)` 依据约定 C1 的拒绝规则读取 `trust/root.json`，并校验其自身的根签名，但不校验时钟，因为已过期的根不会阻止启动。该根是否源自启动器内嵌的根，由启动器自行校验。

<a id="launching"></a>

## 启动

`prepareLaunch({ launcher, root, mode, profile, args })` 不写入任何内容。它读取 `store.json` 的布局编号、`current`、其已校验 manifest 中的启动协议（launch protocol）编号，并执行启动检查，然后返回启动协议 1 的命令：

- 运行时的 Node 可执行文件，即 `node/bin/node`，在 Windows 上为 `node/node.exe`；
- 参数为 `app/node_modules/@delo/cli/src/bin.js`，其后接 `args`；
- 环境变量 `DSH_HOME` 与 `DELO_HOME` 设为 home，`DELO_PROFILE` 设为 profile。

启动器不支持的布局或协议以 `RUNTIME_INCOMPATIBLE` 失败，并列出两个编号；当运行时为较旧的一方时，补救措施为 `update`，否则为 `launcher-update`。无论启动器比当前运行时更新还是更旧，启动器都不切换 `current`。检查在 `warn`、`enforce` 与 `off` 模式下均会运行，且每次拒绝都会注明模式。`launchCommand(version, profile, args)` 不做检查即生成相同的命令，供已自行运行 `checkRuntime` 的调用方使用。

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `STORE_BUSY` | 30 秒内 `store.lock` 未空闲（约定 C1） |
| `NO_ACTIVE_RUNTIME` | `current` 或 `store.json` 缺失或格式错误，或 `current` 指向的版本未安装（约定 C1） |
| `POINTER_REPLACE_FAILED` | 重试后指针重命名仍然失败；旧指针保持不变（约定 C1） |
| `RUNTIME_INCOMPATIBLE` | 启动器不支持仓库的布局或运行时的启动协议，或运行时缺少该协议所需的文件（约定 C1） |
| `INSTALL_VERIFY_FAILED` | 安装期间签名或文件校验失败（约定 C1） |
| `NO_PREVIOUS` | 请求回滚，但不存在已安装的 `previous`（约定 C19） |
| `RUNTIME_CHANGED` | 启动检查失败；约定 C2 要求停止运行，且未为此规定错误代码 |
| `POINTER_CHANGED` | 切换的 `from` 不是 `current` 所记录的版本 |
| `NOT_INSTALLED` | 指针写入所指向的版本未安装 |

<a id="crash-safety"></a>

## 崩溃安全

`tests/crash.spec.ts` 在切换的十个持久化步骤中每一步之前（为每个指针的临时文件执行创建、写入、刷新与重命名，以及刷新 `runtimes/`），以及最后一步之后，以 `SIGKILL` 终止切换进程。在 `current` 重命名之前，`current` 记录旧版本；之后则记录新版本。每种情况下，它所记录的版本都通过启动检查，并且下一次切换与保留策略都能越过已死亡进程遗留的 `store.lock` 成功完成。同一规格还会在随机时刻十二次终止一个循环切换的进程，结果相同。

<a id="not-covered"></a>

## 未涵盖的范围

- 断电：临时文件与 `runtimes/` 的刷新负责在断电后保住指针，但没有任何规格切断电源。
- 重新安装已安装的版本时，先将旧副本移出，再将新副本重命名进来；进程若在两次重命名之间被终止，该版本将处于未安装状态，启动器会提供重新安装。
- Windows：指针重命名的重试由约定 C1 规定，并以替身重命名进行覆盖；模式会变为只读属性，且规格仅在 Linux 与 macOS 上运行。

<a id="development"></a>

## 开发

规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/runtime-store` 运行，包的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/packages/runtime-store/tsconfig.json` 运行。规格测试使用测试中生成的 Ed25519 密钥，为 fixture（测试前置数据）发行包签名，且只使用临时目录。
