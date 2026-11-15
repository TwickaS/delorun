---
description: "Delorun 更新与回退的设计：更新报告的数据项、默认进行的 chat 数据副本、唯一的回退表、被中断的恢复、回退不删除任何东西的规则、对更低版本的拒绝，以及桌面应用的已验证更新与回退。"
---

# 更新与回退

[English](update-and-rollback.md) | 中文

## 摘要

在更新更改任何东西之前，Delorun 会显示一份报告，说明新的发布版本会关闭、移除或更改什么，包括它是否改变 chat 数据的存储方式。如果改变，除非此人拒绝，Delorun 会先复制 chat 数据，这样回到上一个发布版本仍然可行。每一种回退的途径都经过同一个函数和同一张表，并且回退从不删除 chat 数据：更新之后写下的 chat 会被搁置，而不是移除。更新报告的类型和规则见[约定 C3](../contracts/c03-update-report.zh.md)，home 进程的更新握手见[约定 C19](../contracts/c19-home-process.zh.md)，home 的目录见[约定 C1](../contracts/c01-home-layout.zh.md)。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

## 今天已有的内容

- `delorun update` 通过 CLI home 的 home 进程更新它。home 进程获取并验证渠道的发布版本，把它安装到运行时存储中，并构建格式为 `delorun.update-report/3` 的更新报告，其条目包括规则 1 到 3 的 `data` 条目；命令打印报告、询问，并根据此人对 session 数据副本的选择应用它。
- session 数据副本、带有 `targetStarted` 的更新记录 `run/<profile>/update.json`、唯一的回退表、搁置目录、恢复日志、在更新等待期间统计运行中的 chat 并拒绝新轮次的 chat 门，以及带有自动回退的健康检查，均已为 CLI home 构建。[C3](../contracts/c03-update-report.zh.md)、[C19](../contracts/c19-home-process.zh.md) 和 [C1](../contracts/c01-home-layout.zh.md) 对它们作了描述。
- `delorun recover` 报告 profile 所处的状态，并且每次调用运行一个操作：通过唯一的回退表的 `rollback`、`rollback --profile-only`、`restore <version>`、`safe-mode` 和 `exit-safe-mode`，以及针对副本或搁置目录的 `discard <path>`。
- 没有任何客户端在更新之前比较版本：只要渠道的发布版本与正在运行的不同，`delorun update` 就会提供它。
- 桌面应用是上游的，保持不变：它的更新器在此人点击时下载并安装，拒绝降级，不检查任何 Delorun manifest 或日志条目，不保留上一个发布版本，也不提供回退。

## 规则

### 报告指出数据更改

1. 每个发布版本在其运行时中携带一个已签名的文件 `data-formats.json`：`{ "schema": "delorun.data-formats/1", "persistence": <SHA-256 of upstream's generated persistence schema at the built commit>, "delorunRecords": { <record name>: <version> } }`。`delorunRecords` 列出 Delorun 自己的包在 home 之下保存的带版本的记录。该文件在已签名的文件列表中，所以发布 manifest 不变。
2. 相同的文件意味着两个发布版本能读取彼此的数据。任何差异都是类型为 `data`、原因为 `data-format-changed`、效果为 `changed` 的一个报告条目。任何一侧缺失或无法读取的文件，其原因是 `data-format-unknown`，它是未经验证的，并以同样的方式处理。Delorun 不判断差异的方向：每个差异都按单向处理。这一比较从不拒绝更新或回退。
3. 报告格式变为 `delorun.update-report/2`，其计数增加 `data`。

### 默认进行副本

