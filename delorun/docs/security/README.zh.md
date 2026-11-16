---
description: "Delorun 安全索引：威胁模型、发布验证的规定所在，以及如何报告漏洞。"
---

# Delorun 安全

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

安全页面属于参考资料：它们说明 Delorun 保护什么、防范谁以及在哪些地方无法防范，不设教学顺序。

- [每种执行向量的信任](execution-vectors.zh.md)：哪些命令带有 Delorun 的保护、原生沙箱在每个平台上强制执行什么、哪些向量尚未构建、没有任何向量能防范什么，以及每种向量与 stock DSH 的对比。
- [安全基本要求](fundamentals.zh.md)：Delorun 对自己约束的受管规则列表，每项都带有状态、强制执行它的代码和证明它的测试，以及如何更改某项基本要求。
- [威胁模型](threat-model.zh.md)：Delorun 相对于 stock DSH 的目标及每项变更的默认值、Delorun 的防护适用于何处、其资产、各方能看到和能做的事、每个信任边界上的防护及规定它的约定，以及 Delorun 不防范的内容。
- 发布验证：客户端如何检查发布，由[发布清单](../contracts/c02-release-manifest.zh.md)与[发布日志](../contracts/c18-release-log.zh.md)约定规定，启动器在安装发布时打印每项检查的结果，`delorun verify` 报告已安装发布的签名、发布日志和文件检查。
- 报告：疑似漏洞请通过 [SECURITY.md](../../../SECURITY.md) 私下报告。
