# Agent Note: 全新安装遵循 stock DSH，并由对等回放检验

Status: implemented

[English](2026-11-06-delo-stock-parity.md) | 中文

## 问题

在 stock DSH 与 Delo 之间迁移的人，或运行为 DSH 编写的插件、skill 或录制工作流的人，需要相同的行为，除非 Delo 说明了差异。Delo 改变了一些默认值，并新增了对模型可见的行为，因此差异可能在无人察觉时出现。尽力而为的兼容性既不提供已存在差异的清单，也无法证明 stock 工作流仍能运行。

## 决策

全新的 Delo 安装遵循 stock DSH 的工作流：相同的启动方式、相同的会话，以及相同的插件与 profile。上游的四种模式（Standard、PTC、Minimal 与 Creator）在每个新 chat 中都提供。

Delo 改变的每一项默认值都列在[对等清单](../../../../delo/docs/reference/glossary.zh.md)中，并附有该改动的证据。对等清单列出上游标签版本中的每项 stock 功能及其证据，以及每一项刻意的差异。

对等组合是 Delo 的运行时，关闭了 studio 组合包与 Delo 对模型可见的改动。对等回放把上游录制的会话场景在对等组合上运行，其输出必须与每个场景的预期输出一致。这些场景即 `pnpm run test:snapshot` 通过出厂 profile 回放的那些场景。

## 验证

`pnpm run test:snapshot` 是上游场景通过出厂 profile 进行的无密钥录制会话回放。对等回放把同一批场景应用于对等组合，输出与预期输出不一致时即判定失败。Delo 改变的每项默认值，都在对等清单中有一行，附有其证据。

## 相关决策

[默认产品隔离决策](../process/2026-09-12-default-product-experimental-isolation.zh.md) 与[可选 bundle 决策](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md) 使实验性能力保持在默认产品之外。对等组合对 Delo 的新增内容采用同类的边界。

[PTC 模式决策](../feature/2026-06-15-ptc.zh.md) 保留 `native` 作为工具运行时 `mode` 设置的默认值。Delo 在首次设置（onboarding）中预选 PTC，这是对等清单所列的 Delo 默认值之一，它不改变该设置。

[Creator 模式决策](../architecture/2026-09-16-creator-persistent-plugin-management.zh.md) 描述了在每个新 chat 中都保留的四种模式之一。

## 曾考虑的替代方案

**尽力而为的兼容性。** 没有回放时，每个差异都要等到人遇到它才会被发现，也没有差异清单可供对照。

**仅 Delo 的默认值。** 在没有 stock 回放的情况下改变默认值，会破坏为 DSH 编写的插件、skill 与录制工作流，也失去全新安装仍遵循 stock 工作流的证据。

## 后果

Delo 改变的每一项 stock 默认值都出现在同一份清单中，每个新增的差异都需要在该清单中占有一行。

回放会针对每次上游发布运行，因此改变录制场景的上游改动会以回放差异的形式出现，而不会被悄悄改变。

任何进入模型请求的 Delo 新增内容，都必须在对等组合中关闭，否则回放失败。这一约束限定了每项对模型可见的新增内容的引入方式。
