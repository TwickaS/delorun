# Agent Note: Delorun 把状态保存在 ~/.delorun 中，与未改动的 ~/.dsh 并存

Status: proposed

[English](2026-11-06-delorun-home-directory.md) | 中文

## 问题

stock DSH 把所有用户数据保存在同一个 home 根目录下，即 `$DSH_HOME` 或 `~/.dsh`。Delorun 与 stock DSH 安装在同一台机器上，两者都会读写各自的状态。若 Delorun 使用 `~/.dsh`，两者就会读写同一套插件、设置与 chat，其中一方的更新可能破坏另一方，stock DSH 也无法放心地与 Delorun 并存。

## 提案

Delorun 的状态将保存在 `~/.delorun` 中，Delorun 从不修改 `~/.dsh`。设置时将提供按请求导入一份 stock `~/.dsh` 副本的选项。由本人选择是否导入，导入过程只读取 `~/.dsh`，从不写入它。stock DSH 与 Delorun 并存时仍可正常工作。

上游的 home 优先级将保持不变：先是显式配置路径，然后是 `$DSH_HOME`，最后是 `~/.dsh`。Delorun 的启动器将把 `~/.delorun` 作为其进程的 home 根目录，解析器以其常规规则处理该根目录。Delorun 的导出文件将可以在两个 home 之间携带工作区与 chat。

## 相关决策

[单一 harness home 解析器决策](../../implemented/architecture/2026-07-24-single-harness-home-resolver.zh.md) 使 `$DSH_HOME` 或 `~/.dsh` 成为 harness 唯一的 home 根目录。本提案将对 Delorun 偏离该决策，Delorun 的默认 home 根目录为 `~/.delorun`。单一根目录规则与解析器的优先级仍按该决策所述保留，上游决策对 stock DSH 仍然有效。

[共享 agents 根目录决策](../../implemented/architecture/2026-10-05-shared-agents-root-instructions.zh.md) 使共享 agents 根目录位于 harness home 之外。本提案没有提及该根目录。

## 考虑过的替代方案

**共享 `~/.dsh`。** 两个 harness 会读写同一套插件、设置与 chat，其中一方的更新可能破坏另一方，stock DSH 也就无法保持原状。

**原地迁移 `~/.dsh`。** 把 stock 数据移出其 home 会破坏 stock DSH，回到 DSH 的本人会发现其数据已经消失。按请求复制则使两个 home 都保持可用。

## 验收标准

- 拒绝测试针对一份夹具 stock home 运行设置、导入与一次 Delorun 会话，之后该夹具与运行前逐字节一致。
- 在 Delorun 会话之后，针对同一夹具启动的 stock DSH 找到的数据与之前相同。
- `packages/util/home-paths/tests/home-paths.spec.ts` 中的解析器测试在优先级用例不变的情况下通过。
- 一个 home 导出的文件可以把工作区与 chat 导入另一个 home。

## 风险

两个 home 各保存一份插件、设置与 chat，本人必须为每个工作区选择哪份副本为准。

导入是单向的，一个 home 在导入之后所做的改动不会进入另一个 home。

依赖 `~/.dsh` 的工具与脚本需要改用 Delorun 的 home 路径。这是有意改变的默认值，它们必须跟随这一改动。
