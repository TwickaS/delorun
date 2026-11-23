---
description: "更新通知的设计：验证渠道最新发布版本且不发送任何关于使用者的信息的检查，它何时运行，终端和 studio 如何显示它，关闭它的唯一开关，使安全修复保持为补丁的补丁规则，以及插件如何以 Delorun 自己的版本为目标。"
---

# 更新通知

[English](update-notice.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

更新由此人选择：`delorun update` 与 studio 的 Update now 显示同一份报告、询问、复制 chat 数据，并在健康检查失败时回退（[更新与回滚](update-and-rollback.zh.md#the-studios-update)）。更新通知告诉此人存在更新的发布版本。正在运行的安装会在启动时并按计划检查发布渠道，像更新验证一样验证它所获取的内容，并在终端中显示一行，在 studio 的侧边栏中显示一条安静的通知。该通知指出更新的类型、它是否是安全修复、它会关闭多少个已安装的插件以及要运行的命令；它本身不应用任何东西；通知上 studio 的 Update now 按钮会打开报告。Delorun 只有一个发布流，所以安全修复就是带有标记的发布版本，发布工具让这样的修复保持为让每个插件都兼容的补丁。Delorun 的版本和上游的版本是两条轴（[C17](../contracts/c17-plugin-versions.zh.md)）；[C22](../contracts/c22-delorun-plugin-interface.zh.md) 陈述了 Delorun 版本对插件的承诺，`delorun plugin check` 向作者显示他们声明的范围接纳什么。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- `delorun update` 请求 home 进程通过 `@delorun/install` 的 `LauncherChannel` 解析渠道最新的发布版本，后者验证根链、时间戳、manifest、发布日志 bundle 以及在线日志检查（见 [C2](../contracts/c02-release-manifest.zh.md)、[C18](../contracts/c18-release-log.zh.md)），将其安装到存储中，并打印 [C3](../contracts/c03-update-report.zh.md) 的报告。在一个人运行它之前，没有任何东西告诉他存在某个发布版本。
- 时间戳指出每个渠道当前的发布版本及其 manifest。manifest 陈述发布版本的 Delorun 版本及其上游版本 `dsh`。没有已签名的文件标记安全修复或携带摘要。
- `@delorun/update` 针对目标发布版本，为报告判定每个已安装插件的两条轴。
- 上游的 `evaluatePluginCompatibility` 在安装时和启动时判定两条轴。在安装之前，没有任何东西向插件作者显示他们的范围接纳什么。
- 发布工具对草稿所指名的任何版本签名。没有任何东西把发布版本与其次版本的更早发布版本做比较。

<a id="the-rules"></a>

## 规则

### 检查

1. 检查是 `delorun/apps/cli/src/update/notice.ts` 中的 `checkForUpdate`。它像 `delorun update` 那样打开 home 的渠道：使用启动 Delorun 的启动器的发布根（在 `DELORUN_LAUNCHER_ROOTS` 中指明），在安装记录于 `trust/channel.json` 的源站上，通过同一个 `LauncherChannel`。不是由启动器启动的 Delorun 没有锚定的根，它的检查会在不发出请求的情况下失败；检查调用 `LauncherChannel.newest`，它获取 `timestamp.json`、任何更新的根文件、渠道的 manifest 及其发布日志 bundle，并用更新所使用的函数验证它们：根链，时间戳对照已存储时间戳的签名、过期和版本，manifest 对照时间戳的摘要及其 targets 签名，以及 bundle 的包含证明和见证者联署。它不运行在线日志检查，不下载压缩包，也不在 `trust/` 之下写入任何东西。
2. 请求不携带查询、cookie、请求体或标识符。关于已安装插件的任何信息都不会离开这台机器。
3. 结果是渠道最新的发布版本：它的 Delorun 版本、它的上游版本、它的 manifest 是否将其标记为安全修复，以及它的摘要。没有标记的 manifest 不是安全修复；没有摘要的则没有摘要。
4. 插件数量在这台机器上计算：profile 的每个已安装插件都用报告的求值，针对最新发布版本的两个版本在两条轴上求值，这个求值就是用最新发布版本的版本进行的上游安装器和预检求值，通知统计它会关闭的插件。
5. 检查对它的所有请求只有一个期限，即该行的 `timeoutSeconds`。失败或无法验证的检查不会向通知添加任何东西，也不在其中说任何东西：通知继续显示最后一次已验证的发布版本（如果有的话），而 `delorun doctor` 指出故障。比记录中保存的最后一个时间戳更旧的时间戳，或同一渠道上较低的发布版本，是一种故障，即 `regressed`，所以主机无法通过提供较旧的文件来收回通知。
6. 结果连同检查的时间一起写入 `run/<profile>/update-check.json`（[C3](../contracts/c03-update-report.zh.md#update-check)）：最新的已验证发布版本、它被验证的时间、时间戳的版本，以及作为代码的最后一次故障。故障自己的文字可能来自主机，通过在其签名被检查之前读取的字段，所以它只会被转义后进入 home 日志；记录、终端和 `delorun doctor` 显示 Delorun 为该代码所写的句子。

### 已签名的字段

7. 发布 manifest 增加两个可选字段 `security` 和 `summary`，由离线的 targets 密钥与其余内容一起签名。时间戳（其在线密钥只为新鲜度签名）两者都不携带。读取方把没有这两个字段的 manifest 视为没有安全修复、没有摘要。
8. 摘要是不超过 200 个字符、不含控制字符或格式字符的一行，因为终端和 studio 会显示它。签名要求每份新草稿中都有这两个字段。

### 它何时运行

9. 检查是 `@delorun/bundle-local` 的 `delorun-update-check` 行。它的 Config 包含 `enabled`（C16 的开关 `update_check`）、`intervalHours`（至少为 1，默认 24）和 `timeoutSeconds`。该行提供 `delorunUpdateCheck` 服务，`delorun` 在 profile 启动之后把检查附加到它上面，仅当运行时从存储中运行时才这样做。
10. 该行在启动时查看一次，然后按挂钟时间每小时一次，所以休眠过的机器会在第一次唤醒时检查。当上一次检查至少已有间隔那么久时它才检查；失败之后，它在一小时后重试，然后是两小时、四小时，依此类推，但绝不晚于间隔。启动从不等待它。
11. Delorun 项目不保持与任何安装的连接，也不推送任何东西；每次检查都从这台机器上开始。

### 它在哪里显示

12. 终端显示一行，例如 `Delorun 0.1.3 is available (security fix; all your plugins stay compatible). Run: delorun update`。`delorun start` 和不带命令的 `delorun` 在 home 进程运行之后，只根据最近一次检查打印那一行；前台启动在它的第一次检查完成时打印它。`delorun update --check` 还会在其下方打印发布版本的摘要，标记为 `Release note:`，所以发布版本的文字绝不会被当作 Delorun 的指令来读。
13. studio 的侧边栏显示一条安静的通知，带有版本、更新的类型、插件数量、标记为发布说明的摘要以及命令。它通过 studio 的连接读取 `/api/delorunUpdateCheck.notice`，并在重新连接、获得焦点和按间隔时刷新。它可以针对该版本被忽略，并在更新的版本出现时回来。通过远程访问登录的设备会被该路由拒绝，该路由指出正在运行的发布版本和插件数量，所以手机不显示通知；能读取该路由的远程页面则显示文字而不带控件。
14. `delorun update --check` 按需运行检查，无论开关怎么说，并打印同样的一行、摘要和任何故障。`delorun update --report` 通过 home 进程准备更新并打印它的完整报告，包括它会关闭哪些插件及原因，且不应用任何东西。`delorun doctor` 报告最近一次检查。

### 同意与控制

15. 一个开关，即该行的 `enabled`，可以关闭检查：“设置”→“通用”→“更新”→“Check for new releases” 写入它，setup 的 `updateCheck` 答案也以同样的形式写入它（[C11](../contracts/c11-setup-answers.zh.md#profile-writes)）。关闭它会停止每一次计划的检查，`delorun` 会在下次启动时移除记录。
16. setup 中显示的 setup 隐私说明陈述请求什么、发往哪里、这些主机能看到机器的地址，以及如何关闭检查。审阅界面的“更多设置”和 `delorun setup privacy` 随后询问是否检查，说明指出如何到达那个问题，而 `--no-update-check` 为整个 setup 运行（交互式的、`--yes` 或 `--config`）关闭检查；`delorun setup <section>` 会拒绝它，所以 `delorun setup privacy` 改为询问这个问题。setup 在 Delorun 第一次启动之前写入答案，所以在那里关闭的检查不会发出请求。
17. 对等组合重述该行为关闭状态，因为 stock 不发出这样的请求（[C16](../contracts/c16-parity-composition.zh.md)）。

### 补丁规则

18. 签名会拒绝这样的发布版本：它的版本是同一主版本和次版本的更早发布版本的补丁（即低于它的非预发布标签 `v<major>.<minor>.<patch>`），而它的上游版本与该发布版本的不同；上游的持久化 schema 或 Delorun 的记录版本不同；或面向插件的接口清单不同，或指出该发布版本不再声明的接口（[C22](../contracts/c22-delorun-plugin-interface.zh.md)）。因此移动上游基础的发布版本至少是一个次版本，而安全修复作为不关闭任何插件的补丁发布。

### 以 Delorun 为目标

19. A plugin that declares `engines.delorun` is checked on that range alone on Delorun, and its `engines.dsh` and DSH peers are not checked; a plugin that declares none is checked on its upstream axis, as on stock DSH ([C17](../contracts/c17-plugin-versions.zh.md)). The update notice counts plugins the same way.
20. `delorun plugin check <directory>` 在不导入其代码的情况下读取插件的 `package.json`，用上游的 `evaluatePluginCompatibility`（即安装器的求值）针对正在运行的发布版本对两条轴求值，并打印每个声明的范围接纳什么、什么未声明，以及以正在运行的 Delorun 次版本为目标的 `engines.delorun` 范围。For a plugin that declares `engines.delorun` it says the DSH ranges are not checked on Delorun. `--json` prints the decision record ([C22](../contracts/c22-delorun-plugin-interface.zh.md#checking-a-plugin)).

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- 与其他所有完整性请求一样，主机能看到这台机器的地址以及每次检查的时间（见[威胁模型](../security/threat-model.zh.md#the-network)）。
- 检查不读取任何运行时压缩包，所以压缩包与其已签名文件列表不匹配的发布版本仍然会被通知；`delorun update` 和 `delorun update --report` 会下载压缩包，并在安装任何东西之前拒绝它。
- 通知不运行在线日志检查。已签名的 bundle 通过验证、但日志并不包含的发布版本会被通知，而 `delorun update` 会拒绝它。
- 扣住更新的发布版本的主机，只有在时间戳过期时才会被发现；在此之前，通知显示时间戳指出的发布版本。仅凭渠道的 cron Worker 作为密钥保存的在线时间戳密钥，就可以让陈旧的发布版本在超过 3 天之后仍保持最新，并以同样的方式冻结新鲜度，并且它只能指名由离线 targets 密钥签名的 manifest，其版本不低于所记录的最后一个。
- 以此人自己的权限运行的进程可以写入 `run/<profile>/` 之下的记录，从而选择通知说什么；记录的读取方会拒绝含有控制字符的摘要，所以它无法改写终端。
- 插件数量只涵盖版本轴。更新会改变的撤销、已退役的 bundle 或 profile 行，只在 `delorun update` 的报告中显示。
- 补丁规则检查的是清单中的名称，而不是接口的类型。补丁之内接口行为的更改只有通过评审才能发现。

<a id="denial-tests"></a>

## 拒绝测试

| 测试 | 证明什么 |
| --- | --- |
| `update-notice-sends-no-identifier` | 一次检查的每个请求都是对渠道文件的纯 `GET`，没有查询、cookie、请求体或插件名称。 |
| `update-notice-unverified-index-silent` | 未能通过验证的时间戳或 manifest 不会向通知添加任何东西，保留最后一次已验证的发布版本并记录故障。 |
| `update-notice-replayed-timestamp-refused` | 比已存储的更旧的时间戳会被拒绝。 |
| `update-notice-writes-no-trust-state` | 一次检查让 `trust/` 逐字节保持原样。 |
| `update-notice-deadline` | 永不应答的主机使检查在其期限处结束，且没有通知。 |
| `update-notice-regressed` | 同一渠道上较旧的时间戳或较低的发布版本会被拒绝，最后一次已验证的发布版本保持不变。 |
| `update-notice-hostile-text` | 主机选择的文字既不会进入记录，也不会进入终端。 |
| `update-notice-manifest-length-capped` | 陈述 manifest 过大的时间戳，会在获取 manifest 之前被拒绝。 |
| `update-notice-retries-after-failure`、`update-notice-wall-clock` | 故障会在一小时、两小时和四小时之后重试，休眠过的机器会在第一次每小时唤醒时检查。 |
| `update-notice-off-makes-no-request` | 开关关闭时，该行不注册任何东西，也不发出任何请求。 |
| `update-notice-remote-session-offers-no-action` | 远程会话的通知不提供任何控件。 |
| `c02-summary-control-characters-refused` | 含有转义符、换行或方向覆盖符的摘要，会被读取方和签名拒绝。 |
| `patch-rule-refuses-base-move` | 上游版本与更早发布版本不同的补丁拒绝签名。 |
| `patch-rule-refuses-persistence-change`、`patch-rule-refuses-delorun-record-change` | 数据格式不同的补丁拒绝签名。 |
| `patch-rule-refuses-interface-removal`、`patch-rule-refuses-interface-addition` | 接口清单不同的补丁拒绝签名。 |
| `plugin-check-imports-no-code` | `delorun plugin check` 读取 manifest，且不运行插件的任何文件。 |
| `plugin-check-refuses-special-files` | 是 FIFO 或符号链接的 manifest 会被拒绝，而不会等待或跟随它。 |
| `plugin-check-escapes-manifest-text` | manifest 的名称和范围在打印时，终端控制字符会被转义。 |

<a id="implementation-status"></a>

## 实现状态

上述规则均已构建。约定页面把它们陈述为已构建的事实：[C3](../contracts/c03-update-report.zh.md#update-check) 中的检查、其记录和通知，[C2](../contracts/c02-release-manifest.zh.md) 中的已签名字段，[C16](../contracts/c16-parity-composition.zh.md) 中的开关，[C1](../contracts/c01-home-layout.zh.md) 中记录的路径，以及 [C22](../contracts/c22-delorun-plugin-interface.zh.md) 和 [C17](../contracts/c17-plugin-versions.zh.md) 中的承诺、补丁规则和 `delorun plugin check`。本页保留这些规则之所以如此的理由。
