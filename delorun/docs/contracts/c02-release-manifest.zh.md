---
description: "约定 C2：Delorun 发布的文件、已签名的发布 manifest 及其 Ed25519 信封、root、targets、timestamp 与插件索引密钥角色、新鲜度、回滚保护与密钥轮换、targets 密钥持有者在签名前进行的重建、npm 可信发布、依赖安全公告检查，以及桌面回滚规则。"
---

# C2 发布 manifest 与签名

[English](c02-release-manifest.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

每个 Delorun 发布都是 GitHub Releases 上的一组文件，由一份发布 manifest（元数据清单）描述，并由离线的 targets 密钥签名。该 manifest 列出该发布所发布的每个平台的运行时归档、桌面安装程序、S2 与 S3 镜像摘要、SPDX SBOM（软件物料清单）、npm 包与安装脚本，每项都附带其长度与 SHA-256 摘要。一个在线的时间戳密钥签名一个小型时间戳文件，该文件指明每个通道当前的 manifest，并在 3 天后过期，因此扣留某个发布的托管方会在下一次安装、更新或更新检查时被察觉，这些操作会拒绝陈旧的时间戳；启动则使用已有的发布继续。同样离线的根密钥签名每个角色的密钥列表及其每次轮换。targets 密钥持有者只有在一台由自己控制的机器上、于 CI 之外依据发布分支上的已签名标签重建某个公开发布，且该发布的锁文件通过依赖安全公告检查之后，才签名该发布；本地发布（为其自己的通道签名、未经重建）不得使用生产根或生产密钥，从生产发布位置获取内容的启动器会拒绝它。npm 启动器、`delorun update`、每次启动时的启动器与 `delorun verify` 按本页所述验证这些文件，并且还要求具备 [C18](c18-release-log.zh.md) 所定义的该发布的日志条目。类型位于 [`@delorun/contract-release-manifest`](../../packages/contract-release-manifest/README.zh.md)。

<a id="status"></a>

## 状态

客户端验证、启动检查，以及签名、时间戳与安全公告命令已构建；发布工作流、桌面更新器的检查与安装脚本尚未构建。

- **已构建并被调用：** npm 启动器与 `delorun update` 的安装验证（`delorun/apps/install`）、启动器在每次启动时对每个已安装文件的检查（`delorun/packages/runtime-store`）、`delorun verify` 的两项发布检查，以及 `delorun/apps/release/src/` 下的命令：在一致的重建之后签名发布、在不降低任何通道的前提下签名时间戳，以及检查安全公告。
- **尚未构建：** 发布工作流，因此没有 CI 作业和工作流步骤运行安全公告检查或发布到 npm；npm 可信发布；N 个中两个的重建；Authenticode 签名；安装脚本；以及桌面应用的每一项检查，桌面应用是未经改动的上游应用。这些规则见[发布工作流设计](../design/release-workflow.zh.md)与[更新与回滚设计](../design/update-and-rollback.zh.md#the-desktop-app)。
- **部分构建：** 安全公告的接受记录只计入在 `.github/CODEOWNERS` 中以登录名列出的所有者，而该文件只列出一个团队，因此没有任何接受记录有效，每个安全公告都会使检查失败。发行包配方只为 Linux 平台编译上游的原生 system addon，因此 macOS 平台不是发布平台，在配方拥有用于 macOS 二进制文件的固定工具链之前，发布不发布任何 macOS 运行时（[签名前重建](#rebuild-before-signing)）。

下文中被此列表列为尚未构建的要求与拒绝测试，在某次变更构建它们之前不保护任何人。

## 目录

- [状态](#status)
- [发布文件](#release-files)
- [签名信封](#signature-envelope)
- [密钥角色](#key-roles)
- [根元数据](#root-metadata)
- [时间戳元数据](#timestamp-metadata)
- [发布 manifest](#release-manifest)
- [运行时文件列表](#runtime-file-list)
- [客户端验证](#client-verification)
- [新鲜度与回滚保护](#freshness-and-rollback-protection)
- [密钥轮换](#key-rotation)
- [签名前重建](#rebuild-before-signing)
- [依赖安全公告检查](#dependency-advisory-check)
- [npm 发布](#npm-publication)
- [桌面更新与回滚](#desktop-updates-and-rollback)
- [取值与限制](#values-and-limits)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="release-files"></a>

## 发布文件

版本为 `<version>`（Delorun 的语义化版本，不带前导 `v`）的发布，是 Delorun 公开仓库 `https://github.com/twickas/delorun` 的 git 标签 `v<version>`，以及该标签的 GitHub release。平台标识符是以连字符连接的 Node `process.platform` 与 `process.arch`：`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 与 `win32-x64`。发布会发布其配方列为发布平台的那些平台的运行时（该发布提交处 `delorun/apps/release/closure.json` 中的 `platforms`），其 manifest 恰好指明这些平台。配方拒绝列出它无法从带标签的源码构建其原生代码的平台，因此在能够构建之前，`darwin-x64` 与 `darwin-arm64` 不是发布平台；目前的发布平台是 `linux-x64`、`linux-arm64` 与 `win32-x64`。

| 文件 | 内容 |
| --- | --- |
| `delorun-<version>.manifest.json` | 位于签名信封中的发布 manifest。 |
| `delorun-<version>.manifest.log.json` | 该 manifest 的发布日志 bundle（[C18](c18-release-log.zh.md)）。 |
| `delorun-<version>-<platform>.tar.gz` | Linux 或 macOS 平台的运行时发行包（runtime closure）。 |
| `delorun-<version>-win32-x64.zip` | Windows 的运行时发行包。 |
| `delorun-<version>-<platform>.files.json` | 该平台归档的运行时文件列表。 |
| `delorun-<version>.packs.json` | 该发行版的插件包（[插件包](#packs)），在签名信封中；没有插件包的发行版没有此文件。 |
| `delorun-<version>.packs.log.json` | 该 packs 文件的发布日志包（[C18](c18-release-log.zh.md)）。 |
| `delorun-<version>-pack-<name>.<platform or any>.tar.gz` | 一个插件包的归档。 |
| `delorun-<version>.spdx.json` | 覆盖该发布中每个归档、安装程序与镜像，以及编译这些归档原生代码的构建镜像中固定软件包的 SPDX 2.3 JSON SBOM。 |
| `delorun-<version>.rebuild.json` | targets 密钥持有者所做重建的重建记录。 |
| `delorun-<version>.advisories.json` | 依赖安全公告检查的结果。 |
| `install.sh`、`install.ps1` | 本发布的安装脚本。 |
| `Delorun-<version>-mac-arm64.dmg`、`Delorun-<version>-mac-x64.dmg` | macOS 桌面安装程序。 |
| `Delorun-<version>-mac-arm64.zip`、`Delorun-<version>-mac-x64.zip` | electron-updater 所应用的 macOS 桌面更新归档。 |
| `Delorun-<version>-win-x64.exe` | Windows 桌面安装程序（NSIS）。 |
| `*.blockmap` | 桌面文件的 electron-updater 块映射。 |
| `latest.yml`、`latest-mac.yml`（stable）；`beta.yml`、`beta-mac.yml`（beta） | electron-updater 的更新源文件。它们不经签名；桌面应用只信任 manifest。 |

不绑定于单个发布的发布元数据在 `releases.delorun.com` 提供：每个根版本 `n` 的 `root/<n>.root.json`，以及 `timestamp.json`。同一主机还在 `releases/download/v<version>/<file>` 提供每个发布文件。两个镜像提供相同的字节：备用主机 `releases.delo.run` 提供每个文件，该标签的 GitHub release 提供发布文件。只有在前一个主机出现网络故障或 HTTP 状态错误，或返回与已签名引用不符的字节时，客户端才会尝试镜像。这些主机不受信任：每个文件都经过签名，客户端拒绝任何无法通过验证的文件。

<a id="signature-envelope"></a>

## 签名信封

每个签名文件（根、时间戳、manifest、运行时文件列表、[C13](c13-catalogue-revocation.zh.md) 的插件索引文件）都是如下形式的 UTF-8 JSON：

```json
{
  "signed": { "schema": "delorun.release-manifest/1" },
  "signatures": [{ "keyid": "<64 lowercase hex>", "sig": "<base64>" }]
}
```

- 被签名的字节是 `signed` 的 RFC 8785 JSON Canonicalization Scheme 序列化结果。
- 每个签名都是针对这些字节的纯 Ed25519 签名（RFC 8032），采用带填充的标准 base64。
- 密钥的 `keyid` 是其 32 字节原始公钥的小写十六进制 SHA-256。
- `signed.schema` 指明文件种类及其主版本；读取方拒绝它不认识的种类或主版本。
- 当来自该角色当前密钥集中不同密钥的签名达到该角色的阈值时，文件通过验证。来自未知密钥的签名被忽略；重复的密钥只计一次。
- 读取方拒绝 `signed` 中的未知字段、重复的 JSON 键，并在解析之前拒绝超过其大小上限的文件。
- 时间戳是带 `Z` 后缀、精确到整秒的 RFC 3339 UTC 字符串。

<a id="key-roles"></a>

## 密钥角色

| 角色 | 持有方式 | 签名内容 | 阈值 |
| --- | --- | --- | --- |
| `root` | 离线，由所有者持有 | 根元数据：每个角色的密钥与阈值、[C18](c18-release-log.zh.md) 的见证者密钥，以及每次轮换 | 1；维护者持有根密钥后为 N 个中的 2 个 |
| `targets` | 离线，由 targets 密钥持有者持有 | 每份发布 manifest 及其运行时文件列表 | 1 |
| `timestamp` | 在线，由运行时间戳命令的人持有；[发布工作流设计](../design/release-workflow.zh.md)将其放在某个工作流的受保护环境中 | 仅时间戳元数据；它证明新鲜度并按摘要指明 manifest，无法改变 manifest 列出的内容 | 1 |
| `catalogue` | 在线，位于插件索引仓库的发布环境中 | [C13](c13-catalogue-revocation.zh.md) 的插件索引与撤销列表 | 1 |

根私钥与 targets 私钥绝不进入 CI、云服务或发布工作流能够访问的机器。Windows Authenticode、macOS Developer ID 与公证（notarisation）是文件本身的平台签名；manifest 记录已签名文件的摘要，平台签名流程不在本约定范围内。

<a id="root-metadata"></a>

## 根元数据

`root/<n>.root.json`，schema 为 `delorun.release-root/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 整数 ≥ 1 | 根版本 `n`；每次轮换恰好加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 最多在 `issued` 之后 365 天。 |
| `keys` | 由 `keyid` 映射到 `{ "algorithm": "ed25519", "public": <base64 32 bytes> }` 的映射 | 任一角色所指明的每个密钥。 |
| `roles.root`、`roles.timestamp`、`roles.catalogue` | `{ "keyids": [...], "threshold": n }` | 该角色的当前密钥。 |
| `roles.targets` | `{ "keys": [{ "keyid", "status", "lastRelease"? }], "threshold": n }` | `status` 为 `active`、`retired` 或 `revoked`；`retired` 密钥携带 `lastRelease`，即它签名的最后一个 Delorun 版本。 |
| `log` | `{ "origin", "vkey" }` | 发布日志的检查点来源行与验证密钥（[C18](c18-release-log.zh.md)）。 |
| `witnesses` | `{ "keys": [{ "name", "vkey" }], "threshold": n }` | 见证者的验证密钥，以及必须联署的见证者数量（[C18](c18-release-log.zh.md)）。 |

npm 启动器内嵌打包时所带的根版本，不内嵌任何根版本时拒绝每次安装。客户端只有从其信任的最新版本起依次走过 `n + 1, n + 2, …`，才会信任更新的根，其中每个新版本都须以上一版本根密钥的阈值以及其自身根密钥的阈值通过验证。客户端信任的根若已过期，会阻止每次安装与更新，直到更新的根通过验证；它不会阻止启动。根密钥持有者至少在当前版本过期前 30 天签名下一个版本。

<a id="timestamp-metadata"></a>

## 时间戳元数据

`timestamp.json`，schema 为 `delorun.release-timestamp/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 整数 ≥ 1 | 每次签名加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 恰好在 `issued` 之后 3 天（259,200 秒）。 |
| `root` | `{ "version", "sha256" }` | 最新的根版本及其文件摘要。 |
| `channels.stable`、`channels.beta` | `{ "release": <version>, "manifest": FileRef }` | 每个通道当前的发布及其 manifest 文件。 |

时间戳命令 `node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts` 签名它，并拒绝发布分支所提交的 `delorun/release/production-keys.json` 未列出的 timestamp 密钥；生产通道的 cron Worker 每 24 小时用 `delorun/apps/release-channel/src/resign-core.ts` 重新签名时间戳（[发布通道](../../apps/release-channel/README.zh.md)）。重新签名后的时间戳是当前已签名的 JSON，只替换 `version`（下一个）、`issued`（签名前一小时）与 `expires`（上文的有效期），因此根与每个通道条目，无论是否已知，都保持签名时的样子。Worker 拒绝重新签名无法通过最新已存储根验证的时间戳，或低于其高水位线（更低的版本，或指向更低发布的通道）的时间戳，高水位线保存在发布令牌无法写入的存储中。`channels.stable` 指明一个 stable 发布；`channels.beta` 指明一个 beta 发布或一个 stable 发布。时间戳命令拒绝让某个通道指向比上一个时间戳为它指明的版本更低的版本。`FileRef` 为 `{ "name", "length", "sha256" }`：文件名，即匹配 `^[A-Za-z0-9._+-]+$` 且不为 `.` 或 `..` 的单个路径段；以字节计的长度；以及其字节的小写十六进制 SHA-256。

<a id="release-manifest"></a>

## 发布 manifest

`delorun-<version>.manifest.json`，schema 为 `delorun.release-manifest/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 语义化版本 | 本发布的 Delorun 版本。 |
| `dsh` | 语义化版本 | 发布中 `@deepseek-ai/dsh-app-boot` 的 `version`，即上游的版本（[C17](c17-plugin-versions.zh.md)）。 |
| `channel` | `stable` 或 `beta` | 发布所在的通道。 |
| `source` | `{ "repository", "tag", "commit" }` | 公开仓库的 URL（`https://github.com/twickas/delorun`）、`v<version>`，以及该标签指向的 40 位十六进制提交。 |
| `published` | 时间戳 | targets 密钥签名它的时间。 |
| `runtime` | 由平台映射到 `{ "archive": FileRef, "files": FileRef }` 的映射 | 每个运行时归档及其文件列表，恰好覆盖各发布平台且至少一个；没有条目的平台不在该发布中。 |
| `desktop` | 由 `mac-arm64`、`mac-x64`、`win-x64` 映射到 `{ "installer": DesktopFileRef, "update": DesktopFileRef, "blockmap": FileRef }` 的映射 | 桌面文件；`DesktopFileRef` 增加 `sha512`，即 electron-updater 比较的标准 base64 SHA-512。在 Windows 上，安装程序同时也是更新文件。 |
| `images` | `{ "s2": ImageRef, "s3": ImageRef }` | [C9](c09-runtime-supervisor.zh.md) 运行的 Docker 镜像。`ImageRef` 为 `{ "repository", "index": "sha256:<hex>", "platforms": { "linux/amd64": "sha256:<hex>", "linux/arm64": "sha256:<hex>" } }`，并可带可选的 `"seccomp": FileRef`：一个发布文件，存放 [C9](c09-runtime-supervisor.zh.md) 运行该镜像的容器时使用的 seccomp profile。没有它时，容器使用引擎的默认 profile。 |
| `sbom` | 带 `"format": "SPDX-2.3+json"` 的 `FileRef` | 发布的 SBOM。 |
| `npm` | `{ "name", "version", "integrity" }` 的列表 | 发布中的每个 npm 包（`delorun`、`create-delorun`）及其 tarball 的 `sha512-` integrity 字符串。 |
| `install` | `{ "sh": FileRef, "ps1": FileRef }` | 安装脚本；发布说明与 Trust 页面会打印相同的摘要。 |
| `rebuild` | `{ "record": FileRef, "builders": [{ "name", "ci": false }] }` | 重建记录以及进行重建的人（[签名前重建](#rebuild-before-signing)）。 |
| `advisories` | `{ "report": FileRef, "accepted": [advisory ids] }` | 安全公告检查的结果与每个已接受的安全公告。 |
| `security` | 布尔值，可选 | 该发布是否标记为安全修复。读取方把缺失的值视为 `false`。 |
| `summary` | 字符串，可选 | 发布的单行摘要：1 至 200 个 Unicode 码位，不含控制字符（Cc）、格式字符（Cf）、行分隔符（Zl）或段分隔符（Zp），不含孤立的 UTF-16 代理，两端没有空白，因此它在终端与 studio 中都打印为一行纯文本（`isValidSummary`）。读取方把缺失的值视为没有摘要。 |
| `notes` | 文件引用，可选 | 发布说明：发布目录中 1 至 65,536 字节的纯文本文件（`isValidNotes`）：格式正确的 UTF-8，除换行符与制表符外不含控制字符，不含格式字符（Cf）、行分隔符（Zl）或段分隔符（Zp），也不含孤立代理项。读取方把缺失的值视为没有发布说明。更新检查依据此引用验证其长度与 SHA-256 之后，studio 以纯文本显示该文本。 |

签名会把 `security` 与 `summary` 写入每份 manifest，更新通知会把它们与 `version` 和 `dsh` 一起显示；它们位于 targets 签名的 manifest 中，因为时间戳密钥只签名新鲜度。

manifest 不带过期时间：新鲜度由时间戳负责，因此只要其签名密钥仍能验证它，manifest 就一直可用于回滚到其发布。

<a id="runtime-file-list"></a>

## 运行时文件列表

`delorun-<version>-<platform>.files.json`，schema 为 `delorun.release-files/1`，由 targets 密钥签名：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version`、`platform` | 字符串 | 发布与平台。 |
| `files` | `{ "path", "length", "sha256", "mode" }` 的列表 | 解压后归档中的每个常规文件；`path` 为相对路径、以 `/` 分隔且已规范化，`mode` 为 `0644` 或 `0755`。 |

归档中不包含符号链接、硬链接、设备文件或位于其根之外的路径，其条目与列表中的文件完全一致。已安装的列表位于安装旁边、[C1](c01-home-layout.zh.md) 指明的路径下。

<a id="packs"></a>

## 插件包

`delorun-<version>.packs.json`，schema 为 `delorun.release-packs/1`，由 targets 密钥签名，并有它自己的发布日志记录，列出安装本身不携带的插件包。它是一个单独的文件，这样 `delorun.release-manifest/1` 的读取方永远不会遇到它。字段：`version`；`manifest`，即该发行版 manifest 文件的 SHA-256，它把此文件绑定到该发行版；以及 `packs`，一个由 `{ name, version, experimental, variants }` 组成的列表。`variants` 把一个平台（或 `any`）映射到 `{ archive, files, external, peers }`：`peers` 列出该平台的运行时所提供、安装时会链接进插件包的包；归档是带 `sha512` 的 `FileRef`，`files` 像运行时文件列表那样列出每个普通文件，`external` 列出插件包因许可证禁止再分发而不携带的包，每个都带有确切的 `version`、位于 `https://registry.npmjs.org/` 的 tarball `url`、它的 `sha512` 和它的 `length`。插件包、peer 和外部包的名称都是小写的 npm 名称；归档和外部包的 `length` 至多为 512 MiB。客户端只按已签名的名称从发行渠道获取归档，只按已签名的 URL 获取外部包，不跟随任何重定向，并在读到已签名的长度时停止。插件包归档命名为 `delorun-<version>-pack-<name>.<platform or any>.tar.gz`，因此它永远不会被当作运行时归档。安装会封存插件包的目录树（文件为 0444，可执行文件为 0555；目录为 0555），把外部文件的摘要记录在 `trust/runtime-files/packs/<version>/` 之下，启动检查和 `delorun verify` 会对照已签名的列表和该记录，对每个已安装文件计算哈希。

开启一个插件包时，会用已安装发行版的根验证 packs 文件，检查它所指的 SHA-256 是否为已安装 manifest 的，并检查它的日志记录是否通过验证，然后下载其中所列的归档和每个外部包，并拒绝任何长度或摘要不符的文件。在每项检查都通过之前，`packs/<version>/` 之下不会出现任何内容。插件包只为一个发行版安装；更新会在切换之前，为新发行版获取并验证用户已添加的插件包。

<a id="client-verification"></a>

## 客户端验证

安装或更新运行时（npm 启动器、`delorun update`）：

1. 读取受信任的根，并走到时间戳指明的根。
2. 获取 `timestamp.json`；用时间戳角色验证其签名，检查其过期时间，并将其 `version` 与已存储的版本比对。
3. 获取该通道的 manifest；对照时间戳检查其长度与 SHA-256；验证 targets 签名。
4. 获取并验证发布日志 bundle，并运行在线日志检查（[C18](c18-release-log.zh.md)）；没有经过验证的包含证明，安装绝不继续。
5. 当已验证的 manifest 没有本计算机平台的 `runtime` 条目时，以 `PLATFORM_NOT_RELEASED` 拒绝，并指明该平台与发布所列的平台。否则获取该平台的归档与文件列表；解压之前对照 manifest 检查每项的长度与 SHA-256；验证文件列表的 targets 签名。
6. 解压到 `~/.delorun/runtimes/` 之外的暂存目录，对照文件列表检查每个条目，然后按 [C1](c01-home-layout.zh.md) 所述发布该安装。在步骤 1 至 5 通过之前，没有任何文件落入 `~/.delorun/runtimes/` 之下。

CLI 运行时的每次启动时，npm 启动器用它携带的最新根（或者，当某次安装从携带的根走过它时，用已存储的根）验证已存储的 manifest 与文件列表的签名，列出安装内容，并对照列表检查每个已安装文件。缺失、多出或不规则的条目会停止启动。每个列出的文件要么由该安装的身份记录担保，要么被哈希：其长度与 SHA-256 与列表比较，有差异即停止启动。两种停止都提供重新安装或回滚。比启动器携带的最新根更旧的已存储根绝不作为锚点，因此被该根撤销的 targets 密钥，会在使用携带该根的启动器的下一次启动时失败。已存储的发布日志 bundle 缺失的发布无法通过 [C18](c18-release-log.zh.md) 的启动检查：每次经由运行时仓库的安装都会保留它验证过的 bundle。该检查不需要网络，位于启动器与运行时仓库中，并且无论设置了哪种验证模式都会运行，因为启动器不读取模式。由 `delorun update` 启动的发布，以完整哈希作为 [C19](c19-home-process.zh.md) 的第一项健康检查。

- **身份记录。** `trust/runtime-files/delorun-<version>-<platform>.json`，权限为 0600（[C1](c01-home-layout.zh.md#the-home-tree)），只由刚刚哈希或写入其所记录文件的进程在 `store.lock` 下原子地写入。它为每个列出的文件保存一个身份（inode、带文件类型的 mode、大小，以及以纳秒计的修改时间与变更时间）、捕获时间、最近一次哈希每个文件的检查时间，以及它的绑定：schema `delorun.runtime-identity/1`、版本、平台、文件列表与 manifest 的 SHA-256、安装目录的 inode 以及文件系统的 `statfs` 类型。它不带任何密钥，因为每个能写它的进程也能读取同一 home 下的密钥。
- **担保的条件。** 当文件位于安装目录所在的设备上、其身份与记录的身份相同，且该变更时间比记录的捕获时间至少早 2 秒时，文件即被担保；其他任何文件都会被哈希。哈希通过的启动会重写该记录，定时的完整检查也会重写；按请求进行的完整检查（例如 `delorun verify` 的检查）只在记录缺失、未绑定或指明其他身份时才重写它。失败的哈希从不写入它。
- **完整哈希。** 以下情况会哈希每个文件：安装时，每个文件按写入它的字节哈希一次；更新的准备阶段中每个运行时一次，其报告读取方共享该结果；每次 `delorun verify`；最近一次完整检查早于 `DELORUN_RUNTIME_FULL_CHECK_DAYS` 天（默认 7，取值从 0，即每次启动都哈希，到 30）或晚于时钟时；以及记录缺失、无法读取、格式错误、权限宽于 0600、是链接、属于其他用户或绑定到其他任何内容时。
- **普通启动发现不了什么。** 该记录不带密钥，因此以本人权限运行的程序可以改写它，为自己改动过的文件担保，其中包括 Node 可执行文件与 `delorun` 自身的文件；普通启动随后会通过，直到下一次完整哈希。`delorun verify` 与 studio 的“立即检查”（它通过启动器运行）会先哈希每个文件，从而发现改动。
- **变更时间可担保之处。** Linux 上的 ext2、ext3 与 ext4、XFS、Btrfs、F2FS 与 tmpfs，它们的变更时间只由本地内核设置，任何非特权进程都无法把它调回。在其他所有文件系统与平台上，包括 overlayfs、macOS 与 Windows，每次启动都哈希每个文件，且不写入任何记录：无论其各层位于什么文件系统上，overlayfs 都报告它自己的类型。

`delorun verify` 运行相同的检查并报告每项结果（[C15](c15-verification-checks.zh.md)）。[C9](c09-runtime-supervisor.zh.md) 的 Docker 监管器（没有任何随附命令启动它）只运行已验证 manifest 所列的 S2 或 S3 镜像摘要。

<a id="freshness-and-rollback-protection"></a>

## 新鲜度与回滚保护

- 客户端存储它验证过的最高时间戳 `version`，并拒绝更低的版本；相同的 `version` 必须具有完全相同的字节。
- 超过 `expires` 的时间戳会被拒绝。不适用任何时钟容差；拒绝消息会写明过期时间与本地时间，因此错误的时钟可以被看出。
- `delorun update` 只提供新鲜时间戳为该通道指明的发布：摘要与时间戳中该通道条目不同的 manifest 不会被提供。更新通道的 `update.prepare` 也接受运行时仓库（runtime store）中已安装的版本作为其目标，无需时间戳；只有持有启动令牌的调用方才能发送它，`delorun update` 从不指定目标，低于正在运行版本的目标按下文被拒绝。
- 没有本人（the person）的参与，任何内容都不会安装或切换运行时：npm 启动器只安装到空的运行时仓库中，`delorun update` 只在本人确认之后才应用。更新绝不会转到更低的版本：运行时仓库在安装任何内容之前，以 `TARGET_LOWER` 拒绝低于 `current` 所记录版本的目标或通道发布，`delorun update` 拒绝目标低于正在运行发布的报告。`delorun recover rollback` 是唯一的回退途径，回到 `previous` 所记录的版本。只有时间戳签名者把通道移到更低的发布时，通道才会指明它，而时间戳命令拒绝这样做，客户端也拒绝比其已存储的时间戳更旧的时间戳。
- CLI 回滚切换到运行时仓库保留的运行时（[C1](c01-home-layout.zh.md)、[C19](c19-home-process.zh.md)）。
- 陈旧或缺失的时间戳绝不会停止启动；它会阻止安装与更新，并由 `delorun verify` 报告。

<a id="key-rotation"></a>

## 密钥轮换

- 每次轮换都是一个新的根版本，发布在 `root/<n>.root.json`，由上一版本根密钥的阈值及其自身根密钥的阈值签名。
- targets 密钥的状态为 `active`（签名新发布）、`retired`（只验证 `version` 不高于其 `lastRelease` 的 manifest）或 `revoked`（不验证任何内容）。恰好有一个 targets 密钥处于 `active`。
- 例行的 targets 轮换会让旧密钥退役。被泄露的 targets 密钥会被吊销：新的活动密钥在不改动内容的前提下，重新签名仍在提供或为回滚而保留的发布的 manifest 与文件列表，重新签名的文件替换 GitHub Releases 上的旧文件，并获得新的日志条目。
- 没有任何客户端获取已安装发布的重新签名 manifest 与文件列表。若启动器携带一个吊销已安装运行时密钥的根，启动会像遇到错误签名一样无法通过启动检查，并提供该检查的补救措施。
- 时间戳密钥与插件索引密钥通过新的根版本轮换；轮换之后，它们的旧密钥不验证任何内容。

<a id="rebuild-before-signing"></a>

## 签名前重建

只有在其持有者于一台由自己控制的机器上、在 CI 之外、使用已发布的配方从带标签的源码重建该发布，且重建结果与发布工作流的输出一致之后，targets 密钥才会签名该发布。配方、工具链固定版本与比较脚本位于 `delorun/apps/release/`。

可复现性范围：

- 固定的工具链：确切的 Node 发行版本及其分发包摘要、根 `packageManager` 版本的 pnpm，以及编译 `native/system` 下上游原生 system addon 的构建镜像：按摘要指定的 Debian 基础镜像、一个 Debian 快照，以及编译器、链接器、C 库与内核头文件软件包的确切版本，记录在 `delorun/apps/release/toolchain.json` 中；
- `SOURCE_DATE_EPOCH` 设为带标签提交的提交者时间，读取 `CFLAGS` 的编译代码使用 `-ffile-prefix-map=<build root>=.`；上游的原生构建不读取它，其二进制文件不嵌入任何构建路径；
- 确定性归档：条目按路径的字节序排序，所有者与组为 0 且名称为空，模式为 `0644` 或 `0755`，每个 mtime 为 `SOURCE_DATE_EPOCH`，gzip 头的 mtime 为 0 且不含文件名；
- 原生代码：上游原生 system addon 的 `linux-x64` 与 `linux-arm64` 二进制文件在构建镜像中、无网络地从 `native/system` 编译；其他每个原生 addon 都作为预构建文件，取自锁文件按 integrity 固定的 npm tarball；每个发行包所含每个原生文件的 SHA-256 列于 `delorun/apps/release/prebuilt-pins.json`。配方没有用于该 addon macOS 二进制文件的固定工具链：`toolchain.json` 把 `darwin-x64` 与 `darwin-arm64` 标记为 `unbuilt`，`closure.json` 列出 `unbuilt` 平台时，读取配方会失败；
- 发布平台：构建、SBOM、重建记录要求的输出以及签名，恰好覆盖该发布提交处 `closure.json` 所列的平台。构建拒绝该列表未指明的平台，签名拒绝 `runtime` 指明其他平台或遗漏某个平台的 manifest 草稿；
- 比较命令 `node_modules/.bin/tsx delorun/apps/release/src/compare-rebuild.ts <first> <second>`：当两份输出仅在 `delorun/apps/release/rebuild-exceptions.json` 的条目（各附原因）上不同时以 0 退出，出现任何其他差异时以 1 退出。PE 文件在去除其 Authenticode 签名与校验和之后进行比较，这是该文件列出的第一个例外。

签名命令 `node_modules/.bin/tsx delorun/apps/release/src/sign-release.ts` 在 targets 密钥持有者的机器上运行。重建记录 `delorun-<version>.rebuild.json`（schema 为 `delorun.release-rebuild/1`）保存发布版本、提交、配方文件的 SHA-256、构建者的 `name` 与 `ci: false`、工具链版本、每个输出文件的摘要、用于比较的发布工作流运行，以及比较结果。在下列情况下，签名命令会拒绝，并给出指明所需来源的消息（"a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe"）：

- 不存在重建记录，或其比较结果不是一致；
- 记录写明 `ci: true`，或签名命令在设置了 `CI` 或 `GITHUB_ACTIONS` 的情况下运行；
- 重建的输出目录不在签名机器上，或从该目录重新计算的摘要与记录中的不同；
- 记录中的提交与标签的提交不同。

在写入任何内容之前，它在下列情况下同样拒绝：

- 发布提交不是发布分支（`origin/main`，除非 `--release-branch` 指定其他分支）的祖先；
- targets 密钥未列在发布分支所提交的 `delorun/release/production-keys.json` 中；在所有者记录密钥仪式的密钥之前，该登记册不列出任何密钥，因此在此之前签名会停止；
- 发布标签不是其 `tag` 头指明自身的附注标签，或不带可由 `git verify-tag` 用发布分支所提交的 `delorun/release/allowed-signers`（而非工作树中的副本）中所列密钥验证的 SSH 签名；在所有者添加发布签名者的密钥之前，已提交的该文件不列出任何密钥，因此在此之前每个标签都会被拒绝；
- 草稿的 `install.sh` 或 `install.ps1` 不是零长度的占位文件，因为重建比较尚未覆盖安装脚本；
- 某个 `npm` 条目的打包 tarball（发布目录中的 `<name>-<version>.tgz`）缺失，或其 `sha512-` integrity，或其 `package/package.json` 中的名称与版本，与该条目不同。

`local-release.ts` 为它自己的通道目录构建并签名发布，不进行重建，也不进行安全公告检查。其 manifest 把构建者指明为 `local release (no independent rebuild)`；它拒绝其 SHA-256 或根、targets、时间戳密钥 id 列于 `delorun/release/production-keys.json` 的根文件；从生产发布位置获取内容的启动器会拒绝指明该构建者的 manifest，除非以下两点都成立：该版本是 0.x 版本，且验证它的根是预览根（根版本 1，`1.root.json`，SHA-256 为 `e78c076567b1a2e104756409ad6f4a77c9b8caab95a3f38e857a94f82523b746`）。在 `1.0.0` 之前，签名仪式推迟，所以维护者在维护者的电脑上构建并签署 0.x 版本，没有独立重建；`1.0.0` 版本（包括它的预发布版本）、更晚的根下的版本以及其他根下的版本都会被拒绝。本约定的其他所有检查对这种版本照常适用。

签名命令只接受一份重建记录；维护者持有密钥后 N 个中两个构建者的要求见[发布工作流设计](../design/release-workflow.zh.md)，尚未构建。

<a id="dependency-advisory-check"></a>

## 依赖安全公告检查

签名与重建表明的是完整性，而不是锁定的依赖没有已知漏洞。签名之前，签名命令通过 npm 的批量安全公告 API（`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`），对照 GitHub Advisory Database 检查运行时发行包锁文件中的每个包名与版本、其 SBOM 所列的每个已安装包版本以及固定的 pnpm；`check-advisories.ts` 单独运行同一检查。没有任何发布工作流运行它。

当任何严重级别的安全公告影响某个锁定版本且没有有效的接受记录覆盖它、当某条接受记录已失效，或当公告源无法访问或返回格式错误的响应时，检查失败，发布停止。

已接受的安全公告是 `delorun/release/advisory-acceptances.yaml` 中经过评审的条目：

```yaml
acceptances:
  - advisory: GHSA-aaaa-bbbb-cccc
    package: example-package
    range: '>=1.2.0 <1.2.5'
    reason: The vulnerable parser is not reachable from the closure's code paths.
    approver: example-maintainer
    lapsesAfter: 1.3.0
    added: 2026-11-06
```

| 字段 | 含义 |
| --- | --- |
| `advisory` | GHSA id。 |
| `package` | npm 包名。 |
| `range` | 该接受记录覆盖的锁定版本的语义化版本范围。 |
| `reason` | 发布为何可以带着它交付。 |
| `approver` | 批准它的维护者的 GitHub 登录名，即 `delorun/release/` 的一名 CODEOWNERS 所有者。 |
| `lapsesAfter` | 该接受记录覆盖的最后一个 Delorun 版本；之后的发布会使检查失败，直到该条目被续期或移除。 |
| `added` | 添加该条目的日期，`YYYY-MM-DD`。 |

当 id 与包匹配、锁定版本满足 `range`、发布的版本不高于 `lapsesAfter`，且 `approver` 是该发布提交处 `.github/CODEOWNERS` 中以登录名列出的该文件所有者时，接受记录覆盖该安全公告；团队所有者不计入。未知字段与缺失字段会使检查失败。manifest 的 `advisories.accepted` 列出已接受的 id。

<a id="npm-publication"></a>

## npm 发布

`delorun/apps/npm-launcher/src/build.ts` 用给定的发布根打包 `delorun` 包，没有任何发布根时拒绝构建。manifest 记录每个 tarball 的 integrity。启动器没有运行时依赖；`npx` 会在任何 Delorun 检查运行之前运行 npm 提供的启动器，因此 npm 启动器是安装前的信任锚点。启动器在 `DELORUN_LAUNCHER_VERSION` 中把自己的版本告诉它启动的运行时：`delorun setup` 把 `delorun` 命令安装为 `delorun@<that version>`，从不安装 npm 提供的最新版本，`delorun verify` 打印已安装发布的 manifest 为该版本记录的 integrity，供本人与 `npm view delorun@<version> dist.integrity` 比较（[Trust 页面](../guide/safety-and-updates/trust.zh.md)）。没有任何工作流发布它；不使用 npm 令牌、通过 npm 可信发布进行发布的做法见[发布工作流设计](../design/release-workflow.zh.md)。

<a id="desktop-updates-and-rollback"></a>

## 桌面更新与回滚

桌面应用是未经改动的上游应用，Delorun 不构建任何桌面应用。其更新器（`apps/desktop/src/update-coordinator.ts` 中的 `DesktopUpdateCoordinator`）在本人点击时下载并安装每次更新，并拒绝降级（`allowDowngrade` 为 false）。它不检查任何 Delorun 时间戳、manifest 或日志条目，不保留之前的发布，也不提供回滚。验证每次更新并回滚到已签名、已记录日志的发布的桌面应用，其规则见[更新与回滚设计](../design/update-and-rollback.zh.md#the-desktop-app)。

<a id="values-and-limits"></a>

## 取值与限制

| 取值 | 数值 |
| --- | --- |
| 时间戳过期 | `issued` 之后 3 天（259,200 秒） |
| 根过期 | `issued` 之后最多 365 天；下一版本至少在过期前 30 天签名 |
| 阈值 | 每个角色为 1；维护者持有根密钥后，root 变为 N 个中的 2 个 |
| 时钟容差 | 0 秒 |
| 解析前的大小上限 | 根 64 KiB，时间戳 16 KiB，manifest 1 MiB，文件列表 32 MiB，重建记录 1 MiB，安全公告报告 8 MiB |
| 元数据请求超时 | 每个请求 30 秒 |

<a id="consumers"></a>

## 消费方

- `delorun/apps/release/`：构建、比较、检查安全公告并签名。
- `delorun/apps/install/` 与 `delorun/apps/npm-launcher/`：验证并安装。
- `delorun/packages/runtime-store/`：启动检查、切换与回滚。
- `delorun verify`（[C15](c15-verification-checks.zh.md)）、Docker 监管器（Docker supervisor）的镜像检查（[C9](c09-runtime-supervisor.zh.md)），以及插件索引的密钥（[C13](c13-catalogue-revocation.zh.md)）。

<a id="compatibility"></a>

## 兼容性

每个文件的 `schema` 指明其主版本；较旧读取方会误读的变更会增加一个新的主版本，并且只要仍支持只读取旧版本的客户端，发布就会同时发布该文件的两个版本。新的可选字段同样需要新的主版本，因为读取方会拒绝未知字段。可选的 `security` 与 `summary` 字段是在任何发布公开之前加入 `delorun.release-manifest/1` 的，因此不存在拒绝它们的读取方；从第一个公开发布起，新字段需要新的主版本。上游的桌面更新流程、`latest.yml` 更新源与 electron-updater 保持上游发布时的样子。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 根密钥与 targets 密钥离线；时间戳密钥在线，且只签名新鲜度；插件索引密钥只签名 [C13](c13-catalogue-revocation.zh.md) 的文件。
- R2. 时间戳元数据在签发 3 天后过期；客户端拒绝已过期或更旧的时间戳，`delorun update` 不提供时间戳未为该通道指明的 manifest。[发布通道](../../apps/release-channel/README.zh.md)的 cron Worker 每 24 小时重新签名它。因此持有时间戳密钥的人可以让陈旧的发布在 3 天之后仍保持最新，但无法伪造发布：每个通道条目都指明由离线 targets 密钥签名的 manifest，且没有任何签名会把通道移到更低的版本。
- R3. 任何客户端都不会自行降级；本人请求的回滚只能到达已签名、已记录日志的发布。已为 CLI home 构建：没有本人的确认，任何内容都不会安装或切换，运行时仓库以 `TARGET_LOWER` 拒绝低于正在运行版本的更新目标，`delorun update` 拒绝这样的报告，`delorun recover rollback` 只能到达 `previous` 指向的版本（[新鲜度与回滚保护](#freshness-and-rollback-protection)）。
- R4. 轮换通过根版本进行，由旧根与新根的阈值签名；被吊销的 targets 密钥不验证任何内容。
- R5. CLI 启动器在每次启动时，按哈希或按其上次哈希之后记录的身份，对照已签名的文件列表检查每个运行时文件；一个被改动、缺失或多出的文件就会停止启动。每个文件在每个配置的间隔内至少被哈希一次，间隔最长 30 天。
- R6. 桌面应用在每次更新应用之前、在每个平台上，都验证 manifest、文件摘要与日志条目。尚未构建：桌面应用是上游的（[更新与回滚设计](../design/update-and-rollback.zh.md#the-desktop-app)）。
- R7. 没有来自 targets 密钥持有者在 CI 之外的机器上的一致重建记录，签名即拒绝。维护者参与签名后需要 N 个中两个构建者的要求尚未构建（[发布工作流设计](../design/release-workflow.zh.md)）。
- R8. 对于没有有效接受记录的任何安全公告、已失效的接受记录以及无法访问的公告源，安全公告检查都会使发布失败。在发布说明中列出每条接受记录尚未构建。
- R9. 在签名、摘要与日志检查通过之前，没有任何内容落入 `~/.delorun/runtimes/` 之下。带公开摘要的安装脚本尚未构建。
- R10. npm 包只通过带 OIDC 构建证明的可信发布进行发布；工作流中不存在 npm 令牌。尚未构建：没有任何工作流发布它们。
- R11. Windows 运行时发行包中的每个 PE 文件以及桌面应用都带有 Authenticode 签名，manifest 记录已签名文件的摘要。尚未构建。
- R12. 签名拒绝 `dsh` 不是发布提交处 `packages/boot/app-boot/package.json` 的 `version` 的草稿；对于补丁发布（其主版本号与次版本号等于某个更低的、不带预发布后缀的 `v<major>.<minor>.<patch>` 标签的版本），若其上游版本、`docs/persistence-schema.json`、`delorun/packages/update/src/data-records.json` 或所覆盖的面向插件的接口（`delorun/packages/contract-plugin-versions/plugin-interface.json`）与该发布的不同，或其发布提交不再声明某个所覆盖的服务或事件，签名也会拒绝；文件缺失即拒绝。因此安全修复以不停用任何插件的补丁形式交付，移动上游基线的发布至少是一个次版本。对于补丁版本（补丁号大于 0，忽略任何预发布后缀），以下情况签名同样拒绝：某个更早发布标签的提交不是发布提交的祖先；发布提交处的 `delorun/changelog/changelog.json` 缺失或无法读取、未列出某个更早标签的版本，或列出了低于该发布、主次版本相同、没有标签的非预发布版本；以及找不到该主次版本的任何更早发布，除非持有者传入 `--first-of-line`，它声明该发布是这一版本线的第一个发布，并在已有更早发布被打上标签或版本为 `X.Y.0` 时被拒绝。
- R13. 签名拒绝没有 `security` 或 `summary` 的草稿，或摘要不是限制之内的一行纯文本的草稿；读取方同样拒绝这样的 manifest。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 组件 | 它展示的行为 |
| --- | --- | --- |
| `c02-start-stops-on-changed-byte` | `runtime-store` | 已安装运行时文件中一个字节被改动，会停止 CLI 启动，并提供重新安装或回滚。 |
| `c02-start-stops-on-extra-file` | `runtime-store` | 在安装目录下新增一个常规文件会停止启动。 |
| `c02-start-catches-in-place-change` | `runtime-store` | 一个字节被改动、而文件的大小、mode 与修改时间被 `utimes` 恢复时，在身份记录存在的情况下停止启动。 |
| `c02-start-catches-renamed-replacement` | `runtime-store` | 以相同大小、mode 与修改时间的文件重命名覆盖原文件会停止启动。 |
| `c02-start-missing-record-hashes-every-file` | `runtime-store` | 缺失、被截断、无法解析、权限更宽、是链接、属于他人或被重新绑定的记录，会使启动哈希每个文件。 |
| `c02-start-periodic-full-hash` | `runtime-store` | 最近一次完整检查早于间隔或晚于时钟，或间隔为 0，会使启动哈希每个文件。 |
| `c02-verify-always-hashes` | `runtime-store` | 即使每个身份都与记录相符，`delorun verify` 背后的完整检查也会哈希每个文件。 |
| `c02-start-record-forgery-out-of-scope` | `runtime-store` | 被改写为某个已改动文件身份的记录会让启动通过，这是文档所述的限制，而完整检查仍会阻止它。 |
| `c02-update-start-check-catches-in-place-change` | `runtime-store` | 更新对运行中发布及其目标所执行的启动检查，即使在文件大小、权限模式与修改时间已恢复、且身份记录存在的情况下，也会在被改动的字节处停止。 |
| `c02-install-refuses-bad-signature` | `install` | 由 targets 角色之外的密钥签名的 manifest 被拒绝，且 `~/.delorun/runtimes/` 下不出现任何文件。 |
| `c02-install-refuses-tampered-archive` | `install` | SHA-256 与 manifest 不同的归档在解压之前被拒绝。 |
| `c02-refuses-expired-timestamp` | `release`, `install` | 超过 `expires` 一秒的时间戳会阻止更新，并写明过期时间。 |
| `c02-refuses-replayed-timestamp` | `install` | 签名有效、但 `version` 低于已存储版本的时间戳被拒绝。 |
| `c02-refuses-replayed-manifest` | `release`, `install` | 签名有效、但新鲜时间戳未指明的较旧 manifest 不会被提供或安装。 |
| `c02-root-rotation-needs-both-thresholds` | `install` | 只由自身密钥、或只由上一版本密钥签名的新根版本被拒绝。 |
| `c02-revoked-targets-key-verifies-nothing` | `install`, `runtime-store` | 在某个根吊销一个 targets 密钥之后，只由该密钥签名的 manifest 在安装与启动检查中都失败。 |
| `sign-release-refuses-unsigned-tag` | release-chain | 签名拒绝轻量或未签名的发布标签、由 `allowed-signers` 未列出的密钥签名的标签、其标签对象指明另一个标签的标签，并在 allowed-signers 文件不列出任何密钥时拒绝任何标签。 |
| `sign-release-refuses-commit-off-release-branch` | release-chain | 签名拒绝不是发布分支祖先的发布提交，并在分支包含它之后签名。 |
| `sign-release-refuses-install-script` | release-chain | 签名拒绝 `install.sh` 或 `install.ps1` 不是零长度占位文件的草稿。 |
| `sign-release-refuses-unlisted-production-key` | release-chain | 签名拒绝发布分支的 `production-keys.json` 未列出的 targets 密钥，并在其不列出任何密钥时拒绝所有密钥。 |
| `sign-timestamp-refuses-unlisted-production-key` | release-chain | 时间戳命令拒绝发布分支的 `production-keys.json` 未列出的 timestamp 密钥，并在其不列出任何密钥时拒绝所有密钥。 |
| `sign-release-reads-allowed-signers-from-the-release-branch` | release-chain | 只加入工作树 `allowed-signers`、未在发布分支上提交的签名者不能验证标签。 |
| `sign-release-refuses-npm-integrity-mismatch` | release-chain | 签名拒绝其打包 tarball 的 integrity 与条目不同的 `npm` 条目。 |
| `local-release-refuses-production-keys` | release-chain | 本地发布拒绝 `production-keys.json` 所列的根文件或根、targets、时间戳密钥 id，且不写入任何内容。 |
| `c02-start-anchors-on-newest-shipped-root` | release-chain | 由携带的最新根所撤销的 targets 密钥签名的运行时无法通过启动检查，即使已存储的根是列出该密钥的较旧根，且不会启动任何进程。 |
| `c02-production-refuses-local-release` | release-chain | 从生产发布位置获取内容的通道，在安装与更新检查中都会拒绝构建者为 `local release (no independent rebuild)` 的 manifest，除非该版本是在预览根下验证的 0.x 版本；`1.0.0`、`1.0.0-rc.1`、更晚的根和其他根都会拒绝，签名或摘要有误则无论构建者是谁都会拒绝。它自己的通道会安装它。 |
| `c02-setup-installs-pinned-launcher` | release-chain | Setup 按启动器在 `DELORUN_LAUNCHER_VERSION` 中指定的版本安装 `delorun@<version>`，启动器未指定版本时不提供安装。 |
| `c02-rebuild-difference-blocks-signing` | `release` | `compare-rebuild.ts` 在出现 `rebuild-exceptions.json` 之外的差异时以 1 退出，签名步骤停止。 |
| `c02-signing-refuses-without-rebuild` | `release` | 没有重建记录的签名会被拒绝，并给出指明所需来源的消息。 |
| `c02-signing-covers-release-platforms` | `release` | 签名拒绝 `runtime` 指明 `closure.json` 未列出的平台或遗漏其所列平台的草稿；读取 `closure.json` 列出 `unbuilt` 平台的配方会失败；构建拒绝未列出的平台。 |
| `c02-install-refuses-unreleased-platform` | `install` | 在已验证 manifest 未列出的平台上进行的安装或更新，会在日志检查与任何运行时下载之前以 `PLATFORM_NOT_RELEASED` 拒绝，并指明该平台。 |
| `c02-signing-refuses-ci-rebuild` | `release` | 带 `ci: true` 的记录、在设置了 `GITHUB_ACTIONS` 时进行的签名运行，或本地输出目录无法复现其摘要的记录，都会以同一消息被拒绝。 |
| `c02-advisory-fails-release` | `release` | 植入了安全公告 id 的 fixture（测试前置数据）锁文件会使检查失败。 |
| `c02-advisory-acceptance-passes-and-shows` | `release` | 同一锁文件在有匹配的接受记录时通过，组装出的发布说明显示该安全公告及其包、范围、原因、批准者、失效版本与日期。 |
| `c02-advisory-lapsed-acceptance-fails` | `release` | 版本高于接受记录 `lapsesAfter` 的发布会使检查失败。 |
| `c02-advisory-feed-unreachable-fails` | `release` | 拒绝连接的公告源替身会使检查失败。 |
| `c02-summary-control-characters-refused` | update-notice | 含有 ESC（`\u001b`）、换行符或 U+202E 从右到左覆盖字符的摘要，会被 manifest 读取方与签名拒绝。 |
| `c02-summary-too-long-refused` | update-notice | 201 个码位的摘要会被读取方与签名拒绝；200 个码位可以读取。 |
| `c02-security-not-boolean-refused` | update-notice | 为字符串、数字或 `null` 的 `security` 会被读取方与签名拒绝。 |
| `c02-notes-invalid-text-refused` | whats-new | 含有从右到左覆盖字符、转义符、回车符、字节顺序标记或非 UTF-8 字节的发布说明、空的发布说明，以及超过 65,536 字节的发布说明，会被 `isValidNotes`、签名与更新检查拒绝；换行符与制表符可以读取。 |
| `c02-manifest-without-notice-fields-reads` | update-notice | 不带 `security` 与 `summary` 的 manifest 可以读取，其读取方看不到安全标记，也看不到摘要。 |
| `c02-draft-without-notice-fields-refused` | update-notice | 签名拒绝不带 `security` 的草稿以及不带 `summary` 的草稿，且不写入任何内容。 |
| `patch-rule-refuses-base-move` | update-notice | 上游版本与更早发布不同的补丁被拒绝，并指明两个版本以及应改为发布的次版本。 |
| `patch-rule-refuses-draft-base-mismatch` | update-notice | `dsh` 与发布提交处 app-boot 版本不同的草稿被拒绝，无论是否为补丁。 |
| `patch-rule-refuses-persistence-change` | update-notice | `docs/persistence-schema.json` 与更早发布或发布提交处的不同、或在其中缺失的补丁被拒绝。 |
| `patch-rule-refuses-delorun-record-change` | update-notice | `data-records.json` 与更早发布不同的补丁被拒绝。 |
| `patch-rule-refuses-interface-removal` | update-notice | 删去某个所覆盖条目的补丁，或其发布提交不再声明某个所覆盖服务或不再读取某个所覆盖 manifest 字段的补丁，被拒绝。 |
| `patch-rule-refuses-interface-addition` | update-notice | 新增或更改某个所覆盖条目的补丁被拒绝。 |
| `patch-rule-refuses-missing-inventory` | update-notice | 其清单在更早发布或发布提交处缺失或无法读取的补丁被拒绝。 |
| `patch-rule-allows-equal-patch` | update-notice | 与更早发布的基线、数据格式与所覆盖接口都相同的安全修复补丁可以签名，其 manifest 带有 `security: true`。 |
| `patch-rule-skips-new-minor` | update-notice | `0.1.x` 之后的 `0.2.0` 在移动过的上游基线上可以签名。 |
| `patch-rule-ignores-prerelease-tags` | update-notice | 预发布标签不算已有发布，`0.1.3-rc.1` 按 `0.1.3` 检查。 |
| `patch-rule-refuses-patch-without-earlier-release` | update-notice | 没有 `v0.1.x` 发布标签时 `0.1.3` 被拒绝并指明 `--first-of-line`，带上该选项则可以签名；对 `0.2.0` 以及 `v0.1.2` 已打标签时，该选项被拒绝。 |
| `patch-rule-refuses-tag-on-wrong-commit` | update-notice | 被移到不是发布提交祖先的提交上的更早发布标签会导致拒绝。 |
| `patch-rule-refuses-release-missing-from-changelog` | update-notice | 发布提交的 `changelog.json` 未列出其版本的标签、已列出但没有标签的同一次版本的更早版本，或缺失、无法读取的 `changelog.json`，都会导致拒绝。 |
| `c02-summary-lone-surrogate-refused` | update-notice | 含有孤立的高位或低位 UTF-16 代理的摘要会被 manifest 读取方与签名拒绝；代理对可以读取。 |

<a id="what-this-does-not-prove"></a>

### 这些检查不能证明什么

- **补丁的更早发布。** 补丁规则从仓库的标签中找出更早的发布，并用 git 的历史以及发布提交处的 `delorun/changelog/changelog.json`（每个已组装版本的提交记录）交叉核对它们。changelog 记录的是版本而不是提交，因此该检查不能证明更早的标签指向其发布实际所用的提交：被移到另一个祖先提交的标签可以通过。两种来源都写在同一个仓库中，因此 changelog 同样遗漏某个已发布版本的历史可以通过，`--first-of-line` 是持有者的声明，只对照标签与 changelog 检查。记录每个发布提交的公开 manifest 与发布日志不会被查阅。
- **CI 之外的重建。** 签名命令验证：重建记录存在且写明 `ci: false`；签名运行时没有设置 `CI` 或 `GITHUB_ACTIONS` 变量；它在签名机器上根据重建输出重新计算的摘要与记录一致。它无法证明这台机器独立于发布工作流，也无法证明其工具链未被攻破；这取决于 targets 密钥持有人在自己控制的机器上进行重建。
- **安全公告的覆盖范围。** 安全公告检查覆盖运行时发行包 lockfile 中的 npm 包，以及 GitHub Advisory Database 为它们发布的安全公告。它不覆盖锁定的 Node 二进制文件、原生插件的编译器与链接器、S2 与 S3 镜像的系统软件包，也不覆盖桌面应用携带的 Python 与 Office 组件；对于尚无公开安全公告的漏洞，它也无法报告。
- **对时钟的依赖。** 过期检查以客户端的时钟为准。时钟被调慢时，会接受实际已过期的时间戳，因此只要时钟有误，扣留发布的主机就不会被发现；时钟被调快时，会拒绝新的元数据，拒绝信息会写明过期时间与本地时间。
- **启动时的哈希检查。** 启动器能发现已安装运行时中被修改、缺失或多出的文件。以本人自己的权限运行的进程也可以修改启动器、已存储的 root、已存储的 manifest 或身份记录，此时检查会通过；该检查只能发现没有同时修改启动器或记录的篡改，`delorun verify` 也说明了同样的限制（[C15](c15-verification-checks.zh.md)）。
- **与安装的写入处于同一时钟步长内的写入。** 安装在写入每个文件之后立即获取其身份，因此在内核时钟的同一步长内对暂存文件进行写入、并同时恢复其 mode，会保留该身份。只有具备本人自身权限的进程才能写入暂存目录；下一次完整检查会发现该变更。
- **不带变更时间的损坏。** 存储损坏、对块设备的写入或从另一个系统编辑磁盘，可能改变文件的字节而不赋予它新的变更时间。启动不会发现这种情况；下一次完整检查（最晚在配置的间隔之后）与 `delorun verify` 会发现。这是可靠性上的缺口，而不是攻击者的收益，因为攻击者需要 root 或本人自身的权限才能做到。
