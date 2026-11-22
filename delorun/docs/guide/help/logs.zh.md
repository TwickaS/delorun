---
description: "Delorun 的运行日志存放在哪里：每份日志的位置、日志保存什么与绝不保存什么、日志保留多久、delorun logs 如何显示与清空它们，以及它们与记录你的 chat 的会话日志有何不同。"
---

# Delorun 的日志存放在哪里

[English](logs.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页帮助你找出某件事为何失败。你需要先安装 Delorun（见[安装与首次运行](../get-started/install.zh.md)）。出了问题时，第一个要看的地方就是日志。Delorun 自己的每个进程都会写一份[运行日志](../../reference/glossary.zh.md#operational-log)：这是一个记录该进程做了什么的文件，这样你，或你请来帮忙的 agent，就能找出某件事为何失败。这些日志与你的 chat 是分开的，chat 会一直保留到你删除为止。运行 `delorun logs` 可以看到每份日志在哪里，以及正在运行的 Delorun 的最新记录。每条记录在写入之前都会去除其中的密钥，每份日志都有大小上限，旧的日志文件在 14 天后会被删除。

## 目录

- [日志位置](#log-locations)
- [日志保存什么](#what-a-log-holds)
- [日志保留多久](#how-long-logs-are-kept)
- [用 delorun logs 读取日志](#reading-logs-with-delorun-logs)
- [清空日志](#clearing-logs)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="log-locations"></a>

## 日志位置

下面的路径都在你的 Delorun home 内，即 `~/.delorun`，除非你设置了 `DELORUN_HOME`。`<profile>` 是你的 profile 的名称，除非你选了别的，否则就是 `default`。

Delorun 只写一份运行日志：正在运行的 Delorun，即 `delorun start` 运行的后台进程以及其中的 studio 服务器。它的名称是 `home-<profile>`，文件是 `logs/home-<profile>/home.log`。会写入 `delorun logs` 所能列出的其他日志的部分，即 Docker 监管器、桌面应用和自托管中继，并不包含在内，所以这些日志显示为未创建（见[路线图](../roadmap.zh.md)）。

没有任何日志会离开你的电脑。Delorun 不会把你的日志发给任何人；它们是只有你读、或由你选择分享的文件。

- **较旧的文件。**日志文件达到 10 MiB 时，会被重命名为 `<file>.1`，更旧的文件依次移到 `<file>.4`。每份日志最多保留 5 个文件，合计 50 MiB。
- **DeepSeek Harness 的启动报告。**DeepSeek Harness 自己的 `dsh` 命令在启动失败时会写入 `logs/startup-*.log`。这些报告可能包含你的密钥，因为它们保存的是原始诊断信息。`delorun` 从不写入它们，`delorun logs startup` 会连同这条警告一起列出它们。
- **你的 chat** 在 `sessions/` 下。它们不是运行日志：本页的任何内容都不会缩短、脱敏、删除或读取它们。

<a id="what-a-log-holds"></a>

## 日志保存什么

- **Delorun 自己的记录**说明发生了什么：操作、状态、结果、耗时、版本、id 和错误代码。它们绝不包含你的消息、提示词、模型回复、工具参数、工具结果或文件内容。
- **捕获的输出**是 DeepSeek Harness 的代码在 Delorun 运行它时打印的内容，例如 studio 服务器的控制台输出。它可能包含来自你的 chat、命令和文件的文字，例如引用了某条命令的一行错误信息。
- **密钥会被去除。**每条记录，包括捕获的输出，在写入之前都会把其中的密钥替换为 `[redacted:<kind>]`：模型密钥、令牌、会话密钥、cookie 值以及 Delorun 加载的其他密钥，还有 `Authorization` 标头、URL 中的密码、私钥和提供方密钥等常见形式。Delorun 从未加载过、且不符合这些形式的密钥有可能漏过去。
- **chat 与轮次 id。**chat 运行期间写入的记录带有该 chat 的 id 和轮次编号，所以 `delorun logs --session <id> --turn <n>` 能找到一次回答背后的记录。你可以在 `delorun logs` 打印的、你使用该 chat 那段时间的记录里，找到方括号中的 chat id；`delorun trash list` 会显示已删除 chat 的 id。
- **谁能读取。**只有你的用户能打开日志文件夹和文件。模型在沙箱工作区中运行的命令无法更改它们，并且在你的系统强制执行该规则的地方也无法读取它们（见[Delorun 保护什么](../safety-and-updates/safety.zh.md#the-sandbox)）。

<a id="how-long-logs-are-kept"></a>

## 日志保留多久

| 内容 | 时机 |
| --- | --- |
| 文件轮转 | 达到 10 MiB 时 |
| 每份日志保留的文件数 | 5 |
| 文件被删除 | 其最旧的记录已满 14 天 |
| Delorun 检查旧文件 | 每次运行 `delorun` 命令时（`--help` 和 `--version` 除外），以及运行 `delorun logs --prune` 时 |

Delorun 只在你运行 `delorun` 命令时删除旧文件，所以在你不运行任何命令期间，日志可能保留得更久。

<a id="reading-logs-with-delorun-logs"></a>

## 用 delorun logs 读取日志

```sh
delorun logs                 # where every log is, then the latest records
delorun logs --follow        # watch new records as they arrive
delorun logs --since 30m     # the last half hour
```

| 命令或选项 | 打印 |
| --- | --- |
| `delorun logs` | 每份日志及其位置、是否存在、大小和最旧的记录，然后是正在运行的 Delorun 的最后 50 条记录 |
| `delorun logs home` | 正在运行的 Delorun 的最后 50 条记录；`-n <count>` 最多打印 10,000 条 |
| `delorun logs startup` | DeepSeek Harness 的启动报告，附带其警告，但不显示其内容 |
| `--follow` | 写入的新记录 |
| `--since <duration>` | 比某个时长更新的记录，例如 `30m` 或 `2d` |
| `--session <id>`, `--turn <n>` | 一个 chat 或其中某一轮的记录 |
| `--json` | 按存储形式输出的记录，每行一个 JSON 对象 |
| `--path` | 仅当前文件的路径 |
| `--profile <name>` | 另一个 profile 的日志 |

一条记录的打印格式为 `<time> <level> <log name> [<chat id>/<turn>] <message>`，例如 `2026-11-16T09:12:03.412Z info home-default [<chat id>/2] turn finished`。捕获的输出中的控制字符会以转义形式显示，所以一行日志无法改变你的终端所显示的内容。

<a id="clearing-logs"></a>

## 清空日志

- `delorun logs --clear <name>` 会先询问，然后删除该日志的较旧文件并清空其当前文件；正在运行的 Delorun 会继续写入被清空的文件。不带名称的 `delorun logs --clear` 会对你电脑上的每份日志这样做，并删除 DeepSeek Harness 的启动报告。它需要一个可以询问的终端。
- `delorun logs --prune` 会立即删除每个已过期的文件，并逐个打印。
- **永久删除一个 chat 之后。**在该日志文件被删除之前，它的片段可能仍留在捕获的输出中。给 `delorun trash purge <id>` 或 `delorun trash empty` 加上 `--clear-logs`，就能同时清空日志和启动报告，效果与 `delorun logs --clear` 相同。

<details>
<summary>边界情况</summary>

- 如果你设置了 `DELORUN_HOME` 或 `--profile`，那么路径和名称会随之改变。
- 如果某行日志显示了转义字符，那么原文中有控制字符；它们被转义，是为了让一行日志无法改变你的终端所显示的内容。
- 如果你把日志交给 agent 去读，请先自己检查：捕获的输出可能引用你的命令和文件，而 Delorun 从未加载过、且不符合任何已知形式的密钥有可能漏过去。

</details>

<details>
<summary>进一步了解</summary>

- 在问题发生时观察它：`delorun logs --follow`。
- 缩小到某一次回答：`delorun logs --session <id> --turn <n>`。
- 交给脚本处理：`delorun logs --json` 每行打印一个 JSON 对象，`--path` 只打印当前文件的路径。
- 立即释放磁盘：`delorun logs --prune`，或对某一份日志使用 `delorun logs --clear <name>`。

</details>

<a id="next"></a>

## 接下来

- 为你看到的问题寻找修复办法：[故障排查](troubleshooting.zh.md)。
- 检查你的设置：[日常使用](../everyday-use/daily-use.zh.md#check-the-release-and-your-setup)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

日志名称、轮转、脱敏和保留的确切规则见[运行日志约定](../../contracts/c20-operational-logs.zh.md)。
