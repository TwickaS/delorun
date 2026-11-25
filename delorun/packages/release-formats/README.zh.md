---
description: "Delorun 的发布工具与随产品发布的验证器共同读取的发布文件格式：签名元数据及其客户端验证（C2）、release-log 条目、bundle、签名 note、Merkle 证明与 tile（C18），以及确定性归档格式。"
---

# @delorun/release-formats

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

Delorun 发布版的格式集中于一处，供两方共同使用：在 [`delorun/apps/release`](../../apps/release/README.zh.md) 中编写并签名发布版的发布工具，以及安装与检查发布版的随产品发布代码（`@delorun/install`、启动器、`@delorun/runtime-store`、`@delorun/release-verify`、`delorun verify` 与 relay 的令牌格式）。本包依赖发布约定，不依赖任何 CLI、开发工具或运行时发行包，因此运行时发行包携带验证器而不携带任何工具，且任何随产品发布的包都不依赖发布应用。规格见[约定 C2](../../docs/contracts/c02-release-manifest.zh.md) 与[约定 C18](../../docs/contracts/c18-release-log.zh.md)。

## 模块

- `sign/json`：每个签名所覆盖的 RFC 8785 规范 JSON，以及拒绝重复键的严格读取器。
- `sign/envelope`：签名信封、密钥 id 与签名；`sign/schemas`：每个签名文件的读取器。
- `sign/verify`：C2 的客户端验证，涵盖根链、时间戳、通道清单与每个文件引用。
- `log/entry`、`log/bundle`、`log/note`、`log/merkle` 与 `log/tiles`：带 Ed25519ph 签名的 Rekor v2 条目、按 C18 五个步骤进行的离线 bundle 检查、C2SP 签名 note 与联签、RFC 6962 证明，以及由 `tlog-tiles` 计算的证明。
- `archive/*`：确定性的 tar、gzip 与 ZIP 写入器和读取器、归档条目规则、确定性形式的检查，以及重建比较所用的 PE 规范化（`archive/pe`）。
- `brands`：语义版本与 SHA-256 的品牌类型。
- `gate/home-paths`：扫描某个目录的文件与归档中构建者用户的 home 目录、作为文件夹的用户名以及唯一构建根，发布构建与启动器构建都对各自的输出运行它并据此拒绝。

`sign`、`log` 与 `archive` 的规格测试位于编写这些格式的发布工具旁，即 `delorun/apps/release/tests/{sign,log,archive}`；`gate/home-paths` 的规格测试位于本包的 `tests/`。
