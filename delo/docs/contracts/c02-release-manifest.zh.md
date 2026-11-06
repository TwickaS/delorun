---
description: "约定 C2：Delo 发布的文件、已签名的发布 manifest 及其 Ed25519 信封、root、targets、timestamp 与插件索引密钥角色、新鲜度、回滚保护与密钥轮换、targets 密钥持有者在签名前进行的重建、npm 可信发布、依赖安全公告检查，以及桌面回滚规则。"
---

# C2 发布 manifest 与签名

[English](c02-release-manifest.md) | 中文

## 摘要

每个 Delo 发布都是 GitHub Releases 上的一组文件，由一份发布 manifest（元数据清单）描述，并由离线的 targets 密钥签名。该 manifest 列出每个平台的运行时归档、桌面安装程序、S2 与 S3 镜像摘要、SPDX SBOM（软件物料清单）、npm 包与安装脚本，每项都附带其长度与 SHA-256 摘要。一个在线的时间戳密钥每天重新签名一个小型时间戳文件，该文件指明每个通道当前的 manifest，并在 3 天后过期，因此扣留某个发布的托管方会被察觉。同样离线的根密钥签名每个角色的密钥列表及其每次轮换。targets 密钥持有者只有在一台由自己控制的机器上、于 CI 之外依据带标签的源码重建该发布，且该发布的锁文件通过依赖安全公告检查之后，才进行签名。客户端（npm 启动器、安装脚本、每次启动时的 CLI 启动器、`delorun verify` 与桌面更新器）按本页所述验证这些文件，并且还要求具备 [C18](c18-release-log.zh.md) 所定义的该发布的日志条目。类型位于 [`@delo/contract-release-manifest`](../../packages/contract-release-manifest/README.zh.md)。

## 目录

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

版本为 `<version>`（Delo 的语义化版本，不带前导 `v`）的发布，是 Delo 公开仓库的 git 标签 `v<version>`，以及该标签的 GitHub release。平台标识符是以连字符连接的 Node `process.platform` 与 `process.arch`：`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64` 与 `win32-x64`。

| 文件 | 内容 |
| --- | --- |
| `delorun-<version>.manifest.json` | 位于签名信封中的发布 manifest。 |
| `delorun-<version>.manifest.log.json` | 该 manifest 的发布日志 bundle（[C18](c18-release-log.zh.md)）。 |
| `delorun-<version>-<platform>.tar.gz` | Linux 或 macOS 平台的运行时发行包（runtime closure）。 |
| `delorun-<version>-win32-x64.zip` | Windows 的运行时发行包。 |
| `delorun-<version>-<platform>.files.json` | 该平台归档的运行时文件列表。 |
| `delorun-<version>.spdx.json` | 覆盖该发布中每个归档、安装程序与镜像的 SPDX 2.3 JSON SBOM。 |
| `delorun-<version>.rebuild.json` | targets 密钥持有者所做重建的重建记录。 |
| `delorun-<version>.advisories.json` | 依赖安全公告检查的结果。 |
| `install.sh`、`install.ps1` | 本发布的安装脚本。 |
| `Delo-<version>-mac-arm64.dmg`、`Delo-<version>-mac-x64.dmg` | macOS 桌面安装程序。 |
| `Delo-<version>-mac-arm64.zip`、`Delo-<version>-mac-x64.zip` | electron-updater 所应用的 macOS 桌面更新归档。 |
| `Delo-<version>-win-x64.exe` | Windows 桌面安装程序（NSIS）。 |
| `*.blockmap` | 桌面文件的 electron-updater 块映射。 |
| `latest.yml`、`latest-mac.yml`（stable）；`beta.yml`、`beta-mac.yml`（beta） | electron-updater 的更新源文件。它们不经签名；桌面应用只信任 manifest。 |

不绑定于单个发布的发布元数据，以静态文件形式通过 GitHub Pages 从 `Delo-Run` 的一个仓库在 `releases.delorun.com` 提供：每个根版本 `n` 的 `root/<n>.root.json`，以及 `timestamp.json`。该托管方不受信任：每个文件都经过签名，客户端拒绝任何无法通过验证的文件。

<a id="signature-envelope"></a>

