---
description: "Delo 安全索引：威胁模型、发布验证的规定所在，以及如何报告漏洞。"
---

# Delo 安全

[English](README.md) | 中文

安全页面属于参考资料：它们说明 Delo 保护什么、防范谁以及在哪些地方无法防范，不设教学顺序。

- [每种执行向量的信任](execution-vectors.zh.md)：原生沙箱、Docker 工作区、reach、自托管 home 与你自己的 tailnet 各自保证什么、都不能保证什么，以及与 stock DSH 的对比。
- [威胁模型](threat-model.zh.md)：Delo 相对于 stock DSH 的目标及每项变更的默认值、其资产、各方能看到和能做的事、每个信任边界上的防护及规定它的约定，以及 Delo 不防范的内容。
- 发布验证：客户端如何检查发布，由[发布清单](../contracts/c02-release-manifest.zh.md)与[发布日志](../contracts/c18-release-log.zh.md)约定规定，`delorun verify` 报告其结果。
- 报告：疑似漏洞请通过 [SECURITY.md](../../../SECURITY.md) 私下报告。
