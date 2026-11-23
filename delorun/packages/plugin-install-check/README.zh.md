---
description: "Delorun 的插件安装检查与安装记录，供维护者修改安装检查的内容、什么会拒绝安装、启动时用什么比对已安装的插件，以及其他界面读取的信任状态。"
---

# @delorun/plugin-install-check

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/plugin-install-check` 提供上游的 `pluginAudit` 钩子和 `delorunPluginTrust` 服务。[插件管理器](../../../packages/boot/plugin-manager/README.zh.md)在选入、启用或恢复组合包之前询问该钩子，即在组合包的任何插件代码加载之前。对插件及其安装向 profile 锁文件新增的每个包，它显示每一项发现：缺少完整性或 git 来源没有完整提交、明文 `http:` 注册表或下载 URL、GitHub 安全公告、发布时间短于可配置时长的版本，以及与 profile 或 Delorun 已有名称相近的名称。检查在 pnpm 把安装解析进锁文件之后、任何文件下载进 profile 或任何安装脚本运行之前进行。已知的严重公告，以及在包安装之前无法运行的检查，会拒绝安装，直到本人允许；其他发现都不拒绝。包安装完毕且允许的构建运行之后，它记录每个已安装文件的 SHA-256，每次启动以低成本比对，`delorun verify` 完整比对。`delorun plugin` 在其 pnpm 操作周围执行同样的步骤（[`plugin-install-check.ts`](../../apps/cli/src/plugin-install-check.ts)）。开关关闭时（对等值），它不提供任何服务，也不审计任何内容，与 stock 相同；`@delorun/bundle-local` 和 `@delorun/bundle-headless` 把它挂载为开启。

## 目录

- [约定](#contract)
- [信任状态](#the-trust-status)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **何时运行。** 插件管理器用 `pnpm add --lockfile-only --ignore-scripts` 解析安装，因此在检查之前连已批准的 git 依赖的 `prepare` 也不会运行，以 `pending: 'install'` 询问审计，然后才运行 `pnpm install --frozen-lockfile`，由它下载包并运行 profile 允许的构建；完成后它不带 pending 再询问一次，记录在此时写入。第一次的答复只为该包的锁文件引用与完整性保留，并在插件管理器的操作结束时丢弃，因此安装失败或取消之后，之后的询问会重新检查。恢复在保留所有脚本不运行的安装之后以 `pending: 'scripts'` 询问，并在 `pnpm rebuild --pending` 之后再询问一次。`delorun plugin` 以同样的顺序解析、检查和安装。拒绝（包括检查无法运行的情况）会恢复 `package.json` 与锁文件，因此没有任何文件下载进 profile，也没有脚本运行。安装失败同样会恢复它们，因此该插件既不在清单中，也没有记录；它已下载的文件仍留在 `node_modules` 中。
- **检查什么。** 来自 npm、tarball 或 git 的插件，每个已安装的锁文件引用检查一次。插件自身的包总会检查；其依赖只检查尚无其他安装记录持有的锁文件条目。链接的文件夹（`link:`）或本地文件夹（`file:` 目录）既不检查也不记录：本人在其中工作时文件会变化。profile 不依赖的插件，例如安装自带的可选组合包，会被跳过。
- **发现。** `missing-integrity` 与 `unpinned-commit` 读取锁文件的 `resolution`；`insecure-source` 指出插件管理器询问的注册表（无论是配置的，还是为一次安装指定的）或锁文件中的 tarball 或仓库 URL 为明文 `http:`，传输中可能连同首次解析记录的完整性哈希一起被篡改，因此锁文件哈希只能让之后的安装保持与该次解析所得相同的字节；`advisory` 通过 [`@delorun/release-formats/advisory/feed`](../release-formats/src/advisory/feed.ts)（发布自身的公告检查使用的同一客户端）询问 npm 的批量公告 API，其答案来自 GitHub Advisory Database；`recent-publish` 从主注册表的包文档读取 `time[version]`；对于由镜像（首个之后询问的注册表，或插件管理器的回退注册表之一）完成解析的安装，锁文件完整性与主注册表列出的 `versions[version].dist.integrity` 不同的包会被 `integrity-mismatch` 拒绝，无论本人接受什么；主注册表无法访问或未列出完整性时，`integrity-unconfirmed` 需要本人接受；`similar-name` 在折叠 scope 与标点后按编辑距离比较名称。公告源或注册表无法访问、超时或答复格式错误时，会产生 `advisory-unchecked` 或 `publish-time-unchecked` 发现并说明原因；没有任何检查被悄然跳过。每项发现都写明包、其版本及其在锁文件中的行。
- **拒绝。** 只有严重程度为 `critical` 的公告会拒绝。审计答复 `needs-acceptance`，studio 列出每项发现并显示「仍然安装」按钮；接受只针对这一组公告（`blockingDigest` 计算的摘要），因此新的严重公告会再次询问。`delorun plugin` 拒绝同样的公告，并接受 `--allow-advisory <GHSA id>`。其他发现都答复 `clear`，studio 在完成页面列出每一项。
- **可信来源。** npm scope 或 git 所有者列在 `trustedSources` 中的插件只显示严重公告，严重公告仍会拒绝。
- **安装记录。** `<profile>/delorun-plugin-installs/records/<name>.json`（scope 名称中的 `/` 写作 `+`），权限 0600，位于 0700 的目录中：来源（`registry`、`tarball` 或 `git`，以及锁文件引用、完整性、提交与 URL）、版本、显示过的发现、允许的公告、插件闭包的锁文件条目，以及闭包中每个包的目录、每个文件的 SHA-256（链接为 `link:<target>`）与文件标识。被拒绝的安装不写记录。审计遇到记录指明其当前锁文件引用的插件时（例如再次启用），它比对文件，显示记录的发现，文件不同时再加一项 `changed-files` 发现，并保持记录不变。
- **改动检查。** `checkProfileTrust` 把每个已记录插件的文件与其记录比对。每次启动在 Host 启动前运行快速检查，只对文件标识（`@delorun/runtime-store/identity`：inode、模式、大小、修改与变更时间）与记录不同的文件计算哈希，或对标识无法作证的文件计算哈希：其变更时间距记录时间不足两秒，或其文件系统的变更时间并非只由本地内核设置；`delorun verify` 运行完整检查，对每个文件计算哈希。新增或删除的文件也算改动。计算哈希后发现未改动的文件，会重新记录其标识。
- **安装之前失败即拒绝，安装之后只提示。** 在管理器尚未安装该包或尚未运行其脚本时，审计内部出错、锁文件无法读取或锁文件没有写明该包，都答复 `needs-acceptance` 并附严重（critical）的 `delorun.check-failed` 发现，其摘要写明包、其锁文件引用与原因，因此一次接受只涵盖这一次失败。没有待办步骤时（例如启用已安装的组合包），同样的失败答复 `clear` 并把该发现作为警告，由改动的结果携带；启动时改动检查失败只打印警告并继续。

<a id="the-trust-status"></a>

## 信任状态

启动与 `delorun verify` 把改动检查的结果写入 `<profile>/delorun-plugin-installs/trust.json`，权限 0600，格式为 `delorun.plugin-trust/1`。用 `@delorun/plugin-install-check/check` 的 `readPluginTrust(profileDir)` 读取，或在 Host 中通过 `delorunPluginTrust` 服务读取：`status()` 读取上一次结果，`check(full)` 立即运行检查并写入。记录：

| 字段 | 含义 |
| --- | --- |
| `checkedAt` | 检查完成的时间，自纪元起的毫秒数。 |
| `mode` | `quick`（启动）或 `full`（`delorun verify` 或 `check(true)`）。 |
| `plugins[]` | 每个来自 npm、tarball 或 git 的插件一项，按名称排序；链接的与本地的文件夹不列出。 |
| `plugins[].state` | `unchanged`、`changed`（记录的文件不同、新增或已不存在）或 `unrecorded`（没有记录，或记录对应另一个锁文件引用）。没有记录时绝不是 `unchanged`。 |
| `plugins[].changedCount`、`changedFiles` | 不同的文件数，以及其中最多 20 个，形式为 `<包目录>/<文件>`。 |
| `plugins[].version`、`installedAt`、`installFindings` | 记录的版本、安装时间与当时显示的发现数；没有记录时为 `null` 与 0。 |
| `problem` | profile 的锁文件无法读取时出现，此时 `plugins` 为空。 |

<a id="configuration"></a>

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 提供 `pluginAudit` 与 `delorunPluginTrust`。关闭（对等值）时不审计任何内容；Delorun 的组合包把它挂载为开启。 |
| `advisoryFeed` | npm 的批量公告端点 | https URL。 |
| `registry` | `https://registry.npmjs.org/` | https 主注册表，其包文档提供发布时间，并核对由镜像解析的包的完整性。 |
| `minimumAgeHours` | `24` | 比这更新的版本会产生警告。 |
| `similarNameDistance` | `1` | 产生警告的名称最大编辑距离，0 到 3。 |
| `similarNameMinLength` | `4` | 更短的名称不比较。 |
| `requestTimeoutMs` | `15000` | 每个请求的时限。 |
| `requestConcurrency` | `8` | 同时读取的包文档数。 |
| `metadataMaxBytes` | 64 MiB | 读取的包文档上限。 |
| `maxFiles` | `20000` | 每个包记录的文件数；更多文件的包只记录一部分，未记录的文件不比对。 |
| `trustedSources` | `[]` | 其插件只显示严重公告的 npm scope（`@scope`）与 git 所有者（`github.com/owner`）。 |
| `npmMirror` | `false` | 第一个注册表失败时询问 npmmirror 注册表；启动时把它传给插件管理器的 `fallbackRegistries`。 |

