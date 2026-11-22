# Agent Note: 一份 agent 指南、一份文档标准、一个 skill 目录与一棵 notes 树

Status: implemented

[English](2026-11-06-delorun-one-standard.md) | 中文

## 问题

Delorun 与上游需要相同的 agent 指令与文档规则，因为同一批 agent 会读取两者。单独的 Delorun 指南会把共享规则再写一遍，两份陈述随即漂移。分层指南（Delorun 的文件覆盖上游的文件）则会让只打开某一文件的读者看不到某条规则。

## 决策

仓库只有一份根 agent 指南 `AGENTS.md`，`CLAUDE.md` 是它的符号链接。仓库只有一份文档标准 `docs/AGENTS.md`、一个 skill 目录 `.agents/skills/`，以及一棵 notes 树 `.agents/notes/`。Delorun 以上游的版本为基础就地编辑这些文件。每条规则只有一个归属，Delorun 的规则与上游规则并列放在同一个文件中。

Delorun 的文档位于 `delorun/docs/` 之下，遵循上游的文档层级；Delorun 的决策是 `.agents/notes/` 中与上游决策并列的 Agent Note。Delorun 自有的 skill 位于 `.agents/skills/delorun-*/` 目录中。上游对这些文件的改动与 Delorun 所改动的其他上游文件一样，由人工合并；生成文件则重新生成，而不是合并。

## 验证

文档预算清单 `scripts/doc-budgets.manifest.json` 为根指南与文档标准设定了上限，因此任一文件超出上限时，`pnpm run verify-doc-budgets` 即失败。notes 门禁 `pnpm run verify-agent-note-format` 与 `pnpm run verify-translation-pairing` 检查 Delorun 的 notes，它们与上游 notes 位于同一棵树中。

## 相关决策

已归档的[文档层级与预算决策](../../archived/process/2026-07-04-doc-tiers-and-budgets.md) 记录了文档层级与预算的历史。该文档已经冻结，不陈述当前规则。

## 曾考虑的替代方案

**单独的 Delorun 指南。** `delorun/AGENTS.md` 会给 agent 两份指南，却没有规定冲突时以哪一份为准；每条共享规则都会同时出现在两个文件中。

**分层指南。** Delorun 的文件叠加在上游文件之上，要求读者同时加载两者才能知道一条规则；上层文件若没有重述某项覆盖，就很容易被忽略。

## 后果

读取仓库的 agent 只会看到一套规则。Delorun 的新增内容可以凭其主题识别，例如它们所指向的 `delorun/` 路径。

上游对这些文件的改动需要人工合并，这会增加每次上游发布的审阅工作量。

文档预算限制了共享文件能容纳的文字量，因此文件达到上限时，新规则要替换或缩减已有文字。
