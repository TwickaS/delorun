---
description: "@delorun/plugin-update 包，面向 delorun 的维护者：/delorun/update/ 下 studio 的更新路由（立即检查、用 C3 的报告准备并应用更新、取消、回退、关闭结果、停止 Delorun）、每个操作在何处可由谁使用、Host 在内存中保存什么，以及每一步如何通过更新通道抵达 home 进程。"
---

# @delorun/plugin-update

[English](README.md) | 中文

## 摘要

本包是 studio 更新的 Host 一半（[更新与回滚](../../docs/design/update-and-rollback.zh.md#the-studios-update)、[约定 C19](../../docs/contracts/c19-home-process.zh.md)）。它注册 `/delorun/update/` 下的路由，在读取正文之前用 Changes 门决定每个请求，并通过 Host 在启动时收到的更新通道，请求 home 进程检查、准备、应用、取消、回滚和停止。验证、安装、切换和回滚由 home 进程完成；本包只负责询问和报告。

## 目录

- [路由](#routes)
- [谁可以使用每个操作](#who-may-use-each-control)
- [Chats stopped for an update](#chats-stopped-for-an-update)
- [Host 保存什么](#what-the-host-keeps)
- [配置](#configuration)
- [测试](#tests)

<a id="routes"></a>

## 路由

`state` 是任何已放行会话都可读取的 `GET`；其他每个路由都是 `POST`。

| 路由 | 作用 |
| --- | --- |
| `state` | 此 Host 运行的发行版、每个操作对本次请求的决定、检查、进度、已准备的报告、结果记录，以及是否提供 Go back。 |
| `check` | 立即运行发行版检查。 |
| `prepare` | 请求 home 进程获取、验证并安装最新发行版，并在不透明的句柄下返回 C3 的报告。 |
| `apply` | 开始更新已准备的报告。正文给出句柄、对运行中 chat 的 `wait` 或 `stop`、数据复制的选择，以及此人已接受的勾选键。 |
| `cancel` | 结束仍在等待 chat 的更新或回滚。 |
| `rollback` | 从已提交的更新回退；没有 chat 数据的副本时为 `profileOnly`。 |
| `dismiss` | 删除结果记录。 |
| `stop-chats` | While an update waits for chats, records the running top-level chats, then stops them the way their Stop button does, keeping their work. Refused with `NO_UPDATE_PENDING` unless an update waits. |
| `continue-chat` | Sends one fixed message, "Continue where you stopped before the update.", to a chat the update stopped. Refused while an update runs, for a chat the Host continues by itself, and for a chat already continued. |
| `stop` | 停止 Delorun。studio 中没有任何东西会再次启动它。 |

线路类型见 [`src/wire.ts`](src/wire.ts)。`apply`、`rollback` 与 `stop` 在 Host 停止之前应答，与 Restart 相同；页面轮询 `state`，并在 Host 的发行版与其所加载的不同时重新加载一次。

<a id="who-may-use-each-control"></a>

## 谁可以使用每个操作

The controls are entries of the Changes access table ([`@delorun/plugin-changes`](../plugin-changes/README.zh.md)), and the routes are built with its gate, so the site fence, the control's class and the device's grant are decided before a body is read.

| Control | Computer | Phone |
| --- | --- | --- |
| `update-check`, `update-cancel`, `update-dismiss`, `update-continue` (`continue-chat`) | yes | yes, no prompt (class `free`) |
| `update-begin` (also `stop-chats`), `update-rollback`, `stop` | yes | yes, with a one-action grant for the request (class `face`) |

A grant is a Face ID confirmation or the device's PIN for that one request; the approval grace does not count. `state` shows the prepared report, which names plugins and harness diffs, only to a request that may begin an update.

<a id="chats-stopped-for-an-update"></a>

## Chats stopped for an update

`stop-chats` needs what beginning the update needs, because ending running chats is what lets the update go on. It writes the stopped chats, with the update's target version and the `continueStoppedChats` setting as it stands, to `update-stopped-chats.json` in the profile's run folder before it cancels anything, because the update restarts the Host. Every write to that record runs under one lock that re-reads it, and each chat is marked before its message is sent, so a chat gets at most one message. The updated Host continues the recorded chats once, only when the setting was on and the update's outcome record names the same target. An update cancelled, or ended without a restart, settles its chats at once: each gets its message after it has gone idle, and a chat that could not be continued keeps its Continue button. Background jobs stop with the chats and are never continued. The message is a user message with the source kind `delorun-update`.

<a id="what-the-host-keeps"></a>

## Host 保存什么

报告和 home 进程的报告 id 留在 Host 内存中；页面持有一个随机句柄，以恒定时间比较，报告在 600 秒后过期。通道令牌留在 `delorun start` 提供的 `updateChannel` 服务之内。该服务是根 Cordis 服务，因此在 Host 中运行的任何插件都能读取它，并绕过访问表发送更新、回滚与停止请求；Cordis 没有办法给一个插件一个另一个插件读不到的服务名，而 Host 中的插件是受信任的代码，`changesRestart` 也是如此。一个 `apply` 正在启动时再来的 `apply` 会以 `UPDATE_IN_PROGRESS` 拒绝。`apply` 需要报告要求的每个勾选键，规则取自 `delorun update --yes` 所用的规则（`@delorun/update` 中的 `confirmationNeeds`），并且无论页面发送什么，都拒绝有冲突的 harness 文件或失败的发布日志检查。

<a id="configuration"></a>

## 配置

- `waitSeconds`：更新或回滚等待运行中 chat 的时间，60 到 86,400 秒，默认 1,800。
- `continueStoppedChats`: whether chats stopped for an update continue by themselves after it, on by default; Settings → Updates changes it. With it off, each stopped chat shows a Continue button.
- `checkGapSeconds`：两次到达网络的发行版检查之间的最短时间，1 到 3,600 秒，默认 10。一次检查运行期间的请求会并入它；间隔之内的请求得到上一次的答案。

<a id="tests"></a>

## 测试

`tests/update-routes.spec.ts` holds the denial specs: other site, phone without a grant or with only the approval grace, a page-supplied or expired report, a restart or update in progress, missing ticks, a conflicted report, and the channel token and report id never reaching an answer.
