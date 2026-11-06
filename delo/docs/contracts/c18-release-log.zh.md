---
description: "约定 C18：每个 Delo 发布 manifest 如何记录在 Sigstore 的公开 Rekor 日志中、客户端对其检查点所要求的见证者共同签名、发布日志 bundle 的格式、启动器、delorun verify 与桌面更新器如何检查包含关系，以及没有网络时的启动如何进行。"
---

# C18 发布日志与见证者

[English](c18-release-log.md) | 中文

## 摘要

[C2](c02-release-manifest.zh.md) 的每个已签名发布 manifest（元数据清单）在 Sigstore 的公开 Rekor 日志中都有一个条目；Rekor 是一个仅追加的透明日志，不由 Delo 运营。Rekor 为其树的检查点签名，公共见证网络中的一个独立见证者为这些检查点共同签名，因此，如果日志向一个客户端展示的历史与向另一个客户端展示的不同，见证者就会发现。每个发布版本都会发布一个 bundle，其中包含该条目、它的包含证明和一个经见证的检查点。客户端拒绝没有有效见证者共同签名的条目。安装发布版本始终需要经过验证的包含证明；没有网络时的启动会带着一条指明未检查发布版本的警告启动，并在下次连接时检查。类型位于 [`@delo/contract-release-log`](../../packages/contract-release-log/README.zh.md)。

## 目录

