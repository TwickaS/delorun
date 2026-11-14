---
description: "约定 C15：验证检查的注册表、各项检查与其阶段、结果与模式的语义、报告 schema、徽章规则与拒绝测试。"
---

# 约定 C15：验证检查与报告

[English](c15-verification-checks.md) | 中文

<a id="summary"></a>
## 摘要

验证检查报告本人自己的 Delo 是否符合本人的预期。检查是一个已注册的函数，它检视 home 的某一部分，并产生四种结果之一。检查在 home 的进程中以本人的权限运行。其报告列出每项结果及一段简短详情，详情从不包含密钥或文件内容；只有当模式为 `enforce` 且每项检查都通过时，徽章才显示为绿色。检查用于发现漂移、其他程序的篡改以及错误配置。它们不会阻止拥有该机器的本人，模式决定哪些结果会阻止启动或远程访问。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [约定](#contract)
  - [注册表条目](#registry-entry)
  - [检查与阶段](#checks-and-stages)
  - [结果](#results)
  - [模式](#modes)
  - [报告](#report)
  - [徽章](#badge)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="registry-entry"></a>
### 注册表条目

每项检查是 `@delorun/integrity` 检查注册表中的一个条目。条目包含下列字段。

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `id` | 小写 kebab-case 字符串。 | 在注册表中唯一，且永不复用。 |
| `blocks` | `none`、`start`、`reach` 或 `start-always`。 | 指明该检查在 `enforce` 模式下唯一可产生的效果；`start-always` 则在每种模式下适用。 |
| `subject` | 字符串。 | 以定义该检查的约定所用的术语，说明它检视的对象。 |

<a id="checks-and-stages"></a>
### 检查与阶段

阶段为 `start`、`update`、`change` 与 `verify`。`start` 在 home 启动时运行。`update` 在更新应用之后运行。`change` 在远程访问选项或运行时变化之后运行。`verify` 在 `delorun verify` 运行时以及 studio 的验证面板刷新时运行。每一项已注册的检查都在每次运行中运行，报告会写明该次运行的阶段。

注册表包含下列检查。

| `id` | `blocks` | 检视的对象 |
| --- | --- | --- |
| `release-signature` | `start-always` | 已安装发布版本的签名及其发布日志条目，依据发布约定；经验证的失败在每种模式下都会阻止启动。 |
| `runtime-files` | `start` | 运行时文件与已签名清单的比对，依据发布约定。文件被改动即为 `fail`。 |
| `workspace-isolation` | `none` | 每个工作区实际生效的隔离，以及机器上 Docker 所实施的限制。 |
| `confinement-rule` | `none` | 机器的沙箱方言是否使受限命令无法读取 Delo 的密钥与令牌，且无法连接其控制套接字与 Docker socket，依据运行时约定。无法实施该规则的方言结果为 `not-enforced`。 |
| `reach-binding` | `reach` | 远程访问监听器的绑定与生效的远程访问选项。暴露不匹配即为 `fail`。 |
| `own-domain-caa` | `reach` | 自有域名的 CAA 记录，仅就远程访问约定所指定的证书颁发机构所实施的参数进行检查。 |
| `certificates` | `reach` | home 名称的证书状态，以及 home 已发出的证书告警。 |
| `owner-and-devices` | `none` | 所有者、受信任设备，以及每个远程访问地址的身份因子。 |
| `plugin-pins` | `none` | 插件固定版本、兼容徽章与撤销列表。 |
| `data-sharing` | `none` | 上游的两项选择加入项，按本人的设定为开或关。 |
| `home-modes` | `none` | `~/.delorun` 及其密钥文件的模式。若模式含有组或其他用户的位，即为 `fail`，且详情写明修正它的 `chmod` 命令。 |

启动器的运行时哈希检查不在注册表之内。它在每种模式下都会阻止被改动的运行时，因此修改 `@delorun/integrity` 包不会使其失效。

每条沙箱规则的状态都映射为一个验证检查结果：`enforced` 为 `pass`，`not-enforced` 为 `not-enforced`，`unconfined` 为 `fail`，`unknown` 为 `unknown`。 `confinement-rule` 检查对 [C1](c01-home-layout.zh.md#confinement-rules) 的每条规则应用该映射。

<a id="results"></a>
### 结果

一项检查产生四种结果之一。

- `pass`：所检视的状态符合约定的要求。
- `fail`：所检视的状态与要求不符，原因是漂移、篡改或错误配置。
- `not-enforced`：机器无法实施该要求，例如某个沙箱方言无法拒绝对某个套接字的连接。
- `unknown`：检查无法完成，例如其读取的某项输入不存在或无法读取。

<a id="modes"></a>
### 模式

模式为 `warn`、`enforce` 或 `off`。本人可在设置中以键 `integrity.mode` 设定它，也可用 `delorun verify --mode` 设定。

- `warn`，即默认值：检查在各自的阶段运行，并报告每项结果。除 `start-always` 的 `fail` 会阻止启动之外，没有任何结果会阻止启动或远程访问。启动器的运行时哈希检查仍会阻止被改动的运行时。
- `enforce`：`blocks` 为 `start` 的检查若产生 `fail`，则阻止启动。`blocks` 为 `reach` 的检查若产生 `fail`，则阻止远程访问，直至结果通过。`blocks` 为 `none` 的检查若产生 `fail`，除报告与徽章外没有其他效果。
- `start-always`，只用于 `release-signature`：`fail` 在每种模式下都会阻止启动，包括 `warn` 与 `off`。这种 `fail` 即经验证的发布签名或发布日志条目失败，对应 [C18](c18-release-log.zh.md) 的 `failed` 状态。`unknown` 结果永远不会阻止启动。
- `off`：检查不在 `start`、`update` 或 `change` 时运行，但 `release-signature` 在每种模式下都会于 `start` 时进行离线验证。`integrity.mode: off` 同时停止自动运行的在线发布日志检查（[C18](c18-release-log.zh.md)）与撤销列表获取（[C13](c13-catalogue-revocation.zh.md)）。`delorun verify` 与验证面板仍会按请求运行检查，并将模式显示为 `off`。

每个显示结果的界面都会同时显示模式。在任何模式下，`not-enforced` 与 `unknown` 结果都不会阻止任何操作。

<a id="report"></a>
### 报告

报告是一个 JSON 对象，包含下列字段。

```json
{
  "schemaVersion": 1,
  "mode": "warn",
  "stage": "verify",
  "generatedAt": "<RFC 3339 UTC time>",
  "notice": "checks run with the person's access",
  "badge": "not-green",
  "checks": [
    { "id": "runtime-files", "result": "pass", "detail": "" }
  ]
}
```

| 字段 | 类型与取值 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 整数 `1`。 | 读取者拒绝任何其他值。 |
| `mode` | `warn`、`enforce` 或 `off`。 | 运行开始时生效的模式。 |
| `stage` | `start`、`update`、`change` 或 `verify`。 | 该次运行的阶段。 |
| `generatedAt` | UTC 的 RFC 3339 时间。 | 运行结束的时间。 |
| `notice` | 字符串 `checks run with the person's access`。 | 每份报告都包含它。 |
| `badge` | `green` 或 `not-green`。 | 遵循下文的徽章规则。 |
| `checks` | 每个注册表条目对应一个对象。 | 每个对象包含 `id`、`result` 与 `detail`。 |
| `checks[].detail` | 最多 512 个字符的字符串。 | 说明状态与修正方法。从不包含密钥、令牌、所有者验证码、cookie、密钥或文件内容。 |

home 报告不带签名。机器报告带有该机器密钥对报告的规范 JSON 字节（不含 `signature` 字段）所作的 `signature`，并带有 home 发出的一次性挑战，即以 base64url 编码的 32 字节值。

<a id="badge"></a>
### 徽章

只有当模式为 `enforce` 且该次运行中的每项检查都产生 `pass` 时，徽章才为 `green`。其他情况下徽章为 `not-green`。只要有一项检查失败、有一项结果为 `unknown` 或 `not-enforced`，或模式为 `warn` 或 `off`，徽章就不会显示为 `green`。

<a id="consumers"></a>
## 消费方

- `delorun/apps/cli`：`delorun verify`（含其 `--release`、`--offline` 与 `--json` 选项），运行两项已构建的检查、报告、徽章规则与物料清单（`src/verify/bill.ts` 中的 `startBill` 与 `runVerifyStage`）。`delorun status` 不显示验证结果。
- `delorun/apps/npm-launcher` 与 `delorun/packages/runtime-store`：启动器的启动检查，位于注册表之外。
- `@delorun/integrity` 包、studio 的验证面板与徽章，以及 `delorun verify --mode` 尚未构建。
- `delorun/packages/contract-verification-checks/`：注册表条目、结果、模式、阶段与报告的类型。

<a id="compatibility"></a>
## 兼容性

注册表只增不减。新增检查须在同一次变更中添加其一条记录、其 `blocks` 取值以及其植入故障的测试。检查 id 永不复用；被移除的检查，其 id 保持未分配状态以示退役。

报告中任何读取者无法忽略的字段变更，都要递增 `schemaVersion`。新增可选字段则不必递增。

检查的 `blocks` 取值属于其约定的一部分。把它从 `none` 改为 `start` 或 `reach`，等于改变了本人的启动或远程访问所依赖的内容，须在发布说明中列出。

<a id="security"></a>
## 安全

要求：

- 结果、详情或报告从不包含密钥、令牌、所有者验证码、cookie、密钥或文件内容。
- 每份报告都会写明检查以本人的权限运行，并且以该权限运行的程序可以改变检查本身。
- 只有当模式为 `enforce` 且每项检查都通过时，徽章才为绿色。
- 启动器的运行时哈希检查与注册表相互独立，因此被修改的集成包仍会使启动器的检查失败。
- `not-enforced` 与 `unknown` 结果永远不算作通过。
- 经验证的发布签名或发布日志失败在每种模式下都会阻止启动；`unknown` 或 `not-enforced` 结果永远不会阻止启动。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `modified integrity package still fails the launcher check` | 在 `@delorun/integrity` 包被改动时，启动器仍会阻止被改动的运行时文件。 |
| `planted secret never appears in a result or a report` | 被检查的配置文件中的 canary 密钥，不出现在任何检查详情、报告或 `delorun verify --json` 输出中。 |
| `group-readable device-key file fails verify with a chmod fix` | 设备密钥文件带有组或其他用户的位时，`home-modes` 失败，且其详情写明 `chmod 600` 命令。 |
| `home directory that is not 0700 fails verify with a chmod fix` | `~/.delorun` 目录带有组或其他用户的位时，`home-modes` 失败，且其详情写明 `chmod 700` 命令。 |
| `dialect that cannot enforce the confinement rule reports not-enforced` | 在无法拒绝该连接的夹具方言上，`confinement-rule` 产生 `not-enforced`，且徽章为 `not-green`。 |
| `badge is never green with a failing or unknown check` | 一次运行中只要有一项 `fail` 或一项 `unknown`，在 `enforce` 下徽章即为 `not-green`。 |
| `badge is never green outside enforce` | 一次运行中每项检查都通过，在 `warn` 与 `off` 下徽章仍为 `not-green`。 |
| `changed runtime file stops start in every mode` | 被改动的运行时文件，在 `warn` 与 `enforce` 下都会阻止启动器启动。 |
| `enforce stops start on a runtime fail` | 在 `enforce` 下，`runtime-files` 的 `fail` 会阻止启动。 |
| `enforce blocks reach on an exposure mismatch` | 在 `enforce` 下，`reach-binding` 的 `fail` 会阻止远程访问，直至结果通过。 |
| `warn blocks nothing except a start-always fail` | 在 `warn` 下，除 `release-signature` 的 `fail` 外，没有任何 `fail` 会阻止启动或远程访问。 |
| `verified release failure stops start in every mode` | `release-signature` 的 `fail` 在 `warn`、`enforce` 与 `off` 下都会阻止启动；离线检查的 `unknown` 不会阻止启动。 |
| `off stops online checks and keeps the offline release check` | 在 `integrity.mode: off` 下，启动时启动器不发出在线发布日志请求，Host 也不发出撤销列表请求，且已存储发布版本的离线验证仍会在启动时运行。 |

验收测试：

- `each check fails on a planted fault in a fixture home`（每项检查在夹具 home 中植入的故障下都会失败）。
- `every interface shows the mode with each result`（每个显示结果的界面都同时显示模式）。
- `off mode runs no online check at start, update or change; the offline release check still runs at start`（`off` 模式在 `start`、`update` 或 `change` 时不运行在线检查；离线发布检查仍在 `start` 时运行）。
- `verify --json output states the notice and the mode`（`verify --json` 的输出写明说明与模式）。

<a id="decided-values"></a>
## 决定的取值

- 默认模式为 `warn`。
- 设置键为 `integrity.mode`。
- 阶段为 `start`、`update`、`change` 与 `verify`。
- 结果为 `pass`、`fail`、`not-enforced` 与 `unknown`。
- 报告 schema 版本为 `1`，详情最多 512 个字符。
- 说明文字为 `checks run with the person's access`。
- 机器报告以 Ed25519 对规范 JSON 签名，并携带 32 字节的 base64url 挑战。