4. 当数据不同时，条目的操作是 `copy-session-data`（默认）和 `continue-without-copy`。`delorun update --yes` 会进行副本。拒绝需要 `--no-data-copy` 或提示的第二个选项，并且报告会在该选项旁边说明：“Without the copy, Delorun cannot go back to `<from>` after `<to>` first starts.”当没有任何不同时，不提供副本，而 `--data-copy` 仍然会进行一份。
5. 在此人看到该条目并对副本做出选择之前，不应用任何数据有差异的更新。
6. 副本把 home 的 `sessions/` 和 `storages/` 作为真正的副本保存（文件系统提供克隆时使用文件系统克隆，否则完整复制），绝不使用硬链接。`attachments/` 保留在原处，因为没有任何东西会从中删除，而 `cache/` 被略去并会重建。
7. Delorun 自己在 `secrets/` 之下的记录从不被复制或恢复，因为恢复设备列表会再次信任已被移除的设备。取而代之的是，上一个发布版本读取当前发布版本写下的每一条记录，[旅程检查](journey-check.zh.md)的回退步骤对此进行测试。
8. 副本写入 `data-copies/<to version>/`，旁边是 `copy.json`，它记录两个发布版本的 `data-formats.json`、文件数和字节总数。它在 chat 门报告没有 chat 在运行并且 Host 已停止之后、在持有 home 锁期间、以临时名称写入，该名称在运行时切换之前被重命名并同步。报告显示副本的大小和可用空间；放不下的副本会以 `DATA_COPY_NO_SPACE` 拒绝更新，除非此人选择在没有它的情况下继续。
9. 只保留一份副本。以后更新的副本，或此人通过 `delorun recover` 的操作，会移除较旧的那一份。

### 每种回退的途径都使用同一张表

10. 更新记录 `run/<profile>/update.json` 记录两个版本、数据是否不同、副本是否存在，以及 `targetStarted`，后者在目标的进程启动之前写入并同步。
11. 握手的 `rollback`、健康检查失败之后的自动回退、被中断的更新之后的重启，以及没有 home 进程时的 `delorun recover rollback`，都读取更新记录并应用这张表；没有一个自己切换运行时。

| 数据不同 | 目标已启动 | 副本 | 回退 |
| --- | --- | --- | --- |
| 否 | 任一 | 未提供 | 恢复 profile 快照并切换到上一个运行时。此后写下的 chat 保留。 |
| 是 | 否 | 任一 | 同上；目标从未打开过数据。 |
| 是 | 是 | 存在 | 列出自更新以来创建或更改了多少个 chat，并说明它们被搁置而不是被删除。把活动的 `sessions/` 和 `storages/` 移到 `data-set-aside/<to version>-<time>/`，把副本移到位，恢复 profile 快照并切换运行时。 |
| 是 | 是 | 不存在 | 以 `ROLLBACK_NEEDS_DATA_COPY` 和原因拒绝，并提供 `delorun recover rollback --profile-only`，它恢复 profile 快照并保留目标运行时。 |

12. 回退不删除任何 chat 数据。被搁置的数据保留到此人用 `delorun recover` 移除它为止，该命令列出每个搁置目录及其大小。被搁置的 chat 通过归档导入回来（见 [C8](../contracts/c08-archive-and-trash.zh.md)）。
13. 被中断的恢复会在任何 Host 启动之前完成。恢复在第一次重命名之前写一份日志 `data-copies/restore.json`，每一步都是一次目录重命名。启动器、`delorun start` 和 `delorun recover` 在启动 Host 之前读取该日志，并完成正在进行的那一步。

### 命令接通之前

14. chat 门统计运行中的 chat，而健康检查对 [C3 的健康检查判据](../contracts/c03-update-report.zh.md#health-check)求值，两者都发生在 `delorun update` 到达握手之前。
15. 该设计只适用于 CLI home。桌面应用共享 `sessions/` 并且不持有 home 锁，所以在一把锁涵盖两种安装、并且它的更新器遵循同一张表之前，它不通过这个流程更新。

### 没有版本会自行降低

16. `delorun update` 和更新渠道会拒绝低于正在运行版本的目标，除非此人要求回退，而回退只能通过回退表到达已签名并已记录日志的发布版本。

### 桌面应用

17. 在桌面应用把下载交给 electron-updater 的 `quitAndInstall` 之前，它会对照 manifest 的 `desktop` 条目和 manifest 的日志条目，验证一个新的时间戳、manifest 的签名以及下载文件的 SHA-512 和 SHA-256（见 [C2](../contracts/c02-release-manifest.zh.md)、[C18](../contracts/c18-release-log.zh.md)）。任何失败都会拒绝安装，并让正在运行的版本保持不变。
18. 更新应用之后，应用会把它所替换的发布版本的安装程序或更新压缩包保留在它的更新缓存目录中，并对照该发布版本的 manifest 进行验证。缓存只保留一个上一个发布版本。
19. 更新源拒绝自动降级：指出的版本低于或等于正在运行版本的更新源不提供任何东西。
20. 此人请求的回退会安装缓存的上一个发布版本，或此人指名的更早的发布版本，从 GitHub Releases 下载。目标必须验证为已签名（manifest 和文件摘要）并已记录日志（包含证明）；未签名、未记录日志或不匹配的目标会被拒绝。安装之后，profile 从历史中恢复。

## 本设计不防护什么

- 更新之后写下的 chat，在此人随后带着副本回退时会被搁置，而不是合并到被恢复的数据中。此人通过导入把它们带回来。
- 拒绝副本的人，在目标第一次启动之后无法回到上一个发布版本；只有 profile 可以回退。
- 正在运行的桌面应用不被计为 chat 数据的使用者（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)）：home 之下没有任何东西表明它在运行，所以更新的副本、恢复或回退可能在它写入同样的存储期间运行。规则 15 让桌面应用远离这个流程；在桌面应用未发布期间，这一缺口被接受。
- 插件保存在 `sessions/` 和 `storages/` 之外的数据不会被复制。
- 副本是 home 之下的普通文件，具有 home 的模式，与它复制的数据相同；它没有加密。
- Windows 上打开的文件无法重命名这一重命名规则不在涵盖之列。

