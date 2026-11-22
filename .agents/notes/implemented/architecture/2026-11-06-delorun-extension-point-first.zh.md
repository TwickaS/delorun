# Agent Note: Delorun 行为的扩展点优先规则

Status: implemented

[English](2026-11-06-delorun-extension-point-first.md) | 中文

## 问题

Delorun 改变的是本人所用 DSH 副本的行为：studio、安全更新、工作区权限、来自其他设备的访问等等。如果每项改动都直接编辑它所在位置的上游代码，那么每次上游发布都要合并这些编辑，上游行为与 Delorun 行为之间的界线随之消失，审阅者也无法从代码树看出哪些代码由 Delorun 负责。DSH 已经把插件、client slot、注册表、主题层与配置字段作为有文档的扩展点开放出来，因此 Delorun 的大部分行为都可以挂接在这些扩展点上。

## 决策

Delorun 的行为位于 `delorun/` 之下，并挂接在上游有文档的扩展点上：插件、client slot、注册表、主题层与配置字段，包括能力 seam 的 Service Definition。[扩展点优先规则](../../../../delorun/docs/reference/glossary.zh.md) 是 Delorun 术语表为本决策所起的名字。

当所需的改动没有对应的扩展点时，则在上游代码树中增加一个扩展点，形式可以是钩子、Service Definition 或配置字段，而行为仍位于 `delorun/` 之下。只有在没有任何扩展点能承载改动时，才允许就地编辑上游行为。此类编辑须连同其原因与类别记入[差异台账](../../../../delorun/upstream-patches.json)，如 [hard fork 决策](../process/2026-11-06-delorun-hard-fork-on-upstream-tag.zh.md) 所要求的那样。

本笔记用「扩展点」指钩子、slot、注册表、主题层与配置字段，并把「seam」保留给上游的能力 seam，即由 Service Definition、Service Provider 与 Consumer 组成的完整能力。根指南采用相同的用词。

## 验证

Delorun 改动过的、位于 `delorun/` 之外的每个上游文件，都在台账中附有原因与类别，审阅者因此可以对照本规则检查每一处编辑。每次上游合并都会为每个可干净合并的改动文件记录一项裁决，这项审阅会找出本可由扩展点承载的编辑。

## 相关决策

[能力 seam 决策](../architecture/2026-06-13-capability-seams.zh.md) 把「seam」定义为三种角色的整体，并把该词保留给这一完整能力。本笔记遵循此保留。[web 能力 seam](../architecture/2026-06-24-web-capability-seam.zh.md) 与[审批 seam](../feature/2026-07-06-approval-seam.zh.md) 是 Delorun 行为可以挂接的能力 seam 示例。

## 曾考虑的替代方案

**自由修改上游代码。** 凡需要改动之处都直接编辑，会使每次上游发布都要合并这些编辑；上游与 Delorun 之间的界线也随之丢失，因为同一个文件的历史同时混合了两方的改动。

**复制上游包。** 以新名称复制一个上游包，将不会接收上游修复，并且会偏离插件与 profile 在配置中所引用的 stock 契约。

## 后果

Delorun 的大部分改动以 `delorun/` 之下插件的形式出现，只有在上游代码树缺少所需扩展点的地方，上游代码树才会改变。

当所需扩展点在上游代码树中缺失时，改动分两步进行：先增加扩展点，再把行为挂接到该扩展点上。

差异台账列出了所有剩余的就地编辑，因此每次上游合并的成本都可以在一个文件中看到。
