---
description: "约定 C17：插件接受检查的两条版本轴，即上游的 engines.dsh 对照 @deepseek-ai/dsh-app-boot，以及 Delorun 的 engines.delorun 对照 Delorun 自身的版本；插件如何声明它们、精确版本豁免、每种不匹配情形下的拒绝与报告消息，以及 delorun --version 的输出。"
---

# C17 插件版本要求

[English](c17-plugin-versions.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

Delorun 有自己的语义化版本，并基于一个上游 DSH 版本构建，因此插件要在两条轴上接受检查。上游轴保持不变：由上游的 `evaluatePluginCompatibility` 对照 `@deepseek-ai/dsh-app-boot` 的版本检查 `engines.dsh`；没有 `engines.dsh` 时，检查插件对 `@deepseek-ai/dsh*` 的对等依赖（peer dependency）。Delorun 轴是 `engines.delorun`，按相同规则对照 Delorun 的版本检查。为 stock DSH 编写的插件不声明 `engines.delorun`，在 Delorun 轴上视为兼容。每条轴都有自己的精确版本豁免，由本人（the person）在看到风险警告后授予。每条拒绝与每条更新报告条目都写明两个版本。[C22](c22-delorun-plugin-interface.zh.md) 规定 Delorun 版本对声明了 `engines.delorun` 的插件作出哪些承诺，`delorun plugin check` 让作者在安装之前看到自己的范围允许什么。类型位于 [`@delorun/contract-plugin-versions`](../../packages/contract-plugin-versions/README.zh.md)。

<a id="status"></a>

## 状态

两条轴在安装时、`delorun` 运行的 profile 每次启动时以及更新报告中都会检查；Delorun 轴的豁免、studio 的报告以及此处列出的消息尚未构建。

- **已构建并已使用：** 上游 app-boot 中的 `evaluatePluginCompatibility` 对照 `delorun` 导出的 Delorun 版本检查 `engines.delorun`；插件管理器在任一轴不满足时拒绝安装，上游的 profile 预检在 Loader 导入之前停用未满足的行，`delorun update` 的报告写明两条轴，`delorun --version` 打印两个版本。上游轴的豁免通过 `delorun plugin --profile default allow-version ... --dsh-version` 生效，该命令透传给上游。
- **尚未构建：** Delorun 轴的豁免：没有任何代码写入 `delorun-compatibility.json`，Delorun 不匹配从不被豁免，`delorun plugin --profile default allow-version ... --delorun-version` 被上游的参数解析器拒绝，尽管打印出的补救办法写明了它；带有 Update、Keep disabled 与 Roll back 的 studio 报告，因为启动时被停用的行只通过标准错误上的一行报告；下文的消息表，因为已构建的文本是上游的句子后接 Delorun 的句子；目录语料库及其徽章；显示这些版本的 Verification 面板与 `delorun status`。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

## 目录

- [状态](#status)
- [两个版本](#the-two-versions)
- [声明要求](#declaring-requirements)
- [评估](#evaluation)
- [安装之前检查插件](#checking-a-plugin-before-it-is-installed)
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
| Delorun | Delorun 版本 | Delorun 的发布版本号，即 manifest 的 `version`，每个 Delorun 进程都通过 `delorun/apps/cli/src/version.ts` 读取；桌面应用的应用版本与之相同。 |

两者都是语义化版本；预发布版本（`1.0.0-rc.1`）参与范围匹配。

<a id="declaring-requirements"></a>

## 声明要求

插件在其 `package.json` 中声明两者：

```json
{
  "name": "example-delorun-plugin",
  "version": "1.4.0",
  "engines": {
    "dsh": ">=0.2.2 <0.3.0",
    "delorun": ">=1.0.0 <2.0.0"
  }
}
```

- `engines.dsh` 原样遵循上游规则：存在时，它单独决定上游轴；不存在时，每个 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 对等依赖都必须匹配，其中 `workspace:^`、`workspace:~` 与 `workspace:*` 表示正在运行的版本。
- `engines.delorun` 是一个语义化版本范围字符串。它单独决定 Delorun 轴；对 `@delorun/*` 包的对等依赖不用于该轴。
- **On Delorun, `engines.delorun` decides alone when it is declared.** Delorun then reads neither `engines.dsh` nor the `@deepseek-ai/dsh*` peers, so a range there that Delorun's base DSH version does not meet, or a malformed one, changes nothing. Stock DSH ignores `engines.delorun` and checks `engines.dsh` as always.
- 未声明 `engines.delorun` 的插件没有 Delorun 要求。
- Package-manager peer warnings are not this check. pnpm may print a warning for an unmet `@deepseek-ai/dsh*` peer when it installs the plugin; Delorun leaves it, and it neither admits nor refuses the plugin.
- 插件索引的索引文件把两个范围复制到每个版本条目中（[C13](c13-catalogue-revocation.zh.md#catalogue-index)）。

<a id="evaluation"></a>

## 评估

对每条轴，使用 `semver.satisfies(version, range, { includePrerelease: true })`：

| 声明 | 上游轴 | Delorun 轴 |
| --- | --- | --- |
| 版本满足的范围 | 满足 | 满足 |
| 版本不满足的范围 | 未满足 | 未满足 |
| 空字符串、`workspace:` 值或无效范围 | 未满足 | 未满足 |
| 非字符串 | 不可读 | 不可读 |
| 不存在 | 由对等依赖规则决定：满足或未满足；插件没有 DSH 对等依赖时为 `none` | `none` |

不可读的声明按未满足处理：上游拒绝它无法校验的要求元数据，Delorun 轴同样如此。评估只读取插件的 manifest，从不导入插件代码。

各轴在以下时机接受检查：

- 安装时，由插件管理器在添加该包之前检查；
- 每次启动时，由上游的 profile 预检（[`compatibility-preflight.ts`](../../../packages/boot/app-boot/src/compatibility-preflight.ts) 中的 `prepareProfileEntries`）检查，它在 Loader 导入未满足要求的条目之前将其停用，并在标准错误上打印一行写明该条目和原因，studio 不显示任何报告；
- 更新之前，对照目标发布版本的两个版本检查，用于更新报告（[C3](c03-update-report.zh.md)），使用同样的上游函数和目标的版本，因此对等依赖规则在那里同样适用；
- 由更新检查，对照通道上最新发布的两个版本，统计它会停用多少个已安装的插件（[C3](c03-update-report.zh.md#update-check)）；
- 在插件索引语料库中检查，语料库记录徽章运行时所用的版本（[C13](c13-catalogue-revocation.zh.md#badge-record)）。

<a id="checking-a-plugin-before-it-is-installed"></a>

## 安装之前检查插件

`delorun plugin check <directory>` 在不运行插件任何文件的情况下读取其 `package.json`，并用安装程序自己的函数 `evaluatePluginCompatibility` 与 `evaluateDelorunRequirement` 对照运行中的版本评估两条轴，不应用任何豁免；更新报告与更新检查调用的是同样的函数。它打印每个已声明范围允许什么、哪些未声明、以运行中 Delorun 次版本为目标的 `engines.delorun` 范围，以及安装程序是否接纳该插件；其输出与退出码见 [C22](c22-delorun-plugin-interface.zh.md#checking-a-plugin)。插件只用 `engines.delorun` 即可以 Delorun 为目标：Delorun 轴从不覆盖上游轴，使用上游接口的插件仍须声明 `engines.dsh`。

<a id="exemptions"></a>

## 豁免

本人可以在看到运行它可能导致崩溃或数据丢失的警告之后，为一个精确的插件版本在该轴的一个精确版本上接受未满足的要求。

| 轴 | profile 目录中的文件 | 命令 |
| --- | --- | --- |
| 上游 | `compatibility.json`，上游的文件，保持不变 | `delorun plugin --profile default allow-version <package>@<version> --dsh-version <dsh> --accept-risk` |
| Delorun | `delorun-compatibility.json`，相同的记录格式：精确的 `package@version` 键映射到精确 Delorun 版本的列表；尚未构建：没有任何东西写入它，并且启动检查不读取任何 Delorun 豁免 | `delorun plugin --profile default allow-version <package>@<version> --delorun-version <delorun> --accept-risk`；尚未构建：上游的解析器拒绝 `--delorun-version` |

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
| `delorun` | 所检查的 Delorun 版本。 |
| `axes.dsh`、`axes.delorun` | 各为 `{ "status", "requirement"?, "exempted" }`；`status` 为 `met`、`unmet`、`unreadable` 或 `none`。 |

消息在日志与 stderr 中为英文，在 studio 中本地化：

| 情形 | 消息 |
| --- | --- |
| 安装被拒绝，上游轴 | `<package>@<version> requires DSH <range>; this is Delorun <delorun> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --dsh-version <dsh> --accept-risk.` |
| 安装被拒绝，Delorun 轴 | `<package>@<version> requires Delorun <range>; this is Delorun <delorun> on DSH <dsh>. Install a compatible version, or accept the risk for this exact version with delorun plugin allow-version <package>@<version> --delorun-version <delorun> --accept-risk.` |
| 安装被拒绝，不可读 | `<package>@<version> declares engines.<axis> in a form Delorun cannot read; this is Delorun <delorun> on DSH <dsh>. It was not installed.` |
| 启动时停用 | `Disabled <package>@<version>: it requires <DSH or Delorun> <range>, and this is Delorun <delorun> on DSH <dsh>.` |
| 已豁免 | `<package>@<version> requires <DSH or Delorun> <range>; it runs on Delorun <delorun> on DSH <dsh> because you accepted the risk for this exact version.` |

每种情形对应的更新报告条目见 [C3](c03-update-report.zh.md#reasons)。

<a id="version-output"></a>

## 版本输出

`delorun --version` 恰好打印两行：

```text
Delorun 1.0.0
DSH 0.2.2
```

`delorun --version --json` 打印一行：`{"delorun":"1.0.0","dsh":"0.2.2"}`。验证面板与 `delorun status` 显示相同的两个版本。

<a id="consumers"></a>

## 消费方

- 上游 app-boot 中 `plugin-compatibility.ts` 的差异块，以及 `delorun/apps/cli/src/version.ts`。
- 更新前报告（[C3](c03-update-report.zh.md)）。
- 插件索引语料库与徽章（[C13](c13-catalogue-revocation.zh.md)）。
- 更新检查的插件数量（[C3](c03-update-report.zh.md#update-check)）以及 `delorun plugin check`（[C22](c22-delorun-plugin-interface.zh.md)）。

<a id="compatibility"></a>

## 兼容性

上游的轴、它的对等依赖规则、`compatibility.json` 与 `dsh plugin allow-version` 保持不变，因此 stock DSH 插件在 Delorun 上的安装与加载与在 stock DSH 上完全相同。stock DSH 忽略 `engines.delorun`，因此声明了它的插件仍可安装在 stock DSH 上，那里只检查其上游要求。在对等组合（[C16](c16-parity-composition.zh.md)）中，Delorun 轴保持开启，因为它不改变任何模型可见的输入。

<a id="security"></a>

## 安全

<a id="requirements"></a>

### 要求

- R1. 在任一轴上要求未满足或不可读的插件，安装时被拒绝，启动时被停用，绝不会被静默加载。
- R2. 每条拒绝与每份报告都写明 Delorun 版本与 DSH 版本。
- R3. 一项豁免只覆盖一个精确插件版本、一条轴与一个精确版本，需要本人明确接受风险，并以模式 0600 存储。
- R4. 评估从不导入插件代码。

<a id="denial-tests"></a>

### 拒绝测试

| 测试 | 组件 | 所表明的行为 |
| --- | --- | --- |
| `c17-newer-delorun-required-refused` | 插件版本 | `engines.delorun` 为 `>=2.0.0` 的插件在 Delorun 1.x 上安装时被拒绝，消息写明两个版本。 |
| `c17-unmet-delorun-disabled-at-start` | 插件版本 | 已安装插件的 `engines.delorun` 不被正在运行的 Delorun 满足时，该插件在导入之前被停用，并在 studio 中报告。 |
| `c17-unreadable-delorun-refused` | 插件版本 | `engines.delorun` 为数字的插件作为不可读被拒绝。 |
| `c17-exemption-one-axis-only` | 插件版本 | A DSH-axis exemption does not admit a plugin whose `engines.delorun` is unmet. |
| `c17-delorun-decides-alone-admitted` | 插件版本 | A plugin whose `engines.delorun` the running Delorun meets and whose `engines.dsh` or DSH peer it does not is admitted at install, at start and in the update report. |
| `c17-delorun-decides-alone-refused` | 插件版本 | A plugin whose `engines.delorun` the running Delorun does not meet and whose `engines.dsh` it meets is refused, with no DSH requirement named. |
| `c17-exemption-needs-accept-risk` | 插件版本 | 未带 `--accept-risk`、或写明的 Delorun 版本不是正在运行版本的授予被拒绝。 |
| `c17-stock-plugin-unaffected` | 插件版本 | 没有 `engines.delorun` 的插件的安装与加载与在 stock DSH 上完全相同。 |
| `plugin-check-imports-no-code` | update-notice | `delorun plugin check` 读取 manifest，且不运行插件的任何文件。 |
| `plugin-check-refuses-special-files` | update-notice | 作为 FIFO 或符号链接的 manifest 被拒绝，既不等待也不跟随它。 |
| `plugin-check-escapes-manifest-text` | update-notice | manifest 的名称和范围在打印时转义终端控制字符。 |
| `c17-version-output` | 插件版本 | `delorun --version` 打印包含 Delorun 版本与 DSH 版本的两行。 |