- [日志与见证者](#the-log-and-the-witness)
- [日志条目](#log-entry)
- [发布日志 bundle](#release-log-bundle)
- [验证 bundle](#verifying-a-bundle)
- [与当前日志的一致性](#consistency-with-the-current-log)
- [检查状态](#check-states)
- [各客户端的行为](#behaviour-per-client)
- [取值与限制](#values-and-limits)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="the-log-and-the-witness"></a>

## 日志与见证者

- 日志是 Sigstore 的公开 Rekor 实例。它的检查点 origin 行与检查点验证密钥位于根元数据的 `log` 字段中（[C2](c02-release-manifest.zh.md#root-metadata)），因此只能通过根轮换改变。
- 检查点使用 C2SP signed-note 格式（`tlog-checkpoint`）；见证者共同签名使用 C2SP `tlog-cosignature`（`cosignature/v1`），其签名消息包含共同签名时间。
- 见证者以公共见证网络中各见证者的密钥表示，列在根元数据的 `witnesses.keys` 中，`witnesses.threshold` 为 1：至少 1 个所列见证者为某个检查点共同签名时，该检查点即为经见证。Delo 不运营其中任何一个。
- 除其发布 manifest 与重新签名的 manifest 的条目外，Delo 不向该日志发布任何内容。

<a id="log-entry"></a>

## 日志条目

每个已签名的 manifest 文件对应一个条目，由发布工作流在 targets 密钥签名之后、发布版本发布之前写入：

| 条目字段 | 值 |
| --- | --- |
| 类型 | `hashedrekord` |
| 制品摘要 | manifest 文件字节（整个信封）的 SHA-256 |
| 签名 | targets 密钥对 manifest 文件字节的 Ed25519 签名 |
| 公钥 | 当前生效的 targets 公钥，采用 PKIX PEM 格式 |

targets 密钥撤销之后重新签名的 manifest（[C2](c02-release-manifest.zh.md#key-rotation)）有自己的条目。当发布版本的 manifest 文件条目按本页所述通过验证时，该发布版本即为「已记录」（logged）。

<a id="release-log-bundle"></a>

## 发布日志 bundle

`delorun-<version>.manifest.log.json`，schema 为 `delo.release-log-bundle/1`，不签名（其中每一部分都带有自己的签名）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `manifest` | `{ "name", "sha256" }` | 此 bundle 所覆盖的 manifest 文件。 |
| `entry` | `{ "logIndex", "integratedTime", "body" }` | Rekor 返回的原样条目；`body` 是 base64 编码的规范条目。 |
| `inclusion` | `{ "treeSize", "rootHash", "hashes": [hex...], "logIndex" }` | 该条目的叶子在该树中的 RFC 6962 包含证明。 |
| `checkpoint` | 字符串 | 对应 `treeSize` 与 `rootHash` 的 signed-note 检查点，带有 Rekor 的签名以及至少 1 行见证者共同签名。 |

发布工作流在某个见证者已为树大小大于或等于该条目树大小的检查点共同签名之后，将 bundle 发布到 GitHub Releases，与 manifest 放在一起。bundle 通过验证之前，发布版本不会发布。

<a id="verifying-a-bundle"></a>

## 验证 bundle

使用客户端当前受信任根中的密钥，以下各项全部成立时，bundle 通过验证：

1. `manifest.sha256` 等于客户端按 [C2](c02-release-manifest.zh.md) 验证过的 manifest 文件的 SHA-256。
2. 条目主体是一个 `hashedrekord`，其摘要等于该 SHA-256，其签名可用一个对该发布版本有效的 targets 密钥验证。
3. 条目主体的叶子哈希、包含证明与 `treeSize` 能复算出 `rootHash`。
4. 检查点指明根元数据中的日志 origin，其 `treeSize` 与 `rootHash` 与证明相符，其日志签名可用日志的验证密钥验证。
5. 来自至少 `witnesses.threshold` 个不同的所列见证者密钥的共同签名针对该检查点通过验证。

没有有效见证者共同签名的 bundle 在第 5 步失败，条目被拒绝，无论日志签名如何。

<a id="consistency-with-the-current-log"></a>

## 与当前日志的一致性

经过验证的 bundle 表明，该条目在其携带的检查点时已在日志中。在线检查还表明，客户端所见的日志与见证者此后所见的一致：

1. 客户端从见证网络的检查点分发服务获取日志的最新检查点及其见证者共同签名。
2. 它要求有效的日志签名、至少 `witnesses.threshold` 个有效的所列共同签名，以及最新的共同签名时间早于客户端时钟不超过 24 小时。
3. 它从日志获取从 bundle 的（或已存储的）检查点到最新检查点的 RFC 6962 一致性证明，并验证该证明。
4. 它存储最新的已验证检查点，以便下一次检查从该检查点证明一致性。

当客户端无法访问分发服务或日志，或者最新经见证的检查点已超过 24 小时时，在线检查不进行，该发布版本保持 `unchecked`；这不算失败。可验证的失败（错误的签名、缺失的见证者共同签名、无法通过验证的一致性证明、小于已存储检查点的检查点）为 `failed`。

<a id="check-states"></a>

## 检查状态

| 状态 | 含义 |
| --- | --- |
| `verified` | bundle 通过验证，且在线检查在此安装中至少通过过一次。 |
| `unchecked` | 由于日志或分发服务无法访问，在线检查尚未通过；bundle 如存在，则通过验证。 |
| `failed` | bundle 或在线检查以可验证的方式失败。 |

状态按已安装的发布版本分别存储在 [C1](c01-home-layout.md) 指定的路径下，`delorun verify`、`delorun status` 与 studio 的验证面板会连同发布版本号一起显示它（[C15](c15-verification-checks.zh.md)）。

<a id="behaviour-per-client"></a>

## 各客户端的行为

| 客户端 | 安装或更新 | 启动 |
| --- | --- | --- |
| npm 启动器与安装脚本 | 需要经过验证的 bundle 与通过的在线检查；否则不安装任何内容。 | — |
| `delorun update` 与 studio 的 "Update now" | 需要目标版本经过验证的 bundle 与通过的在线检查；否则更新被拒绝，并给出原因。 | — |
| CLI（命令行界面）启动器，每次启动时 | — | 离线验证已存储的 bundle。有网络时，运行在线检查。没有网络时，带着警告 "Release <version> has not been checked against the release log; Delo checks it at the next connection." 启动，并记录 `unchecked`。为 `failed` 时，在每种验证模式下都停止，并提供回滚。 |
| 无界面 home | — | 与 CLI 启动器相同；警告输出到终端、运行日志（[C20](c20-operational-logs.md)）与 `delorun status`。 |
| 运行中的 home 进程（home process） | — | 状态为 `unchecked` 期间，每 15 分钟以及每次启动时重试在线检查，直到通过或失败。 |
| 桌面更新器 | 在 `quitAndInstall` 之前，以及对请求的回滚目标，需要经过验证的 bundle 与通过的在线检查。 | 启动时，若已存储其发布版本的 bundle 则验证它，并运行在线检查；没有网络时，在应用中显示同一条警告，并每 15 分钟重试。 |
| `delorun verify` | — | 报告当前生效发布版本的 `verified`、`unchecked` 或 `failed`，并在 `failed` 或缺少 bundle 时失败。 |

从下载的安装程序安装的桌面应用首次启动时没有已存储的 bundle；它从 GitHub Releases 获取 bundle，没有网络时则以 `unchecked` 状态带着警告启动。

<a id="values-and-limits"></a>

## 取值与限制

| 值 | 数值 |
| --- | --- |
| 见证者阈值 | 1 个所列见证者 |
| 在线检查所接受的最新经见证检查点的最大时长 | 24 小时 |
| `unchecked` 期间的重试间隔 | 15 分钟 |
| 解析前的 bundle 大小上限 | 64 KiB |
| 包含证明与一致性证明的长度 | 最多 64 个哈希 |
| 向日志与分发服务发出请求的超时 | 30 秒 |

<a id="consumers"></a>

## 消费方

- `delo/apps/release/`（WP3.1）：写入条目，等待经见证的检查点，并发布 bundle。
- `delo/apps/install/` 与 `delo/apps/npm-launcher/`（WP3.2）：在安装之前要求 bundle 与在线检查。
- CLI 启动器与 home 进程（WP2.11、WP3.9）：启动检查、警告与重试。
- 桌面更新器（WP6.3）。
- `delorun verify` 与验证面板（[C15](c15-verification-checks.zh.md)）。

<a id="compatibility"></a>

## 兼容性

bundle 的 `schema` 指明其主版本。日志的 origin 与密钥以及见证者密钥只能通过根轮换（[C2](c02-release-manifest.zh.md#key-rotation)）改变，因此客户端绝不会仅凭网络接受新的日志或见证者。迁移到另一个 Rekor 实例或另一种条目类型，需要一个新的根版本加上一个新的 bundle 主版本；在仍支持旧客户端期间，发布版本会同时发布两个 bundle 版本。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 每个 manifest 文件（包括重新签名的）在其发布版本发布之前都有日志条目。
- R2. 客户端拒绝其检查点缺少所列见证者有效共同签名的条目。
- R3. 安装或更新，以及请求的桌面回滚，都需要经过验证的 bundle 与通过的在线检查。
- R4. 没有网络时的启动会带着一条指明未检查发布版本的警告启动，记录 `unchecked`，并在下次连接时检查。
- R5. 可验证的日志失败会在每种验证模式下停止 CLI 启动，并使 `delorun verify` 失败。
- R6. 日志密钥与见证者密钥只有来自根元数据时才受信任。
- R7. 已存储的检查点绝不后退：更小或不一致的检查点为 `failed`。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 负责方 | 所表明的行为 |
| --- | --- | --- |
| `c18-missing-witness-fails-verify` | WP3.1, WP3.2 | bundle 的检查点不带任何见证者共同签名的发布版本会使 `delorun verify` 失败，且不会被安装。 |
| `c18-unlisted-witness-refused` | WP3.2 | 来自 `witnesses.keys` 之外密钥的共同签名不计入，bundle 验证失败。 |
| `c18-wrong-inclusion-proof-refused` | WP3.2 | 证明无法复算出 `rootHash` 的 bundle 在安装之前被拒绝。 |
| `c18-entry-for-other-manifest-refused` | WP3.2 | 针对另一个 manifest 摘要的有效条目被拒绝。 |
| `c18-offline-start-warns` | WP2.11, WP3.9 | 在日志与分发服务的替身均无法访问时启动，仍会启动，打印带有该发布版本号的警告，并记录 `unchecked`。 |
| `c18-offline-recheck-on-connect` | WP3.9 | 替身变为可访问后，home 进程的下一次重试记录 `verified`。 |
| `c18-offline-update-refused` | WP3.2, WP3.9, WP6.3 | 在日志无法访问时尝试的更新被拒绝，正在运行的版本保持不变。 |
| `c18-inconsistent-log-fails-start` | WP2.11 | 最新检查点从已存储检查点出发的一致性证明无法通过验证时，记录 `failed`，并在每种验证模式下停止启动。 |
| `c18-checkpoint-rollback-refused` | WP2.11 | 树大小小于已存储检查点的经见证检查点记录 `failed`。 |
| `c18-desktop-refuses-unlogged-update` | WP6.3 | bundle 验证失败的桌面更新在 `quitAndInstall` 之前被拒绝。 |

<a id="what-this-does-not-prove"></a>

### 这些检查不能证明什么

- **见证者的独立性。** 客户端验证的是 root 元数据所列出的某个见证者密钥对检查点进行了联署。它无法验证该见证者的运营独立于日志或 Delo；这取决于 root 元数据列出哪些见证者。
- **离线的 home。** 始终无法连接日志与分发服务的 home 会保持 `unchecked`，并在每次启动时显示警告。它永远无法完成一致性检查，因此在它连接之前，向它展示的不同日志视图不会被发现；安装或更新仍然需要该检查。
- **对时钟的依赖。** 对最新已见证检查点不超过 24 小时的限制以客户端的时钟为准；时钟有误时，可能接受较旧的检查点，或者对当前的检查点记录 `unchecked`。
- **日志条目的含义。** 一条已验证的条目说明 manifest 已发布在每个客户端都能检查的日志中；它并不说明该发布没有缺陷或漏洞。
