# Agent Note: 全新安装遵循 stock DSH，并由对等回放检验

Status: proposed

[English](2026-11-06-delorun-stock-parity.md) | 中文

## 问题

在 stock DSH 与 Delorun 之间迁移的人，或运行为 DSH 编写的插件、skill 或录制工作流的人，需要相同的行为，除非 Delorun 说明了差异。Delorun 改变了一些默认值，并新增了对模型可见的行为，因此差异可能在无人察觉时出现。尽力而为的兼容性既不提供已存在差异的清单，也无法证明 stock 工作流仍能运行。

## 提案

全新的 Delorun 安装将遵循 stock DSH 的工作流：相同的启动方式、相同的会话，以及相同的插件与 profile。上游的四种模式（Standard、PTC、Minimal 与 Creator）将在每个新 chat 中提供。

Delorun 改变的每一项默认值都将列在[对等清单](../../../../delorun/docs/reference/glossary.zh.md)中，并附有该改动的证据。对等清单将列出上游标签版本中的每项 stock 功能及其证据，以及每一项刻意的差异。

对等组合将是 Delorun 的运行时，关闭了 studio 组合包与 Delorun 对模型可见的改动。对等回放将把上游录制的会话场景在对等组合上运行，其输出须与每个场景的预期输出一致。这些场景即 `pnpm run test:snapshot` 通过出厂 profile 回放的那些场景。

## 相关决策

[默认产品隔离决策](../../implemented/process/2026-09-12-default-product-experimental-isolation.zh.md) 与[可选 bundle 决策](../../implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md) 使实验性能力保持在默认产品之外。对等组合将对 Delorun 的新增内容采用同类的边界。

[PTC 模式决策](../../implemented/feature/2026-06-15-ptc.zh.md) 保留 `native` 作为工具运行时 `mode` 设置的默认值。Delorun 在首次设置（onboarding）中预选 PTC，这是对等清单将列出的 Delorun 默认值之一，它不会改变该设置。

[Creator 模式决策](../../implemented/architecture/2026-09-16-creator-persistent-plugin-management.zh.md) 描述了将在每个新 chat 中保留的四种模式之一。

## 考虑过的替代方案

**尽力而为的兼容性。** 没有回放时，每个差异都要等到人遇到它才会被发现，也没有差异清单可供对照。

**仅 Delorun 的默认值。** 在没有 stock 回放的情况下改变默认值，会破坏为 DSH 编写的插件、skill 与录制工作流，也会失去全新安装仍遵循 stock 工作流的证据。

## 验收标准

- `pnpm run test:snapshot` 在对等组合上通过每个录制场景，输出与预期输出没有差异。
- 对等清单为 Delorun 改变的每项默认值各有一行，并附有证据；改变默认值却没有对应行的改动会失败。
- 全新 Delorun 安装中，新 chat 提供四种模式中的每一种。

## 风险

回放会把每个上游场景的改动变为需要本人审阅的差异，因此每次上游发布都会按其改动的场景数量耗费审阅时间。

要使「每项默认值一行」的规则成立，需要一项比较清单与代码中默认值的检查。本提案未规定该检查，因此清单可能落后于代码。

进入模型请求的 Delorun 新增内容必须在对等组合中关闭，否则回放失败。这一约束限定了每项对模型可见的新增内容的引入方式；而一个未触及该新增内容的场景，可能掩盖其差异。
