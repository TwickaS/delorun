---
description: "Delorun 发布日志约定（C18）的类型与固定值，供发布流程、安装程序、启动器的启动检查与桌面更新器使用：Rekor 发布日志 bundle、见证者阈值、检查状态与重试间隔。"
kind: "package-library"
---

# @delorun/contract-release-log

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/contract-release-log` 定义发布 manifest（元数据清单）的 Rekor v2 `hashedrekord` 请求与条目主体（Ed25519ph，`PKIX_ED25519_PH`）、发布日志 bundle（它携带该条目、其包含证明与一个经见证的检查点）、客户端按已安装发布版本记录的检查状态，并以常量形式给出见证者阈值、检查点时长、重试间隔与大小上限。本包只包含导出的类型与只读常量，没有运行时代码，因此从不改变任何进程的行为；约定页面 [C18 发布日志与见证者](../../docs/contracts/c18-release-log.zh.md) 是权威，本包遵循它。其入口为 `src/index.ts`，导出为 `.`。

## 目录

- [使用本包](#use-this-package)
- [已知限制](#known-limitations)

<a id="use-this-package"></a>

## 使用本包

发布工作流写入 bundle；安装脚本、npm 启动器、CLI（命令行界面）启动器与 home 进程（home process）、`delorun verify` 以及桌面更新器读取它们并记录检查状态。用 `import type` 导入类型，用值导入从 `@delorun/contract-release-log` 导入常量；读取或写入本约定所定义文件的包仍须在其解析器中校验这些文件，因为这些类型描述的是有效文件，并不检查它们。

<a id="known-limitations"></a>

## 已知限制

- 检查点、共同签名与证明的格式是该约定页面所指明的 C2SP 与 RFC 6962 格式；本包将它们类型化为字符串与十六进制列表，并不解析它们。
