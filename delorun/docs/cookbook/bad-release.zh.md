---
description: "维护者在已发布的 Delorun 版本出问题或被篡改时使用的操作指南：阻止其扩散、发布修复版本、在仓库和站点上发布公告、给用户提供回到上一版本的命令，并在测试渠道上演练整个预案。"
---

# 处理有问题的发布版本

[English](bad-release.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本指南面向维护者。它涵盖已发布的版本损坏了用户的安装，或被人篡改的情形。完成后，你将发布一个修复版本，在仓库和站点上发出公告，并让安装了有问题版本的用户回到一个正常的版本。你需要发布签名密钥、负责发布的 npm 和 GitHub 账号，以及仓库检出中的一个终端。发布始终由人手动、配合第二因素完成，所以 agent 可以准备这些步骤，但不能替你执行。

## 目录

- [用户已经具备什么](#what-people-already-have)
- [步骤](#the-steps)
- [给用户的命令](#the-command-for-people)
- [在测试渠道上演练](#rehearse-on-a-test-channel)

<a id="what-people-already-have"></a>
## 用户已经具备什么

在你采取行动之前，Delorun 已经保护了大多数安装：

- 更新在切换之后会检查新版本。健康检查失败时，Delorun 会自动回到用户原来的版本和 profile（[更新](../guide/safety-and-updates/updates.zh.md#what-happens-during-an-update)）。
- Delorun 保留两个已安装的版本，即正在运行的版本和它之前的版本，所以用户可以回退一个版本。
- 没有任何发布渠道会移动到更低的版本，所以不能通过把渠道指向旧版本来撤回有问题的版本。修复版本必须使用更高的版本号。

<a id="the-steps"></a>
## 步骤

1. **判断属于哪种情形。** 损坏的版本是因为普通的原因而失败。被篡改的版本，或可能被他人持有的签名密钥，属于安全事件：还要遵循 [SECURITY.md](../../../SECURITY.md)，如果涉及密钥，则遵循[发布清单契约](../contracts/c02-release-manifest.zh.md)中的轮换规则。
2. **阻止其扩散。** 用 `npm deprecate delorun@<bad-version> "<一行原因>"` 在 npm 上弃用有问题的启动器，并用 `npm dist-tag add delorun@<good-version> latest` 把 `latest` 标签移回最后一个正常的版本，这样 `npx delorun` 安装的就是正常的启动器。在有问题版本的 GitHub release 上，编辑说明，写明该版本已撤回及原因。保留它的文件和它在公开发布日志中的条目：日志是一份记录，它会一直保留。
3. **发布修复版本。** 在发布分支上修复问题，用更高的版本号切出一个版本，完成全部检查和依赖公告检查，并手动发布。渠道的时间戳随后指向修复版本，安装在下一次更新检查时就会提供它。
4. **发布公告。** 在仓库（一个置顶的 issue，以及一条 Discussions 公告）和站点上发布。公告写明哪个版本有问题、安装了它的用户会怎样、修复版本是哪个，下面的命令，以及已回退的用户在修复版本发布之前不要运行 `delorun update`。对于被篡改的版本，还要写明该检查什么：`delorun verify` 和发布日志条目。
5. **确认用户能离开有问题的版本。** 在装有该版本的机器上运行下面的命令，确认 Delorun 运行的是上一个版本，并且 `delorun update` 提供的是修复版本。在修复版本发布之前，`delorun update` 会再次提供有问题的版本，因为渠道仍把它当作最新版本。
6. **结束事件。** 在事后复盘中记录发生了什么，并加上能发现它的检查。

<a id="the-command-for-people"></a>
## 给用户的命令

安装了有问题的版本、且尚未更新的用户运行：

```sh
delorun recover rollback
```

它会回到上一次更新之前的版本，并使用在此之前拍下的 profile 快照。无论 Delorun 是否在运行，它都可以工作。如果更新改变了聊天数据的格式，它会把较新的数据放到一边，并把更新前所做的副本放回原位。没有该副本时，它会以 `ROLLBACK_NEEDS_DATA_COPY` 拒绝，而 `delorun recover rollback --profile-only` 只恢复 profile（[更新](../guide/safety-and-updates/updates.zh.md#going-back)）。在修复版本发布之前，渠道一直指向有问题的版本，所以已回退的用户运行 `delorun update` 会再次被提供该版本。修复版本发布后，`delorun update` 会把用户带向前。

<a id="rehearse-on-a-test-channel"></a>
## 在测试渠道上演练

在首个公开版本之前演练一次这份预案，并在发布流程变化之后再演练一次：

1. 按[发布工具 README](../../apps/release/README.zh.md)中本地发布渠道一节的说明提供一个测试渠道，并从中安装一个版本。本地发布使用的根文件会指明它提交到的日志，所以生产密钥和公开日志不能用于演练。请使用一次性密钥、基于它们的根文件和一个替身发布日志（由 `delorun/apps/release` 中的 `tests/journey/parts.ts` 和 `tests/journey/servers.ts` 构建），以及为该根、渠道和日志构建的启动器。
2. 向该渠道发布第二个版本，然后把第二个版本当作“有问题”的版本。渠道只接受递增的版本号，所以三个版本可以是 `0.1.0-rc.5`（正常）、`0.1.0-rc.6`（有问题）和 `0.1.0-rc.7`（修复）；`local-release.ts --closures-from` 会为你此前构建好的闭包签名，所以演练不需要重新构建。
3. 走一遍上面的步骤：在已安装的副本上运行 `delorun update` 取得有问题的版本，运行该命令，确认安装最终停在上一个版本，并且 `delorun update --check` 会再次提供有问题的版本。然后发布修复的第三个版本，确认 `delorun update` 能到达它。使用独立的 `DELORUN_HOME` 和独立的工作室端口。
4. 写下任何不清楚的地方，并修订本页。npm 和 GitHub 的步骤不做演练：检查命令格式正确（`npm deprecate --help`、`npm dist-tag --help`），并且指向正确的版本。

**验证。** 演练之后，`delorun --version` 报告的是修复版本，`delorun recover status` 报告最近一次更新，`delorun verify` 通过。