## 签名信封

每个签名文件（根、时间戳、manifest、运行时文件列表、[C13](c13-catalogue-revocation.zh.md) 的插件索引文件）都是如下形式的 UTF-8 JSON：

```json
{
  "signed": { "schema": "delo.release-manifest/1" },
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
| `timestamp` | 在线，位于发布工作流的受保护环境中 | 仅时间戳元数据；它证明新鲜度并按摘要指明 manifest，无法改变 manifest 列出的内容 | 1 |
| `catalogue` | 在线，位于插件索引仓库的发布环境中 | [C13](c13-catalogue-revocation.zh.md) 的插件索引与撤销列表 | 1 |

根私钥与 targets 私钥绝不进入 CI、云服务或发布工作流能够访问的机器。Windows Authenticode、macOS Developer ID 与公证（notarisation）是文件本身的平台签名；manifest 记录已签名文件的摘要，平台签名流程不在本约定范围内。

<a id="root-metadata"></a>

## 根元数据

`root/<n>.root.json`，schema 为 `delo.release-root/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 整数 ≥ 1 | 根版本 `n`；每次轮换恰好加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 最多在 `issued` 之后 365 天。 |
| `keys` | 由 `keyid` 映射到 `{ "algorithm": "ed25519", "public": <base64 32 bytes> }` 的映射 | 任一角色所指明的每个密钥。 |
| `roles.root`、`roles.timestamp`、`roles.catalogue` | `{ "keyids": [...], "threshold": n }` | 该角色的当前密钥。 |
| `roles.targets` | `{ "keys": [{ "keyid", "status", "lastRelease"? }], "threshold": n }` | `status` 为 `active`、`retired` 或 `revoked`；`retired` 密钥携带 `lastRelease`，即它签名的最后一个 Delo 版本。 |
| `log` | `{ "origin", "vkey" }` | 发布日志的检查点来源行与验证密钥（[C18](c18-release-log.zh.md)）。 |
| `witnesses` | `{ "keys": [{ "name", "vkey" }], "threshold": n }` | 见证者的验证密钥，以及必须联署的见证者数量（[C18](c18-release-log.zh.md)）。 |

npm 启动器、安装脚本与桌面应用各自内嵌其构建时最新的根版本。客户端只有从其信任的最新版本起依次走过 `n + 1, n + 2, …`，才会信任更新的根，其中每个新版本都须以上一版本根密钥的阈值以及其自身根密钥的阈值通过验证。客户端信任的根若已过期，会阻止每次安装与更新，直到更新的根通过验证；它不会阻止启动。根密钥持有者至少在当前版本过期前 30 天签名下一个版本。

<a id="timestamp-metadata"></a>

## 时间戳元数据

