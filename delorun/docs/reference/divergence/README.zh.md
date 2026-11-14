---
description: "Delo 的差异索引：Delo 编辑的每个上游文件的台账、各类别、检查如何测量它、限制每次发布增长的差异预算，以及差异记录所在之处。"
---

# 差异索引

[English](README.md) | 中文

Delo 修改了上游 DeepSeek Harness 的一些文件。差异台账记录其中每个文件的原因与类别，使其与上游的差异可测量、可审查。本页定义台账、如何阅读与测量它，以及限制其在一次发布内增长的差异预算。

## 目录

- [台账](#the-ledger)
- [类别](#classes)
- [阅读台账](#reading-the-ledger)
- [测量台账](#measuring-the-ledger)
- [差异预算](#divergence-budget)
- [差异记录](#divergence-records)

<a id="the-ledger"></a>
## 台账

台账是 [`delorun/upstream-patches.json`](../../../upstream-patches.json)，其 [schema](../../../upstream-patches.schema.json) 描述其结构。它列出 Delo 自有目录之外、与所固定上游提交存在差异的每个文件，并附上修改原因与类别。Delo 自有的目录为 `delorun/`、`.agents/skills/delorun-*/` 技能与 `.agents/notes/**/*-delorun-*` 笔记。这些文件属于 Delo，而不是上游修改，因此台账不列出它们。

Delo 编辑、新增或删除的每个上游文件计为一条条目，不论它包含多少差异块。上游吸收某项修改时，其条目移入 `retired`，记录吸收它的上游提交及其所含的差异块数。退役条目保留在台账中，并在[差异预算](#divergence-budget)中被抵扣。

<a id="classes"></a>
## 类别

| 类别 | 含义 |
| --- | --- |
| `delorun-feature` | 该修改服务于 Delo 的某项功能。 |
| `generic-fix` | 该修改是上游可以采纳的修复。每项通用修复单独成一次提交。 |
| `security` | 该修改改变了批准、拒绝或权限提升。它附有 lead 的结论，以及在修改前失败、修改后通过的拒绝测试。 |

<a id="reading-the-ledger"></a>
## 阅读台账

- `upstream.repository`、`upstream.ref` 与 `upstream.commit` 固定了每条条目所据以测量的上游提交。上游版本合并时，固定的提交随之变化。
- `forkOwned` 列出 Delo 完全自有的路径与 glob。
- `patches` 列出每个上游文件及其类别，以及说明修改内容与原因的 `reason` 字段。
- `retired` 列出上游已吸收的条目，附吸收提交与每条所含的差异块数。

<a id="measuring-the-ledger"></a>
## 测量台账

`pnpm --filter @delorun/tools check` 运行台账检查，任何违规都以 1 退出。检查针对固定提交与工作树执行。其拒绝的完整情形列在 [tools 说明](../../../apps/tools/README.zh.md)中。

`node_modules/.bin/tsx delorun/apps/tools/src/check-fork-boundary.ts --count` 运行相同的检查，并打印差异：列出的条目数及其差异块数。差异块是相对固定提交的 `git diff --unified=0` 中的一个 `@@` 头；未跟踪的文件计为一个差异块。退役条目单独列出，不计入数量。

<a id="divergence-budget"></a>
## 差异预算

预算限制台账在一次发布内可增长的幅度，并列出执行该限制的检查。

- **数量。** 一次发布的数量是台账中非生成条目与差异块，按类别计。退役条目对数量进行抵扣：增长按扣除退役条目所记录的条目与差异块后的净值计算。
- **增长上限。** 每次发布的条目增长上限为 20 条与第一次发布基线条目数的 10 % 中较大者；差异块增长上限为 150 块与第一次发布基线差异块数的 10 % 中较大者。
- **超出。** 超出任一上限，需要维护者的决定，并记录于发布说明中。
- **预演合并。** Delo 的预算要求：将树预演合并到上游最新标签时，若冲突的差异块超过该标签处台账差异块数的 15 %，或任何 `security` 类文件发生冲突而未记录维护者的决定，则预演合并失败。`node_modules/.bin/tsx delorun/apps/tools/src/rehearse-upstream.ts --tag <tag>` 在临时工作树中运行预演合并，并同时把增长限制在上限之内；[tools 说明](../../../apps/tools/README.zh.md#the-rehearsal-merge)描述其输出。
- **基线。** 第一次发布的基线在该版本发布时记录。
- **当前数量。** `node_modules/.bin/tsx delorun/apps/tools/src/check-fork-boundary.ts --count` 输出台账相对于基线标签的条目与差异块数量；首个发布的基线记录在该发布的说明中。

<a id="divergence-records"></a>
## 差异记录

对上游某一领域的重大修改，会在本目录下拥有各自的差异记录页面，说明如何为该领域合并下一个上游版本。产生该差异的修改同时添加该页面。目前尚无差异记录。

上游合并遵循根目录 [AGENTS.md](../../../../AGENTS.md#the-fork-boundary) 中的分叉边界规则。
