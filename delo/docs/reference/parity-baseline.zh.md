# 对等基线

[English](parity-baseline.md) | 中文

本页记录对等基线：上游 DeepSeek Harness 自身的测试套件，在 Delo 参考主机上、于上游标签 `dsh-v0.2.2-rc.1` 下的运行结果。本页包含两轮运行、一次 Node 24 核对、每项剩余失败的分类，以及这些结果所依赖的环境与主机状态。术语遵循 [Delo 术语表](glossary.zh.md)。

## 目录

- [参考主机与代码树](#reference-host-and-tree)
- [两轮运行](#passes)
- [上游 CI 设定的环境](#environment-as-upstream-ci-sets-it)
- [Node 24 核对](#node-24-check)
- [剩余失败的分类](#classification-of-the-remaining-failures)
- [主机状态](#host-state)

<a id="reference-host-and-tree"></a>
## 参考主机与代码树

- **代码树。** 代码树为上游标签 `dsh-v0.2.2-rc.1`，未作任何修改。两轮运行均未编辑或提交它；运行结束后，仅有被 git 忽略的构建产物有差异。
- **主机。** Ubuntu 24.04.1 LTS，运行于 WSL2 之上，内核为 `6.6.87.2-microsoft-standard-WSL2`，22 个 CPU，15 GiB 内存与 4 GiB 交换空间。
- **工具。** pnpm 11.28.5，即 `package.json` 所固定的版本。Playwright 1.61.1。Docker 服务端 29.9.2，可连通。
- **Node。** 第一轮与第二轮运行使用 Node `v26.12.1`。Node 24 核对使用 Node `v24.22.0`。
- **负载。** 两轮运行期间，主机上还有其他任务。第一轮的平均负载约为 20，第二轮约为 25。
- **前置步骤。** `pnpm install --frozen-lockfile` 与 `pnpm run build:native-system` 均已通过。在 `apps/web` 中运行的 `pnpm exec playwright install chromium webkit` 通过了，但报告主机缺少 WebKit 库，详见[主机状态](#host-state)。未安装系统软件包。快照测试套件需要已构建的 `lib/` 输出，因此第一轮在任何构建之前运行过一次，该次运行失败。

<a id="passes"></a>
## 两轮运行

第一轮使用普通环境。第二轮先用 CI 变量重新构建，然后在限制于 Linux 的环境中，按[上游 CI 设定的环境](#environment-as-upstream-ci-sets-it)中列出的变量，依次运行每个套件。

### 第一轮：普通环境

没有 CI 变量，使用默认构建配置，WSL 环境未作修改。

| Command | Exit | Wall time | Test files passed / failed / skipped | Tests passed / failed / skipped | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| `pnpm run test` | 1 | 643 s | 2514 / 44 / 23 (2581) | 52268 / 147 / 256 (52672; 1 expected fail) | 2.58 GiB |
| `pnpm run test:snapshot`, before any build | 1 | 115 s | 3 / 1 / 0 (4) | 74 / 165 / 2 (241) | 517 MiB |
| `pnpm run test:snapshot`, after the build | 0 | 151 s | 4 / 0 / 0 (4) | 239 / 0 / 2 (241) | 512 MiB |
| `pnpm run test:web`, includes a build of about 157 s | 1 | 3695 s | 214 / 12 / 4 (230) | 925 / 15 / 31 (971) | 4.76 GiB |
| `pnpm run test:expected` | 1 | 108 s | 21 / 3 / 0 (24) | 137 / 5 / 0 (142) | 521 MiB |

单独重跑时，44 个失败的单元测试文件中有 34 个通过，12 个失败的 web 测试文件中有 1 个通过。重跑结果表明，这些失败源于共享主机上的负载。

### 第二轮：按上游 CI 设定，限制在 Linux 内

第二轮先运行 `DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official pnpm run build`：退出码 0，耗时 49 s，10 个门禁中 10 个通过。official 配置记录了 366 个客户端产物，其中 4 个公开值；默认配置记录了 2 个。

| Command | Exit | Wall time | Test files passed / failed / skipped | Tests passed / failed / skipped | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| `pnpm run test` (`DSH_COVERAGE_TEST_TIMEOUT_MS=90000`) | 1 | 979 s | 2533 / 28 / 20 (2581) | 52394 / 37 / 240 (52672; 1 expected fail) | 2.60 GiB |
| `pnpm run test:snapshot` (`DSH_EXAMPLE_MODE=lib`) | 0 | 140 s | 9 / 0 / 0 (9) | 257 / 0 / 2 (259) | 528 MiB |
| `pnpm run test:web` (`DSH_SNAPSHOT=replay`, `DSH_BUILD_CLIENT_PROFILE=official`), includes a build | 1 | 4335 s | 216 / 10 / 4 (230) | 929 / 11 / 31 (971) | 2.87 GiB |
| `pnpm run test:expected` (`DSH_EXAMPLE_MODE=lib`) | 1 | 103 s | 21 / 3 / 0 (24) | 136 / 6 / 0 (142) | 522 MiB |

因为 `DSH_EXAMPLE_MODE=lib` 增加了 `apps/web/tests/*.snapshot.ts` 中的五个文件，所以第二轮的快照测试套件运行 9 个文件，第一轮为 4 个。第二轮中每个失败的文件又在相同环境下单独运行三次；结果见[剩余失败的分类](#classification-of-the-remaining-failures)。

### 两轮之间的变化

- 单元测试通道的失败文件从 44 个降至 28 个，失败测试从 147 个降至 37 个。
- web 通道的失败文件从 12 个降至 10 个，失败测试从 15 个降至 11 个。`context-menus.e2e.ts` 与 `smoke-real.e2e.ts` 在第二轮通过；它们在第一轮的失败未能复现。
- expected 通道的失败文件仍为同样三个，失败测试从 5 个增至 6 个。
- `spawn-runner.spec.ts` 在第一轮单独运行时失败，在第二轮的完整运行中通过。

### 场景数

计数为 `snapshots/` 下包含 `snapshot.yml` 的场景目录数。

| Group | Scenarios |
| --- | --- |
| session | 166 |
| web | 71 |
| sdk | 38 |
| acp | 9 |
| Total | 284 |

<a id="environment-as-upstream-ci-sets-it"></a>
## 上游 CI 设定的环境

下列每个变量，都取上游工作流文件为本基线所运行命令设定的值。没有任何工作流文件为快照、expected 或 web 命令设定 `DSH_SNAPSHOT`，也没有为这些命令设定 `DSH_EXAMPLE_MODE`；它们由 `scripts/run-gates.ts` 中的门禁定义设定。

- `DSH_TELEMETRY_DISABLED=1`：`.github/workflows/ci.yml`、`sandbox.yml` 与 `e2e.yml` 顶层的 `env`。适用于本基线中的每条命令。
- `DSH_BUILD_CLIENT_PROFILE=official`：`ci.yml` 中 `node-compat` 任务的 "Run compatibility smokes" 步骤，以及 `build-exe-for-python-sdk.yml`。构建门禁通过 `scripts/client-build-environment.ts` 中的 `CLIENT_BUILD_PROFILE_SELECTOR` 设定它，`scripts/run-gates.ts` 中的 `ciBuildGate` 与 `ciArtifactBuildGate` 使用该常量。适用于第二轮的构建，以及 `test:web` 内部的构建。
- `DSH_COVERAGE_TEST_TIMEOUT_MS=90000`：`ci.yml` 中 `node-24-coverage` 任务的 `env`，以及 `sandbox.yml` 中的 "Unit tests (darwin parity)" 步骤，该步骤运行 `pnpm run check:ci:unit`。适用于 `pnpm run test`。
- `DSH_EXAMPLE_MODE=lib`：`e2e.yml` 为 `pnpm run test:e2e` 设定它，本基线不运行该命令。`scripts/run-gates.ts` 中的快照与 expected 门禁定义为 `pnpm run test:snapshot` 与 `pnpm run test:expected` 设定它。
- `DSH_SNAPSHOT=replay`：`scripts/run-gates.ts` 中的 web 快照门禁定义为 `pnpm run test:web` 设定它。

上游仅在自托管运行器上使用的变量，例如 `DSH_COVERAGE_MAX_WORKERS`、`DSH_GATE_CONCURRENCY` 与 `DSH_WEB_SNAPSHOT_WORKERS`，在托管运行器上解析为空字符串。本基线不设定它们。

### WSL 下的本地限制

每条命令都在 Delo 检查工具于 WSL 上施加的 Linux 限制下运行，即 `delo/apps/tools/src/checks/machine.ts` 中的 `confineToLinux`。上游 CI 不施加该限制。shell 的 `PATH` 去掉了 44 个位于 Windows 驱动器挂载点下的条目，保留 25 个；下列变量被取消设置：`WSL_INTEROP`、`WSL_DISTRO_NAME`、`WSLENV`、`WSL2_GUI_APPS_ENABLED`、`DISPLAY`、`WAYLAND_DISPLAY`、`PULSE_SERVER` 与 `NoDefaultCurrentDirectoryInExePath`。这些变量是在 shell 中为每条命令设置的，而不是在每个测试 fork 中设置；移除的变量集合相同，因此各套件看到的环境一致。

<a id="node-24-check"></a>
## Node 24 核对

`.nvmrc` 固定为 `24`，`ci.yml` 将 `PRIMARY_NODE_VERSION` 设为 `'24'`。核对时将 Node `v24.22.0` 置于 `PATH` 首位，并保留 CI 变量与限制。

- `pnpm install --frozen-lockfile` 通过：退出码 0，3 s。原生插件在 Node 24 下重新构建，加载时的模块版本为 137。
- `DSH_BUILD_CLIENT_PROFILE=official pnpm run build` 通过：退出码 0，95 s，10 个门禁中 10 个通过。
- 上游的 `node-compat` 矩阵还会运行 Node `24.9` 与 `26`。

下列每个文件都在第二轮环境下，于 Node 24 中单独运行三次。本表为有针对性的对比，不是完整的 Node 24 运行，也不能替代完整运行。

| File | Node 24, 3 runs | Node 26, pass 2 | Result |
| --- | --- | --- | --- |
| `apps/web/tests/composer-focus.e2e.ts` | 3 次中 3 次失败，teardown 报 `llm-replay: fixture not fully consumed` | 3 次中 3 次失败，错误相同 | 两者失败相同 |
| `apps/web/tests/context-meter.e2e.ts`，仅 Chromium 测试（`-t Chromium`） | 3 次中 3 次通过 | 3 次中 3 次通过 | 两者均通过 |
| `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts` | 3 次中 3 次通过 | 3 次中 3 次失败，缺少已编目子代理的行 | 仅 Node 24 通过 |
| `apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts` | 3 次中 3 次通过 | 3 次中 3 次失败，`delegationDepth` 不同 | 仅 Node 24 通过 |
| `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`，服务用例 | 3 次中 3 次失败，报 `HTTP request timed out` | 3 次中 3 次失败，错误相同 | 两者失败相同 |
| `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`，明文 HTTP 警告用例 | 3 次中 1 次通过；3 次中 2 次失败，报 `expected 'SIGKILL' to be undefined` | 3 次中 3 次失败，错误相同 | Node 24 上不稳定；失败时错误相同 |
| `packages/session/session-persistence-jsonl/tests/generation.spec.ts` | 3 次中 3 次通过 | 3 次中 3 次失败，zstd 目标字节 | 仅 Node 24 通过 |
| `packages/subagent/subagent-acp/tests/subagent-acp.spec.ts` | 3 次中 3 次通过 | 3 次中 3 次通过 | 相同 |
| `packages/subagent/subagent/tests/continuation.spec.ts` | 3 次中 3 次通过 | 3 次中 3 次通过 | 相同 |
| `packages/experimental/liveshare/tests/viewer-source-write-unavailable-artifact.client.spec.tsx` | 3 次中 3 次通过 | 3 次中 3 次通过 | 相同 |
| `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts` | 3 次中 3 次通过 | 3 次中 3 次通过 | 相同 |
| `packages/experimental/liveshare/tests/viewer-shell-artifact.client.spec.tsx` | 3 次中 3 次通过 | 3 次中 3 次通过 | 相同 |

最后五行是从下文分类中的 (c) 类随机抽取的五个文件。

Node 24 与 Node 26 在 `composer-focus.e2e.ts`、`public-url.expected.e2e.ts` 的服务用例，以及 `context-meter.e2e.ts` 的 Chromium 用例上结论一致。在本次核对中，有三个文件仅在 Node 26.12.1 上失败：`subagent-diagnostic`、`subagent-inheritance` 与 `generation.spec.ts`。`public-url.expected.e2e.ts` 的明文 HTTP 警告用例在 Node 24 上不稳定。

<a id="classification-of-the-remaining-failures"></a>
## 剩余失败的分类

第二轮的失败测试分为四类。文件所属的类别，由其单独运行的结果以及输出中显示的错误决定。除 `public-url.expected.e2e.ts` 外，每个失败文件只属于一类：该文件的 IPv6 测试属于 (a) 类，其另外两个测试属于 (d) 类。

| Class | Meaning | Unit files | Web files | Expected files | Named failing tests |
| --- | --- | --- | --- | --- | --- |
| (a) | 主机状态：主机缺少 WebKit 系统库，或 IPv6 loopback 不可用 | 1 | 8 | 1 | 12 |
| (b) | WSL 上的上游测试缺陷：运行的是生产代码中的 WSL 分支 | 4 | 0 | 0 | 5 |
| (c) | 完整运行中不稳定：单独运行时通过 | 22 | 0 | 0 | 未按测试列出 |
| (d) | 其他：原因未诊断 | 1 | 2 | 3 | 8 |

expected 列合计为 4，而文件只有 3 个，因为 `public-url.expected.e2e.ts` 同时计入 (a) 类与 (d) 类。web 通道的总计报告为 11 个失败测试，但 (a) 类与 (d) 类中列出的测试共 12 个（9 个 WebKit 测试，加上 `composer-focus.e2e.ts` 与 `context-meter.e2e.ts` 中的 3 个）。本基线未能解释这一差异。

### (a) 主机状态

WebKit 浏览器启动失败，因为主机缺少 WebKit 的 GTK 与 WPE 系统库。八个 web 文件在 `browserType.launch` 处失败，错误为主机缺少运行浏览器所需的依赖，共 9 个测试。每个文件单独运行时均为 3 次中 3 次失败：

- `apps/web/tests/declared-reasoning.e2e.ts`
- `apps/web/tests/deepseek-messages-settings.e2e.ts`
- `apps/web/tests/markdown-wide-table.e2e.ts`
- `apps/web/tests/menu-material.e2e.ts`
- `apps/web/tests/models-settings.e2e.ts`，两个测试
- `apps/web/tests/session-inspector.e2e.ts`
- `apps/web/tests/session-replay-reload.e2e.ts`
- `apps/web/tests/turn-tail-actions.e2e.ts`

主机上 IPv6 loopback 被禁用，因此 `::1` 监听失败，报 `EADDRNOTAVAIL`。有三个测试以此方式失败，单独运行时均为 3 次中 3 次失败：

- `packages/test-support/llm-mock-server/tests/server.spec.ts`："formats an IPv6 listener as a valid base URL"（单元测试）。
- `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`："prints the IPv6 loopback root for `::1` and serves it"，以及 "prints the IPv6 loopback root for the second IPv6 spelling and serves it"（expected 测试）。

### (b) WSL 上的上游测试缺陷

这些测试没有注入平台或内核版本。该 WSL2 内核的版本字符串包含 `microsoft`，因此运行的是生产代码中的 WSL 分支。每个文件单独运行时均为 3 次中 3 次失败。

- `packages/host/open-in-app/tests/resolver.spec.ts`："does not offer the Linux file manager without a desktop session"。该文件从未注入 `osRelease`，而 `packages/util/native-command/src/path-opener.ts` 中的 `isWsl()` 会回退到 `os.release()`。
- `packages/util/native-command/tests/path-opener.spec.ts`："rejects unsupported platforms, cancellation, and launcher errors"，以及 "uses the native runner for a file-manager handoff when none is injected"。
- `packages/util/native-command/tests/file-applications.spec.ts`："uses the production command adapter and current platform when no override is supplied"。
- `packages/util/native-command/tests/file-applications-linux-native.spec.ts`："queries and launches an installed Linux desktop entry through GIO"。该文件未注入平台，因此运行 WSL 分支并调用 `powershell.exe`，而该命令已被限制移除。

### (c) 完整运行中不稳定

二十二个单元测试文件在完整的 `pnpm run test` 运行中失败，单独运行时通过。其完整运行中的首个错误为 30 s 至 180 s 的预算超时，或 CPython 探测超时。每个文件单独运行时均为 3 次中 3 次通过；判定标准为至少 2 次通过。

- `packages/client/ui-settings-account/tests/apply.client.spec.ts`
- `packages/experimental/client-ui-forge/tests/controller.host.spec.ts`
- `packages/experimental/worktree/tests/worktree.spec.ts`
- `packages/experimental/ptc-runtime-python/tests/runtime.spec.ts`
- `packages/experimental/speech-to-text-sensevoice/tests/worker.spec.ts`
- `packages/schedule/schedule/tests/change-notice.spec.ts`
- `packages/subagent/subagent/tests/continuation.spec.ts`
- `packages/subagent/subagent-acp/tests/subagent-acp.spec.ts`
- `scripts/gen-third-party-notices.spec.ts`
- `scripts/persistence-epoch-header.spec.ts`
- `scripts/persistence-schema.spec.ts`
- 与 `packages/experimental/liveshare/tests/viewer-*.client.spec.tsx` 匹配的十一个文件

### (d) 其他

以下原因未作进一步诊断。每个文件单独运行时均为 3 次中 3 次失败。

- `apps/web/tests/composer-focus.e2e.ts`："keeps mobile submission keyboard navigation in the composer while retaining desktop focus"（1 个测试）。teardown 报告 `llm-replay: fixture not fully consumed`：一个已录制的脚本从未绑定到活动会话。
- `apps/web/tests/context-meter.e2e.ts`："keeps details visible while resizing the window"，分别针对 `Chat statistics: true` 与 `false`（2 个测试）。teardown 错误与 `composer-focus.e2e.ts` 相同。该文件会启动 WebKit，但 WebKit 库缺失并不能解释这两个测试。
- `apps/cli/tests/profiles/headless/tests/subagent-diagnostic.expected.e2e.ts`："discovers a catalogued child without reading its descriptor through the assembled headless app"（1 个测试）。expected 输出缺少已编目子代理的行。
- `apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts`："confines a delegated child through the assembled headless app"（1 个测试）。深度比较在 `delegationDepth` 上不一致。
- `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`："serves the bound address and a declared authority, refusing any other name"（报 `HTTP request timed out`），以及 "warns about the plain-HTTP bind even when an HTTPS root is advertised"（报 `expected 'SIGKILL' to be undefined`），共 2 个测试。
- `packages/session/session-persistence-jsonl/tests/generation.spec.ts`："accepts a valid append on a zstd target created by another migration"（1 个测试）。追加失败，因为当前会话 generation 已存在，且其目标字节不以迁移后的 generation 开头。未发现 WSL 特有的原因。

<a id="host-state"></a>
## 主机状态

- **WebKit 库。** 参考主机缺少 WebKit 的 GTK 与 WPE 系统库，因此 (a) 类文件中的 WebKit 启动失败。Chromium 可完整解析。
- **IPv6 loopback。** 主机上 IPv6 loopback 被禁用，因此 `::1` 监听失败，报 `EADDRNOTAVAIL`。
- **负责人决定。** 负责人于 2026-11-06 推迟了这两项主机修复。(a) 类的失败属于主机状态的结果，本页按主机现状记录。
- **负载。** 两轮运行期间主机上还有其他任务，如[参考主机与代码树](#reference-host-and-tree)所述。第一轮的单独重跑以及 (c) 类文件显示出与负载相关的失败。