本人在 profile 自己的 `cordis.patch.yml` 中以完整的 `config` 重述 `delorun-plugin-install-check` 行来修改它们。`delorun plugin` 与启动读取同一组合后的行。要开启 npmmirror 回退，使用设置 → 隐私，或运行 `delorun plugin mirror on`。

<a id="known-limitations"></a>

## 已知限制

- 检查只知道已发布的公告。尚无公告的恶意版本最多只得到发布时间或名称警告。
- 检查读取锁文件，因此对包的安装脚本会运行什么，它只能通过上述发现得知，并不读取脚本；检查通过后，允许的构建才会运行。
- 记录检测插件之外造成的改动：被编辑的文件、经链接被编辑的 pnpm 存储、Delorun 之外的包操作。以本人身份运行的代码同样可以改写记录。
- 发布时间来自配置的注册表；来自私有注册表的包会得到 `publish-time-unchecked` 发现。

<a id="tests"></a>

## 测试

[`tests/install-check.integration.spec.ts`](tests/install-check.integration.spec.ts) 在手写的 profile 和回环上的公告源与注册表替身上覆盖每项发现：严重公告在被允许之前的拒绝、在安装任何内容之前对已解析锁文件的检查、明文 `http:` 来源、公告源与注册表的失败、可信的 scope 与 git 所有者、链接的文件夹、记录及其文件哈希，以及改动检查发现被编辑、新增或删除的文件。[`tests/provider.integration.spec.ts`](tests/provider.integration.spec.ts) 挂载插件，覆盖其开关、审计在安装之前的 `clear`、`needs-acceptance` 与 `accepted` 答复和安装之后的记录、自身失败、`delorunPluginTrust`，以及配置的 https 与可信来源校验。
