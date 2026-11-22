---
description: "Delorun 文档索引：各层级的内容（用户指南、实操手册、参考资料、防御性模式、架构说明、安全、性能与设计），以及从哪里开始阅读。"
---

# Delorun 文档

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

Delorun 的文档按层级组织在 `delorun/docs/` 下，与上游位于 `docs/` 下的文档并列。每个事实只有一个归属，即承担其职责的层级，其他页面链接到那里。涉及上游的页面链接到上游文档，而不重复其内容。[指南](guide/README.zh.md)面向使用 Delorun 的人。其他每个层级面向开发者与维护者，他们需要对行为有精确的定义。

- [指南](guide/README.zh.md)：面向安装并使用 Delorun 的人的用户指南，用平实的语言写成，技术术语在首次出现处加以解释，从[安装与首次运行](guide/get-started/install.zh.md)开始。[路线图与愿景](guide/roadmap.zh.md)是唯一一页关于计划工作的页面。
- [实操手册](cookbook/README.zh.md)：面向任务的分步指南，每份指南以带编号的验证步骤结束。实操手册目前没有任何指南。
- [参考资料](reference/README.zh.md)：供需要精确定义的人查阅的页面，从[术语表](reference/glossary.zh.md)开始，其条目以一句平实的话开头。其他页面面向开发者与维护者。
- [防御性模式](defensive-patterns/README.zh.md)：Delorun 代码评审所执行的规则，扩展了上游的[防御性模式](../../docs/defensive-patterns/README.zh.md)。Delorun 没有自己的模式。
- [架构说明](architecture/README.zh.md)：Delorun 各子系统的有序地图，每个子系统一页现行状态说明。该地图没有列出任何子系统页面。
- [安全](security/README.zh.md)：威胁模型、Delorun 每种运行方式下的信任，以及[安全基础](security/fundamentals.zh.md)，即 Delorun 自我约束的受管规则清单，每条规则都附有强制执行它的代码和证明它的测试。
- [性能](performance/README.zh.md)：等待时间基准、如何运行它们，以及目前已记录的计时：[更新计时](performance/update-timings.zh.md)与[命令与启动](performance/commands-and-start.zh.md)。
- [设计](design/README.zh.md)：尚未构建或仅部分构建的功能的规则，与只描述已构建内容的[约定页面](contracts/README.zh.md)分开存放：[更新与回滚](design/update-and-rollback.zh.md)、[在你自己的 tailnet 上访问](design/reach.zh.md)、[首次运行](design/first-run.zh.md)、[对你的 harness 的修改](design/changes.zh.md)、[安全扩展点](design/security-extension-points.zh.md)与[旅程检查](design/journey-check.zh.md)。