`timestamp.json`，schema 为 `delo.release-timestamp/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 整数 ≥ 1 | 每次签名加 1。 |
| `issued`、`expires` | 时间戳 | `expires` 恰好在 `issued` 之后 3 天（259,200 秒）。 |
| `root` | `{ "version", "sha256" }` | 最新的根版本及其文件摘要。 |
| `channels.stable`、`channels.beta` | `{ "release": <version>, "manifest": FileRef }` | 每个通道当前的发布及其 manifest 文件。 |

发布工作流的一个定时作业每 24 小时重新签名它，发布工作流在发布一个版本时也会再次签名它。`FileRef` 为 `{ "name", "length", "sha256" }`：文件名、以字节计的长度，以及其字节的小写十六进制 SHA-256。

<a id="release-manifest"></a>

## 发布 manifest

`delorun-<version>.manifest.json`，schema 为 `delo.release-manifest/1`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 语义化版本 | 本发布的 Delo 版本。 |
| `dsh` | 语义化版本 | 发布中 `@deepseek-ai/dsh-app-boot` 的 `version`，即上游的版本（[C17](c17-plugin-versions.md)）。 |
| `channel` | `stable` 或 `beta` | 发布所在的通道。 |
| `source` | `{ "repository", "tag", "commit" }` | 公开仓库的 URL、`v<version>`，以及该标签指向的 40 位十六进制提交。 |
| `published` | 时间戳 | targets 密钥签名它的时间。 |
| `runtime` | 由平台映射到 `{ "archive": FileRef, "files": FileRef }` 的映射 | 每个运行时归档及其文件列表。 |
| `desktop` | 由 `mac-arm64`、`mac-x64`、`win-x64` 映射到 `{ "installer": DesktopFileRef, "update": DesktopFileRef, "blockmap": FileRef }` 的映射 | 桌面文件；`DesktopFileRef` 增加 `sha512`，即 electron-updater 比较的标准 base64 SHA-512。在 Windows 上，安装程序同时也是更新文件。 |
| `images` | `{ "s2": ImageRef, "s3": ImageRef }` | [C9](c09-runtime-supervisor.md) 运行的 Docker 镜像。`ImageRef` 为 `{ "repository", "index": "sha256:<hex>", "platforms": { "linux/amd64": "sha256:<hex>", "linux/arm64": "sha256:<hex>" } }`。 |
| `sbom` | 带 `"format": "SPDX-2.3+json"` 的 `FileRef` | 发布的 SBOM。 |
| `npm` | `{ "name", "version", "integrity" }` 的列表 | 发布中的每个 npm 包（`delorun`、`create-delorun`）及其 tarball 的 `sha512-` integrity 字符串。 |
| `install` | `{ "sh": FileRef, "ps1": FileRef }` | 安装脚本；发布说明与 Trust 页面会打印相同的摘要。 |
| `rebuild` | `{ "record": FileRef, "builders": [{ "name", "ci": false }] }` | 重建记录以及进行重建的人（[签名前重建](#rebuild-before-signing)）。 |
| `advisories` | `{ "report": FileRef, "accepted": [advisory ids] }` | 安全公告检查的结果与每个已接受的安全公告。 |

manifest 不带过期时间：新鲜度由时间戳负责，因此只要其签名密钥仍能验证它，manifest 就一直可用于回滚到其发布。

<a id="runtime-file-list"></a>

## 运行时文件列表

`delorun-<version>-<platform>.files.json`，schema 为 `delo.release-files/1`，由 targets 密钥签名：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version`、`platform` | 字符串 | 发布与平台。 |
| `files` | `{ "path", "length", "sha256", "mode" }` 的列表 | 解压后归档中的每个常规文件；`path` 为相对路径、以 `/` 分隔且已规范化，`mode` 为 `0644` 或 `0755`。 |

归档中不包含符号链接、硬链接、设备文件或位于其根之外的路径，其条目与列表中的文件完全一致。已安装的列表位于安装旁边、[C1](c01-home-layout.md) 指明的路径下。

<a id="client-verification"></a>

## 客户端验证

安装或更新运行时（npm 启动器、安装脚本、`delorun update`）：

1. 读取受信任的根，并走到时间戳指明的根。
2. 获取 `timestamp.json`；用时间戳角色验证其签名，检查其过期时间，并将其 `version` 与已存储的版本比对。
3. 获取该通道的 manifest；对照时间戳检查其长度与 SHA-256；验证 targets 签名。
4. 获取并验证发布日志 bundle，并运行在线日志检查（[C18](c18-release-log.zh.md)）；没有经过验证的包含证明，安装绝不继续。
5. 获取该平台的归档与文件列表；解压之前对照 manifest 检查每项的长度与 SHA-256；验证文件列表的 targets 签名。
6. 解压到 `~/.delo/runtimes/` 之外的暂存目录，对照文件列表检查每个条目，然后按 [C1](c01-home-layout.md) 所述发布该安装。在步骤 1 至 5 通过之前，没有任何文件落入 `~/.delo/runtimes/` 之下。

CLI 运行时的每次启动，在每种验证模式（`warn`、`enforce`、`off`）下，启动器都会用已存储的根验证已存储的 manifest 与文件列表的签名，然后对照列表验证每个已安装文件的长度与 SHA-256。缺失、被改动或多出的常规文件会停止启动，并提供重新安装或回滚。该检查不需要网络，且位于 `@delo/integrity` 之外。

`delorun verify` 运行相同的检查并报告每项结果（[C15](c15-verification-checks.md)）。S2 与 S3 镜像只按已验证 manifest 中的摘要运行（[C9](c09-runtime-supervisor.md)）。

