---
description: "@delorun/runtime-store 库：约定 C1 在 ~/.delorun/runtimes 下的运行时仓库，其 current 与 previous 指针通过原子重命名切换，并使用 store.lock、从暂存目录安装、保留策略、回滚，以及约定 C2 对每个已安装文件的启动检查。"
---

# @delorun/runtime-store

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包是 [约定 C1](../../docs/contracts/c01-home-layout.zh.md#the-runtime-store) 所定义运行时仓库（runtime store）的唯一实现。它将经过校验的运行时发行包（runtime closure）安装到 `~/.delorun/runtimes/<version>/` 之下，以原子重命名切换 `current` 与 `previous` 指针文件，使切换过程中被终止的进程只会留下一个完整的当前版本；它保留上一版本以供回滚，并删除其余版本。每次启动 CLI 运行时之前，它都会执行[约定 C2](../../docs/contracts/c02-release-manifest.zh.md#client-verification)的启动检查，以可信根校验已存储的发布 manifest 与文件列表，并在每种校验模式下校验每个已安装文件的长度与 SHA-256。签名由 [`@delorun/release`](../../apps/release/README.zh.md) 的 C2 校验器校验。

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
import { RuntimeStore, SUPPORTED } from '@delorun/runtime-store'

const store = new RuntimeStore({ home, platform: 'linux-x64', logger })
const plan = await store.prepareLaunch({ launcher: SUPPORTED, root: anchoredRoot, mode: 'warn', profile: 'default', args })
```

`home` 是来自 [`@delorun/home`](../home/README.zh.md) 的已解析 Delorun home，`anchoredRoot` 是 `trust/root.json` 所保存、并已锚定在启动器携带的根上的根（[启动检查](#the-start-check)），`platform` 是本机的运行时平台（C2 的 `process.platform` 与 `process.arch` 以连字符相连），`logger` 是供保留策略记录失败的 [`@delorun/logs`](../logs/README.zh.md) 日志器。每个失败都是一个 `RuntimeStoreError`，携带 `code`、其涉及的 `path`、`detail`，以及启动器提供的 `remedies`。

<a id="pointers-and-switching"></a>

## 指针与切换

`pointers()` 完整读取 `current` 与 `previous`。若 `current` 缺失、为空、超过 65 字节、内容不是恰好一个版本号加换行符、是符号链接，或其版本没有已安装目录，则以 `NO_ACTIVE_RUNTIME` 失败；`previous` 若属于上述任一情况，则读作不存在。

- **写入指针。** 新值写入 `<pointer>.tmp-<16 hex>`，以模式 0600 独占创建并刷新，然后重命名覆盖该指针；在 Linux 与 macOS 上随后刷新 `runtimes/`。在 Windows 上，若重命名报告 `EPERM`、`EBUSY` 或 `EACCES`，则最多重试 2,000 ms，之后以 `POINTER_REPLACE_FAILED` 失败，并保留旧指针。
- **`switchTo(from, to)`** 获取 `store.lock`，要求 `current` 记录的版本为 `from`（否则为 `POINTER_CHANGED`），并要求 `to` 已安装（否则为 `NOT_INSTALLED`），然后以 `from` 写入 `previous`，以 `to` 写入 `current`。它不删除任何内容。
- **`restore(before)`** 将两个指针写回更新前读取的值，先写 `previous`；若 `previous` 原先不存在，则将其删除。
- **`store.lock`** 保存 `{"v":1,"pid":…,"id":…}`，模式为 0600，在平台提供时还包含持有者的 `processStart` 与 `pidNamespace`；它就是 `@delorun/home` 的 `LockFile`：通过硬链接整体创建，不含这两个字段的记录同样可读。遇到存活的持有者时等待 30 秒，之后以 `STORE_BUSY` 失败；按 `@delorun/home` 的 `holderAlive` 判断持有者已不存活（其进程已退出，或另一个进程现在使用其进程 id；处于另一个 pid 命名空间的持有者视为存活）的锁，则在以其随机 id 命名的接管守卫之下删除。

<a id="rollback"></a>

## 回滚

仓库自身不提供回滚：每条回退路径都读取更新记录，并通过 `@delorun/update` 唯一的回滚函数应用[约定 C3](../../docs/contracts/c03-update-report.zh.md#rollback) 的回滚表，该函数按调用方的路径通过 `switchTo` 或 `restore` 切换指针。指针写入（包括回滚的写入）不改变 `runtimes/` 之外的任何文件。`NO_PREVIOUS` 代码保留在启动器的拒绝表中，没有任何仓库操作会产生它。

<a id="installing"></a>

## 安装

`install({ version, root, fill })` 在整个安装过程中获取 `store.lock`，并以模式 0700 创建 `staging/<16 hex>/`。`fill` 下载发行包，执行约定 C2 客户端校验的第 1 至第 5 步，将归档解压到该目录，然后返回发布 manifest、文件列表与发布日志（release log）捆绑包，并可在按与列表相符的字节写入每个文件之后报告该文件的身份（`staged`）。随后仓库执行以下步骤：

1. 以 `root` 校验发布 manifest 与文件列表的 targets 签名，并校验二者描述的是 `version` 与本平台；
2. 设置安装后的模式（文件为 0444，可执行文件为 0555，目录为 0555），已具有该模式的文件保持不动；
3. 按文件列表检查每个暂存条目：普通文件必须与列表中的文件完全一致，其长度与 SHA-256 须相符，且不存在其他类型的条目。在可信任变更时间的地方，fill 针对同一文件列表报告过、且 `lstat` 仍显示其身份的文件不再重新读取；仓库会先等到最新报告的变更时间已过去 2 秒，使它写入的记录能为每个文件担保；
4. 在安装目录旁写入三个发布文件；若为首次安装，还写入 `store.json`；
5. 将同一版本已有的安装副本移出，将暂存目录重命名为 `runtimes/<version>/`，将其设为 0555，并在可信任变更时间的地方写入其身份记录；
6. 若为首次安装，且 `current` 缺失或格式错误，则写入 `current`。

任何失败都以 `INSTALL_VERIFY_FAILED` 或底层错误失败，删除暂存目录，并使每个指针与安装保持原状。若 `store.json` 记录的布局不是 1，则以 `RUNTIME_INCOMPATIBLE` 拒绝该仓库。

<a id="retention"></a>

## 保留策略

`retain()` 在切换提交后以及每次启动时运行。它在 `store.lock` 之下保留 `current` 与 `previous` 所记录版本及其发布文件与身份记录，并删除其他所有安装（先将其移出 `runtimes/`，使其立即不再被视为已安装），连同其发布文件与身份记录、`staging/` 之下的每个目录，以及被中断写入的临时文件。其他条目保持不动。删除失败时，以 `warn` 级别记录日志，并由下一次运行重试。若无法读取 `current`，则不删除任何内容。

<a id="the-start-check"></a>

## 启动检查

`checkRuntime(version, root)` 是完整检查：它以 `root` 校验已存储的发布 manifest 与文件列表，然后不论身份记录如何，都按列表对安装中的每个文件计算哈希并比对：缺失、被改动、多出或非普通的条目会使其以 `RUNTIME_CHANGED` 失败，并列出至多十个条目及其类型。补救措施为 `reinstall`；若 `previous` 记录的是另一个已安装版本，则还提供 `rollback`。若 root 撤销了为运行时签名所用的 targets 密钥，则与签名无效的情形相同，同样导致检查失败。检查通过时，仅当记录缺失、未绑定或记录的是另一身份，才在 `store.lock` 之下重写身份记录（不等待锁），因此对完好运行时的检查不写入任何内容。`delorun verify` 与回滚的报告使用它。`startCheckRuntime(version, root, fullCheckDays)` 对任一已安装版本运行 `prepareLaunch` 所运行的启动检查，使用相同的记录、间隔与失败；更新在打开通道之前对正在运行的版本、在准备阶段对已安装的目标、在后继进程启动之前的 `HomeRuntimeStore.checkLaunch` 中以及健康检查的 H1 中使用它。`shareChecks(work)` 运行一段工作，其中对同一版本的各项检查以及该版本的安装共享一次文件检查，`HomeRuntimeStore` 在更新的准备阶段与回滚的报告中使用它：启动检查共享该版本先前的任一检查，完整检查只共享完整检查或安装。

`prepareLaunch` 运行的启动检查读取安装的身份记录，即模式为 0600 的 `trust/runtime-files/delorun-<version>-<platform>.json`（`identity.ts`）。当安装位于其变更时间只由本地内核设置的文件系统上（Linux 上的 ext2 至 ext4、XFS、Btrfs、F2FS 或 tmpfs），记录绑定于本版本、平台、文件列表、manifest、安装目录与文件系统，且其最近一次完整检查距今不足 `fullCheckDays` 天时，启动只列出安装内容，并仅对身份与记录不同、设备不是安装所在设备、或变更时间距记录的捕获时间不足 2 秒的文件计算哈希。否则运行完整检查。计算过哈希并通过的启动会在 `store.lock` 之下（不等待锁）重写记录；失败的启动保留原记录。[启动检查设计](../../docs/design/start-check.zh.md)说明了身份比对能检测和不能检测的内容。

`resolveFullCheckDays(text)` 根据启动器的 `DELORUN_RUNTIME_FULL_CHECK_DAYS` 解析该间隔：0 至 30 的整天数，未设置时为 7，其他值均报错。

仓库自身从不读取 `trust/root.json`：它用来校验的每个根都由调用方提供，并锚定在启动器携带的发布根上。启动器为自己的启动锚定根；home 进程的 `HomeRuntimeStore` 接受一个 `TrustedRootSource`（其选项中的 `root`），CLI 将其锚定在启动器于 `DELORUN_LAUNCHER_ROOTS` 中指定的根上，进程若不是由启动器启动则以 `ROOT_NOT_ANCHORED` 拒绝，因此不会在同一用户的进程可能替换过的根之下安装更新或开始回滚。不读取时钟：已过期的根不会阻止启动。

<a id="launching"></a>

## 启动

`prepareLaunch({ launcher, root, mode, fullCheckDays, profile, args })` 除身份记录外不写入任何内容。它读取 `store.json` 的布局编号、`current`、其已校验 manifest 中的启动协议（launch protocol）编号，并执行启动检查，然后返回启动协议 1 的命令：

- 运行时的 Node 可执行文件，即 `node/bin/node`，在 Windows 上为 `node/node.exe`；
- 参数为 `app/node_modules/@delorun/cli/src/bin.js`，其后接 `args`；
- 环境变量 `DSH_HOME` 与 `DELORUN_HOME` 设为 home，`DELORUN_PROFILE` 设为 profile。

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
| `ROOT_NOT_ANCHORED` | `TrustedRootSource` 无法把 `trust/root.json` 锚定在启动器携带的根上：进程不是由启动器启动、其根无法读取，或没有任何根能走到已存储的根 |
| `TARGET_LOWER` | 更新的准备阶段指定的目标，或通道解析出的版本，低于 `current` 所记录的版本；没有安装任何内容，`delorun recover rollback` 是唯一的回退途径 |

<a id="crash-safety"></a>

## 崩溃安全

`tests/crash.integration.spec.ts` 在切换的十个持久化步骤中每一步之前（为每个指针的临时文件执行创建、写入、刷新与重命名，以及刷新 `runtimes/`），以及最后一步之后，以 `SIGKILL` 终止切换进程。在 `current` 重命名之前，`current` 记录旧版本；之后则记录新版本。每种情况下，它所记录的版本都通过启动检查，并且下一次切换与保留策略都能越过已死亡进程遗留的 `store.lock` 成功完成。同一规格还会在随机时刻十二次终止一个循环切换的进程，结果相同。

<a id="not-covered"></a>

## 未涵盖的范围

- 断电：临时文件与 `runtimes/` 的刷新负责在断电后保住指针，但没有任何规格切断电源。
- 重新安装已安装的版本时，先将旧副本移出，再将新副本重命名进来；进程若在两次重命名之间被终止，该版本将处于未安装状态，启动器会提供重新安装。
- Windows：指针重命名的重试由约定 C1 规定，并以替身重命名进行覆盖；模式会变为只读属性，且规格仅在 Linux 与 macOS 上运行。

<a id="development"></a>

## 开发

规格测试用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/runtime-store` 运行，包的类型检查用 `node_modules/.bin/tsc --noEmit -p delorun/packages/runtime-store/tsconfig.json` 运行。规格测试使用测试中生成的 Ed25519 密钥，为 fixture（测试前置数据）发行包签名，且只使用临时目录。
