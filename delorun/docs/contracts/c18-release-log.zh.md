---
description: "约定 C18：每个 Delorun 发布 manifest 如何记录在 Sigstore 的公开 Rekor 日志中、客户端对其检查点所要求的见证者共同签名、发布日志 bundle 的格式、启动器、delorun verify 与桌面更新器如何检查包含关系，以及没有网络时的启动如何进行。"
---

# C18 发布日志与见证者

[English](c18-release-log.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

[C2](c02-release-manifest.zh.md) 的每个已签名发布 manifest（元数据清单）在 Sigstore 的公开 Rekor 日志中都有一个条目；Rekor 是一个仅追加的透明日志，不由 Delorun 运营。Rekor 为其树的检查点签名，公共见证网络中的一个独立见证者为这些检查点共同签名，因此，如果日志向一个客户端展示的历史与向另一个客户端展示的不同，见证者就会发现。每个发布版本都会发布一个 bundle，其中包含该条目、它的包含证明和一个经见证的检查点。客户端拒绝其检查点不带有效见证者共同签名的 bundle；日志提供的最新检查点不带这种共同签名时，只会使发布版本保持未检查，并给出警告。安装发布版本始终需要经过验证的包含证明。当日志无法访问、没有给出由其密钥签名的检查点、其最新检查点缺少见证者的共同签名，或其最新的共同签名已过时，安装或更新会发出警告，凭发布版本的签名继续，并记录在线检查未运行；若日志随后给出的已签名检查点与该发布版本矛盾，或见证者共同签名存在但无效，则拒绝。`delorun update` 在其报告中显示所记录的状态，`--yes` 不会确认保持未检查的发布版本。没有网络时的启动会带着一条指明未检查发布版本的警告启动，并在下次连接时检查；运行时仓库安装的发布版本若缺少已存储的 bundle，则会停止启动，因为每次这样的安装都会保留它验证过的 bundle。类型位于 [`@delorun/contract-release-log`](../../packages/contract-release-log/README.zh.md)。

<a id="status"></a>

## 状态

bundle 格式、其验证与在线检查已构建，并在安装时、启动器每次启动时以及 `delorun verify` 中被调用；发布是由人运行的命令，运行中 home 的重试、桌面更新器与模式开关尚未构建。

- **已构建并被调用：** npm 启动器与 `delorun update` 在安装任何内容之前要求经过验证的 bundle 并运行在线检查；启动器在每次启动时验证已存储的 bundle 并运行在线检查，在 `unchecked` 时警告并继续，在 `failed` 或缺少已存储的 bundle 时停止；`delorun verify` 报告该状态。发布的 `log-release` 命令写入条目，并且只有在 bundle 用根的日志密钥与见证者密钥验证通过之后才写出 bundle。
- **尚未构建：** 本仓库中运行日志命令并发布 bundle 的发布工作流，因此验证之后的发布取决于运行这些命令的人；运行中的 home 进程每 15 分钟一次的重试，因为启动检查只在启动器中运行；运行日志与 `delorun status` 中的启动警告，`delorun status` 不显示任何发布日志状态；studio 的 "Update now" 与验证面板；桌面更新器的检查；`integrity.mode: off`，没有任何内容读取它，因此在线检查总会运行。

下文中被此列表列为尚未构建或没有任何内容调用的要求与拒绝测试，在某次变更构建并接入它们之前不保护任何人。

## 目录

- [状态](#status)
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

- 日志是 Sigstore 公开 Rekor v2 日志的一个分片，它用 Ed25519 note 密钥为检查点签名。它的检查点 origin 行与检查点验证密钥位于根元数据的 `log` 字段中（[C2](c02-release-manifest.zh.md#root-metadata)），因此只能通过根轮换改变。
- 检查点使用 C2SP signed-note 格式（`tlog-checkpoint`）；见证者共同签名使用 C2SP `tlog-cosignature`（`cosignature/v1`），其签名消息包含共同签名时间。
- 见证者以公共见证网络中各见证者的密钥表示，列在根元数据的 `witnesses.keys` 中，`witnesses.threshold` 为 1：至少 1 个所列见证者为某个检查点共同签名时，该检查点即为经见证。Delorun 不运营其中任何一个。
- 除其发布 manifest 与重新签名的 manifest 的条目外，Delorun 不向该日志发布任何内容。

<a id="log-entry"></a>

## 日志条目

One entry per signed manifest file, submitted by the release's signing command after the targets key signs and before the release is published. The entry is signed by an `active` key the trusted root lists in `logEntryKeys` ([C2](c02-release-manifest.zh.md#root-metadata)): ECDSA P-256 first, with Ed25519ph by the targets key as the listed alternative. A root without the list, such as `1.root.json`, verifies no release.

| 条目字段 | 值 |
| --- | --- |
| 类型 | `hashedrekord`，API 版本 `0.0.2`（Rekor v2） |
| Key details | The entry key type: `PKIX_ED25519_PH` or `PKIX_ECDSA_P256_SHA_256` |
| Digest | The key type's digest of the manifest file's bytes (the whole envelope): SHA-512, algorithm `SHA2_512`, for `PKIX_ED25519_PH`; SHA-256, algorithm `SHA2_256`, for `PKIX_ECDSA_P256_SHA_256` |
| Signature | Over the manifest file's bytes: Ed25519ph (RFC 8032, empty context) for `PKIX_ED25519_PH`; ECDSA P-256 with SHA-256, DER-encoded, for `PKIX_ECDSA_P256_SHA_256` |
| Public key | The signing key's DER-encoded PKIX public key |

The signing command submits these fields as a `hashedRekordRequestV002` to the log's `/api/v2/log/entries`; the log builds the entry body from them, and the log's leaf is the RFC 8785 serialisation of that body. Rekor v2 accepts an Ed25519 key only with Ed25519ph, so the log refuses a pure Ed25519 (`PKIX_ED25519`) entry, and clients refuse one too.

The signing command tries the root's listed `active` keys it holds in the root's order. Before each submission it verifies its own request as step 2 below does, under the root it signs for, and submits nothing that does not verify. It moves to the next key only when the log answers HTTP 400 with a JSON body whose `message` is exactly `invalid hashedrekord request` (Rekor v2) or `entry algorithms are not allowed` (Rekor v1), which is how a log refuses an entry key type; any other answer stops the release. On the 1.0 path, `sign-release` writes these requests ahead, one per key it may sign with, as `delorun-<version>.manifest.entry.json` and then `delorun-<version>.manifest.entry.<n>.json` in the root's order (the packs file's as `delorun-<version>.packs.entry[.<n>].json`), and `log-release`, which holds no key, submits them in that order by the same rule, verifying each under the root first, so a request whose digest is not the signed file's is never submitted; when it logs a later request, it rewrites the first file with it. The log accepting an entry proves nothing by itself: the bundle the command writes must verify as this page states. Before a cut, `apps/release/scripts/probe-log.ts` submits one entry over random bytes per listed `active` type, each signed by a throwaway key, and reports which types the log accepts.

targets 密钥撤销之后重新签名的 manifest（[C2](c02-release-manifest.zh.md#key-rotation)）有自己的条目。当发布版本的 manifest 文件条目按本页所述通过验证时，该发布版本即为「已记录」（logged）。

<a id="release-log-bundle"></a>

## 发布日志 bundle

`delorun-<version>.manifest.log.json`，schema 为 `delorun.release-log-bundle/1`，不签名（其中每一部分都带有自己的签名）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `manifest` | `{ "name", "sha256" }` | 此 bundle 所覆盖的 manifest 文件。 |
| `entry` | `{ "logIndex", "integratedTime", "body" }` | Rekor 返回的原样条目；`body` 是 base64 编码的规范条目主体。Rekor v2 不记录集成时间，因此 `integratedTime` 为 0。 |
| `inclusion` | `{ "treeSize", "rootHash", "hashes": [hex...], "logIndex" }` | 该条目的叶子在该树中的 RFC 6962 包含证明。 |
| `checkpoint` | 字符串 | 对应 `treeSize` 与 `rootHash` 的 signed-note 检查点，带有 Rekor 的签名以及至少 1 行见证者共同签名。 |

bundle 发布到 GitHub Releases，与 manifest 放在一起。`log-release` 命令只有在某个见证者已为树大小大于或等于该条目树大小的检查点共同签名、且 bundle 通过验证之后才写出它；本仓库中没有任何工作流发布发布版本，因此「bundle 通过验证之前发布版本不发布」这条规则取决于发布它的人。

<a id="verifying-a-bundle"></a>

## 验证 bundle

使用客户端当前受信任根中的密钥，以下各项全部成立时，bundle 通过验证：

1. `manifest.sha256` 等于客户端按 [C2](c02-release-manifest.zh.md) 验证过的 manifest 文件的 SHA-256。
2. The entry body is a Rekor v2 `hashedrekord` (`0.0.2`), the root lists `logEntryKeys` (`entry-key-untrusted` otherwise), the entry's key details are a listed type this client implements (`entry-type-refused` otherwise), its public key is byte for byte a listed key of that type that is `active`, or `retired` with a `lastRelease` at or above the version of the signed manifest, never a version the bundle names (`entry-key-untrusted` otherwise, and always for a `revoked` key), its digest algorithm and digest are the type's over the manifest file, and its signature over the manifest file verifies with that listed key.
3. 条目主体的叶子哈希、包含证明与 `treeSize` 能复算出 `rootHash`。
4. The checkpoint names the origin of a log the root lists in `logs` (`log-origin-untrusted` otherwise, and always under a root without `logs`), its `treeSize` and `rootHash` match the proof, and its log signature verifies with that log's Ed25519 verifier key.
5. Cosignatures from at least `witnesses.threshold` distinct listed witness keys verify over that checkpoint, whichever listed log signed it.

没有有效见证者共同签名的 bundle 在第 5 步失败，条目被拒绝，无论日志签名如何。

<a id="consistency-with-the-current-log"></a>

## 与当前日志的一致性

经过验证的 bundle 表明，该条目在其携带的检查点时已在日志中。在线检查还表明，客户端所见的日志与见证者此后所见的一致：

1. 客户端从日志本身获取日志的最新检查点及其见证者共同签名：`GET https://<log origin>/api/v2/checkpoint`，其中 `<log origin>` 是根元数据的 `log.origin`。Rekor v2 在此提供经见证的检查点，没有单独的分发服务。
2. 它要求一个能用根的日志密钥验证的有效日志签名；在验证通过之前，日志应答的任何内容都未经签名。所列见证者的每个已存在的共同签名都必须通过验证；尚未共同签名的所列见证者视为缺席，这不是错误。时间晚于客户端时钟 5 分钟以上的共同签名不计入，因为时钟偏慢与见证者的时间偏前无法区分。然后它要求至少 `witnesses.threshold` 个计入的共同签名，且最新的共同签名时间早于客户端时钟不超过 24 小时。
3. 它根据日志的瓦片 `GET https://<log origin>/api/v2/tile/<L>/<N>` 与部分瓦片 `<N>.p/<W>`（C2SP `tlog-tiles`；日志没有证明端点）计算从 bundle 的（或已存储的）检查点到最新检查点的 RFC 6962 一致性证明，并对照两个检查点的根哈希验证它。
4. 它把最新的已验证检查点作为带树大小与根哈希的 signed note 存储在 `trust/checkpoint.json` 中，以便下一次检查从该检查点证明一致性。已存储的检查点只有在其 note 带有根的日志密钥的有效签名、且其字段与 note 相符时才会被读取。

一条规则决定每种结果：检查点的日志签名验证通过之前的任何情况都使发布版本保持 `unchecked`，验证通过之后任何不能自洽的情况都为 `failed`。因此，没有应答、请求超过其 30 秒超时、整个检查超过其 90 秒截止时间、`5xx`、检查点返回 `404` 或 `410`、检查点被重定向到其他主机或应答超出其大小上限，以及正文不是由根的日志密钥签名的检查点（代理的页面、另一个日志的 note），都使发布版本保持 `unchecked`；这不算失败。已签名的检查点小于已存储的检查点、一致性证明无法通过验证、已签名树大小表明存在的瓦片返回 `404` 或 `410`、长度不对、字节数超出其格式允许的范围或被重定向到其他主机，以及所列见证者的共同签名存在但无法通过验证，都为 `failed`。最新检查点计入的所列共同签名少于 `witnesses.threshold` 个（时间超前 5 分钟以上的共同签名不计入，`detail` 会说明是哪个见证者以及客户端的时钟），或其最新的共同签名早于 24 小时之前，会使发布版本保持 `unchecked`，且只在回滚检查与一致性检查之后才如此，因此与发布版本矛盾的日志无法通过省略共同签名来避开这些检查。存在但无效的共同签名，其失败代码为 `witness-cosignature-missing`，检查的 `detail` 说明是哪个见证者以及原因。客户端自身代码的失败作为客户端的错误报告，绝不当作日志无法访问。

发现 `unchecked` 的安装或更新只凭发布版本的签名继续，并告知本人。启动器打印步骤 "Checking the release log: not checked" 及其原因，然后打印警告 "Release <version> has not been checked against the release log; Delorun checks it at the next connection."。运行时仓库安装该发布版本之后，它在检查状态文件中将该发布版本记录为 `unchecked`，并以原因作为 `detail`；被仓库拒绝的发布版本不留下记录。能够阻断某人到日志及其见证者连接的人，会让此人只剩下签名可依；发布版本自身 bundle 中的包含证明仍会在安装任何内容之前离线验证。发现 `failed` 的安装或更新不安装任何内容，也不记录检查状态。它验证过的根与时间戳，以及通过的检查所验证的检查点，仍记录在 `trust/` 下，因为之后的安装要让根链、时间戳与日志遵守它们已证明的内容。

The online check reads only the current log, the root's `log`. A release whose bundle's checkpoint is in an earlier log the root lists is verified offline at install and at each start and stays `unchecked` online, with a `detail` that names both logs.

早先的安装写下的只有树大小与根哈希、没有 signed note 的 `trust/checkpoint.json`，是客户端自身无法检查的下限。只有当从它到日志已签名最新检查点的一致性证明通过验证时，在线检查才保留它，随后由已验证的检查点替换该文件。证明无法通过验证时，它不设定下限，由已验证的检查点替换它，本次尝试记录一条给出其树大小的通知；日志无法访问时，该文件保持原样。完全无法读取的 `trust/checkpoint.json` 同样不设定下限：下限从发布版本自身的检查点重新开始，本次尝试记录一条说明这一点的通知，并列出 home 记录为 `verified` 的发布版本，因此重置从不会悄无声息。

<a id="check-states"></a>

## 检查状态

| 状态 | 含义 |
| --- | --- |
| `verified` | bundle 通过验证，且在线检查在此安装中至少通过过一次。 |
| `unchecked` | 在线检查尚未通过：日志无法访问、没有给出由其密钥签名的检查点，或其见证者未在 24 小时内为其最新检查点共同签名；bundle 如存在，则通过验证。 |
| `failed` | bundle 或在线检查以可验证的方式失败。 |

状态按已安装的发布版本分别存储在 `trust/release-log.json` 中（schema 为 `delorun.release-log-state/1`，每个发布版本一个条目，含其 `state`、`lastAttempt`，`unchecked` 时以原因作为 `detail` 并以当前这段 `unchecked` 期间的第一次尝试作为 `uncheckedSince`，以及本次尝试的 `notices`，例如无法读取的已存储检查点），位于 [C1](c01-home-layout.zh.md) 指定的检查点旁。安装为其安装的发布版本记录 `verified` 或 `unchecked`，启动检查更新同一条目。`delorun verify` 会连同发布版本号一起显示它（[C15](c15-verification-checks.zh.md)）；`delorun status` 与 studio 不显示任何发布日志状态。

在 `integrity.mode: off`（[C15](c15-verification-checks.zh.md#modes)）下，在线检查不运行。没有任何内容读取 `integrity.mode`，启动器总会运行在线检查。仅能离线验证的发布版本因此保持 `unchecked`，启动警告与重试均不适用。每次启动时的离线验证仍会运行，其经验证的失败在每种模式下都会阻止启动，如 R5 所要求。

<a id="behaviour-per-client"></a>

## 各客户端的行为

| 客户端 | 安装或更新 | 启动 |
| --- | --- | --- |
| npm 启动器与安装脚本 | 需要经过验证的 bundle。在线检查通过时，安装并记录 `verified`。为 `unchecked` 时，打印原因与警告，安装，并记录 `unchecked`。为 `failed` 时，不安装任何内容。 | — |
| `delorun update` 与 studio 的 "Update now" | 需要目标版本经过验证的 bundle，并像启动器一样对待在线检查：`unchecked` 时警告、继续并记录，`failed` 时拒绝更新并给出原因。更新报告显示所记录的状态，`--yes` 不会确认 `unchecked`。 | — |
| CLI（命令行界面）启动器，每次启动时 | — | 离线验证已存储的 bundle。有网络时，运行在线检查。没有网络时，带着警告 "Release <version> has not been checked against the release log; Delorun checks it at the next connection." 启动，并记录 `unchecked`。为 `failed` 时，或运行时仓库安装的发布版本没有已存储的 bundle 时，在每种验证模式下都停止，并提供回滚。 |
| 无界面 home | — | 与 CLI 启动器相同；警告输出到终端、运行日志（[C20](c20-operational-logs.zh.md)）与 `delorun status`。 |
| 运行中的 home 进程（home process） | — | 状态为 `unchecked` 期间，每 15 分钟以及每次启动时重试在线检查，直到通过或失败。 |
| 桌面更新器 | 在 `quitAndInstall` 之前，以及对请求的回滚目标，需要经过验证的 bundle；在线检查为 `unchecked` 时警告并记录，为 `failed` 时拒绝。 | 启动时，若已存储其发布版本的 bundle 则验证它，并运行在线检查；没有网络时，在应用中显示同一条警告，并每 15 分钟重试。 |
| `delorun verify` | — | 报告当前生效发布版本的 `verified`、`unchecked` 或 `failed`，并在 `failed` 或缺少 bundle 时失败。它通过安装所走过的链，把已存储的根锚定在启动它的启动器所携带的根上，启动器在 `DELORUN_LAUNCHER_ROOTS` 中指定这些根；没有它们时，它只按根自身的签名核对根，且不把发布签名报告为通过。它说明发布版本自何时起一直处于 `unchecked`，并且只有在没有检查失败、且发布签名通过或仅因在线检查无法完成而未达通过时才以 0 退出。 |

从下载的安装程序安装的桌面应用首次启动时没有已存储的 bundle；它从 GitHub Releases 获取 bundle，没有网络时则以 `unchecked` 状态带着警告启动。

<a id="values-and-limits"></a>

## 取值与限制

| 值 | 数值 |
| --- | --- |
| 见证者阈值 | 1 个所列见证者 |
| 在线检查所接受的最新经见证检查点的最大时长 | 24 小时 |
| 共同签名时间超前客户端时钟、仍被计入的最大差值 | 5 分钟 |
| `unchecked` 期间的重试间隔 | 15 分钟 |
| 解析前的 bundle 大小上限 | 64 KiB |
| 包含证明与一致性证明的长度 | 最多 64 个哈希 |
| 向日志发出请求的超时 | 每个请求 30 秒 |
| 一次完整在线检查的截止时间，包括每个请求与重定向 | 90 秒 |

<a id="consumers"></a>

## 消费方

- `delorun/apps/release/`：写入条目，等待经见证的检查点，并发布 bundle。
- `delorun/apps/install/` 与 `delorun/apps/npm-launcher/`：在安装之前要求 bundle 与在线检查。
- CLI 启动器与 home 进程：启动检查、警告与重试。
- 桌面更新器。
- `delorun verify` 与验证面板（[C15](c15-verification-checks.zh.md)）。

<a id="compatibility"></a>

## 兼容性

bundle 的 `schema` 指明其主版本。日志的 origin 与密钥以及见证者密钥只能通过根轮换（[C2](c02-release-manifest.zh.md#key-rotation)）改变，因此客户端绝不会仅凭网络接受新的日志或见证者。迁移到另一个 Rekor 实例或另一种条目类型，需要一个新的根版本加上一个新的 bundle 主版本；在仍支持旧客户端期间，发布版本会同时发布两个 bundle 版本。当根所指定的某个日志分片停止服务时，该根之下每个发布版本的在线检查都会永久保持 `unchecked` 并给出警告，而绝不会变为 `failed`；根轮换到新分片并在那里记录的发布版本会结束这种状态。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 每个 manifest 文件（包括重新签名的）在其发布版本发布之前都有日志条目。
- R2. 客户端拒绝其检查点缺少所列见证者有效共同签名的 bundle。在线检查有所不同：没有任何所列见证者共同签名的最新检查点会使发布版本保持 `unchecked`，存在但无效的共同签名为 `failed`，时间超前于时钟偏差上限的共同签名不计入。
- R3. 安装或更新，以及请求的桌面回滚，都需要经过验证的 bundle。无法运行的在线检查（`unchecked`）不会阻止它们：它们发出警告，凭签名继续，并记录检查未运行。以可验证的方式失败的在线检查会阻止它们。
- R4. 没有网络时的启动会带着一条指明未检查发布版本的警告启动，记录 `unchecked`，并在下次连接时检查。
- R5. 可验证的日志失败会在每种验证模式下停止 CLI 启动，并使 `delorun verify` 失败。
- R6. 日志密钥与见证者密钥只有来自根元数据时才受信任。
- R7. 已存储的检查点绝不后退：更小或不一致的检查点为 `failed`。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 组件 | 所表明的行为 |
| --- | --- | --- |
| `c18-missing-witness-fails-verify` | `release`, `install` | bundle 的检查点不带任何见证者共同签名的发布版本会使 `delorun verify` 失败，且不会被安装。 |
| `c18-store-install-missing-bundle-fails` | release-chain | 运行时仓库安装的发布版本若缺少已存储的 bundle，记录 `failed`（`bundle-malformed`），并在每种模式下停止启动；安装之后才获取 bundle 的客户端记录 `unchecked`。 |
| `c18-unlisted-witness-refused` | `install` | 来自 `witnesses.keys` 之外密钥的共同签名不计入，bundle 验证失败。 |
| `c18-wrong-inclusion-proof-refused` | `install` | 证明无法复算出 `rootHash` 的 bundle 在安装之前被拒绝。 |
| `c18-entry-for-other-manifest-refused` | `install` | 针对另一个 manifest 摘要的有效条目被拒绝。 |
| `c18-pure-ed25519-entry-refused` | `release`, `install` | 带纯 Ed25519 签名或 `PKIX_ED25519` 密钥详情的条目被拒绝；同一 manifest 的 Ed25519ph 条目通过验证。 |
| `c18-root-without-log-trust-refused` | `release-verify`, `install` | Under a root without `logEntryKeys`, even an Ed25519ph entry by its targets key is refused; under a root without `logs`, every checkpoint is. |
| `c18-listed-entries-only` | `release-verify` | A root that lists only an ECDSA P-256 key refuses an Ed25519ph entry by its targets key. |
| `c18-revoked-entry-key-refused` | `release-verify` | A revoked log-entry key verifies no release, an older one too, whatever `lastRelease` it carries. |
| `c18-retired-entry-key-by-signed-version` | `release-verify`, `install` | A retired log-entry key verifies a release up to its `lastRelease` by the signed manifest's version; a bundle that names the old release for a newer manifest is refused. |
| `c18-listed-log-needs-witness` | `release-verify` | A checkpoint of an earlier log the root lists, with no cosignature from a listed witness, is refused. |
| `c18-unlisted-entry-type-refused` | `release-verify` | An entry whose key type the root does not list is refused whatever its signature, in each direction between the two types. |
| `c18-listed-type-other-key-refused` | `release-verify`, `install` | An entry of a listed type whose key is not a listed key of that type is refused, and one naming the listed key with another key's signature is refused. |
| `c18-unlisted-log-origin-refused` | `release-verify` | A bundle whose checkpoint is in a log the root does not list is refused; one in an earlier log the root lists verifies only with that log's key. |
| `c18-ecdsa-strict-encodings` | `release-verify` | An ECDSA P-256 entry by the listed key is refused when its signature is a raw 64-byte `r` and `s` concatenated, when it signs SHA-256 of the manifest instead of the manifest's bytes, and when it names the listed key by its compressed-point SPKI. |
| `c18-entry-verifier-parity` | `release-verify`, `release` | One denial table gives the same outcome in the client's entry check and the signing tool's: revoked, retired before the release, unlisted type, unimplemented type, root without `logEntryKeys`, another key, and the three ECDSA encodings. |
| `c18-earlier-log-closed-after-last-release` | `release-verify`, `release` | A bundle in an earlier listed log for a release newer than that log's `lastRelease` is refused by both verifiers; the current log takes it. |
| `log-fallback-only-on-type-refusal` | `release` | A log answering the first entry with a 400 whose body is not one of the two refusal messages, a 5xx or a 409 stops the release with no other key tried and the channel unchanged. |
| `log-fallback-verifies-success` | `release` | A log that refuses the first type and accepts the second with an entry that is not the release's leaves the release unwritten. |
| `sign-release-entry-per-listed-key` | `release` | The signing command writes one entry request per `active` log-entry key the root lists and it holds, ECDSA P-256 first and Ed25519ph second in the root's order, and each verifies under the root. |
| `log-release-fallback-on-type-refusal` | `release` | The logging command submits the next pre-signed request only after the log refuses the first one's key type with a refusal answer, and the bundle of the accepted one verifies under the root. |
| `log-release-only-on-type-refusal` | `release` | The logging command stops at a 400 with another body or a 500 and submits no later request. |
| `log-release-refuses-other-digest` | `release` | The logging command submits no request that does not verify under the root, such as one whose digest is another file's or whose key the root does not list. |
| `c18-offline-start-warns` | CLI 启动器, home 进程 | 在日志替身无法访问时启动，仍会启动，打印带有该发布版本号的警告，并记录 `unchecked`。 |
| `c18-offline-recheck-on-connect` | home 进程 | 替身变为可访问后，home 进程的下一次重试记录 `verified`。 |
| `c18-offline-install-continues` | `install`, home 进程, 桌面更新器 | 在日志无法访问或其最新经见证检查点已过时时尝试的安装或更新，会打印原因与警告，进行安装，并记录带原因的 `unchecked`。 |
| `c18-missing-cosignature-install-continues` | `install`, home 进程, 桌面更新器 | 最新检查点不带任何所列见证者共同签名的安装或更新会发出警告，进行安装，并记录带原因的 `unchecked`。 |
| `c18-invalid-cosignature-refuses-install` | `install`, home 进程, 桌面更新器 | 所列见证者的共同签名存在但无法通过验证时，不安装任何内容，也不记录检查状态。 |
| `c18-contradicting-log-refuses-install` | `install`, home 进程, 桌面更新器 | 当日志应答的检查点签名无法通过验证、小于已存储的检查点，或从已存储或 bundle 检查点出发的一致性证明无法通过验证时尝试的安装或更新，不安装任何内容，不记录检查状态，正在运行的版本保持不变。 |
| `c18-inconsistent-log-fails-start` | CLI 启动器 | 最新检查点从已存储检查点出发的一致性证明无法通过验证时，记录 `failed`，并在每种验证模式下停止启动。 |
| `c18-checkpoint-rollback-refused` | CLI 启动器 | 树大小小于已存储检查点的经见证检查点记录 `failed`。 |
| `c18-desktop-refuses-unlogged-update` | 桌面更新器 | bundle 验证失败的桌面更新在 `quitAndInstall` 之前被拒绝。 |

<a id="what-this-does-not-prove"></a>

### 这些检查不能证明什么

- **见证者的独立性。** 客户端验证的是 root 元数据所列出的某个见证者密钥对检查点进行了联署。它无法验证该见证者的运营独立于日志或 Delorun；这取决于 root 元数据列出哪些见证者。
- **离线的 home。** 始终无法连接日志的 home 会保持 `unchecked`，并在每次启动时显示警告。它永远无法完成一致性检查，因此在它连接之前，向它展示的不同日志视图不会被发现。无法连接日志的安装或更新也以同样方式继续，因此能够阻断某人到日志及其见证者连接的人，会让此人只剩下发布版本的签名与离线包含证明可依。
- **对时钟的依赖。** 对最新已见证检查点不超过 24 小时的限制以客户端的时钟为准；时钟有误时，可能接受较旧的检查点，或者对当前的检查点记录 `unchecked`。
- **日志条目的含义。** 一条已验证的条目说明 manifest 已发布在每个客户端都能检查的日志中；它并不说明该发布没有缺陷或漏洞。
