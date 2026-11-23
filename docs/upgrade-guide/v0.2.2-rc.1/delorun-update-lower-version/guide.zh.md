---
kind: upgrade-guide
description: "delorun update 与更新通道拒绝低于正在运行的 Delorun 发布版本的目标。"
---

# `delorun update` 拒绝更低的发布版本

[English](guide.md) | 中文

## 变更

此前，只要通道指定的发布版本与正在运行的不同，无论更低还是更高，`delorun update` 都会应用它，home 进程的 `update.prepare` 请求也接受任何已安装的版本作为其 `target`。现在更新绝不会转到更低的版本。运行时仓库在下载或安装任何内容之前，以 `TARGET_LOWER` 拒绝低于 `current` 所记录版本的通道发布版本或 `target`，home 进程以指明该代码的 `VERIFY_FAILED` 回应 `update.prepare`。对于目标低于正在运行的发布版本的报告，`delorun update` 同样拒绝并以退出状态 1 结束，`--yes` 也不例外。

受影响的是曾用 `delorun update` 回到较早发布版本的人，例如在切换到当前发布版本更低的通道之后，以及发送带有更低 `target` 的 `update.prepare` 的脚本。

## 迁移

1. 要回到上次更新之前的发布版本，运行 `delorun recover rollback`；加上 `--profile-only` 则只还原 profile。它只能回到运行时仓库的 `previous` 指针所指定的版本。
2. 要运行不是 `previous` 的更旧发布版本，用该发布版本的启动器 `npx delorun@<version> --release <version>` 把它安装到一个空的 home 中。
3. 从发送 `update.prepare` 的脚本中删除低于正在运行版本的 `target`。
4. 用 `delorun status` 确认，它会给出正在运行的版本。
