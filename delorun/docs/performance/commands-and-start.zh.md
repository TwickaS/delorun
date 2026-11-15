---
description: "Delorun 的日常命令、一次启动和一次停止要花多长时间，以及其他套件的场景：第一份测量记录以及时间花在哪里。"
---

# 命令与启动

[English](commands-and-start.md) | 中文

## 摘要

这些套件为本人在更新之外需要等待的事项计时：日常命令、启动和停止 Delorun、首次安装、恢复、导出和回收站、插件、没有模型的 chat 轮次，以及浏览器中的 studio。每个命令都通过启动器运行，就像本人的 `delorun` 那样。有了快速启动检查，大多数命令在 1 至 2.5 秒内答复；仍然较长的等待是首次安装（到 studio 约 52 秒）、home 的首次启动（21 秒）、`delorun stop`（15 秒）、`recover status`（15 秒）、`verify --offline`（17 秒）以及安装插件（到其行运行为止 14 秒）。

## 目录

- [每个套件测量什么](#what-each-suite-measures)
- [2026-11-11 的记录](#record-of-2026-11-11)
- [时间花在哪里](#where-the-time-goes)
- [2026-11-10 的记录](#record-of-2026-11-10)

<a id="what-each-suite-measures"></a>

## 每个套件测量什么

- `cli`：裸 Node 启动、单独的启动器（`--help`，它不启动任何运行时）、由运行时自己的 Node 运行的 `--version`，以及每个命令到首次输出和到退出：`--version`、已停止和运行中的 `status`、`doctor`、`verify --offline`、已停止和运行中的 `trash list`、`recover status`、`plugin --profile default list` 和 `logs`。`update --check` 由 [update 套件](update-timings.zh.md)测量，因为由 `delorun start` 启动的 home 进程会读取已发布的发布主机，而在线 `verify` 需要发布日志。
- `start`：被复制的 home 的第一次 `delorun start` 和之后的一次，各自测到命令报告 Delorun 正在运行、以及 studio 的 web 服务器答复其索引为止；`delorun stop`、`delorun stop --now` 和重启。不带参数的 `delorun` 不被测量，因为它会打开默认浏览器，在 WSL 上那是本人自己的 Windows 浏览器。
- `install`：启动器没有运行时时的首次运行（解析、签名、日志检查、下载和解包、存储以及首次启动）、`delorun setup --yes`，以及到 studio 的首次启动。交互式 setup 需要终端；`setup --yes` 采用相同的默认值。
- `recovery`：`recover status`、进入安全模式、安全模式下的启动、离开安全模式，以及 `recover restore` 最早的 profile 历史版本。
- `data`：一个 chat 以及容纳每个 chat 的工作区的 `delorun export`、对其执行 `delorun import`、通过 studio 自己的路由把一个 chat 移入回收站并恢复它、把每个 chat 都移入回收站，以及在小型和大型 home 中，在 studio 中和用 `delorun trash list` 列出满的回收站。
- `plugins`：在 Delorun 运行期间从本地 tarball 安装合成插件、将其关闭、开启并通过 profile patch 重新加载它，以及已安装 0 个、5 个和 20 个各自加载一行的插件时的首次启动。
- `turn`：针对讲模型提供方线路协议的回环模型替身的一个 chat 轮次及其工具调用，从发送到第一个令牌和到轮次结束，以及每次工具调用，在 Delorun 的组合中以及在 Delorun 的开关行关闭时。
- `studio`：无头 Chromium 中的 studio：启动到可交互、有少量和大量 chat 的侧栏、打开较短和较长的 chat、在它们之间切换、设置和新手引导的各步骤，分别在 studio 外观和 stock 外观下。

<a id="record-of-2026-11-11"></a>

## 2026-11-11 的记录

每个场景三次重复，2026-11-11 的 03:48 至 05:50 UTC，在第一个预览版之前的主干加上本分支的基准代码上：22 个 CPU（Intel Core Ultra 9 185H）、21.5 GiB、WSL2 内核 6.6、Node 24.22.0、没有克隆功能的 ext4、与其他通道共享的机器（负载平均值 4 至 16，存储压力最高 16%）。中位数，附样本范围：

| 项目 | 中位数 | 范围 |
| --- | --- | --- |
| `node -e ""` | 26 ms | 25 ms 至 37 ms |
| 启动器 `--help` | 81 ms | 74 ms 至 122 ms |
| 由运行时自己的 Node 运行的 `delorun --version` | 437 ms | 401 ms 至 774 ms |
| `delorun --version` | 1.9 s | 1.1 s 至 9.2 s |
| `delorun status`，已停止 / 运行中 | 1.8 s / 1.1 s | 1.0 s 至 14.9 s |
| `delorun doctor` | 2.7 s | 1.1 s 至 2.9 s |
| `delorun verify --offline` | 17.1 s | 9.5 s 至 19.3 s |
| `delorun trash list`，已停止 / 运行中 | 1.6 s / 1.1 s | 1.0 s 至 1.9 s |
| `delorun recover status`（cli 套件 / recovery 套件） | 1.5 s / 15.1 s | 1.1 s 至 15.4 s |
| `delorun plugin --profile default list` | 2.1 s | 1.6 s 至 2.4 s |
| `delorun logs` | 1.4 s | 1.1 s 至 1.5 s |
| `delorun open --print` | 1.5 s | 1.0 s 至 1.9 s |
| home 的第一次 `delorun start`，到运行中以及到 studio 答复 | 21.3 s | 17.7 s 至 34.8 s |
| 之后的 `delorun start` | 5.4 s | 4.2 s 至 9.3 s |
| `delorun stop` | 15.4 s | 13.5 s 至 19.7 s |
| `delorun stop --now` | 2.2 s | 1.6 s 至 3.4 s |
| 重启（`stop`，然后 `start`） | 8.3 s | 6.7 s 至 10.4 s |
| 启动器的首次运行：安装，到运行时的 `--version` | 41.8 s | 40.9 s 至 54.6 s |
| 其中下载和解包 | 33.5 s | 29.3 s 至 40.3 s |
| `delorun setup --yes` | 2.4 s | 1.4 s 至 2.9 s |
| setup 之后的第一次 `delorun start`，到 studio 答复 | 5.6 s | 3.8 s 至 7.5 s |
| 安装、setup 和第一次启动合计 | 52.1 s | 46.1 s 至 62.7 s |
| `delorun recover safe-mode`，然后安全模式下的 `start`，然后 `exit-safe-mode` | 12.9 s、6.1 s、2.1 s | 1.7 s 至 15.8 s |
| 一个 chat 的 `delorun export`，20 个 chat / 400 个 chat 的 home | 8.8 s / 13.5 s | 8.6 s 至 16.6 s |
| 在 studio 中把一个 chat 移入回收站 / 恢复它 | 47 ms / 17 ms | 16 ms 至 69 ms |
| 把 400 个 chat 移入回收站，每个一次请求 / 列出它们 | 12.1 s / 0.3 s | 0.3 s 至 12.4 s |
| 400 个条目的 `delorun trash list` | 1.8 s | 1.8 s 至 2.2 s |
| Delorun 运行期间从本地 tarball 执行 `delorun plugin add` / 到其行已启动 | 12.0 s / 14.2 s | 10.3 s 至 16.0 s |
| 把插件关闭、开启、通过 profile patch 重新加载 | 各 2.1 s | 2.1 s 至 2.2 s |
| 已安装 0 个、5 个和 20 个插件时的首次启动 | 13.3 s、17.5 s、14.0 s | 10.1 s 至 22.7 s |
| chat 轮次，第一个令牌 / 结束，会话的第一个轮次（回环模型替身） | 232 ms / 250 ms | 218 ms 至 255 ms |
| chat 轮次，第一个令牌 / 结束，之后的轮次 | 69 ms / 72 ms | 62 ms 至 80 ms |
| 一次工具调用，读取 / 写入，在 20 次调用的轮次中 | 47 ms / 69 ms | 34 ms 至 125 ms |

这份记录中没有测量的内容：工作区的导出和导入（已设置好的 home 的工作区注册表没有可把 chat 汇集到其中的条目）、恢复 profile 历史版本（`setup --yes` 所设置的 home 的历史没有列出任何版本）、stock 组合中的 chat 轮次（Delorun 的开关行关闭的 `delorun start` 在 Delorun 运行之前以 1 退出），以及浏览器中的 studio（它的第一项等待预览说明对话框，而页面没有显示它；该套件在记录数字之前需要在浏览器中跑一遍）。在这台机器上，每个插件的启动开销在 0 个、5 个和 20 个插件时无法与噪声区分开。

<a id="where-the-time-goes"></a>

## 时间花在哪里

- **启动器的启动检查不再是一个命令的开销。** `--version` 通过启动器需要 1.9 秒，而由运行时自己的 Node 运行需要 0.4 秒；大多数命令在 1 至 2.5 秒内答复。
- **首次安装，42 秒。** 通过回环下载 193 MB 的归档不到一秒；写入它的 35,287 个文件和存储的安装占据其余时间。
- **home 的第一次启动，21 秒，而之后的一次为 5.4 秒。** 被复制的 home 的第一次引导要付出之后的启动无需付出的工作；该记录没有进一步拆分。
- **`delorun stop`，15 秒，而 `stop --now` 为 2.2 秒。** 不是 Host 的关闭：home 进程从停止请求到其 `stopped` 记录用时 0.15 至 0.25 秒，而由运行时自己的 Node 运行的 `delorun stop` 用时 0.8 至 1.1 秒。该套件在第一次启动一个用 `cp -al` 复制的 home 之后立即测量 `stop`，这会移动每个运行时文件的变更时间；第一次启动的标识记录于是不为任何文件担保，所以启动器在 `stop` 之前的检查会再次对所有文件计算哈希（[启动检查设计](../design/start-check.zh.md#measurements)），而 `stop --now` 在之后到来，那时已有记录担保。已安装的 home 不会遇到这种情况，因为安装会等待 2 秒再记录。在该套件的 home 让变更时间在第一次启动之前稳定下来之前，该套件的数字包含这一点；更新的 `stop-host` 曾经持有它自己的一次完整哈希，现在是一次启动检查（[更新耗时](update-timings.zh.md#start-checks-and-parallel-unpacking)）。
- **recovery 套件中的 `recover status`、`verify --offline` 和 `recover safe-mode`，13 至 17 秒。** 每一个所用的时间都和完整读取一个运行时的文件一样长；`recover status` 在 cli 套件的 home（Delorun 此前运行过的地方）中用时 1.5 秒，而在刚复制的 home 中作为第一个命令用时 15 秒，那里的每个文件都要计算哈希，与上面的 `stop` 相同。
- **导出，一个 chat 为 9 至 14 秒，更大的 home 中更长。** 导出会取得每个 profile 的 home 锁，并在写入之前扫描 chat 历史中的密钥；该记录没有在二者之间拆分时间。

<a id="record-of-2026-11-10"></a>

## 2026-11-10 的记录

在快速启动检查之前，`cli` 和 `start`，各三次重复，2026-11-10 的 13:34 UTC，在负载很高的机器上：每个命令通过启动器都需要 8 至 28 秒（`--version` 9.9 秒，`verify --offline` 28.0 秒），之后的 `delorun start` 10.0 秒，重启 29.6 秒，因为启动器在每次启动之前都要读取并对运行时的全部 35,287 个文件计算哈希。
