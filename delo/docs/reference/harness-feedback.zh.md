# 框架反馈：痛点

[English](harness-feedback.md) | 中文

在本框架与本仓库中工作时遇到的摩擦的持续记录，避免同一代价被重复支付。第一次遇到耗费时间的问题时添加条目；已知的变通办法写在同一条目中。会转化为工作的条目注明其拉取请求。

**如何添加。** 取下一个空闲编号，条目只保留下列行，日期写在最前。说明发生了什么、付出了什么代价，以及应改为怎样做。上游修复后，以上游拉取请求结束；属于 Delo 自身的修复，以 Delo 拉取请求结束。

**状态：** `open`（未解决）、`worked around`（已变通）、`fixed`（已修复，附引用）。

## 条目

### 2026-11-06 · #1 本机缺少 WebKit 的系统库

**发生了什么。** 本机缺少 WebKit 所需的系统库：`playwright install-deps --dry-run webkit` 报告缺失 73 个软件包。`apps/web/tests` 下有十一个网页端到端规范在内部启动 WebKit，因此变更网页通道（`tests:web-changed`）无法在本机运行它们的 WebKit 部分。

**付出的代价。** 该通道只运行 Chromium，并整体排除这十一个规范文件，因为没有开关能单独运行它们的 Chromium 部分。它们的 Chromium 部分只在 CI 的网页快照门禁中运行，因此对其中某个规范的本地改动在推送前不会被运行。

**应改为怎样做。** 由所有者在本机执行 `sudo npx playwright install-deps webkit`；然后从 `delo/apps/tools/src/checks/web.ts` 中移除 WebKit 排除。所有者已推迟本机的修复。

**状态：** `worked around`：在本机修复落地之前，该通道只运行 Chromium。
