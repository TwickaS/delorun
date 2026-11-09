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

### 2026-11-07 · #2 插件管理器端到端规范的团队对话框在本机超时

**发生了什么。** `apps/web/tests/plugin-manager.e2e.ts:1215` 等待 智能体团队 对话框中的“Team 暂不可用”文本时超时（30 秒 `locator.waitFor`）。把工作区的全部改动 stash 之后，同一棵树上仍然复现同样的失败，因此在途的改动都不是原因；该端到端运行的是 app-boot 已构建的 `lib/`。

**付出的代价。** 只要变更的包到达 app-boot（例如 loader 的 `refuseCode` 改动），`tests:web-changed` 就会选中这条规范，把一个本应直接跳过的通道变成失败。

**应改为怎样做。** 在依赖这条规范之前，先在本机诊断团队对话框的可用状态；在此之前，凡是变更集到达该规范的推送，都可以使用 `DELO_PUSH_SKIP=tests:web-changed`，以本条目为理由，并在拉取请求中写明跳过。

**状态：** `open`。

### 2026-11-09 · #3 新建工作树的通道因缺少原生系统插件而失败

**发生了什么。** 执行 `git worktree add` 与 `node delo/apps/tools/src/setup-worktree.ts` 之后，`native/system/packages/linux-x64/bin/glibc/system.node` 并不存在：该插件被 git 忽略，而 setup 不构建任何原生文件。于是 `tests:snapshots`、`tests:fork` 与 `parity-replay` 的多数测试失败，报错为 `dsh: Cannot find module '…/native/system/packages/linux-x64/bin/glibc/system.node'`：仅 `snapshots/session/headless.snapshot.ts` 一个文件，186 个测试中就有 168 个失败，其中多数带着这行。`tests:upstream-changed` 在加载该插件的规范上同样失败（`packages/session/session-persistence-jsonl/tests/lease.spec.ts`：19 个测试中 17 个失败）。

**付出的代价。** 在手工构建该插件之前，新建工作树无法运行其变更所涉及的通道。失败只指出一个模块路径，而不指出缺失的步骤，因此读起来像是树坏了，而不是缺少前置条件；而该步骤唯一被记录的地方是对等基线的前置条件一行。仅 `tests:snapshots` 就报告 200 多个失败，把真正的失败全部掩盖。

**应改为怎样做。** `pnpm run build:native-system` 约一秒即可构建本机的插件。加载它的通道现在在其 needs 中声明 `generate:native`（[`plan.ts`](../../apps/tools/src/checks/plan.ts)），因此 `pnpm check` 会在第一个需要它的通道之前构建它，无需手工步骤；由于该检查不声明任何输入，丢失插件的树会在下一次运行时被重新构建。

**状态：** `fixed`：每个加载该插件的通道都把它作为依赖，并由 [`checks-native-system.spec.ts`](../../apps/tools/tests/checks-native-system.spec.ts) 断言。
