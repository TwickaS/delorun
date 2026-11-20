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
- [为更新而停止的 chat](#chats-stopped-for-an-update)
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
| `dismiss` | 删除结果记录，以及更新所停止的 chat 的记录。 |
| `stop-chats` | 更新等待 chat 时，记录运行中的顶层 chat，再按其 Stop 按钮的方式停止它们，保留它们的工作。除非有更新在等待，否则以 `NO_UPDATE_PENDING` 拒绝。 |
| `continue-chat` | 向更新所停止的 chat 发送一条固定消息“Continue where you stopped before the update.”。更新运行期间、对 Host 自行继续的 chat、以及对已继续过的 chat，均予以拒绝。 |
| `stop` | 停止 Delorun。studio 中没有任何东西会再次启动它。 |

线路类型见 [`src/wire.ts`](src/wire.ts)。`apply`、`rollback` 与 `stop` 在 Host 停止之前应答，与 Restart 相同；页面轮询 `state`，并在 Host 的发行版与其所加载的不同时重新加载一次。

<a id="who-may-use-each-control"></a>

## 谁可以使用每个操作

这些操作是 Changes 访问表（[`@delorun/plugin-changes`](../plugin-changes/README.zh.md)）中的条目，路由用它的门构建，因此站点围栏、操作的类别和设备的授权凭证在读取正文之前就已决定。

| 操作 | 电脑 | 手机 |
| --- | --- | --- |
| `update-check`、`update-cancel`、`update-dismiss`、`update-continue`（`continue-chat`） | 是 | 是，无提示（类别 `free`） |
| `update-begin`（也包括 `stop-chats`）、`update-rollback`、`stop` | 是 | 是，需针对该请求的一次一个操作的授权凭证（类别 `face`） |

授权凭证是针对那一个请求的 Face ID 确认或该设备的 PIN；批准宽限期不算。`state` 只向可以开始更新的请求显示已准备的报告，该报告列出插件与 harness 的差异。

<a id="chats-stopped-for-an-update"></a>

## 为更新而停止的 chat

`stop-chats` 所需的条件与开始更新相同，因为结束运行中的 chat 正是让更新得以继续的条件。它在取消任何内容之前，先把已停止的 chat 连同更新的目标版本和 `continueStoppedChats` 设置的当前值，写入 profile 运行文件夹中的 `update-stopped-chats.json`，因为更新会重启 Host。对该记录的每次写入都在同一把锁下运行，并重新读取记录；每个 chat 在其消息发送之前先被标记，因此一个 chat 至多收到一条消息。更新后的 Host 只在该设置已开启、且更新的结果记录指明同一目标时，才把记录中的 chat 继续一次。被取消或未重启即结束的更新会立即处理其 chat：每个 chat 在空闲之后收到它的消息，未能继续的 chat 保留其 Continue 按钮。后台任务随 chat 一起停止，且从不继续。该消息是来源类型为 `delorun-update` 的用户消息。

<a id="what-the-host-keeps"></a>

## Host 保存什么

报告和 home 进程的报告 id 留在 Host 内存中；页面持有一个随机句柄，以恒定时间比较，报告在 600 秒后过期。通道令牌留在 `delorun start` 提供的 `updateChannel` 服务之内。该服务是根 Cordis 服务，因此在 Host 中运行的任何插件都能读取它，并绕过访问表发送更新、回滚与停止请求；Cordis 没有办法给一个插件一个另一个插件读不到的服务名，而 Host 中的插件是受信任的代码，`changesRestart` 也是如此。一个 `apply` 正在启动时再来的 `apply` 会以 `UPDATE_IN_PROGRESS` 拒绝。`apply` 需要报告要求的每个勾选键，规则取自 `delorun update --yes` 所用的规则（`@delorun/update` 中的 `confirmationNeeds`），并且无论页面发送什么，都拒绝有冲突的 harness 文件或失败的发布日志检查。

<a id="configuration"></a>

## 配置

- `waitSeconds`：更新或回滚等待运行中 chat 的时间，60 到 86,400 秒，默认 1,800。
- `continueStoppedChats`：更新所停止的 chat 在更新之后是否自行继续，默认开启；在 Settings → Updates 中更改。关闭后，每个已停止的 chat 显示一个 Continue 按钮。
- `checkGapSeconds`：两次到达网络的发行版检查之间的最短时间，1 到 3,600 秒，默认 10。一次检查运行期间的请求会并入它；间隔之内的请求得到上一次的答案。

<a id="tests"></a>

## 测试

`tests/update-routes.spec.ts` 存放拒绝测试：其他站点、没有授权凭证或只有批准宽限期的手机、页面提供的或已过期的报告、正在进行的重启或更新、缺失的勾选、冲突的报告，以及通道令牌和报告 id 永远不会进入应答。
