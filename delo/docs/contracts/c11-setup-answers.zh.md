---
description: "约定 C11：setup 所问的问题、回答的 schema、每个回答产生的 profile 写入、--yes 与 --config 形式，以及 setup 所作的说明。"
---

# 约定 C11：setup 回答

[English](c11-setup-answers.md) | 中文

<a id="summary"></a>
## 摘要

setup 回答是 `delorun setup` 在新 home 上所问的固定问题、保存每个回答的 schema、每个回答产生的 profile 写入，以及在没有终端时给出相同回答的 `--yes` 与 `--config` 形式。studio 新手引导与同意屏幕对上游的两项选择加入使用相同的回答。Delo 自身没有遥测，setup 在询问上游的选择加入项之前会说明这一点。两项选择加入默认均为关闭。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [约定](#contract)
  - [问题](#questions)
  - [回答 schema](#answer-schema)
  - [profile 写入](#profile-writes)
  - [--yes 与 --config 形式](#yes-and-config-forms)
  - [说明](#statements)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="questions"></a>
### 问题

setup 按以下顺序提出这些问题。本人接受默认值时即采用该默认值，`--yes` 形式对未另行设定的每个问题使用默认值。

| 问题 | 回答 | 默认值 |
| --- | --- | --- |
| 模型提供方与密钥 | 上游提供的 provider id，以及一个凭据。 | `deepseek-official`，凭据在提示处输入。 |
| 运行时 | `native`，或 `docker` 加一种形态与一种资源预设。 | `native` |
| studio 附加功能 | 开或关。关闭即 stock 外观。 | 开 |
| 从任何地方远程访问 | 无、Tailscale 私有、Tailscale Funnel 或自托管中继。 | 无 |
| 远程访问开启时的身份因子 | 通行密钥、OpenID Connect 登录，或用于 tailnet 私有远程访问的 tailnet 身份。 | 远程访问为无时为无。每个公开远程访问方式都必须有一个。 |
| 设置其他模型 | 是或否。选择是会设置 studio 新手引导标志，用于推荐提供方插件。 | 否 |
| 上游桌面分析 | 开或关。 | 关 |
| DeepSeek 会话日志上传 | 开或关。 | 关 |
| 导入 stock DeepSeek Harness home | 是或否。仅当 `~/.dsh` 存在 stock home 时提供。 | 否 |

Delo 中继不在 setup 的远程访问选项之列。setup 读取 stock home 只是为了从中复制，且从不修改它。

<a id="answer-schema"></a>
### 回答 schema

回答文档是一个 JSON 对象，包含下列字段。交互式 setup 填写它，`--config` 读取它，二者使用同一 schema。

```json
{
  "schemaVersion": 1,
  "modelProvider": { "id": "deepseek-official", "credential": { "source": "environment", "name": "DEEPSEEK_API_KEY" } },
  "studioAdditions": true,
  "runtime": { "kind": "native" },
  "reach": { "option": "none", "identityFactor": null },
  "helpSetUpModels": false,
  "sessionLogUpload": false,
  "desktopAnalytics": false,
  "importStockHome": false
}
```

| 字段 | 类型与取值 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `schemaVersion` | 整数 `1`。 | `1` | setup 拒绝任何其他值。 |
| `modelProvider.id` | 上游提供的 provider id。 | `deepseek-official` | setup 拒绝上游未提供的 id。 |
| `modelProvider.credential` | `{ "source": "prompt" }`，或 `{ "source": "environment", "name": "<variable>" }`。 | `{ "source": "prompt" }` | `prompt` 只在交互形式中接受。 |
| `studioAdditions` | 布尔值。 | `true` | `false` 选择 stock 外观。 |
| `runtime` | `{ "kind": "native" }`，或 `{ "kind": "docker", "shape": "S2" 或 "S3", "preset": "small"、"balanced"、"large" 或 "advanced" }`。 | `{ "kind": "native" }` | Docker 形态与预设取自 Docker 运行时约定。 |
| `reach.option` | `none`、`tailscale-private`、`tailscale-funnel` 或 `self-hosted-relay`。 | `none` | 非 `none` 的取值只在交互形式中接受。 |
| `reach.identityFactor` | `passkey`、`oidc`、`tailnet` 或 `null`。 | `null` | 选项为 `none` 时为 `null`。`tailscale-funnel` 与 `self-hosted-relay` 只能为 `passkey` 或 `oidc`。`tailscale-private` 可为 `passkey`、`oidc` 或 `tailnet`。 |
| `helpSetUpModels` | 布尔值。 | `false` | 设置新手引导标志。 |
| `sessionLogUpload` | 布尔值。 | `false` | 对应上游的会话日志选择加入项。 |
| `desktopAnalytics` | 布尔值。 | `false` | 对应上游的桌面分析选择加入项。 |
| `importStockHome` | 布尔值。 | `false` | 启动导入 stock home；这是一项动作，不是 profile 写入。 |

回答文档从不包含凭据的取值。凭据要么在提示处输入并存入上游的凭据存储，要么从 `credential.name` 所指定的环境变量读取。

<a id="profile-writes"></a>
### profile 写入

每个回答产生下列写入。配置写入进入其所属 profile 各自的 `cordis.patch.yml`，上游在 bundle 之后应用该文件。

| 回答 | 写入 | 目标 |
| --- | --- | --- |
| `modelProvider` | 上游保存的模型选择，经由上游的设置写入。凭据进入上游的凭据存储。 | `default` profile 的设置。 |
| `studioAdditions` | `@delo/bundle-studio` 的 stock 外观开关。 | `default` profile。 |
| `runtime` | Docker 运行时约定中的运行时行。`native` 不写入任何行。 | `default` profile。 |
| `reach.option` | 远程访问约定中的远程访问行。`none` 不写入任何行。仅在交互形式中写入。 | `default` profile。 |
| `reach.identityFactor` | 针对远程访问地址的登记请求。无配置行。 | home 认证状态，遵循身份约定。 |
| `helpSetUpModels` | studio 新手引导标志。 | `default` profile。 |
| `sessionLogUpload` | `session-log-deepseek` 行的 `config.enabled`。 | `default` profile。 |
| `desktopAnalytics` | `product-analytics` 行的 `config.enabled`。 | `desktop` profile；该 profile 不存在时 setup 会创建它。 |
| `importStockHome` | 按归档约定导入 stock home。 | 不是 profile 写入。 |

上游的会话遥测行 `session-telemetry-otel` 不是一个回答。只有本人提交反馈后，它才会发送会话日志前缀，setup 在下面的说明中陈述这一行为。反馈对话框在本人发送前显示确切的载荷（包括会话日志前缀）及其目的地。

<a id="yes-and-config-forms"></a>
### --yes 与 --config 形式

`--yes` 接受每个默认值。它不应用默认值之外的任何回答，并从 `credential.name` 所指定的环境变量读取模型凭据，该名称默认为 `DEEPSEEK_API_KEY`。该变量未设置时，setup 以一个带类型的错误停止，并写明变量名。

`--config <file>` 读取符合上述 schema 的回答文档，并按与 `--yes` 相同的规则应用其回答。若其 `reach.option` 不是 `none`，或其 `sessionLogUpload` 或 `desktopAnalytics` 为 `true`，则该文档以带类型的错误被拒绝，错误中写明字段名。任何字段中若带有凭据取值的文档会被拒绝，且不回显该取值。

对于相同的回答，交互形式与 `--yes` 或 `--config` 形式写入的 profile 文件完全相同。

setup 会在未完成的第一步处恢复被中断的运行。被重新执行的步骤写入相同的取值。

<a id="statements"></a>
### 说明

setup 在询问上游的选择加入项之前显示以下说明，并在审阅屏幕上重复显示。

- Delo 自身没有遥测。
- 上游的桌面分析与 DeepSeek 的会话日志上传除非您开启，否则均为关闭。
- 上游的反馈发送包含会话日志前缀，且仅在您提交反馈时发生。
- 身份因子已登记时，恢复使用恢复套件与 home 的终端；未登记任何身份因子时，恢复仅能通过 home 的终端进行。
- Docker 组成员身份等同于 root，setup 推荐使用 rootless Docker。
- 当系统的沙箱方言无法实施运行时约定中的隔离规则时，Docker 选项会标明为未实施。

<a id="consumers"></a>
## 消费方

- `delo/apps/cli/src/setup/`：setup 屏幕及其 `--yes` 与 `--config` 形式。
- `delo/packages/bundle-local`：上游选择加入项的配置行，以及 studio 中对应的同意屏幕。
- `delo/packages/plugin-onboarding/`：studio 新手引导标志。
- `delo/packages/contract-setup-answers/`：回答类型、默认值与 profile 行名称。

<a id="compatibility"></a>
## 兼容性

回答 schema 通过 `schemaVersion` 标记版本，其值为 `1`。若新增的问题带有安全的默认值，且忽略该新字段的旧读取者写入的 profile 相同，则该变更保持版本不变。改变既有回答含义，或删除字段，都会递增版本。setup 拒绝其不认识版本的回答文档。

上游新增的选择加入项，以默认关闭的问题形式加入，并在同一次变更中把其 profile 行加入映射表。

<a id="security"></a>
## 安全

要求：

- `--yes` 与 `--config` 永远不会开启远程访问、凭据转发、上游的桌面分析或上游的会话日志上传。
- 上游的选择加入项可用，默认关闭。只有本人在 setup 或同意屏幕上开启，它们才会生效。
- Delo 不发送任何自身遥测。
- 凭据取值永远不会出现在回答文档、profile 文件、进程参数或日志中。
- setup 不写入任何开启凭据转发的行。转发依据运行时约定按工作区设定。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `yes run leaves reach and credential forwarding off` | `--yes` 之后，profile 中没有远程访问行，也没有转发行。 |
| `config file cannot enable reach` | `reach.option` 不是 `none` 的文档，会被拒绝，并返回写明 `reach.option` 的带类型的错误。 |
| `config file cannot enable upstream opt-ins` | `sessionLogUpload` 或 `desktopAnalytics` 为 `true` 的文档，会被拒绝，并返回写明该字段的带类型的错误。 |
| `config file carrying a credential value is refused` | 任何字段中带有凭据取值的文档会被拒绝，且不回显该取值。 |
| `default-profile run sends no analytics or upload` | 在默认 profile 中，网络夹具不记录任何发往分析端点的请求，也没有会话日志上传。 |
| `default-profile model request carries no dsh_session_log` | 默认 profile 发出的模型请求不包含 `dsh_session_log` 字段。 |

验收测试：

- `setup states the telemetry statement and that both opt-ins default to No`（setup 陈述遥测说明，并说明两项选择加入默认为否）。
- `interactive and --yes runs write identical profile files`（交互运行与 `--yes` 运行写入相同的 profile 文件）。
- `interrupted setup resumes without a repeated write`（被中断的 setup 恢复时不重复写入）。
- `consent screen turns each upstream opt-in on alone and off again from the same screen`（同意屏幕可单独开启每一项上游选择加入项，并在同一屏幕上再次关闭）。
- `Docker option carries the not-enforced label on a dialect that cannot enforce the confinement rule`（在无法实施隔离规则的方言上，Docker 选项带有未实施标记）。

<a id="decided-values"></a>
## 决定的取值

- 回答 schema 的版本为 `1`。
- 默认值为：提供方 `deepseek-official`，运行时 `native`，studio 附加功能开，远程访问 `none`，以及新手引导标志、两项上游选择加入项和 stock home 导入均为关。
- 默认凭据变量为 `DEEPSEEK_API_KEY`。
- setup 的远程访问选项为 `none`、`tailscale-private`、`tailscale-funnel` 与 `self-hosted-relay`。
- 反馈发送不是一个回答，setup 会对其作出说明。
