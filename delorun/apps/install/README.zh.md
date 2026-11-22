---
description: "Delorun 的安装路径：启动器通过 HTTPS 获取的发布文件、约定 C2 的客户端校验第 1 至 5 步、约定 C18 的 bundle 与在线日志检查，以及把已校验的运行时归档解压到运行时存储的暂存目录。"
---

# @delorun/install

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/install` 是 [`@delorun/npm-launcher`](../npm-launcher/README.zh.md) 的 `delorun` 启动器背后的安装路径。它从约定 C1 列出的主机通过 HTTPS 获取某个发布的文件，在解压任何内容之前逐一校验它们，并把运行时归档写入运行时存储的暂存目录。运行时存储发布此包准备好的内容：这里从不切换 `current`，被拒绝的安装也不会在 `~/.delorun/runtimes/` 下留下任何目录。

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
3. 频道清单：新时间戳指定的摘要与 targets 阈值的签名，以及当有人指定版本时该人的版本号。构建者为 `local release (no independent rebuild)`（`LOCAL_RELEASE_BUILDER`）的清单只有 `local-release.ts` 会写出，它在维护者的电脑上构建并签名，没有第二个构建者重建过它。从约定 C2 的生产发布获取内容、或其根为生产根的通道，只在 `localBuilderAllowed`（`src/local-builder.ts`）成立时才安装这种清单：该版本是 0.x 版本，且验证它的根是预览根，即根版本 1，其 SHA-256 为[信任页](../../docs/guide/safety-and-updates/trust.zh.md#how-releases-are-signed-in-the-preview)所公布的值。1.0 版本（包括 `1.0.0-rc.1`）、更晚的根或其他根会以 `INSTALL_VERIFY_FAILED` 拒绝。这是唯一的例外：每一项签名、摘要、阈值、发布日志、新鲜度和路径检查仍会先运行。
4. 平台的清单文件，需满足清单中的长度与 SHA-256，以及该文件自身的签名。
5. 归档本身，在从磁盘读取时满足清单中的长度与 SHA-256。

`LauncherChannel` 是启动器驱动的组合：`resolve` 命名并校验一个发布，把校验通过的事实记录到 `trust/` 下；`fill` 先删除早先运行留在 `staging/` 中的 `.download-*` 目录（此时持有存储的锁，因此其中没有属于正在进行的安装的目录），再下载该发布的归档与文件清单，将两者对照清单检查，并解压到存储创建的暂存目录。每次下载都受其签名引用给出的长度约束：清单受时间戳所给的长度约束，归档与文件清单受清单所给的长度约束，上限为约定 C1 的限额，发布日志 bundle 的上限为其 64 KiB 限额。`recordInstalled` 记录该发布的检查状态；调用方在存储的安装返回之后才运行它，因此存储拒绝的发布不会留下记录。根、时间戳和校验通过的检查点在校验通过时即被记录，因为即使本次安装在运行时落地之前结束，之后的安装也要按它们核对根链、时间戳与日志。通道把完成的每一步作为 `InstallProgress` 事件（`resolved`、`signature-checked`、`log-checked`，以及带归档签名大小的 `downloading`）通过其 `progress` 选项报告，自身不做任何格式化；`progressLines` 把每个事件以及调用方自己的 `installing` 步骤转换成供人阅读的行，启动器与 `delorun update` 都打印这些行。

<a id="the-release-log"></a>

## 发布日志

未发布 bundle 的发布为 `RELEASE_LOG_FAILED`，不会安装任何内容。`resolve` 通过 `@delorun/release-verify` 的 `checkAndStore` 以 `enforce` 模式运行约定 C18 的检查，启动器的启动与 `delorun verify` 运行的也是这同一个实现：先离线检查 bundle，再对照日志的最新检查点做在线检查，起点是 bundle 携带的检查点或本 home 存储的更新的检查点，并把校验通过的检查点存储到 `trust/checkpoint.json`。哪些应答使发布处于 `unchecked`、哪些使它失败，由该包的 README 说明。检查结果为 `failed` 时以 `RELEASE_LOG_FAILED` 拒绝安装；`unchecked` 的发布凭其签名安装，通道报告带原因的 `log-checked`，以便启动器发出警告（约定 C18 的“各客户端的行为”）。检查自身代码出错时同样以 `RELEASE_LOG_FAILED` 拒绝；`trust/` 下的记录若是链接、属于其他用户、权限宽于 0600 或无法写入，则以 `TRUST_STATE_INVALID` 拒绝。`recordInstalled` 通过 `recordResult` 把结果（`verified`，或带原因的 `unchecked`）写入 `trust/release-log.json`，并保留其他发布的条目；`failed` 的检查不记录任何内容。`log` 选项是检查所读取的传输，或为被信任的根生成传输的函数；启动器传入 `@delorun/release-verify` 的 `tilesTransport`，端点为根的 `log.origin` 所指定的端点，在为本地日志构建的版本中则为本地日志的端点。

<a id="extraction"></a>

## 解压

`extractArchive` 只接受签名文件清单所列的文件，并且要符合清单中的长度、SHA-256 与权限位。每个文件只按写入它的字节计算一次哈希，以其安装权限（0444，可执行文件为 0555）独占创建，并在写入后立即报告其身份，因此运行时存储只需确认该身份，而不必再次读取文件。归档格式禁止的条目类型、清单未列出的路径、会落到暂存目录之外的路径、重复的路径，以及长度或摘要与清单矛盾，都会中止解压；归档缺少清单列出的文件同样中止。暂存目录留给调用方删除，目录之外不会写入任何内容。读取归档的同时，最多 16 个文件（合计至多 64 MiB）同时写入；文件已存在的条目（如在忽略大小写的文件系统上仅大小写不同的两个名称）视为被拒绝的归档，其他无法写入的文件会以 `DOWNLOAD_FAILED` 中止解压，与无法写入的下载相同；拒绝或写入失败时，要等所有写入都结束后才返回，因此调用方删除暂存目录时不会与任何写入竞争。单个文件不单独同步：运行时仓库在把暂存目录移入之前与之后同步仓库目录。`tests/timing/extract-timing.ts` 用真实的发行包为归档读取、带哈希的读取与解压计时。

<a id="what-a-home-remembers"></a>

## home 记住的内容

`trust/` 下的三个文件是安装过程保留的回滚保护，每个都通过临时文件以权限 0600 写入：最近校验通过的根、最近校验通过的时间戳，以及最近校验通过的日志检查点。在这三者之外，`trust/roots/<n>.root.json` 为安装所走过的每个根版本各保存一个文件，最旧的在前。一旦启动器携带的根能走到已存储的根，之后的安装就从已存储的根向前走根链；它拒绝所指根低于已存储根的时间戳，在请求任何根之前拒绝所指根比已存储根多出 `MAX_ROOT_ROTATIONS`（32）个以上的时间戳，并在每个根文件到达时校验它。它拒绝低于已存储版本的时间戳；无法读取的根或时间戳文件，以及这些文件中属于其他用户或权限宽于 0600 的任何一个，都会让安装以 `TRUST_STATE_INVALID` 失败，而不会被替换。检查点与检查状态是 `@delorun/release-verify` 的记录：已存储的检查点让日志受其树约束，无法读取的检查点会被替换，并在检查结果中附带说明，而不会拒绝安装。

已存储的根同时是启动的锚点，因此由 `readStoredRootBytes` 把它读回，并由 `verifyStoredRoot` 按启动器随包携带的根核对它：在启动器携带的某个版本上，存储的根必须正是该根（键与角色一致）。比携带的最新根更旧的存储根（包括比携带的所有根都旧的存储根）不作为锚点：`verifyStoredRoot` 返回携带的最新根，因此被该根撤销的 targets 键会使启动检查失败。比携带的所有根都新的存储根，只有在安装所走过的链能从携带的某个根走到它、且每个版本都由前一个根的键和自身的键共同签名时才被信任；没有携带的根作为起点的根会被拒绝，因此还原或同步留在 `trust/` 下的文件无法成为锚点。除此之外，已存储的根的任何内容都不被直接相信。`readShippedRoots(directory)` 按从旧到新读取启动器的 `roots/<n>.root.json` 文件，目录中没有任何根、跳过某个版本或无法连成链时会被拒绝；`readAnchoredRoot(home, shipped)` 读取 `trust/root.json` 与走过的链并应用 `verifyStoredRoot`，启动器所启动的运行时正是这样为每次更新、回滚与健康检查确定锚点。

<a id="failures"></a>

## 失败

每种拒绝都是 `InstallError`，可用 `isInstallError` 判断：

| 代码 | 含义 |
| --- | --- |
| `DOWNLOAD_REFUSED` | URL 不是 HTTPS、指向约定 C1 列表之外的主机，或跳转到这样的主机 |
| `DOWNLOAD_FAILED` | 连接未建立或停滞、应答不是 200、文件超过限额，或文件无法创建、无法完整写入或无法关闭 |
| `INSTALL_VERIFY_FAILED` | 签名、摘要、长度或版本检查失败 |
| `ARCHIVE_REFUSED` | 归档含有其格式禁止、或签名清单未列出的条目 |
| `RELEASE_LOG_FAILED` | 约定 C18 的 bundle 或在线检查出现了可验证的失败；无法运行的在线检查不算失败 |
| `RELEASE_NOT_OFFERED` | 有人指定的版本不是新时间戳指定的发布 |
| `PLATFORM_NOT_RELEASED` | 已校验的发布没有列出本机平台的运行时；拒绝信息会指出本机平台以及发布所列的平台 |
| `RELEASE_METADATA_INVALID` | 某个发布文件完全无法读取 |
| `TRUST_STATE_INVALID` | `trust/` 下的某个文件无法读取或无法写入 |
| `NO_TRUSTED_ROOT` | 启动器未提供任何根，因此什么都无法校验 |

<a id="development"></a>

## 开发

此包的测试位于 `tests/`，它们用本地字节而非网络来提供所校验的发布。用仓库的 Vitest 配置运行：`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/install`。
