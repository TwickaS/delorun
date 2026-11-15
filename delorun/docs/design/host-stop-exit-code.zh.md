---
description: "Host 停止的退出码设计：Host 拆除失败或超时的停止，以失败码和一行日志结束 home 进程，而不是正常停止给出的成功码。"
---

# Host 停止失败的退出码

[English](host-stop-exit-code.md) | 中文

## 摘要

当 home 进程停止时，它通过上游有界的关闭流程，以成功码关闭它的 Host。无论拆除是完成了、失败了还是超时了，该关闭流程都以被给定的码结束进程，所以 Host 没有干净地拆除的停止，会以退出码 0 结束，且不在 home 日志中留下任何一行。监管器、`delorun stop` 和使用者都会把它当作一次干净的停止。本设计让失败或超时的拆除以失败码结束进程，并记录原因。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- `delorun/apps/cli/src/start.ts` 中的 `RunningHost.close()` 调用 `booted.shutdown(EXIT.ok)`，然后移除沙箱覆盖层。
- `booted.shutdown` 是上游的 `createProcessShutdown`（`apps/cli/src/process-shutdown.ts`）。它释放 Host 并设置一个 `PROCESS_SHUTDOWN_TIMEOUT_MS`（5 秒）的计时器。当释放被拒绝，或计时器先触发时，它用被给定的码调用 `process.exit`，这个码就是 `EXIT.ok`。这两种情况都不会被记录。
- `delorun/packages/home-process/src/home-process.ts` 中 home 进程的 `shutdown(code)` 先调用 `closeHost()`，并把被拒绝的关闭记录为 “the Host did not close”。上游的强制退出会在那一行之前、在更新渠道关闭之前、也在 home 进程自己的 `exit(code)` 运行之前结束进程，所以停止所要求的码（例如中断时的 130）也会丢失。home 锁由进程的退出处理程序释放。
- 进程被强制退出时，沙箱覆盖层会保留，这是安全的：下一次启动会重写它。
- 更新或回退的切换以不同的方式停止 Host：`suspend()` 释放它而不结束进程，home 进程自己限定这一等待的时间，并把没有停止的 Host 报告为 `HostNotStoppedError`。

<a id="the-rules"></a>

## 规则

1. `close()` 像 `suspend()` 一样通过 profile 自己的拆除流程释放 Host，由 home 进程以与限定切换相同的限制来限定时间，并且不调用上游的进程关闭。
2. 被拒绝或超时的拆除，会被记录为 “the Host did not stop” 并附上原因，并且 home 进程以 `EXIT.failed` 而不是停止所要求的码结束。覆盖层保留。
3. 在时限内完成的拆除，像今天一样以停止所要求的码结束进程。
4. 如果规则 1 无法成立，因为有界的关闭必须仍是唯一的退出路径，那么上游的 `createProcessShutdown` 为被拒绝或超时的释放接受第二个码，Delorun 传入 `EXIT.failed`。该更改属于上游，并记录在 Delorun 的上游台账中。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **永远不从拆除中返回的 Host。**时限会结束进程；Host 启动但没有停止的子进程不会被本设计停止。
- **从外部终止的进程。**`SIGKILL` 和电脑断电会在没有本设计所设置的任何码的情况下结束进程。

<a id="denial-tests"></a>

## 拒绝测试

- `a stop whose Host teardown rejects ends with the failure code and logs it`
- `a stop whose Host teardown overruns its limit ends with the failure code`
- `an interrupted stop whose teardown fails ends with the failure code, not 130`
- `a clean stop ends with the code it asked for`

<a id="implementation-status"></a>

## 实现状态

尚无；正常的停止路径如“今天已有的内容”所述。
