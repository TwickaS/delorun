---
description: "约定 C18 的客户端 release-log 验证：对已安装版本的 bundle 按可信根做离线检查、基于日志 tlog-tiles 的在线一致性检查、存储的检查点与检查状态。"
---

# @delo/release-verify

[English](README.md) | 中文

## 摘要

已安装的版本在清单文件旁附带一个 release-log bundle：清单文件的 Rekor v2 `hashedrekord` 条目、该条目的包含证明，以及日志签名并由见证者联签的检查点。本包按客户端自己可信根中的密钥离线验证该 bundle，在线证明与日志最新检查点的一致性，保存验证通过的检查点与每个已安装版本的检查状态，并回答启动时该怎么做：继续、带着点名未检查版本的警告继续，或停止。调用方说明缺失 bundle 的含义（`missingBundle`）：对运行时仓库安装的版本为 `failed`（`bundle-malformed`），因为该仓库会保留它验证过的 bundle；只有对安装之后才获取 bundle 的客户端才为 `unchecked`。安装器、启动器的启动与 `delorun verify` 都通过 `record` 运行它，因此检查只有一份，每种记录也只有一种格式。home 进程运行期间对 `unchecked` 版本的检查服务重试（`ReleaseVerification`）已构建，但没有任何随附的进程使用它，因此版本会一直处于 `unchecked`，直到下一次启动或 `delorun verify`。规格见[约定 C18](../../docs/contracts/c18-release-log.zh.md)。

## 模块

- `bundle`、`entry`、`json` 与 `merkle`：五步离线检查、Rekor v2 正文、严格读取器与 RFC 6962 哈希。叶子是 bundle 所携带的条目正文字节，因此同一正文换一种方式序列化会使包含证明失效。
- `note`、`checkpoint` 与 `online`：签名 note、绝不后退的存储检查点，以及一致性检查。
- `transport`：`tilesTransport`，即在线检查通过注入的 `fetch` 进行的读取：最新检查点，以及由日志的 C2SP tlog-tiles 哈希瓦片构建的 RFC 6962 一致性证明，因为 Rekor v2 日志不提供证明端点。`logEndpoints` 从可信根的 `log.origin`（主机名，可带端口）推导出两者：`https://<origin>/api/v2/checkpoint` 与 `https://<origin>/api/v2/tile/` 之下的瓦片。
- `state`、`start`、`record`、`service` 与 `paths`：记录的检查状态、启动时的行为、检查及其两份记录（`checkAndStore` 由安装器在安装前运行，`recordResult`，以及同时完成两者的 `checkAndRecord`）、带 15 分钟重试的检查服务，以及两个文件的路径。
- `store`：唯一访问文件系统的模块，经由 `@delo/home` 的受保护文件规则。

## 限制

在线检查接受一个 transport。`tilesTransport` 的每个请求都经由调用方传入的 `fetch`，使用 HTTPS，带 C18 的 30 秒超时与大小上限，并且最多跟随两次指向日志自身主机的重定向。整个检查在一个 90 秒的截止时间 `ONLINE_CHECK_DEADLINE_SECONDS` 内运行，每个请求与重定向都计入其中。

一条规则决定每种结果：检查点的日志签名验证通过之前的任何情况都使版本处于 `unchecked`，验证通过之后任何不能自洽的情况都为 `failed`。没有应答、超时、到达截止时间、`5xx`、检查点返回 `404` 或 `410`、应答超出其上限或检查点被重定向到其他主机，以及正文不是由根的日志密钥签名的检查点，都使版本处于 `unchecked`。签名检查点小于存储的检查点、一致性证明验证失败，以及签名树大小表明存在的瓦片返回 `404` 或 `410`、长度不对、超出其上限或被重定向到其他主机，都为 `failed`（证明与瓦片均为 `consistency-proof-invalid`）。本包自身代码的失败以 `ReleaseLogInternalError` 抛出，绝不被当作日志不可达。`tests/real/` 下记录的向量是来自公开 Rekor v2 日志 `log2025-1.rekor.sigstore.dev` 的两个经见证的检查点及其间的瓦片；`tests/real/record-real-log.ts` 用于手动刷新它们，任何规格都不访问网络。本包从不签名：这里无法铸造检查点或条目，并且不信任任何由 bundle 带来的密钥。

最新检查点若未经见证者联签，或其最新的联签早于 24 小时之前，则在回滚检查与一致性检查运行之后使版本处于 `unchecked`，因此省略联签无法绕过其中任何一项。所列见证者的联签若存在但验证失败，或其时间晚于客户端时钟 300 秒以上，则为 `failed`（`witness-cosignature-missing`），详情会点名该见证者、联签时间与本地时钟。离线 bundle 检查仍然拒绝没有有效联签的 bundle。

可信根是前提：调用方先按约定 C2 读取它，由 C2 检查其签名、`expires` 与时钟的关系，以及日志验证密钥的名字是否为日志的 origin。没有可信根自身的签名，本包无法检查这些。

存储的检查点只有在其 note 带有可信根日志密钥对记录所指定的树的有效签名时，才设定回滚下限。没有可信密钥签名的记录与无法读取的记录都视为没有记录：检查从 bundle 自带的检查点开始，验证通过的检查点替换该文件，结果附带一条说明下限已重新开始的通知，并点名主目录记录为 `verified` 的版本。安装器早先格式的文件（只有树大小与根哈希、没有 note）只有在从它到日志签名最新检查点的一致性证明验证通过时才保留为下限；否则它不设定下限，由验证通过的检查点替换它，并有一条通知给出它的树大小；日志不可达时它保持原样。版本的检查状态保留 `uncheckedSince`（其当前这段 `unchecked` 期间的第一次尝试）以及该次尝试的通知。两份记录都位于主目录的 `trust/` 下，并按 C1 的要求，在它们是符号链接、属于其他用户或可被他人读取时被拒绝。
