---
description: "Delorun 的安全基本要求：Delorun 对自己约束的简短受管列表，每项都带有状态、强制执行它的代码和证明它的测试，以及如何更改某项基本要求。"
---

# 安全基本要求

[English](fundamentals.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

安全基本要求是关于 Delorun 做什么或拒绝什么的规则，本人可以在每个发布中依赖它。每一条都用一句话陈述，并附有强制执行它的代码，以及在该代码不再强制执行时失败的测试。`enforced` 的基本要求在今天这个仓库的代码上成立。`designed` 的基本要求是 Delorun 已采纳、但其代码尚未构建的规则；它的[设计页面](../design/README.zh.md)说明它将如何成立，构建它的变更会把该行移到 `enforced`。

防护可以使某项基本要求更严格，没有任何东西能在没有[更改基本要求](#changing-a-fundamental)所述决定的情况下削弱或移除其中一项。尚未构建的[安全扩展点设计](../design/security-extension-points.zh.md)让插件可以使 Delorun 更严格而从不更宽松。

## 目录

- [基本要求](#the-fundamentals)
- [如何检查该列表](#how-the-list-is-checked)
- [更改基本要求](#changing-a-fundamental)

<a id="the-fundamentals"></a>

## 基本要求

「强制执行者」写明持有该检查的最窄文件。「证明者」写明一个规格文件及其中一个测试的确切标题，该测试提供被拒绝的情形，并在该检查被移除时失败。标记为 `designed` 的行不写明任何代码，因为没有代码强制执行它们。

| ID | 基本要求 | 状态 | 强制执行者 | 证明者 |
| --- | --- | --- | --- | --- |
| F1 | 下载的发布在安装任何内容之前，对照启动器内部携带的发布根进行验证；不携带任何根的启动器不安装任何内容。 | `enforced` | `delorun/apps/install/src/verify.ts`, `delorun/packages/release-formats/src/sign/verify.ts`, `delorun/apps/npm-launcher/src/root.ts` | `delorun/apps/install/tests/channel.integration.spec.ts` "verifies each root as it arrives, and asks for no root past one that does not verify"; `delorun/apps/install/tests/channel.integration.spec.ts` "refuses every release when the launcher embeds no root"; `delorun/apps/release/tests/sign/verify.integration.spec.ts` "refuses a manifest signed by a key outside the targets role, a timestamp signed by the targets key, and a revoked targets key" |
| F2 | 与其已签名描述相差一个字节的发布产物，或增加、遗漏或更改了已签名文件列表中某个文件的发布产物，在安装任何内容之前被拒绝。 | `enforced` | `delorun/apps/install/src/extract.ts`, `delorun/apps/install/src/verify.ts` | `delorun/apps/install/tests/channel.integration.spec.ts` "refuses an archive whose SHA-256 is not the manifest’s, before it is extracted"; `delorun/apps/install/tests/extract.spec.ts` "refuses an entry whose bytes are not the length and SHA-256 the list signs"; `delorun/apps/install/tests/extract.spec.ts` "refuses an entry its signed list does not name" |
| F3 | 当发布日志无法访问或其最新的见证检查点已过期时，安装或启动会发出警告，依据发布的签名继续，并记录该检查没有运行；当日志有应答且与发布相矛盾时，安装被拒绝且不安装任何内容，启动也会停止。 | `enforced` | `delorun/packages/release-verify/src/online.ts`, `delorun/apps/install/src/channel.ts`, `delorun/apps/npm-launcher/src/launcher.ts` | `delorun/apps/install/tests/channel.integration.spec.ts` "continues on the signature when the log cannot be reached, and records that the check did not run"; `delorun/apps/install/tests/channel.integration.spec.ts` "continues when the log’s newest witnessed checkpoint is stale, naming its age"; `delorun/apps/install/tests/channel.integration.spec.ts` "reports nothing about the log and installs nothing when the log contradicts the release"; `delorun/apps/npm-launcher/tests/launcher.spec.ts` "starts an unchecked release with the warning and its reason, and never blocks it"; `delorun/apps/npm-launcher/tests/launcher.spec.ts` "stops a release whose release-log check failed, saying how to proceed and that deleting state is no remedy" |
| F4 | 没有关于本人的任何信息会在未经其选择的情况下离开这台机器：上游的 DeepSeek 会话日志上传和产品分析在 Delorun 的 profile 中关闭，并且没有任何 setup 回答可以开启它们。 | `enforced` | `delorun/packages/bundle-local/cordis.patch.yml`, `delorun/apps/cli/src/setup/answers.ts` | `delorun/packages/bundle-local/tests/privacy-defaults.spec.ts` "default-profile model request carries no dsh_session_log"; `delorun/packages/bundle-local/tests/privacy-defaults.spec.ts` "default-profile run sends no analytics or upload"; `delorun/apps/cli/tests/setup/answers.spec.ts` "refuses a document that carries a removed question, naming the removed keys and no value" |
| F5 | 在 Delorun 的 profile 中，搜索工具、`read` 和 `present` 拒绝受保护的 Delorun home，范围更大的搜索会略去 home 中的路径。 | `enforced` | `delorun/packages/bundle-local/cordis.patch.yml`, `packages/fs/tool-fs-search/src/search-core.ts`, `packages/fs/tool-fs/src/read-target.ts`, `packages/deliverables/tool-present/src/index.ts` | `delorun/packages/bundle-local/tests/protected-reads.integration.spec.ts` "refuse %s over %j with SEARCH_SANDBOX_DENIED"; `packages/fs/tool-fs/tests/integration.spec.ts` "refuses reading under the home, through a link, `..` or another mount of it, and reads readable entries"; `packages/deliverables/tool-present/tests/present.spec.ts` "refuses a file under the sandbox provider's protected home, directly and through a link, and presents one beside it" |
| F6 | 在 Delorun 的 profile 中，`web_fetch` 在建立任何连接之前，拒绝回环、链路本地和私有网络目标，包括云元数据地址。 | `enforced` | `delorun/packages/plugin-fetch-guard/src/guard.ts`, `packages/web/web-fetch-http/src/provider.ts`, `delorun/packages/bundle-local/cordis.patch.yml` | `delorun/packages/plugin-fetch-guard/tests/provider-guard.spec.ts` "resolves the hostname and refuses a private target before any connection"; `delorun/packages/plugin-fetch-guard/tests/guard.spec.ts` "refuses %s as %s" |
| F7 | 在 setup 默认选择的「Ask me first」回答之下，模型发起的对指令文件的写入、新的 stdio MCP 服务器，以及新建或编辑的计划任务，都会先询问本人，被拒绝的询问不改变任何内容。 | `enforced` | `delorun/packages/plugin-instruction-consent/src/index.ts`, `packages/fs/tool-fs/src/consent.ts`, `delorun/packages/plugin-mcp-consent/src/index.ts`, `packages/mcp/mcp-client/src/index.ts`, `packages/schedule/tool-schedule/src/index.ts` | `delorun/packages/plugin-instruction-consent/tests/consent.spec.ts` "requires consent for a workspace AGENTS.md write and carries the edit pair"; `packages/fs/tool-fs/tests/tools.spec.ts` "a refused consent ask carries the review's grant marker and leaves the file unchanged with the typed refusal"; `packages/mcp/mcp-client/tests/consent.spec.ts` "leaves the server stopped with the typed reason when the service refuses"; `packages/schedule/tool-schedule/tests/consent.spec.ts` "asks before creating a task once a consent service is mounted, without any policy ask" |
| F8 | 在「Ask me first」回答之下，计划投递在为其创建任何 chat 之前先被审查，计划无法识别的审查答案会使该投递被拒绝。 | `enforced` | `packages/schedule/schedule/src/runtime.ts` | `packages/schedule/schedule/tests/consent.spec.ts` "refuses a due delivery whose consent answers %s"; `packages/schedule/schedule/tests/consent.spec.ts` "refuses a manual run whose consent answers an unrecognised verdict with the typed refusal" |
| F9 | 删除 chat 或工作区会把它移入回收站，只有清除才会移除它。 | `enforced` | `delorun/packages/trash/src/service.ts`, `delorun/packages/plugin-trash/src/operations.ts` | `delorun/packages/trash/tests/delete.integration.spec.ts` "moves the chat session directory with every generation into the trash and leaves no copy at the origin"; `delorun/packages/trash/tests/purge.integration.spec.ts` "removes the canary from the index, every generation, the attachments, the spill files and the drafts, and keeps the process-log residue" |
| F10 | 归档在其暂存目录之外写入任何内容之前，先被完整验证并检查其签名，home 不担保的签名者会被拒绝，直到本人确认其指纹。 | `enforced` | `delorun/packages/archive/src/importer.ts` | `delorun/packages/archive/tests/consent.integration.spec.ts` "is refused by the preview and the import alike, and nothing is staged or published"; `delorun/packages/archive/tests/consent.integration.spec.ts` "is refused with the checksum mismatch, before anything is staged"; `delorun/packages/archive/tests/consent.integration.spec.ts` "refuses a key the home does not vouch for until the person confirms that key" |
| F11 | 只在 home 自己的电脑上、通过回环监听器认领 home，并列出或移除它的设备。 | `enforced` | `delorun/packages/home-auth/src/home-auth.ts`, `delorun/packages/home-auth/src/routes.ts` | `delorun/packages/home-auth/tests/owner-claim.spec.ts` "refuses a claim on a reach listener with a valid code, and claims nothing"; `delorun/packages/home-auth/tests/owner-claim.spec.ts` "refuses a claim whose Host names a reach address even when nothing stamped the request"; `delorun/packages/home-auth/tests/routes.spec.ts` "refuses a removal whose Host names a reach address, before it reads the body" |
| F12 | 只在 home 所在的电脑上批准新设备。 | `enforced` | `delorun/packages/home-auth/src/reach-routes.ts`, `delorun/packages/home-auth/src/service.ts`, `delorun/packages/home-process/src/devices-approve.ts` | `delorun/packages/home-auth/tests/reach-routes.spec.ts` "a tailnet-route session cannot approve a device or open the window"; `delorun/packages/home-process/tests/devices-approve.integration.spec.ts` "the channel token cannot call devices.approve"; `delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts` "a tailnet-route session cannot approve a device" |
| F13 | 远程会话授予完全访问（通过逐次调用的升级或按工作区的同意）或启动外部 agent，只有在该答案带有单次操作的 Face ID 或 PIN 授权凭证（grant），或处于该设备用 Face ID 开启的 Face ID 通行期（pass）内时才可以；移除另一台设备，只有在持有通行密钥的设备给出单次操作的 Face ID 授权时才可以，PIN 从不签发这种授权，任何通行期也不能代替它；没有任何由 PIN、来自电脑的代码或危险模式开启的窗口能代替二者，并且它从不批准设备或更改 reach。 | `enforced` | `delorun/packages/home-auth/src/reach-access.ts`, `delorun/packages/home-auth/src/authenticator.ts`, `delorun/packages/home-auth/src/reach-routes.ts`, `delorun/packages/home-auth/src/routes.ts` | `delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts` "a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent"; `delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts` "a tailnet-route session cannot start an external agent"; `delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts` "a tailnet-route session cannot remove another device, reset, enrol a factor or change reach"; `delorun/packages/home-auth/tests/authenticator.spec.ts` "refuses a full-access, workspace-management or external-agent grant answered from a reach Peer, and nothing else"; `delorun/packages/home-auth/tests/denial/face-pass.spec.ts` "are never admitted by a live pass, one family at a time"; `delorun/apps/cli/tests/denial/reach/reach-access.spec.ts` "needs an unlock for a settings write in every settings namespace, and never opens the settings document"; `delorun/apps/cli/tests/denial/reach/reach-access.spec.ts` "never turns the external-agent consent off, and takes its run time limit and turning it on" |
| F14 | 回滚不删除 chat 数据：更新之后写入的 chat 被搁置，从不被删除。 | `designed` | — | — |
| F15 | 除非本人在自己的电脑上批准了更改，否则没有任何东西会改变 harness 所运行的内容。 | `designed` | — | — |
| F16 | 针对本人未批准的更改的保护设置，只在 home 所在电脑的终端上降低，从不由远程会话或模型的工具降低。 | `designed` | — | — |
| F17 | Delorun 添加的每项拒绝或同意都有一个拒绝测试，在移除该检查时失败。 | `designed` | — | — |
| F25 | 一个发布的日志条目只有在以下情况下才算数：受信任根为该条目的密钥类型所列、且对该发布有效的密钥签署了它，它位于根所列的某个日志中，并由所列见证者联署；没有这些列表的根不验证任何发布，两个列表都只通过根轮换更改，而较旧的根绝不会取代客户端已验证的较新根。 | `enforced` | `delorun/packages/release-formats/src/log/entry-keys.ts`、`delorun/packages/release-verify/src/entry.ts`、`delorun/packages/release-verify/src/bundle.ts`、`delorun/apps/install/src/channel.ts` | `delorun/packages/release-verify/tests/entry-keys.spec.ts` "c18-root-without-log-trust-refused: verifies no release, not even an Ed25519ph entry by its targets key"; `delorun/packages/release-verify/tests/entry-keys.spec.ts` "c18-unlisted-entry-type-refused: refuses an entry whose type the root does not list, whatever its signature"; `delorun/packages/release-verify/tests/entry-keys.spec.ts` "c18-listed-type-other-key-refused: refuses an entry of a listed type by a key the root does not list"; `delorun/packages/release-verify/tests/entry-keys.spec.ts` "c18-unlisted-log-origin-refused: refuses a checkpoint of a log the root does not list"; `delorun/apps/install/tests/key-agility.integration.spec.ts` "c02-log-entry-keys-unverified-root-refused: never reads a list in a root that the root before it did not sign"; `delorun/apps/install/tests/key-agility.integration.spec.ts` "c02-replayed-root-cannot-restore-type: stays removed when the channel replays the root that listed it" |

F12 和 F13 在 [reach 设计](../design/reach.zh.md)中描述；远程会话写入设置，以及降低 [C21](../contracts/c21-changes.zh.md) 的 Changes 保护设置，只有在带有针对该写入的单次操作授权，或处于 Face ID 通行期内时才可以，并且从不关闭外部 agent 同意。F14 见[更新与回退设计](../design/update-and-rollback.zh.md)，F15 和 F16 见[更改设计](../design/changes.zh.md)。F15 和 F16 在 Changes 保护开启时适用；保护关闭（默认）时，更改不经评审即加载，且每项都被记录（[C21](../contracts/c21-changes.zh.md#the-protection-setting)）。F17 目前是一条评审规则：[CONTRIBUTING.md](../../../CONTRIBUTING.zh.md#quality-bar) 要求这些测试，没有任何检查能找出没有测试的拒绝。

<a id="how-the-list-is-checked"></a>

## 如何检查该列表

[检查运行器](../../apps/tools/README.zh.md)的 `gates:fundamentals` 闸门读取上表。当缺少某一列、某个 id 重复或不是 `F` 加数字，或某个状态既不是 `enforced` 也不是 `designed` 时，它失败。对于 `enforced` 的行，当所列的文件不存在，或规格文件中没有 `it` 或 `test` 的标题（或 `.each` 模板）等于所引用的标题时，它失败；被跳过的测试不算数。它打印每种状态下基本要求的数量。

该闸门检查的是所列测试存在，而不是该测试在移除检查时失败。评审检查这一点，就像评审检查每个拒绝测试一样。

<a id="changing-a-fundamental"></a>

## 更改基本要求

更改该列表，即增加一项基本要求、更改某项所陈述的内容或移除某项，需要一项维护者决定，记录为 [Agent Note](../../../.agents/notes/README.zh.md)，并在安全一节中附一个 changelog 片段（[changelog](../../changelog/README.zh.md)），二者都与对本页的更改位于同一个拉取请求中（[治理](../../../GOVERNANCE.md#decisions)）。把某行从 `enforced` 移回 `designed` 会削弱它，需要同样的决定。有两种编辑不改变任何基本要求，也不需要这二者：在构建其代码和测试的变更中，把某行从 `designed` 移到 `enforced`，以及在某项变更移动代码或重命名测试时更新路径和标题。
