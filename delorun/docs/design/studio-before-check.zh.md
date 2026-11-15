---
description: "后置启动检查之前的 studio 设计：只有当 Host 通过 C19 的后置启动检查之后才签发 studio 链接，以及在该检查之前 studio 的端口开始监听的剩余窗口期。"
---

# 后置启动检查之前的 studio

[English](studio-before-check.md) | 中文

## 摘要

`delorun start` 启动的 Host 必须先通过 [C19](../contracts/c19-home-process.zh.md) 的后置启动检查，人才能在其中工作：防护行没有启动、或防护服务来自另一行的 Host 会被拒绝并停止。本设计大部分已经构建：studio 只能通过 home 进程在检查之后签发的一次性链接打开。剩下的是 Web 服务器开始监听到检查完成之间的时间，以及被中断的更新的健康检查所花的时间，在这些时间里，studio 的端口会接受连接，或者在 Host 得到确认之前就签发了链接。本页陈述关闭这些窗口的规则。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- `delorun start` 以 `--no-open` 启动 CLI profile（`delorun/apps/cli/src/start.ts` 中的 `bootProfile`），所以上游的浏览器交接从不运行。
- studio 通过 home 进程的 `studio.open-token` 请求打开（`delorun/packages/home-process/src/studio-link.ts` 中的 `studioOpenToken`）。home 进程根据它的 `host` 字段应答该请求，该字段在 `bootedHost()` 返回时设置（`delorun/packages/home-process/src/home-process.ts`）；`bootedHost()` 只在 `assertDelorunInvariants` 通过之后才返回。在此之前，该请求会以 `STUDIO_UNAVAILABLE` 被拒绝。
- `delorun start`、`delorun open` 和 `delorun setup` 的结尾，只在 `HomeProcess.start` 返回之后才调用 `announceStudio`。
- 更新渠道在 Host 启动之前就开始监听，所以 `studio.open-token` 请求可能在启动期间到达；它会如上所述被拒绝。
- Web 服务器在上游的 `runProfile` 内、在 `assertDelorunInvariants` 运行之前就开始监听。在这个窗口期里，studio 的端口会接受已经持有较早一次启动的 studio 会话的浏览器的连接。
- 更新门（`holdUntilChecked`）扣住 CLI profile 的 agent 轮次，直到 home 进程在检查之后释放它们。标题生成、自动审阅以及人启动的压缩不会被扣住。
- 在被中断的更新之后，home 进程会在运行更新的健康检查之前设置 `host`，所以在该检查运行期间可以签发链接。

<a id="the-rules"></a>

## 规则

1. home 进程只在 `running` 状态下签发 studio 链接：即后置启动检查之后，以及在被中断的更新之后，其健康检查提交该更新之后。在所有其他状态下，`studio.open-token` 以 `STUDIO_UNAVAILABLE` 被拒绝，原因是 “Delorun is still starting”。
2. 在 home 进程释放更新门之前，studio 对每个会话请求（包括来自较早会话的重新连接）都以 “Delorun is starting” 响应作答，并且不打开任何 chat。这需要在 Web 服务器的连接上有一个上游的准入点，让 Delorun 的某一行可以持有它，方式与更新门扣住轮次相同。
3. 更新门的扣留涵盖 Host 在释放之前发出的每一个模型请求，而不仅仅是 agent 轮次。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **被拒绝的 Host 的拆除时间。**被检查拒绝的 Host 会一直运行到它的拆除结束；规则 2 和 3 在此期间让人和模型远离它。
- **同一用户的另一个进程。**以此人身份运行并持有 home 的启动令牌的进程，可以在 Delorun 运行之后请求链接；[威胁模型](../security/threat-model.zh.md)把此人自己的账户视为受信任的。

<a id="denial-tests"></a>

## 拒绝测试

- `a studio link requested while the Host boots is refused as still starting`
- `a studio link requested during an interrupted update's health check is refused`
- `a studio reconnect before the post-boot check opens no chat`
- `no title generation request reaches the model before the post-boot check`

<a id="implementation-status"></a>

## 实现状态

studio 只通过一次性链接打开，并且在正常启动时，链接只在后置启动检查之后签发。规则 1 到 3 尚未构建。
