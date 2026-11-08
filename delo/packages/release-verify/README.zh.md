---
description: "约定 C18 的客户端 release-log 验证：对已安装版本的 bundle 按可信根做离线检查、在线一致性检查、存储的检查点与检查状态。"
---

# @delo/release-verify

[English](README.md) | 中文

## 摘要

已安装的版本在清单文件旁附带一个 release-log bundle：清单文件的 Rekor v2 `hashedrekord` 条目、该条目的包含证明，以及日志签名并由见证者联签的检查点。本包按客户端自己可信根中的密钥离线验证该 bundle，在线证明与日志最新检查点的一致性，保存验证通过的检查点与每个已安装版本的检查状态，并回答启动时该怎么做：继续、带着点名未检查版本的警告继续，或停止。规格见[约定 C18](../../docs/contracts/c18-release-log.zh.md)。

## 模块

- `bundle`、`entry`、`json` 与 `merkle`：五步离线检查、Rekor v2 正文、严格读取器与 RFC 6962 哈希。
- `note`、`checkpoint` 与 `online`：签名 note、绝不后退的存储检查点，以及一致性检查。
- `state`、`start`、`service` 与 `paths`：记录的检查状态、启动时的行为、检查服务，以及两个文件的路径。

## 限制

本包不含网络代码：在线检查接受一个 transport，因此规格由夹具作答，启动器传入被把关的那个。它也从不签名——这里无法铸造检查点或条目——并且不信任任何由 bundle 带来的密钥。