<a id="freshness-and-rollback-protection"></a>

## 新鲜度与回滚保护

- 客户端存储它验证过的最高时间戳 `version`，并拒绝更低的版本；相同的 `version` 必须具有完全相同的字节。
- 超过 `expires` 的时间戳会被拒绝。不适用任何时钟容差；拒绝消息会写明过期时间与本地时间，因此错误的时钟可以被看出。
- 更新提议只来自新鲜的时间戳：摘要与时间戳中该通道条目不同的 manifest，不会作为该通道的发布提供。
- 任何客户端都不会自行转到更低的 Delo 版本。本人（the person）请求的回滚可以安装更早的发布，前提是其 manifest 能以对该发布有效的 targets 密钥通过验证，且其日志条目通过验证（[C18](c18-release-log.zh.md)）；CLI 回滚切换到运行时仓库（runtime store）保留的运行时（[C1](c01-home-layout.md)、[C19](c19-home-process.md)），桌面回滚遵循[桌面更新与回滚](#desktop-updates-and-rollback)。
- 陈旧或缺失的时间戳绝不会停止启动；它会阻止安装与更新，并由 `delorun verify` 报告。

<a id="key-rotation"></a>

## 密钥轮换

- 每次轮换都是一个新的根版本，发布在 `root/<n>.root.json`，由上一版本根密钥的阈值及其自身根密钥的阈值签名。
- targets 密钥的状态为 `active`（签名新发布）、`retired`（只验证 `version` 不高于其 `lastRelease` 的 manifest）或 `revoked`（不验证任何内容）。恰好有一个 targets 密钥处于 `active`。
- 例行的 targets 轮换会让旧密钥退役。被泄露的 targets 密钥会被吊销：新的活动密钥在不改动内容的前提下，重新签名仍在提供或为回滚而保留的发布的 manifest 与文件列表，重新签名的文件替换 GitHub Releases 上的旧文件，并获得新的日志条目。
- 客户端采用一个吊销其已安装运行时密钥的根之后，会获取该发布重新签名的 manifest 与文件列表；在获得它们之前，启动检查会像遇到错误签名一样失败。
- 时间戳密钥与插件索引密钥通过新的根版本轮换；轮换之后，它们的旧密钥不验证任何内容。

<a id="rebuild-before-signing"></a>

## 签名前重建

只有在其持有者于一台由自己控制的机器上、在 CI 之外、使用已发布的配方从带标签的源码重建该发布，且重建结果与发布工作流的输出一致之后，targets 密钥才会签名该发布。配方、工具链固定版本与比较脚本位于 `delo/apps/release/`。

可复现性范围：

- 固定的工具链：确切的 Node 发行版本及其分发包摘要、根 `packageManager` 版本的 pnpm，以及 `native/system` 下原生 addon 的编译器与链接器，记录在 `delo/apps/release/toolchain.json` 中；
- `SOURCE_DATE_EPOCH` 设为带标签提交的提交者时间，编译代码使用 `-ffile-prefix-map=<build root>=.`；
- 确定性归档：条目按路径的字节序排序，所有者与组为 0 且名称为空，模式为 `0644` 或 `0755`，每个 mtime 为 `SOURCE_DATE_EPOCH`，gzip 头的 mtime 为 0 且不含文件名；
- 原生 addon 由固定的工具链构建，或作为预构建文件取用，其 SHA-256 摘要列于 `delo/apps/release/prebuilt-pins.json`；
- 比较命令 `node_modules/.bin/tsx delo/apps/release/src/compare-rebuild.ts <first> <second>`：当两份输出仅在 `delo/apps/release/rebuild-exceptions.json` 的条目（各附原因）上不同时以 0 退出，出现任何其他差异时以 1 退出。PE 文件在去除其 Authenticode 签名与校验和之后进行比较，这是该文件列出的第一个例外。

签名命令 `node_modules/.bin/tsx delo/apps/release/src/sign-release.ts` 在 targets 密钥持有者的机器上运行。重建记录 `delorun-<version>.rebuild.json`（schema 为 `delo.release-rebuild/1`）保存发布版本、提交、配方文件的 SHA-256、构建者的 `name` 与 `ci: false`、工具链版本、每个输出文件的摘要、用于比较的发布工作流运行，以及比较结果。在下列情况下，签名命令会拒绝，并给出指明所需来源的消息（"a rebuild made by the targets-key holder on their own machine, outside CI, with the published recipe"）：

- 不存在重建记录，或其比较结果不是一致；
- 记录写明 `ci: true`，或签名命令在设置了 `CI` 或 `GITHUB_ACTIONS` 的情况下运行；
- 重建的输出目录不在签名机器上，或从该目录重新计算的摘要与记录中的不同；
- 记录中的提交与标签的提交不同。

当维护者持有密钥时，签名需要列出的 N 个构建者中两个构建者的一致重建记录，其中至少一个为 `ci: false`。

<a id="dependency-advisory-check"></a>

## 依赖安全公告检查

签名与重建表明的是完整性，而不是锁定的依赖没有已知漏洞。签名之前，发布工作流通过 npm 的批量安全公告 API（`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`），对照 GitHub Advisory Database 检查运行时发行包锁文件中的每个包名与版本，签名命令会再次运行该检查。

当任何严重级别的安全公告影响某个锁定版本且没有有效的接受记录覆盖它、当某条接受记录已失效，或当公告源无法访问或返回格式错误的响应时，检查失败，发布停止。

已接受的安全公告是 `delo/release/advisory-acceptances.yaml` 中经过评审的条目：

```yaml
acceptances:
  - advisory: GHSA-aaaa-bbbb-cccc
    package: example-package
    range: '>=1.2.0 <1.2.5'
    reason: The vulnerable parser is not reachable from the closure's code paths.
    approver: example-maintainer
    lapsesAfter: 1.3.0
```

| 字段 | 含义 |
| --- | --- |
| `advisory` | GHSA id。 |
| `package` | npm 包名。 |
| `range` | 该接受记录覆盖的锁定版本的语义化版本范围。 |
| `reason` | 发布为何可以带着它交付。 |
| `approver` | 批准它的维护者的 GitHub 登录名，即 `delo/release/` 的一名 CODEOWNERS 所有者。 |
| `lapsesAfter` | 该接受记录覆盖的最后一个 Delo 版本；之后的发布会使检查失败，直到该条目被续期或移除。 |

当 id 与包匹配、锁定版本满足 `range`，且发布的版本不高于 `lapsesAfter` 时，接受记录覆盖该安全公告。未知字段会使检查失败。发布说明列出每个已接受的安全公告及其包、范围、原因、批准者、失效版本，以及添加该条目的提交的日期；manifest 的 `advisories.accepted` 列出它们的 id。

<a id="npm-publication"></a>

## npm 发布

`delorun` 与 `create-delorun` 通过 npm 可信发布，从公开仓库的发布工作流发布：发布作业请求一个 OIDC 令牌（`permissions: id-token: write`），不持有 npm 令牌，npm 会附上一份经 Sigstore 签名的 SLSA 构建证明，写明仓库、工作流文件与提交。manifest 记录每个 tarball 的 integrity。启动器没有运行时依赖；`npx` 会在任何 Delo 检查运行之前运行 npm 提供的启动器，因此 npm 启动器是安装前的信任锚点，Trust 页面也这样说明。

<a id="desktop-updates-and-rollback"></a>

## 桌面更新与回滚

桌面应用在 Delo 的更新源上保留上游的更新流程（`apps/desktop/src/update-coordinator.ts` 中的 `DesktopUpdateCoordinator`：下载与安装都在本人点击时进行，`allowDowngrade` 为 false），并增加以下内容：

- 在 `install` 把下载内容交给 electron-updater 的 `quitAndInstall` 之前，应用会验证新鲜的时间戳、manifest 的签名、下载文件的 SHA-512 与 SHA-256 是否与 manifest 的 `desktop` 条目一致，以及 manifest 的日志条目（[C18](c18-release-log.zh.md)）。任何一项失败都会拒绝安装，并使正在运行的版本保持不变。
- 更新应用之后，应用会在其更新缓存目录中保留被替换发布的安装程序或更新归档，并已对照该发布的 manifest 验证。缓存恰好保留一个之前的发布。
- 更新源拒绝自动降级：所指明版本低于或等于正在运行版本的更新源不提供任何内容。
- 本人请求的回滚会安装缓存中的上一个发布，或本人指定、从 GitHub Releases 下载的更早发布。目标必须验证为已签名（manifest 与文件摘要）且已记录日志（包含证明）；未签名、未记录日志或不一致的目标会被拒绝。安装之后，profile 会从历史中恢复（[C3](c03-update-report.md)）。

<a id="values-and-limits"></a>

## 取值与限制

| 取值 | 数值 |
| --- | --- |
| 时间戳过期 | `issued` 之后 3 天（259,200 秒） |
| 时间戳重新签名 | 每 24 小时一次，以及每次发布时 |
| 根过期 | `issued` 之后最多 365 天；下一版本至少在过期前 30 天签名 |
| 阈值 | 每个角色为 1；维护者持有根密钥后，root 变为 N 个中的 2 个 |
| 时钟容差 | 0 秒 |
| 桌面更新缓存 | 1 个之前的发布 |
| 解析前的大小上限 | 根 64 KiB，时间戳 16 KiB，manifest 1 MiB，文件列表 32 MiB，重建记录 1 MiB，安全公告报告 8 MiB |
| 元数据请求超时 | 每个请求 30 秒 |

<a id="consumers"></a>

## 消费方

- `delo/apps/release/`（WP3.1）：构建、比较、检查安全公告、签名并发布。
- `delo/apps/install/` 与 `delo/apps/npm-launcher/`（WP3.2）：验证并安装。
- `delo/packages/runtime-store/`（WP3.3）：启动检查、切换与回滚。
- 桌面更新器（WP6.3）：经验证的更新与回滚。
- `@delo/integrity` 与 `delorun verify`（[C15](c15-verification-checks.md)）、Docker 监管器（Docker supervisor）的镜像检查（[C9](c09-runtime-supervisor.md)），以及插件索引的密钥（[C13](c13-catalogue-revocation.zh.md)）。

<a id="compatibility"></a>

## 兼容性

每个文件的 `schema` 指明其主版本；较旧读取方会误读的变更会增加一个新的主版本，并且只要仍支持只读取旧版本的客户端，发布就会同时发布该文件的两个版本。新的可选字段同样需要新的主版本，因为读取方会拒绝未知字段。上游的桌面更新流程、`latest.yml` 更新源与 electron-updater 保持上游发布时的样子；manifest 检查加在安装之前，因此仅凭上游的更新源文件永远不会安装任何内容。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 根密钥与 targets 密钥离线；时间戳密钥在线，且只签名新鲜度；插件索引密钥只签名 [C13](c13-catalogue-revocation.zh.md) 的文件。
- R2. 时间戳元数据在签发 3 天后过期，并每 24 小时重新签名；客户端拒绝已过期或更旧的时间戳，时间戳未为该通道指明的 manifest 不会被提供。
- R3. 任何客户端都不会自行降级；本人请求的回滚只能到达已签名、已记录日志的发布。
- R4. 轮换通过根版本进行，由旧根与新根的阈值签名；被吊销的 targets 密钥不验证任何内容。
- R5. CLI 启动器在每次启动时、在每种验证模式下，都对照已签名的文件列表检查每个运行时文件；一个被改动、缺失或多出的文件就会停止启动。
- R6. 桌面应用在每次更新应用之前、在每个平台上，都验证 manifest、文件摘要与日志条目。
- R7. 没有来自 targets 密钥持有者在 CI 之外的机器上的一致重建记录，签名即拒绝；维护者参与签名后，需要 N 个中的两个构建者，其中至少一个在 CI 之外。
- R8. 对于没有有效接受记录的任何安全公告、已失效的接受记录以及无法访问的公告源，安全公告检查都会使发布失败；发布说明显示每条接受记录。
- R9. 在签名、摘要与日志检查通过之前，没有任何内容落入 `~/.delo/runtimes/` 之下；安装脚本的摘要会公开发布，脚本在安装之前验证运行时发行包。
- R10. npm 包只通过带 OIDC 构建证明的可信发布进行发布；工作流中不存在 npm 令牌。
- R11. Windows 运行时发行包中的每个 PE 文件以及桌面应用都带有 Authenticode 签名，manifest 记录已签名文件的摘要。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 负责方 | 它展示的行为 |
| --- | --- | --- |
| `c02-start-stops-on-changed-byte` | WP3.3 | 已安装运行时文件中一个字节被改动，会在 `warn`、`enforce` 与 `off` 下停止 CLI 启动，并提供重新安装或回滚。 |
| `c02-start-stops-on-extra-file` | WP3.3 | 在安装目录下新增一个常规文件会停止启动。 |
| `c02-install-refuses-bad-signature` | WP3.2 | 由 targets 角色之外的密钥签名的 manifest 被拒绝，且 `~/.delo/runtimes/` 下不出现任何文件。 |
| `c02-install-refuses-tampered-archive` | WP3.2 | SHA-256 与 manifest 不同的归档在解压之前被拒绝。 |
| `c02-refuses-expired-timestamp` | WP3.1, WP3.2, WP6.3 | 超过 `expires` 一秒的时间戳会阻止更新，并写明过期时间。 |
| `c02-refuses-replayed-timestamp` | WP3.2, WP6.3 | 签名有效、但 `version` 低于已存储版本的时间戳被拒绝。 |
| `c02-refuses-replayed-manifest` | WP3.1, WP3.2, WP6.3 | 签名有效、但新鲜时间戳未指明的较旧 manifest 不会被提供或安装。 |
| `c02-root-rotation-needs-both-thresholds` | WP3.2 | 只由自身密钥、或只由上一版本密钥签名的新根版本被拒绝。 |
| `c02-revoked-targets-key-verifies-nothing` | WP3.2, WP3.3 | 在某个根吊销一个 targets 密钥之后，只由该密钥签名的 manifest 在安装与启动检查中都失败。 |
| `c02-desktop-refuses-bad-manifest` | WP6.3 | manifest 签名失败、或下载文件的 SHA-512 与 manifest 不同的桌面更新，会在 `quitAndInstall` 之前被拒绝。 |
| `c02-desktop-refuses-unrequested-downgrade` | WP6.3 | 指明更低版本的更新源不提供更新。 |
| `c02-desktop-rollback-signed-logged` | WP6.3 | 请求回滚到已签名、已记录日志的更早发布时，回滚会被应用，并从历史中恢复 profile。 |
| `c02-desktop-rollback-refuses-unsigned-or-unlogged` | WP6.3 | 请求回滚到没有可验证 manifest、或没有已验证日志条目的发布时，回滚被拒绝。 |
| `c02-rebuild-difference-blocks-signing` | WP3.1 | `compare-rebuild.ts` 在出现 `rebuild-exceptions.json` 之外的差异时以 1 退出，签名步骤停止。 |
| `c02-signing-refuses-without-rebuild` | WP3.1 | 没有重建记录的签名会被拒绝，并给出指明所需来源的消息。 |
| `c02-signing-refuses-ci-rebuild` | WP3.1 | 带 `ci: true` 的记录、在设置了 `GITHUB_ACTIONS` 时进行的签名运行，或本地输出目录无法复现其摘要的记录，都会以同一消息被拒绝。 |
| `c02-advisory-fails-release` | WP3.1 | 植入了安全公告 id 的 fixture（测试前置数据）锁文件会使检查失败。 |
| `c02-advisory-acceptance-passes-and-shows` | WP3.1 | 同一锁文件在有匹配的接受记录时通过，组装出的发布说明显示该安全公告及其包、范围、原因、批准者、失效版本与日期。 |
| `c02-advisory-lapsed-acceptance-fails` | WP3.1 | 版本高于接受记录 `lapsesAfter` 的发布会使检查失败。 |
| `c02-advisory-feed-unreachable-fails` | WP3.1 | 拒绝连接的公告源替身会使检查失败。 |
| `c02-npm-publish-has-no-token` | WP3.2 | 当 npm 发布作业引用 npm 令牌或缺少 `id-token: write` 时，工作流 lint 失败。 |
| `c02-pe-files-signed` | WP3.1 | `signtool verify /pa` 在 Windows 运行时发行包中的每个 PE 文件上都通过。 |