## 拒绝测试

| 测试 | 证明什么 |
| --- | --- |
| `c03-data-change-named` | `data-formats.json` 不同的目标，在任何东西改变之前产生一个 `data` 条目。 |
| `c03-unknown-data-format-is-unverified` | 缺失或无法读取的 `data-formats.json` 是 `data-format-unknown`，未经验证，并且 `--yes` 不会确认它。 |
| `c03-yes-takes-the-copy` | 对数据更改使用 `delorun update --yes`，会在运行时切换之前写入副本。 |
| `c03-copy-without-space-refuses` | 大于可用空间的副本会以 `DATA_COPY_NO_SPACE` 拒绝更新。 |
| `c03-rollback-restores-copy-and-sets-aside` | 目标启动之后的回退会恢复副本，并把较新的数据移到 `data-set-aside/`，不删除任何东西。 |
| `c03-rollback-without-copy-refuses` | 目标启动之后、没有副本的回退以 `ROLLBACK_NEEDS_DATA_COPY` 拒绝，而 `--profile-only` 成功。 |
| `c03-rollback-before-first-start-needs-no-copy` | 目标启动之前的回退不需要副本，并让数据保持原样。 |
| `c03-pointer-swap-applies-the-table` | 没有 home 进程时的 `delorun recover rollback` 应用这张表，并且从不单独切换运行时。 |
| `c03-second-rollback-keeps-both-set-asides` | 第二次回退保留第一个搁置目录。 |
| `c03-interrupted-restore-completes-before-a-host-starts` | 在两次重命名之间被终止的恢复，会在 Host 启动之前由下一次 `delorun start` 完成。 |
| `c03-previous-release-reads-delorun-records` | 上一个发布版本读取当前发布版本在 home 之下写下的每一条记录。 |
| `an update to a lower version is refused` | 针对指出低于正在运行版本的发布版本的渠道，`delorun update` 不提供任何东西，指名较低的已安装版本的更新渠道请求会被拒绝。 |
| `c02-desktop-refuses-bad-manifest` | manifest 签名失败、或下载文件的 SHA-512 与 manifest 不同的桌面更新，会在 `quitAndInstall` 之前被拒绝。 |
| `c02-desktop-refuses-unrequested-downgrade` | 指出较低版本的更新源不提供更新。 |
| `c02-desktop-rollback-signed-logged` | 对已签名并已记录日志的更早发布版本所请求的回退会被应用，并从历史中恢复 profile。 |
| `c02-desktop-rollback-refuses-unsigned-or-unlogged` | 对没有可验证的 manifest、或没有已验证的日志条目的发布版本所请求的回退会被拒绝。 |

## 实现状态

规则 1 到 14 和规则 16 已为 CLI home 构建，由 C3、C19、C1 和 C2 描述：运行时存储在安装任何东西之前，会以 `TARGET_LOWER` 拒绝低于 `current` 的更新目标，而 `delorun update` 会拒绝目标低于正在运行发布版本的报告。规则 15 的、CLI home 和桌面应用共用的一把锁，以及桌面应用的规则 17、18 和 20，尚未构建。规则 19 通过上游的更新器成立，后者拒绝降级（`allowDowngrade` 为 false）。
