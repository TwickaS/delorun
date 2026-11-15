---
description: "Delorun 的等待时间基准：每个套件测量什么，如何运行，如何阅读结果及其预算，以及更改如何添加套件。"
---

# 性能

[English](README.md) | 中文

## 摘要

`pnpm run benchmark:delorun` 测量本人需要等待 Delorun 的各个点，每个点一个套件，以便找出缓慢的步骤，并在发布之前发现退步。每个套件都在被测提交的本地发布上运行真实的产品，使用一次性的 home，没有任何请求离开这台机器。一次运行写出一个 JSON 结果并打印一张表；`--check-budgets` 在某一步的中位数超过其上限时使运行失败。[harness](../../apps/benchmarks/README.md) 拥有这些代码。

## 目录

- [套件](#suites)
- [运行基准](#running-the-benchmarks)
- [一次运行做什么](#what-a-run-does)
- [阅读结果](#reading-a-result)
- [预算](#budgets)
- [添加套件](#adding-a-suite)

<a id="suites"></a>

## 套件

| 套件 | 测量内容 | 页面 |
| --- | --- | --- |
| `update` | 逐步的 `delorun update`、`update --check`，以及带数据副本需要恢复和不带副本的回滚 | [更新耗时](update-timings.zh.md) |
| `cli` | 本人期望立即得到答复的命令，到首次输出和到退出，以及启动一个进程的开销 | [命令与启动](commands-and-start.zh.md) |
| `start` | `delorun start` 冷启动和热启动到 studio 的首页、`delorun stop`、`stop --now`、重启以及不带参数的 `delorun` | [命令与启动](commands-and-start.zh.md) |
| `install` | 启动器的首次运行、setup 以及到 studio 的首次启动 | [命令与启动](commands-and-start.zh.md) |
| `recovery` | `delorun recover status`、安全模式以及恢复 profile 历史版本 | [命令与启动](commands-and-start.zh.md) |
| `data` | 小型和大型 home 的 `delorun export` 与 `import`，以及把 chat 移入回收站、恢复它们并列出大型回收站 | [命令与启动](commands-and-start.zh.md) |
| `plugins` | 从本地包安装插件、将其关闭、开启并重新加载，以及已安装 0 个、5 个和 20 个插件时的启动开销 | [命令与启动](commands-and-start.zh.md) |
| `turn` | 围绕回环模型替身的一个 chat 轮次及其工具调用，在 Delorun 的组合中以及在 Delorun 的开关行关闭时 | [命令与启动](commands-and-start.zh.md) |
| `studio` | 无头 Chromium 中的 studio：启动、侧栏、chat、设置和新手引导，分别在 studio 外观和 stock 外观下 | [命令与启动](commands-and-start.zh.md) |

`pnpm run benchmark:delorun -- --list` 打印每个套件、其场景及其测量的项目。

<a id="running-the-benchmarks"></a>

## 运行基准

在 Linux 上、从仓库根目录运行，需要有可用的无特权用户命名空间。

1. 像任何闭包构建一样，构建工作区的产物。
2. `pnpm run benchmark:delorun -- --prepare` 用发布配方（`build-closure.ts --artifacts existing`）把已检出提交的基础运行时闭包构建到 `.cache/delorun-benchmarks/` 中。工作树必须位于该提交且没有已跟踪的更改。`--closure-from <dir>` 则改用在别处构建的闭包。
3. `pnpm run benchmark:delorun` 运行每个套件；`--suite <id>` 和 `--scenario <id>` 用于选择，`--repeat <n>` 设置每个场景的重复次数（默认 3），`--chats-small`、`--chats-large` 和 `--plugins` 设定合成数据的规模。
4. 在安静的机器上，`--check-budgets` 把中位数与 [`budgets.json`](../../apps/benchmarks/budgets.json) 比较。`--keep-roots` 在运行之后保留每个一次性 home，因此可以读取失败的重复运行的 home 日志。`node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only benchmark:delorun` 通过检查运行器运行同一项检查，运行器单独运行它。运行器的任何层级都不选择它：一次完整运行需要将近一个小时，而且它的耗时在负载很高的机器上没有意义。

<a id="what-a-run-does"></a>

## 一次运行做什么

- **发布。** 基础闭包被重新标记为发布 `0.1.0`，并为 update 套件标记为 `0.1.1` 和 `0.2.0`，使用发布工具自己的步骤；`0.2.0` 携带一个在 Delorun 的某份记录上不同的 `data-formats.json`，因此更新到它会取得会话数据副本。每个发布都用为这次运行生成的一次性密钥签名，记录到发布工具的替身发布日志，并从回环通道提供。启动器是为该通道和该日志构建的。
- **Home。** 每个 home 都是系统临时目录（或 `--root-base`）之下的新目录，其中的 `home/` 是这次运行启动的每个进程的 `HOME`。如果某个根目录是本人真实 home 的 `.delorun` 或 `.dsh`、包含它们或位于它们之内，harness 就拒绝它。启动器安装 `0.1.0` 并运行 `delorun setup --yes`；profile 的 studio 监听系统分配的端口。模板 home 只安装一次，并为每次重复运行复制；副本中已安装的运行时是指向模板只读文件的硬链接，因此一次重复运行只写入它自己安装的内容。
- **数据。** chat 是上游的合成 Session 语料，其每个 chat 的长度遵循所测量语料的聚合分位数，其文本是固定的合成词汇；相同的数量写出相同的字节。插件是合成的包。不读取也不写入任何个人内容。
- **网络。** 被测的运行以本人自己的用户，在只有回环的新网络命名空间中重新运行自身，因此 harness 或产品的任何请求都不会离开这台机器。
- **计时。** 每个命令都通过启动器运行，就像本人运行 `delorun` 那样。各步骤由命令自己的各行到达的时间、home 日志的记录读出，在 update 套件中，还由一个 home 进程驱动读出，该驱动在不改变更新支持调用的前提下为其计时（[更新耗时](update-timings.zh.md#how-the-steps-are-timed)）。

<a id="reading-a-result"></a>

## 阅读结果

结果是 `.cache/delorun-benchmarks/results/<time>.json`（或 `--out`），格式为 `delorun.benchmark-result/1`：提交、机器的处理器数量和型号、内存、内核版本、Node 版本、根目录的文件系统及其是否克隆文件、前后的负载平均值、前后以及最高采样处的存储压力（`/proc/pressure/io` 的 `some avg10`），以及按套件和场景给出的每个样本，以及每个被测项目的中位数、最小值、最大值和离散度，连同失败和被跳过的项目。它不写明一次性根目录之外的任何主机、用户或路径。

表按场景打印相同的内容。请在具有相同事实的机器上，按中位数比较运行结果；离散度表明负载使样本移动了多少。在负载很高的机器上运行会抬高每个数字，其中进程启动最为明显。

<a id="budgets"></a>

## 预算

[`budgets.json`](../../apps/benchmarks/budgets.json) 为每个场景的被测项目保存以毫秒计的上限。当某个中位数超过其上限、某个有预算的项目没有被测量、某个已运行的场景没有上限，或某次重复运行失败时，`--check-budgets` 失败。如果运行中的存储压力在任何采样处超过 20%，它拒绝对这次运行作出判断，并以 3 退出而不是通过或失败：这样的运行测量的是一个繁忙的磁盘。该文件的 `measured` 字段写明其上限的来源；目前的上限是在与其他通道共享的机器上取得的，在安静机器上的运行取而代之之前都是暂定的。每个上限是在所记录的机器和负载上所测中位数的四倍，至少一秒，向上取整为两位有效数字；这四倍吸收了高负载机器的噪声，因此该检查捕获的是把某一步耗时成倍放大的退步，而不是几个百分点的变化。`--propose-budgets <file>` 按这条规则根据一次运行写出上限；有意让某一步变慢的更改，在其拉取请求中记录新的上限及其理由。

<a id="adding-a-suite"></a>

## 添加套件

增加本人需要等待的点的更改，在同一次更改中添加它的套件：`delorun/apps/benchmarks/src/suites/<id>/` 之下导出 `Suite` 的模块、它在 `src/suites/index.ts` 中的条目、它在 `budgets.json` 中的首批上限，以及它在上表中的一行及其页面或页面的一节。套件使用 harness 的模板 home、其通道和其计时进程，像本人那样运行每个命令，除计时观察者或日志记录（其页面会写明）之外，不增加任何产品代码。
