# Agent Note: Delorun 以上游发布 tag 为根，采用 hard fork

Status: implemented

[English](2026-11-06-delorun-hard-fork-on-upstream-tag.md) | 中文

## 问题

Delorun 运行 DeepSeek Harness（DSH），并在接收每个上游发布时保留其改动记录。把上游保存为副本、再把 Delorun 的改动保存为补丁集，会让每次发布都变成人工重建，而且补丁集无法从仓库历史中读出。逐次发布以 squash 方式导入，会抹去 git 合并上游各次发布所需的共同祖先。vendoring 副本与 squash 导入存在同样的问题：它用一棵与上游提交没有 git 关联的树取代了上游提交。

## 决策

Delorun 的仓库包含上游的公开历史，以上游发布 tag `dsh-v0.2.2-rc.1` 为根。每个上游发布都以 git 合并的方式进入 Delorun。

Delorun 自有的代码与文档位于 `delorun/` 之下。差异台账 `delorun/upstream-patches.json` 记录上游仓库、tag 与提交，并列出 `delorun/` 之外每一个被改动或新增的文件，附上其原因与类别（类别（class）只有三种取值）：`delorun-feature`（该文件服务于 Delorun 功能）、`generic-fix`（上游可以采纳的修复），或 `security`（该文件移动了审批、拒绝或升权，并且需要 lead 裁决）。`.agents/notes/` 下 Delorun 的 Agent Note 同样是 `delorun/` 之外新增的文件，因此也有台账条目。台账中列为 fork 自有的路径，即 `delorun/` 与 `.agents/skills/delorun-*/`，不需要条目。

当上游的某项改动吸收了 Delorun 的某项编辑时，该条目退役，记录中注明由该上游改动吸收。每次上游合并都会更新台账，并按功能分组，为每个可干净合并的改动文件记录一项裁决。根指南还要求每次合并运行对等回放与插件语料；对等回放由[对等提案](../../proposed/testing/2026-11-06-delorun-stock-parity.zh.md)规定。每次发布的台账增长保持在差异预算之内，由对最新上游 tag 进行的预演合并来衡量。超出预算，或 `security` 文件发生冲突，都需要维护者作出决定。

## 验证

台账 schema `delorun/upstream-patches.schema.json` 规定了记录的结构：上游提交是一个 40 位十六进制字符串；每个条目包含路径、封闭集合中的一个类别以及原因。预演合并在每次发布前衡量台账增长以及该次发布产生的冲突。

## 相关决策

当前没有活跃的上游 Agent Note 决定 fork 如何跟踪上游发布。[vendor/README.md](../../../../vendor/README.md) 中的流程管理的是固定版本的 vendored 包，而不是 harness。

## 曾考虑的替代方案

**带补丁的 soft fork。** 上游副本加上补丁集可以把 Delorun 的改动与上游分开，但每次发布都要人工重建补丁集，而且该补丁集无法与上游历史对照。Delorun 只能通过比较 diff 来了解自己吸收了哪些上游改动，而无法从合并结果中得知。

**逐次发布的 squash 导入。** 每次导入都是一个没有上一次上游发布祖先的提交。随后的每次导入都会在 Delorun 改动过的每个文件上产生冲突，而 git 也无法把新发布的改动与早先的改动联系起来。

**vendoring 整个 harness。** vendored 副本把 harness 放进一个带有清单的目录，正如 [vendor/README.md](../../../../vendor/README.md) 对固定版本的 Cordis 包所做的那样。把整个 harness 做成 vendored 树，会使它与上游之间没有 git 祖先关系，因而与 squash 导入有同样的合并问题，并且隐藏了 Delorun 改动过哪些文件。

## 后果

每个上游发布都是一次 git 合并，Delorun 的历史包含上游的公开提交。

`delorun/` 之外的每一处 Delorun 编辑都记录在同一个文件中，附有原因与类别，因此审阅者可以从台账核对 fork 边界。

代价是：Delorun 改动过的文件会产生合并冲突；每个发生冲突的 `security` 文件都需要 lead 裁决；台账随 Delorun 的每处编辑增长，但须保持在差异预算之内。
