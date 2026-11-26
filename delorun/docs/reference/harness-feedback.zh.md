# 框架反馈：痛点

[English](harness-feedback.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

在本框架与本仓库中工作时遇到的摩擦的持续记录，避免同一代价被重复支付。第一次遇到耗费时间的问题时添加条目；已知的变通办法写在同一条目中。会转化为工作的条目注明其拉取请求。

**如何添加。** 取下一个空闲编号，条目只保留下列行，日期写在最前。说明发生了什么、付出了什么代价，以及应改为怎样做。上游修复后，以上游拉取请求结束；属于 Delorun 自身的修复，以 Delorun 拉取请求结束。

**状态：** `open`（未解决）、`worked around`（已变通）、`fixed`（已修复，附引用）。

## 条目

### 2026-11-06 · #1 本机缺少 WebKit 的系统库

**发生了什么。** 本机缺少 WebKit 所需的系统库：`playwright install-deps --dry-run webkit` 报告缺失 73 个软件包。`apps/web/tests` 下有十一个网页端到端规范在内部启动 WebKit，因此变更网页通道（`tests:web-changed`）无法在本机运行它们的 WebKit 部分。

**付出的代价。** 该通道只运行 Chromium，并整体排除这十一个规范文件，因为没有开关能单独运行它们的 Chromium 部分。它们的 Chromium 部分只在 CI 的网页快照门禁中运行，因此对其中某个规范的本地改动在推送前不会被运行。

**应改为怎样做。** 由所有者在本机执行 `sudo npx playwright install-deps webkit`；然后从 `delorun/apps/tools/src/checks/web.ts` 中移除 WebKit 排除。所有者已推迟本机的修复。

**状态：** `worked around`：在本机修复落地之前，该通道只运行 Chromium。

### 2026-11-07 · #2 插件管理器端到端规范的团队对话框在本机超时

**发生了什么。** `apps/web/tests/plugin-manager.e2e.ts` 在其团队对话框步骤中超时，位置是对 智能体团队 对话框空状态文本的 `waitFor`（30 秒 `locator.waitFor`），早于该步骤对「Team 暂不可用」不存在的检查。把工作区的全部改动 stash 之后，同一棵树上仍然复现同样的失败，因此在途的改动都不是原因；该端到端运行的是 app-boot 已构建的 `lib/`。

**付出的代价。** 只要变更的包到达 app-boot（例如 loader 的 `refuseCode` 改动），`tests:web-changed` 就会选中这条规范，把一个本应直接跳过的通道变成失败。

**应改为怎样做。** 在依赖这条规范之前，先在本机诊断团队对话框的可用状态；在此之前，凡是变更集到达该规范的推送，都可以使用 `DELORUN_PUSH_SKIP=tests:web-changed`，以本条目为理由，并在拉取请求中写明跳过。

**状态：** `open`。

### 2026-11-09 · #3 新建工作树的通道因缺少原生系统插件而失败

**发生了什么。** 执行 `git worktree add` 与 `node delorun/apps/tools/src/setup-worktree.ts` 之后，`native/system/packages/linux-x64/bin/glibc/system.node` 并不存在：该插件被 git 忽略，而 setup 不构建任何原生文件。于是 `tests:snapshots`、`tests:fork` 与 `parity-replay` 的多数测试失败，报错为 `dsh: Cannot find module '…/native/system/packages/linux-x64/bin/glibc/system.node'`：仅 `snapshots/session/headless.snapshot.ts` 一个文件，186 个测试中就有 168 个失败，其中多数带着这行。`tests:upstream-changed` 在加载该插件的规范上同样失败（`packages/session/session-persistence-jsonl/tests/lease.spec.ts`：19 个测试中 17 个失败）。

**付出的代价。** 在手工构建该插件之前，新建工作树无法运行其变更所涉及的通道。失败只指出一个模块路径，而不指出缺失的步骤，因此读起来像是树坏了，而不是缺少前置条件；而该步骤唯一被记录的地方是对等基线的前置条件一行。仅 `tests:snapshots` 就报告 200 多个失败，把真正的失败全部掩盖。

**应改为怎样做。** `pnpm run build:native-system` 约一秒即可构建本机的插件。加载它的通道现在在其 needs 中声明 `generate:native`（[`plan.ts`](../../apps/tools/src/checks/plan.ts)），因此 `pnpm check` 会在第一个需要它的通道之前构建它，无需手工步骤；由于该检查不声明任何输入，丢失插件的树会在下一次运行时被重新构建。

**状态：** `fixed`：每个加载该插件的通道都把它作为依赖，并由 [`checks-native-system.spec.ts`](../../apps/tools/tests/checks-native-system.spec.ts) 断言。

### 2026-11-10 · #4 parity-switches 把上游插件 `apply` 内部一处对模型不可见的编辑标记出来

**发生了什么。** 当台账中上游文件的某一改动行位于持有注册调用的任一顶层语句之内时，`parity-switches` 把它计为对模型可见的贡献。`lane/sandbox-escapes` 的安全修复在 `packages/deliverables/workspace-changes/src/index.ts` 的 `apply` 内用一行改动，把每个 Session 的 git 运行器绑定到它的沙箱，而 `apply` 同时持有上游未改动的 `ctx.on('tools/pre-execute')` 监听器，因此该检查报告了这一行，尽管模型所见的任何内容都没有改变，`parity-replay` 也显示没有差异。重新组织代码也避免不了：`apply` 内的任何编辑都落在同一条语句里。

**付出的代价。** 对于没有 C16 开关可注册的安全修复，该检查会失败，因为该修复在对等组合中也必须成立。

**应改为怎样做。** 审查该差异块，然后用 `node_modules/.bin/tsx delorun/apps/tools/src/ledger-record.ts --non-model-visible-hunk <path>:<line> --reason "<one line>"` 记录它，这会把它的摘要加入该文件 security 条目的 `nonModelVisibleHunks` 之下，并以 3 退出，等待 lead 的结论；随后 `parity-switches` 放行恰好那个差异块，并在它变化时再次失败（[tools 说明](../../apps/tools/README.zh.md)）。跳过 `parity-switches` 或 `tests:fork` 需要 lead 对该次推送的授权，并且主干永远不能使用。

**状态：** `fixed`：security 条目记录已审查的对模型不可见的差异块，该检查读取它们。

### 2026-11-26 · #5 子代理模型选择没有对等开关，两项对等检查在 `main` 上失败

**发生了什么。** #102（子代理模型选择）修改了 `subagent` 工具的描述，并在 `packages/subagent/tool-subagent/src/list-models.ts` 中注册了一个对模型可见的工具，但没有任何 C16 开关能将二者关闭。在 preview.4 候选版本的合并层级上，`parity-switches` 标记了该注册，`parity-replay` 有 234 个场景失败，其请求头在该描述处与上游不一致。

**付出的代价。** 每次合并层级推送都会让这两项检查失败，无论改动内容是什么。开发机此前的"合并层级全绿"漏掉了它。

**应改为怎样做。** 在 [#147](https://github.com/TwickaS/delorun/issues/147) 添加该开关之前，推送可以使用 `DELORUN_PUSH_SKIP=parity-replay,parity-switches`，并以本条目作为理由，这依据所有者对 0.1.0-preview.4 的裁定。其他检查照常运行。

**状态：** `open`：#147，里程碑 0.1.0-preview.5。

## 下一步

[对等基线](parity-with-deepseek-harness/parity-baseline.zh.md)记录了若干条目所依赖的主机状态。[参考资料索引](README.zh.md)列出其他开发者页面。
