---
description: "在你运行大量第三方插件时更新 Delorun：Delorun 在更新之前保存什么，如何阅读更新报告中的 disabled 行并用版本豁免强行尝试某个插件，健康检查验证什么，以及之后如何回退或修复。"
---

# 在有大量插件时更新 Delorun

[English](updating-with-plugins.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页面向运行大量他人所写插件的人。如果某个发布版本不在某个插件声明的版本范围之内，它就会排除该插件，更新会把该插件关闭。你可以在决定之前看到是哪些插件，可以强行尝试其中一个，如果新的发布版本对你不适用，也可以回退。你需要通过启动器安装 Delorun，并安装有 git（前提条件见[更新](../safety-and-updates/updates.zh.md)）。各步骤按顺序进行：之前、检查、更新、之后。

## 目录

- [之前：保存了什么](#before-what-is-saved)
- [检查：阅读报告](#check-read-the-report)
- [更新：健康检查](#update-the-health-check)
- [之后：验证与回退](#after-verify-and-go-back)
- [接下来](#next)

<a id="before-what-is-saved"></a>

## 之前：保存了什么

Delorun 自己保存你的设置，所以你不必手工复制。在切换之前，它会记录一个名为 `Before update to Delorun <version>` 的 [profile 历史](../../reference/glossary.zh.md#profile-history)版本（一个[快照](../../reference/glossary.zh.md#snapshot)）。这个版本包含你的插件列表和你固定的版本、你的 bundle 列表、你的补丁以及你的插件版本豁免。它不包含插件已安装的代码；`delorun recover` 和 studio 的 Setup versions 界面会把列表带回来，profile 再据此安装。

你的 chat 不属于这个快照。大多数发布版本存储它们的方式与前一个发布版本相同，此时没有任何东西需要复制。当某个发布版本改变了 chat 数据的格式时，Delorun 会先提议复制一份。要为任何更新都做一份副本，请添加 `--data-copy`：

```text
delorun update --data-copy
```

为了保住你的 chat，还要用 `delorun export <chat-or-workspace> --out <file>` 把它们导出，它会把一个 chat，或一个工作区的记录连同其 chat 和附件，保存为另一个 home 可以导入的文件（见[日常使用](../everyday-use/daily-use.zh.md#trash-export-and-import)）。导出不包含工作区文件夹中的文件，也不包含你的插件，所以它不是项目的备份。

<a id="check-read-the-report"></a>

## 检查：阅读报告

在 Delorun 运行时运行报告。它会把发布版本安装在你的版本旁边，且不做任何更改：

```text
delorun update --report
```

阅读 `Changes` 下面的各行。每一行以该插件将发生什么开头：

- `kept`：插件会被保留。只有在你应当看到它时 Delorun 才会列出，例如在豁免下运行的插件。
- `disabled`：更新会把该插件关闭。像 `acme-tools requires DSH ^0.1.0; Delorun 0.2.0 runs DSH 0.2.2.` 这样的一行说明哪个范围排除了新的发布版本。
- `removed`：插件或 bundle 会从你的列表中移除。
- 以 `Delorun cannot predict this item.` 结尾的项目，是报告无法判定的项目，例如因为无法读取它的 `package.json`。

阅读每一条 `disabled` 行时，请想着该插件的作者。没有声明范围的插件是 `kept`，并附有一行说明其兼容性未说明。

在发布版本出现之前检查某个插件，或检查你正在编写的插件，请使用 `delorun plugin check <directory>`。它读取文件夹的 `package.json`，不运行其中的任何文件，并说明插件的每个版本范围相对于你所运行的发布版本接纳什么。它不应用任何豁免。

当某条 `disabled` 行是 DeepSeek Harness 的范围而你仍然想要该插件时，报告会打印尝试的方法。版本豁免是为某个确切的插件版本在某个确切的 DeepSeek Harness 版本上接受风险：

```text
delorun plugin allow-version acme-tools@1.2.0 --dsh-version 0.2.2 --accept-risk
```

Delorun 在保存豁免之前会打印风险。请使用报告中点名的插件版本，以及它所说的新发布版本所运行的 DeepSeek Harness 版本。豁免不会延续到下一个插件版本或下一个 Delorun 发布版本，所以其中任何一个变化时，请重复这一步。`delorun plugin version-exemptions` 列出你已有的豁免，`delorun plugin revoke-version` 移除其中一个。Delorun 的范围（`engines.delorun`）没有豁免：请向作者索取接纳新版本的发布版本，或让该插件保持关闭。

再次运行 `delorun update --report` 查看该行的变化，然后做决定。

<details>
<summary>边界情况</summary>

- 如果报告说某个插件 `runs today under your exemption` 而该豁免 `does not cover` 新版本，那么这个豁免写的是旧的 DeepSeek Harness 版本。请为新版本重新授予。
- 如果你拒绝更新，那么没有任何插件会改变，豁免仍然保存着。

</details>

<a id="update-the-health-check"></a>

## 更新：健康检查

运行 `delorun update`。它会再次打印报告并询问 `Apply the update to Delorun <version>?`。`delorun update --yes` 只确认不会关闭任何东西、不会移除任何东西、不会合并你对 Delorun 自身文件的改动、也不含 Delorun 无法预测的内容的报告，而且只在发布日志检查通过时才可用，所以插件很多时，你通常需要自己回答这个问题。报告的有效期是十分钟。

切换之后，新的发布版本有两分钟时间通过它的健康检查。该检查验证：

- 新发布版本自己的文件与其已签名的列表一致；
- studio 能够应答；
- 更新所关闭的每个插件、bundle 和 profile 条目都是报告中点名的；
- 报告中没有点名的每个条目都能无错误地加载，之前就已经加载失败的除外；
- 你的 bundle 列表就是报告所预测的那一份。

加载失败的已豁免插件，属于报告没有关闭的条目，所以检查会失败。如果任何一项检查失败，或新的发布版本停止运行，Delorun 会自行回退到你原来的发布版本和 profile，并打印哪项检查失败：`Delorun <version> failed its health check (<check>); Delorun <previous> runs again with the profile from before. See delorun logs.` 成功时它会打印 `Delorun <version> runs now.`

<a id="after-verify-and-go-back"></a>

## 之后：验证与回退

检查你的插件是否已开启：打开 studio 的“设置”→“插件”页面，或运行 `delorun doctor`，它会报告安装器或启动拒绝的插件，并打印接受风险的命令。

如果新的发布版本能用而某个插件不能用，那么设置保存在历史中，所以你可以一步一步地回退：

| 你想要 | 运行 |
| --- | --- |
| 上一个发布版本，以及更新之前的 profile | `delorun recover rollback` |
| 更新之前的 profile，保留在新的发布版本上 | `delorun recover rollback --profile-only` |
| 你的设置的任何已保存版本 | `delorun recover restore <version>`，或 studio 中的“设置”→“Setup versions” |
| 查看你所处的状态 | `delorun recover status` |
| 不带你自己的插件的 Delorun | `delorun recover safe-mode` |

studio 中的版本界面（“设置”→“Setup versions”）按最新在前列出每个已保存的版本。版本上的 **What changes** 显示哪些插件会回来、更改版本或被移除，以及哪些豁免会改变；它不写入任何东西。**Switch to this version** 会先保存你当前的设置，所以切换回去是同一个步骤。回退的说明见[切换回去](../safety-and-updates/updates.zh.md#going-back)。

当 chat 格式发生变化时，回退到上一个发布版本需要 chat 数据副本；没有副本时它会以 `ROLLBACK_NEEDS_DATA_COPY` 拒绝，而 `--profile-only` 仍然可用。

<details>
<summary>边界情况</summary>

- 如果 Delorun 在更新之后无法启动，那么请替换程序并保留你的数据：`npx delorun@latest repair`（见[修复](../help/troubleshooting.zh.md#repair)）。阻止启动的插件是另一种情况：`delorun recover safe-mode`。
- 如果无法访问发布渠道，那么请下载发布版本的文件并运行 `delorun update --from <folder>`（见[用你下载的文件更新](../safety-and-updates/updates.zh.md#update-from-files-you-downloaded)）。报告、健康检查和回退都相同。
- 如果你所依赖的某个插件没有兼容的发布版本，那么暂时不要更新：继续运行你现有的发布版本，它仍然每天检查一次渠道，并在存在更新的版本时告诉你。

</details>

<details>
<summary>进一步了解</summary>

- 在更新之前查找发布版本会关闭的插件：`delorun update --check` 指出有多少个，`delorun update --report` 指出是哪些。
- 每次都做 chat 数据副本：`delorun update --data-copy`。
- 对照你所运行的发布版本检查插件声明的范围：`delorun plugin check <directory>`。

</details>

<a id="next"></a>

## 接下来

- 完整的更新流程：[更新](../safety-and-updates/updates.zh.md)。
- 编写或维护插件：[为 Delorun 编写插件](plugins.zh.md)，包括[检查它的版本](plugins.zh.md#check-its-versions)。
- 如果出了问题：[更新与回退](../help/troubleshooting.zh.md#updates-and-rollback)。
