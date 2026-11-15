---
description: "delorun update、update --check 和回滚要花多长时间，逐步给出：update 套件的场景、每一步如何计时，以及第一份测量记录和使它停下的缺陷。"
---

# 更新耗时

[English](update-timings.md) | 中文

## 摘要

`update` 套件为从一个本地发布到下一个的真实 `delorun update` 逐步计时，以及回退的几种方式：`delorun update --check`、没有数据副本需要恢复的回滚，以及恢复一份副本的回滚。由于更新运行的是启动器的启动检查，而不是对整个运行时计算哈希，并且同时解包多个文件，在负载较高的机器上，一次 400 个 chat 的更新约 46 秒提交，而此前约为 92 秒。剩下的大部分时间花在解包新运行时和存储的准备开始之前；检查、停止 Host、下载、验证发布、报告、副本和切换合计约七秒。

## 目录

- [场景](#scenarios)
- [各步骤如何计时](#how-the-steps-are-timed)
- [运行套件](#running-the-suite)
- [启动检查与并行解包](#start-checks-and-parallel-unpacking)
- [2026-11-11 的记录](#record-of-2026-11-11)
- [2026-11-10 的记录](#record-of-2026-11-10)
- [最慢的步骤](#the-slowest-steps)

<a id="scenarios"></a>

## 场景

| 场景 | 主要耗时 |
| --- | --- |
| `same-format` | 数据格式相同，因此没有副本；小型 chat 集；冷存储；然后是没有副本需要恢复的回滚 |
| `changed-format` | 数据格式改变，因此取得副本；小型 chat 集；然后是恢复该副本的回滚 |
| `changed-format-large` | 同上，但使用大型 chat 集（`--chats-large`），因此副本占主要耗时 |
| `many-plugins` | 格式相同，安装了 `--plugins` 个插件包，因此报告要读取每一个 |
| `warm-store` | 先 `update --check`，因此更新发现目标已在存储中 |

文件系统克隆需要位于支持克隆的文件系统上的根目录（`--root-base`）；结果记录根目录的文件系统是否支持克隆，在不支持之处，套件将克隆场景列为已跳过。

<a id="how-the-steps-are-timed"></a>

## 各步骤如何计时

home 进程从已安装运行时自己的模块运行 `delorun start --foreground` 自己的函数，只替换一个启动依赖：它的更新支持读取这次运行的回环通道和替身日志，已发布的运行时以常量的形式写明它们，遵循为回环通道构建的启动器所用的下载规则。除此之外，该支持就是 CLI 自己的（运行时仓库之上的 `homeUpdateSupport`、CLI 的报告来源、profile 历史和数据副本）。围绕该支持的存储、通道、下载器、报告来源、profile 历史和副本的包装层，在每次调用的开始和结束各写一条计时记录，不改变任何参数或结果。更新所启动的后继，就是目标运行时自己的 `delorun start`。

三个来源给出步骤边界：这些计时记录、home 日志的 `update phase` 记录和后继的记录 `the Host booted on the new runtime; checking its health`（home 进程为此目的写入它），以及命令自己的各行到达 harness 的时间。`pnpm run benchmark:delorun -- --list` 写明每个项目；最重要的是 `cli-start`（启动器的启动检查、运行时启动、请求）、`running-check`、`download`、`unpack`、`store-install`、`report`、`stop-host`、`data-copy`、`switch`、`target-boot`、`health-check` 和 `total`（命令开始到提交）。

<a id="running-the-suite"></a>

## 运行套件

在 `--prepare` 之后运行 `pnpm run benchmark:delorun -- --suite update`；`--scenario same-format` 运行一个场景。每次重复运行都会安装一个约 770 MB、含 35,287 个文件的运行时，并且在有副本时再次写入 chat 数据，因此只在安静的磁盘上运行大型场景。

<a id="start-checks-and-parallel-unpacking"></a>

## 启动检查与并行解包

三次重复运行 `changed-format-large`，分别在更新让启动器的启动检查在它所读取和启动的运行时上运行、以及解包一次写入最多 16 个文件（[启动检查设计](../design/start-check.md#decisions)）之前和之后，时间为 2026-11-11 的 05:35 至 06:40 UTC，在下面记录的机器和 Node 上，与其他通道共享。之前：负载平均值 10 至 20，存储压力最高 8.5%。之后：负载平均值 20 至 31，存储压力最高 11.8%。中位数以秒计，在负载很高的机器上测得；它们显示的是变化的幅度，而不是安静机器所需的时间：

| 项目 | 之前 | 之后 |
| --- | --- | --- |
| `total`，命令开始到提交 | 91.8 | 46.4 |
| `running-check` | 14.3 | 0.8 |
| `download-unpack` | 27.1 | 19.0 |
| `stop-host`，它曾持有切换之前对目标的完整哈希 | 13.9 | 1.0 |
| `health-check`，此前是 H1 对目标的完整哈希 | 13.2 | 1.3 |
| `rollback` | 83.0 | 51.7 |

`stop-host` 并不是 Host 的关闭：home 进程在 0.15 至 0.25 秒内停止其 Host，而该步骤持有的是更新在切换之前运行的对目标的完整哈希。单独的解包（对真实的 32,449 个文件闭包执行 `extractArchive`，`delorun/apps/install/tests/timing/extract-timing.ts`，在负载平均值 6 至 12 时交错运行）之前用时 15.3 至 18.4 秒，之后用时 8.6 至 10.1 秒；读取并对归档计算哈希占其中 4 至 5 秒。六次重复运行全部提交。

<a id="record-of-2026-11-11"></a>

## 2026-11-11 的记录

每个场景三次重复（`changed-format-large` 为两次，它的第三次如下所述失败），2026-11-11 的 03:48 至 04:35 UTC，在第一个预览版之前的主干加上本分支的基准代码上：22 个 CPU（Intel Core Ultra 9 185H）、21.5 GiB、WSL2 内核 6.6、Node 24.22.0、没有克隆功能的 ext4、与其他通道共享的机器（负载平均值 9 至 16，存储压力最高 16%）。闭包是主干配方的输出，没有本地改动。中位数以秒计；小型 chat 集为 20 个 chat，大型为 400 个（125 MiB）：

| 项目 | `same-format` | `changed-format` | `changed-format-large` | `many-plugins`（20） | `warm-store` |
| --- | --- | --- | --- | --- | --- |
| `total`，命令开始到提交 | 87.0 | 97.8 | 80.1 | 95.1 | 48.6 |
| `cli-start`，到存储的准备 | 11.6 | 12.4 | 9.9 | 12.1 | 1.3 |
| `running-check` | 10.9 | 14.1 | 13.3 | 13.5 | 11.8 |
| `channel-verify` | 0.2 | 0.2 | 0.2 | 0.1 | 0.1 |
| `download-unpack` | 33.5 | 25.9 | 27.4 | 27.4 | 已在存储中 |
| `store-install` | 3.7 | 3.0 | 3.6 | 4.8 | 已在存储中 |
| `report` | 0.9 | 1.0 | 1.0 | 1.3 | 0.8 |
| `snapshot` 和 `drain` | 0.1 | 0.1 | 0.1 | 0.1 | 0.1 |
| `stop-host` | 9.7 | 14.5 | 10.7 | 16.4 | 11.8 |
| `data-copy` | 无 | 0.2 | 1.7 | 无 | 无 |
| `switch` | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `target-boot` | 2.0 | 3.0 | 2.1 | 3.0 | 2.4 |
| `health-check` | 9.3 | 13.3 | 9.8 | 13.7 | 9.5 |
| `rollback` | 47.1 | 50.0 | 60.2 | 未运行 | 未运行 |
| `rollback-switch` | 17.6 | 17.2 | 22.3 | 未运行 | 未运行 |
| `rollback-target` | 11.8 | 10.7 | 14.9 | 未运行 | 未运行 |

`delorun update --check` 用时 57.5 秒（冷存储，它会将其填充）；随后的更新发现目标已经安装，其 `total` 就是 `warm-store` 一列。离散度很大：三个样本中最慢的一个，在其他通道使用这台机器时，最高达到中位数的 1.6 倍。

### 失败或出人意料之处

- 三次 `changed-format-large` 重复运行中有一次，在标准 `H3-only-named-disabled` 上未通过健康检查并自动回滚；另外两次提交。Docker Desktop 在 04:10 UTC 启动，恰在该场景期间：后继的启动拒绝了 Docker 套接字的真实路径，而运行中 Host 的启动没有拒绝，于是 H3 把沙箱行已更改的设置读作报告没有写明的变化。H3 现在单独比较沙箱行的保护，并略去启动在这台计算机上发现的套接字（[C3](../contracts/c03-update-report.zh.md#health-check)）；四次重新运行都提交了。
- 不声明 `engines.dsh` 的合成插件会使报告把每一个都写明为不可预测，随后 `update --yes` 拒绝确认，这是应有的行为；夹具现在声明了范围。
- 在更新修复之前，主干无法构建闭包，每次更新都在报告或健康检查处失败；[2026-11-10 的记录](#record-of-2026-11-10)保留了细节。

<a id="record-of-2026-11-10"></a>

## 2026-11-10 的记录

在更新修复之前的主干上，对带有本地修复构建的闭包执行一次 `same-format` 重复运行，停在健康检查处：报告用时 68.6 秒，解包 22.0 秒，存储的安装 15.7 秒，运行中运行时的启动检查 7.9 秒，而通道的检查为 0.1 秒，下载为 0.7 秒。当时遇到的缺陷此后都已在主干上修复：配方无法构建闭包（pnpm 任务循环、按名称导入 TypeScript 的 `@delorun/release` 源码、仍指向 `.ts` 的通配符导出）；报告对目标 bundle 表的读取器拒绝了上游的 `PROFILE_TEMPLATES`；意外的准备失败使 `delorun update` 以 `TypeError` 崩溃；以及 H2 在没有会话的情况下请求 studio 的索引，使每次更新都因其 401 而失败。

<a id="the-slowest-steps"></a>

## 最慢的步骤

1. **解包目标，在负载很高的机器上约 19 秒。** `download-unpack` 几乎全是解包：186 至 193 MB 的归档通过回环下载不到一秒，读取并对其计算哈希需要 4 至 5 秒，其余时间用于以 16 个文件并行的方式把 35,287 个文件（约 770 MB）写入暂存区。
2. **存储的准备开始之前，12 至 15 秒。** `cli-start`（当此前的 `--check` 已经运行时为 1.3 秒）是第一个请求在准备之前所做的工作，计时记录没有对它做进一步拆分。
3. **检查，每个不到一秒。** `running-check`、切换之前的检查和 H1 是启动器的启动检查；只有在某次启动会计算哈希时，才会在那里对运行时进行完整哈希，以及在 `delorun verify` 和回滚的报告中。
