# Agent Note: Delo 把状态保存在 ~/.delo 中，与未改动的 ~/.dsh 并存

Status: implemented

[English](2026-11-06-delo-home-directory.md) | 中文

## 问题

stock DSH 把所有用户数据保存在同一个 home 根目录下，即 `$DSH_HOME` 或 `~/.dsh`。Delo 与 stock DSH 安装在同一台机器上，两者都会读写各自的状态。若 Delo 使用 `~/.dsh`，两者就会读写同一套插件、设置与 chat，其中一方的更新可能破坏另一方，stock DSH 也无法放心地与 Delo 并存。

## 决策

Delo 的状态保存在 `~/.delo` 中，Delo 从不修改 `~/.dsh`。设置时可按请求导入一份 stock `~/.dsh` 的副本。由本人选择是否导入，导入过程只读取 `~/.dsh`，从不写入它。stock DSH 与 Delo 并存时仍可正常工作。

上游的 home 优先级保持不变：先是显式配置路径，然后是 `$DSH_HOME`，最后是 `~/.dsh`。Delo 的启动器把 `~/.delo` 作为其进程的 home 根目录，解析器以其常规规则处理该根目录，因此每个进程只有一个 home 根目录。Delo 的导出文件可以在两个 home 之间携带工作区与 chat。

## 验证

拒绝测试针对一份夹具 stock home 运行设置、导入与一次 Delo 会话，然后断言该夹具与运行前的状态逐字节一致。解析器自身的测试位于 `packages/util/home-paths/tests/home-paths.spec.ts`，它们覆盖本决策所保留的优先级。

## 相关决策

[单一 harness home 解析器决策](../architecture/2026-07-24-single-harness-home-resolver.zh.md) 使 `$DSH_HOME` 或 `~/.dsh` 成为 harness 唯一的 home 根目录。本决策对 Delo 偏离该决策，Delo 的默认 home 根目录为 `~/.delo`。单一根目录规则与解析器的优先级仍按该决策所述保留，上游决策对 stock DSH 仍然有效。

[共享 agents 根目录决策](../architecture/2026-10-05-shared-agents-root-instructions.zh.md) 使共享 agents 根目录位于 harness home 之外。本决策没有提及该根目录。

## 曾考虑的替代方案

**共享 `~/.dsh`。** 两个 harness 会读写同一套插件、设置与 chat，其中一方的更新可能破坏另一方，stock DSH 也就无法保持原状。

**原地迁移 `~/.dsh`。** 把 stock 数据移出其 home 会破坏 stock DSH，回到 DSH 的本人会发现其数据已经消失。按请求复制则使两个 home 都保持可用。

## 后果

同时安装两种 harness 的机器有两个 home，本人选择每份工作区或 chat 副本保存在哪个 home 中。

导入是单向复制：导入之后在 Delo 中做的改动不会进入 `~/.dsh`，导入之后在 `~/.dsh` 中做的改动也不会进入 Delo。

上游的解析器笔记仍然是 stock home 默认值的归属方，从而使两项决策保持分离。
