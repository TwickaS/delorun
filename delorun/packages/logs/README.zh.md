---
description: "Delorun 运行日志包，供写入 C20 日志的入口的维护者使用：日志器、脱敏、捕获的输出、Cordis 日志器导出器、轮转与保留、为 delorun logs 提供数据的读取函数，以及跨入口的拒绝测试套件。"
---

# @delorun/logs

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包实现[约定 C20](../../docs/contracts/c20-operational-logs.zh.md)：每个保存运行日志的 Delorun 进程都通过本包写入日志，因此脱敏、记录格式、轮转与保留在每个入口上的行为保持一致。本包还包含 `delorun logs` 与清除所使用的读取函数、清空操作与期限检查操作，以及跨入口的拒绝测试套件，该套件在树中的每个入口上运行 C20 的拒绝测试。约定的取值与类型来自 [`@delorun/contract-operational-logs`](../contract-operational-logs/README.zh.md)；模式代码来自 [C1](../../docs/contracts/c01-home-layout.zh.md)。

## 目录

- [写入入口的日志](#writing-a-surfaces-log)
- [记录与键](#records-and-keys)
- [脱敏](#redaction)
- [捕获的输出](#captured-output)
- [轮转与保留](#rotation-and-retention)
- [读取](#reading)
- [拒绝测试套件](#the-denial-suite)
- [测试](#tests)

<a id="writing-a-surfaces-log"></a>
## 写入入口的日志

入口的负责人在该进程启动时执行以下步骤：

1. 用 `resolveSurface({ kind, home, profile })` 解析入口的位置。中继的位置是其容器路径，并忽略 home。
2. 为该进程创建一个 `Redactor`，并用 `register(value, kind)` 登记进程持有的或在加载时读取的每个密钥值；对于之后被丢弃的值，保留返回的释放函数。
3. 用 `SurfaceLog.open({ location, redactor, pid, level, startId, onFailure, now })` 打开日志。打开时会以 0700 创建目录，并以独占创建方式以 0600 创建活动文件；已存在的目录或文件则由 `@delorun/home` 的 `checkPrivateDirectorySync` 与 `checkProtectedFileSync` 检查，它们是 C1 拒绝规则的唯一实现：符号链接、属于其他用户或带有组或其他用户权限位的路径会抛出带有 `HOME_MODE` 或 `SECRET_FILE_MODE` 的 `HomeLayoutError`，并附带其 `chmod` 修复方法。这样，入口会在启动时即失败，而不是在没有日志的情况下运行。
4. 运行 `startAgeChecks({ home, now, onReport })`，它一次性清理每个本地入口，此后每隔 3,600 秒清理一次。`delorun` 在每次调用启动时通过 `pruneLocalSurfaces` 清理一次；home 进程的 `startAgeChecks` 随 home 进程的包 `delorun/packages/home-process` 一起到来。
5. 通过 `log.logger(name)` 写入 Delorun 自身的记录；用来自 `@delorun/logs/cordis` 的 `attachCordisLogs(ctx, log)` 挂接 Cordis 应用；并用 `LineCapture`、`captureStream` 或 `interceptStdio` 捕获上游代码的输出。

`SurfaceLog.write` 从不抛出异常：无法写入的记录会被丢弃，其 `LogsError` 或 `HomeLayoutError` 交给 `onFailure`，下一条记录会重新打开文件。若入口既保留上游的控制台导出器，又捕获自身的标准输出，则每条 Cordis 消息都会被写入两次，因此它只保留其中之一。

<a id="records-and-keys"></a>
## 记录与键

每条记录是一行 JSON，包含 C20 的字段，最多 16,384 字节。超长记录在脱敏后截断，截断顺序依次为 `err.stack` 的末尾、`msg`、`err.message`；`truncated` 统计删除的字节数，其中包括捕获时已丢弃的字节。来自 Cordis 导出器和 `log.logger(name)` 的记录带有 `source: "delorun"`；捕获的行带有 `source: "captured"`，并以 `stdout` 或 `stderr` 作为其日志器名称。

记录通过 `keys` 指定其键，或从日志的键来源（`log.useKeys(source)`）中获取键。`attachCordisLogs` 添加一个键来源，它读取上游的 agent 注册表：当某个 agent 驱动一个 chat 时，`ctx.agents.currentInitiator()` 给出该 agent，记录则带有该会话的 id；轮次未结束时，还带有该会话最近一次 `turn/start` 的编号。这涵盖 Cordis 消息，以及该进程在轮次期间写入其自身流的输出。会话日志事件不作任何改动，因此上游的会话格式与对等回放保持不变。

<a id="redaction"></a>
## 脱敏

`Redactor.text` 应用 C20 的第 1 步与第 3 步：每个长度至少为 8 个字符的已登记值，以及其 base64、base64url、十六进制、URL 编码与 JSON 转义形式，不区分大小写进行匹配，包括较长编码中在每个字节对齐位置都保持不变的 base64 编码部分；随后是列出的形式，从头部值与 URL 凭据，到可大写或小写、可分组的所有者验证码串与 `NAME=value` 对，以及文本中不含 `BEGIN` 行、由两行或更多每行 64 个字符的 base64 组成的密钥主体。`Redactor.fields` 在结构化值序列化之前应用第 2 步，`Redactor.error` 应用第 4 步。已登记的值替换为 `[redacted:<kind>]`，列出的形式替换为 `[redacted:<pattern>]`，名称表明为机密的字段替换为 `[redacted]`。脱敏只捕获已登记的值与列出的形式；C20 说明了它无法捕获的内容。

<a id="captured-output"></a>
## 捕获的输出

`LineCapture` 将流按行拆分为每行一条记录，在多次写入之间暂存不完整的行，最多 65,536 字节。超过该大小的行会在该大小处整体脱敏，其后直到换行符为止的部分被丢弃并计数。PEM 私钥块的每一行都替换为 `[redacted:private-key]`，因为每行本身就是一条记录。`captureStream` 捕获子进程的流，`interceptStdio` 捕获本进程自身的流；在轮次期间写入的行带有该轮次的键。

<a id="rotation-and-retention"></a>
## 轮转与保留

写入方在某次写入会使活动文件超过 10 MiB 之前进行轮转：`.3` 重命名为 `.4`，`.2` 重命名为 `.3`，`.1` 重命名为 `.2`，活动文件重命名为 `.1`，并删除旧的 `.4` 以及更靠后的文件。若某个写入方的活动文件被另一进程轮转、清理、清空或删除，它会继续写入其路径上当前的文件。`pruneSurface` 与 `pruneLocalSurfaces` 会删除每个最早记录早于 14 天的文件，并先将已过期的活动文件轮转走；`pruneStartupReports` 按各自最后写入时间删除超过同一窗口的上游 `startup-*.log` 报告，因为报告没有可用于判定日期的记录。`clearSurface`、`clearStartupReports` 与 `clearLocalLogs` 是 `delorun logs --clear` 与清除所提供选项对应的清空操作：轮转文件与上游的 `startup-*.log` 报告被删除，活动文件则原地清空。这些函数只作用于入口自身的 `<name>.log` 与 `<name>.log.<n>` 文件以及启动报告，拒绝符号链接，并且从不触及 `sessions/`。

<a id="reading"></a>
## 读取

`readLines` 返回入口各文件中最后的匹配行，从最新的文件开始向前读取。`followLines` 交付其启动后写入的每一行，并跨越轮转；被原地清空的文件，在检查发现其长度短于已读取的部分时，会从头开始跟随。两者都先用 C1 的拒绝规则检查每个文件。`parseRecord` 检查一行中必需的字段，并保留未知字段。

<a id="the-denial-suite"></a>
## 拒绝测试套件

[`tests/denial/`](tests/denial/denial.integration.spec.ts) 对参考入口运行 C20 的拒绝测试：由本包写入 `home-default` 并捕获子进程的输出；同时对包位于树中且依赖 `@delorun/logs` 的每个入口运行。[`tests/denial/surfaces.ts`](tests/denial/surfaces.ts) 列出 C20 的入口及其所属包。包不存在或未依赖 `@delorun/logs` 的入口，会作为带有原因的跳过测试列出；包依赖 `@delorun/logs` 的入口必须在那里添加其 `SurfaceDriver`，否则套件失败。

| C20 测试 | 规格文件 | 运行范围 |
| --- | --- | --- |
| `log-canary-every-surface` | `denial.integration.spec.ts` | 套件中的每个入口，包括轮转文件 |
| `log-canary-split` | `denial.integration.spec.ts` | 套件中的每个入口 |
| `log-canary-patterns` | `denial.integration.spec.ts` | 套件中的每个入口 |
| `log-rotation` | `denial.integration.spec.ts` | 大小：套件中的每个入口；期限：每个入口运行的期限检查 |
| `log-modes` | `denial.integration.spec.ts` | 套件中的每个入口 |
| `log-session-keys` | [`session-keys.spec.ts`](tests/denial/session-keys.spec.ts)、[`home-wiring.spec.ts`](tests/denial/home-wiring.spec.ts) | 上游生产环境 agent 循环上的 Cordis 导出器；home 入口自身的接线 |
| home 进程的已知值 | `home-wiring.spec.ts` | home-auth 存储、凭据提供方包装器与环境所生成的每种机密，以原始与编码形式植入记录和捕获的输出，包括轮转文件 |
| `log-purge-clear` | `denial.integration.spec.ts` | 套件中每个入口上的清空操作；清除本身在 C8 的清除进入树中之前会被跳过 |
| `log-desktop-host-file` | 跳过 | 等待桌面 Host 的日志文件 |
| `log-confined-write-denied` | 跳过 | 等待 Delorun 针对 C1 的 `home-write` 规则提供的沙箱配置文件 |

<a id="tests"></a>
## 测试

在仓库根目录下，运行 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/logs` 即可执行这些测试规格；`--reporter=verbose` 会列出每个被跳过的入口及其原因。启动 agent 的测试规格会加载上游的构建包，因此需要先运行 `pnpm run build:artifacts`。
