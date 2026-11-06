---
description: "约定 C17：插件接受检查的两条版本轴，即上游的 engines.dsh 对照 @deepseek-ai/dsh-app-boot，以及 Delo 的 engines.delo 对照 Delo 自身的版本；插件如何声明它们、精确版本豁免、每种不匹配情形下的拒绝与报告消息，以及 delorun --version 的输出。"
---

# C17 插件版本要求

[English](c17-plugin-versions.md) | 中文

## 摘要

Delo 有自己的语义化版本，并基于一个上游 DSH 版本构建，因此插件要在两条轴上接受检查。上游轴保持不变：由上游的 `evaluatePluginCompatibility` 对照 `@deepseek-ai/dsh-app-boot` 的版本检查 `engines.dsh`；没有 `engines.dsh` 时，检查插件对 `@deepseek-ai/dsh*` 的对等依赖（peer dependency）。Delo 轴是 `engines.delo`，按相同规则对照 Delo 的版本检查。为 stock DSH 编写的插件不声明 `engines.delo`，在 Delo 轴上视为兼容。每条轴都有自己的精确版本豁免，由本人（the person）在看到风险警告后授予。每条拒绝与每条更新报告条目都写明两个版本。类型位于 [`@delo/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md)。

## 目录

- [两个版本](#the-two-versions)
- [声明要求](#declaring-requirements)
- [评估](#evaluation)
- [豁免](#exemptions)
- [结果与消息](#results-and-messages)
- [版本输出](#version-output)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)

<a id="the-two-versions"></a>

## 两个版本

| 轴 | 版本 | 来源 |
| --- | --- | --- |
| 上游 | DSH 版本 | 正在运行的运行时中 `@deepseek-ai/dsh-app-boot` 的 `version`，由上游 [`plugin-compatibility.ts`](../../../packages/boot/app-boot/src/plugin-compatibility.ts) 中的 `getDshRuntimeVersion()` 读取。发布 manifest（元数据清单）将其记录为 `dsh`（[C2](c02-release-manifest.zh.md#release-manifest)）。 |
| Delo | Delo 版本 | Delo 的发布版本号，即 manifest 的 `version`，每个 Delo 进程都通过 `delo/apps/cli/src/version.ts` 读取；桌面应用的应用版本与之相同。 |

两者都是语义化版本；预发布版本（`1.0.0-rc.1`）参与范围匹配。

<a id="declaring-requirements"></a>

## 声明要求

插件在其 `package.json` 中声明两者：

```json
{
  "name": "example-delo-plugin",
  "version": "1.4.0",
  "engines": {
    "dsh": ">=0.2.2 <0.3.0",
    "delo": ">=1.0.0 <2.0.0"
  }
}
```

- `engines.dsh` 原样遵循上游规则：存在时，它单独决定上游轴；不存在时，每个 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 对等依赖都必须匹配，其中 `workspace:^`、`workspace:~` 与 `workspace:*` 表示正在运行的版本。
- `engines.delo` 是一个语义化版本范围字符串。它单独决定 Delo 轴；对 `@delo/*` 包的对等依赖不用于该轴。
- 未声明 `engines.delo` 的插件没有 Delo 要求。
- 插件索引的索引文件把两个范围复制到每个版本条目中（[C13](c13-catalogue-revocation.zh.md#catalogue-index)）。

<a id="evaluation"></a>

## 评估

对每条轴，使用 `semver.satisfies(version, range, { includePrerelease: true })`：

| 声明 | 上游轴 | Delo 轴 |
| --- | --- | --- |
| 版本满足的范围 | 满足 | 满足 |
| 版本不满足的范围 | 未满足 | 未满足 |
| 空字符串、`workspace:` 值或无效范围 | 未满足 | 未满足 |
| 非字符串 | 不可读 | 不可读 |
| 不存在 | 由对等依赖规则决定：满足或未满足；插件没有 DSH 对等依赖时为 `none` | `none` |

不可读的声明按未满足处理：上游拒绝它无法校验的要求元数据，Delo 轴同样如此。评估只读取插件的 manifest，从不导入插件代码。

各轴在以下时机接受检查：

- 安装时，由插件管理器在添加该包之前检查；
- 每次启动时，由上游的 profile 预检（[`compatibility-preflight.ts`](../../../packages/boot/app-boot/src/compatibility-preflight.ts) 中的 `prepareProfileEntries`）检查，它在 Loader 导入未满足要求的条目之前将其停用，并在 studio 中报告，提供 Update、Keep disabled 与 Roll back；
- 更新之前，对照目标发布版本的两个版本检查，用于更新报告（[C3](c03-update-report.zh.md)）；
- 在插件索引语料库中检查，语料库记录徽章运行时所用的版本（[C13](c13-catalogue-revocation.zh.md#badge-record)）。

<a id="exemptions"></a>

## 豁免

本人可以在看到运行它可能导致崩溃或数据丢失的警告之后，为一个精确的插件版本在该轴的一个精确版本上接受未满足的要求。

| 轴 | profile 目录中的文件 | 命令 |
| --- | --- | --- |
| 上游 | `compatibility.json`，上游的文件，保持不变 | `delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk` |
| Delo | `delo-compatibility.json`，相同的记录格式：精确的 `package@version` 键映射到精确 Delo 版本的列表 | `delorun plugin allow-version <package>@<version> --delo-version <delo> --accept-risk` |

- 两个文件都在该文件的锁下以模式 0600 原子写入，与上游 `setProfileVersionExemption` 写入 `compatibility.json` 的方式相同。
- 授予必须写明其轴的正在运行的版本；撤销可以写明更早的版本。
- 文件缺失时不授予任何豁免；文件不可读时不授予任何豁免并予以报告，profile 仍会启动。
- 一项豁免只覆盖一条轴：在两条轴上都未满足的插件需要两项豁免。
- 授予是一次 profile 变更，记录为一个 profile 历史（profile history）版本。

<a id="results-and-messages"></a>

## 结果与消息

对照一对版本评估一个插件的结果：

| 字段 | 含义 |
| --- | --- |
| `plugin` | 来自 manifest 的 `{ "name", "version" }`。 |
| `dsh` | 所检查的 DSH 版本。 |
| `delo` | 所检查的 Delo 版本。 |
| `axes.dsh`、`axes.delo` | 各为 `{ "status", "requirement"?, "exempted" }`；`status` 为 `met`、`unmet`、`unreadable` 或 `none`。 |

消息在日志与 stderr 中为英文，在 studio 中本地化：

| 情形 | 消息 |
| --- | --- |
| 安装被拒绝，上游轴 | `<package>@<version> requires DSH <range>; this is Delo <delo> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk.` |
| 安装被拒绝，Delo 轴 | `<package>@<version> requires Delo <range>; this is Delo <delo> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --delo-version <delo> --accept-risk.` |
| 安装被拒绝，不可读 | `<package>@<version> declares engines.<axis> in a form Delo cannot read; this is Delo <delo> on DSH <dsh>. It was not installed.` |
| 启动时停用 | `Disabled <package>@<version>: it requires <DSH or Delo> <range>, and this is Delo <delo> on DSH <dsh>.` |
| 已豁免 | `<package>@<version> requires <DSH or Delo> <range>; it runs on Delo <delo> on DSH <dsh> because you accepted the risk for this exact version.` |

每种情形对应的更新报告条目见 [C3](c03-update-report.zh.md#reasons)。

<a id="version-output"></a>

## 版本输出

`delorun --version` 恰好打印两行：

```text
Delo 1.0.0
DSH 0.2.2
```

`delorun --version --json` 打印一行：`{"delo":"1.0.0","dsh":"0.2.2"}`。验证面板与 `delorun status` 显示相同的两个版本。

<a id="consumers"></a>

## 消费方

- 上游 app-boot 中 `plugin-compatibility.ts` 的差异块，以及 `delo/apps/cli/src/version.ts`（WP3.8）。
- 更新前报告（WP3.4，[C3](c03-update-report.zh.md)）。
- 插件索引语料库与徽章（WP7.2，[C13](c13-catalogue-revocation.zh.md)）。

<a id="compatibility"></a>

## 兼容性

上游的轴、它的对等依赖规则、`compatibility.json` 与 `dsh plugin allow-version` 保持不变，因此 stock DSH 插件在 Delo 上的安装与加载与在 stock DSH 上完全相同。stock DSH 忽略 `engines.delo`，因此声明了它的插件仍可安装在 stock DSH 上，那里只检查其上游要求。在对等组合（[C16](c16-parity-composition.md)）中，Delo 轴保持开启，因为它不改变任何模型可见的输入。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 在任一轴上要求未满足或不可读的插件，安装时被拒绝，启动时被停用，绝不会被静默加载。
- R2. 每条拒绝与每份报告都写明 Delo 版本与 DSH 版本。
- R3. 一项豁免只覆盖一个精确插件版本、一条轴与一个精确版本，需要本人明确接受风险，并以模式 0600 存储。
- R4. 评估从不导入插件代码。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 负责方 | 所表明的行为 |
| --- | --- | --- |
| `c17-newer-delo-required-refused` | WP3.8 | `engines.delo` 为 `>=2.0.0` 的插件在 Delo 1.x 上安装时被拒绝，消息写明两个版本。 |
| `c17-unmet-delo-disabled-at-start` | WP3.8 | 已安装插件的 `engines.delo` 不被正在运行的 Delo 满足时，该插件在导入之前被停用，并在 studio 中报告。 |
| `c17-unreadable-delo-refused` | WP3.8 | `engines.delo` 为数字的插件作为不可读被拒绝。 |
| `c17-exemption-one-axis-only` | WP3.8 | Delo 轴的豁免不会放行上游要求同样未满足的插件。 |
| `c17-exemption-needs-accept-risk` | WP3.8 | 未带 `--accept-risk`、或写明的 Delo 版本不是正在运行版本的授予被拒绝。 |
| `c17-stock-plugin-unaffected` | WP3.8 | 没有 `engines.delo` 的插件的安装与加载与在 stock DSH 上完全相同。 |
| `c17-version-output` | WP3.8 | `delorun --version` 打印包含 Delo 版本与 DSH 版本的两行。 |
