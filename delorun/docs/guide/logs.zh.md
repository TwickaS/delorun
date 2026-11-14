---
description: "Delo 的运行日志存放在哪里：每份日志的位置、日志保存什么与绝不保存什么、日志保留多久、delorun logs 如何显示与清空日志，以及它们与记录你聊天内容的会话日志有何不同。"
---

# Delo 的日志存放在哪里

[English](logs.md) | 中文

Delo 尚无正式发布；本页描述首个发布版本。

## 摘要

Delo 自身的每个进程都会写入一份运行日志：一个记录该进程行为的文件，便于你或你的 agent 查明故障原因。运行日志与会话日志是分开的：会话日志记录你的 chat，并一直保留，直到你删除该 chat。`delorun logs` 会打印每份日志的位置，以及你的 home 进程的最近记录。Delo 的约定要求：每条记录在写入前都先经过脱敏；每份日志在达到 10 MiB 时轮转；Delo 运行期间，每个日志文件在其写入之后 14 天被删除。

## 目录

- [日志位置](#log-locations)
- [日志保存什么](#what-a-log-holds)
- [日志保留多久](#how-long-logs-are-kept)
- [用 delorun logs 读取日志](#reading-logs-with-delorun-logs)
- [清空日志](#clearing-logs)

<a id="log-locations"></a>
## 日志位置

路径位于你的 Delo home 之下，即 `~/.delorun`（除非你设置了 `DELORUN_HOME`）；其中 `<profile>` 为你的 CLI profile（除非你设置了 `DELORUN_PROFILE`，否则为 `default`）。

| 进程 | 日志名称 | 活动文件 |
| --- | --- | --- |
| `delorun start` 运行的 home 进程及其 Host | `home-<profile>` | `logs/home-<profile>/home.log` |
| Docker 监管器 | `supervisor-<profile>` | `logs/supervisor-<profile>/supervisor.log` |
| 桌面应用的 Host | `desktop-host` | `logs/desktop-host/desktop-host.log` |
| 自托管中继 | `relay` | 中继容器内的 `/var/log/delorun-relay/relay.log`，不在你的电脑上 |

- **较早的文件。** 活动文件达到 10 MiB 时，它会被重命名为 `<file>.1`，较早的文件依次上移至 `<file>.4`；每个进程最多保留 5 个文件，共计 50 MiB。
- **上游的启动报告。** DeepSeek Harness 自身的 `dsh` 命令在启动失败时写入 `logs/startup-*.log`。这些报告保存未经处理的诊断信息，其中可能包含凭据值；`delorun` 从不写入它们，`delorun logs startup` 列出它们时会附带该警告。
- **会话日志。** 你的 chat 位于 `sessions/` 之下。它们不是运行日志：本页所述的机制均不会轮转、脱敏、删除或读取它们。

<a id="what-a-log-holds"></a>
## 日志保存什么

- **Delo 自身的记录**记录操作、状态、结果、耗时、版本、id 与错误代码。它们不包含你的消息、提示词、模型输出、工具参数、工具结果或文件内容。
- **捕获的输出**是 DeepSeek Harness 代码在 Delo 运行期间打印的内容，例如 Host 的控制台输出。它可能包含来自你的 chat、命令和文件的文本，例如引用了某条命令的错误行。
- **脱敏。** 每条记录（包括捕获的行）都会先经过脱敏，然后才写入。模型密钥、令牌、所有者验证码、会话密钥、cookie 值，以及 Delo 进程加载的其他密钥，都会被替换为 `[redacted:<kind>]`；列出的形式，例如 `Authorization` 头、URL 中的密码、私钥与提供方密钥，同样会被替换。脱敏无法识别 Delo 从未加载、且不具备任何列出形式的密钥。
- **chat 与轮次 id。** chat 运行期间写入的记录会带有该 chat 的会话 id 与轮次编号，因此 `delorun logs --session <id> --turn <n>` 能找到某个轮次背后的进程记录。你的会话日志不会为此增加任何字段。
- **访问权限。** 日志目录的权限为 0700，日志文件为 0600，因此只有你的用户能读取它们。Delo 的约定要求：模型在受限工作区中运行的命令不能写入它们；在你的系统强制执行 Delo 读取规则的地方，这些命令也不能读取它们。`delorun verify` 会报告你的系统强制执行了哪些规则。

<a id="how-long-logs-are-kept"></a>
## 日志保留多久

| 规则 | 取值 |
| --- | --- |
| 轮转 | 达到 10 MiB 时 |
| 每个进程保留的文件 | 5 |
| 删除 | 每个文件在其最早记录满 14 天时删除，因此没有记录保留更久 |
| 检查时机 | 任一 Delo 进程启动时、任一进程运行期间每小时，以及执行 `delorun logs --prune` 时 |

没有任何 Delo 进程运行时，不会删除过期文件；它们会在下一次 Delo 进程启动时，或你执行 `delorun logs --prune` 时被删除。

<a id="reading-logs-with-delorun-logs"></a>
## 用 delorun logs 读取日志

| 命令 | 输出内容 |
| --- | --- |
| `delorun logs` | 每份日志及其位置、是否存在、大小与最早记录，然后是你的 home 进程的最后 50 条记录 |
| `delorun logs <name>` | `home`、`supervisor` 或 `desktop-host` 的最后 50 条记录；`-n <count>` 最多输出 10,000 条 |
| `delorun logs startup` | 上游的启动报告，附带上游的警告，但不显示其内容 |
| `delorun logs relay` | 中继日志在其容器内的位置，以及在容器内读取它的命令 |
| `--follow` | 写入的新记录，跨越轮转 |
| `--since <duration>` | 比某个时长更新的记录，例如 `30m` 或 `2d` |
| `--session <id>`，`--turn <n>` | 某个 chat 的记录，以及其中某个轮次的记录 |
| `--json` | 按存储格式输出的记录，每行一个 JSON 对象 |
| `--path` | 仅输出活动文件的路径 |
| `--profile <name>` | 另一个 CLI profile 的日志 |

一条记录的输出格式为 `<time> <level> <log name> [<session id>/<turn>] <message>`。捕获输出中的控制字符以转义形式显示。

<a id="clearing-logs"></a>
## 清空日志

- `delorun logs --clear <name>` 会先请求确认，然后删除该日志较早的文件并清空其活动文件；正在运行的进程会继续写入被清空的文件。不带名称的 `delorun logs --clear` 对每份本地日志执行同样的操作，并删除上游的启动报告。
- `delorun logs --prune` 立即删除每个过期文件，并逐一打印被删除的文件。
- **清除一个 chat 之后。** 已清除的 chat 的片段，可能仍保留在运行日志的捕获输出中，直到它们在 Delo 运行期间写入 14 天后被删除。清除会提供立即清空运行日志与启动报告的选项，该选项会执行 `delorun logs --clear`。
