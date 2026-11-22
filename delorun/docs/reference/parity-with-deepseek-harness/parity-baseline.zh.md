# 对等基线

[English](parity-baseline.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

本页记录对等基线：上游 DeepSeek Harness 自身的测试套件，在 Delorun 参考主机上、于上游标签 `dsh-v0.2.2-rc.1` 下的运行结果。本页包含两轮运行、一次 Node 24 核对、每项剩余失败的分类，以及这些结果所依赖的环境与主机状态。本页还记录 `main` 上的绿色基线：运行步骤、前置条件、唯一的排除项，以及使每个失败文件通过的修复。术语遵循 [Delorun 术语表](../glossary.zh.md)。

## 目录

- [参考主机与代码树](#reference-host-and-tree)
- [两轮运行](#passes)
- [上游 CI 设定的环境](#environment-as-upstream-ci-sets-it)
- [Node 24 核对](#node-24-check)
- [剩余失败的分类](#classification-of-the-remaining-failures)
- [主机状态](#host-state)
- [main 上的绿色基线](#green-base-on-main)

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

每条命令都在 Delorun 检查工具于 WSL 上施加的 Linux 限制下运行，即 `delorun/apps/tools/src/checks/machine.ts` 中的 `confineToLinux`。上游 CI 不施加该限制。shell 的 `PATH` 去掉了 44 个位于 Windows 驱动器挂载点下的条目，保留 25 个；下列变量被取消设置：`WSL_INTEROP`、`WSL_DISTRO_NAME`、`WSLENV`、`WSL2_GUI_APPS_ENABLED`、`DISPLAY`、`WAYLAND_DISPLAY`、`PULSE_SERVER` 与 `NoDefaultCurrentDirectoryInExePath`。这些变量是在 shell 中为每条命令设置的，而不是在每个测试 fork 中设置；移除的变量集合相同，因此各套件看到的环境一致。

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

<a id="web-e2e-rc5"></a>
## rc.5 漂移修复后的 Web e2e

完整的 Web 套件（`vitest.web.config.ts`）在 rc.5 分支上运行，旁边没有其他重负载任务：共 1,098 个测试，1,058 个通过、29 个跳过、11 个文件中的 11 个失败。完成下列修复后，这 11 个文件加上预览启动文件在重跑中全部通过（16 个文件，30 个测试）。29 个跳过的测试是套件自身的跳过。本次运行未出现 WebKit 启动失败，因此上文 (a) 类中的 WebKit 条目不适用于在该主机上运行的 Web 通道。

| 文件 | 类别 | 原因与处理 |
| --- | --- | --- |
| `built-boot.expected.e2e.ts`、`hmr-live.e2e.ts` | 构建记录 | 一次预览构建重写了 `dist/`，使产物与 `.dsh-build/client-build-environment.json` 不再一致。完整的 `pnpm run build` 将其恢复；两者均通过。 |
| `delorun-allow-for-chat`、`delorun-dangerous-mode`、`delorun-full-access-consent`、`delorun-pairing`、`delorun-privacy-consent`、`delorun-setup-versions`、`delorun-update-notice` | 构建记录 | Delorun 插件库（`@delorun/plugin-trash`）尚未在工作树中构建。完整构建修复了它们；全部通过。 |
| `chat-fold-opened-group.e2e.ts` | 负载下不稳定 | 仅在主机负载较高时，一次滚动步骤朝错误方向移动；单独运行 3 次均通过。 |
| `ptc-round.e2e.ts` | 测试支持 | 黄金文件中包含了真实命令的墙钟耗时。aria 规范化器现在将带空格的秒数（`0.1 s`）替换为 `{{duration}}`，并刷新了四个黄金文件。 |

rc.4 的分诊类别解决如下。

- **过期的黄金文件（复制命令按钮与耗时）：** 已刷新 `clickable-links-gallery`、`ptc-round`、`live-job-stream`、`plugin-install-registry`、`plugin-install-silent-failure`。
- **Delorun 差异，规格已更新：** `deepseek-messages-settings`、`models-settings`、`onboarding-native`、`onboarding-usable-provider` 中的密钥占位符（“Paste your key”）；`plugin-config` 中插件的“History”按钮；`plugin-config` 中本地抓取提供方的描述；`lifecycle-chrome` 中忽略浏览器离线状态的环回页面；`window-drag-coverage` 中悬停预览的侧边栏；`pwa-manifest` 中的十六进制应用图标、由构建得出的标题与 Delorun 图标集；`smoke-real` 中插件资源现在需要的会话 cookie。
- **回归，已在产品代码中修复：** `preview-boot`（预览工作进程的 `node:fs` 缺少数值形式的打开标志、读取流的 `fd` 选项、`readlink` 与 `rmdir`，而加固后的本地文件读取器需要它们）和 `deepseek-chat-import`（上传路由未声明 `application/octet-stream`，因此精确路由的媒体类型门禁拒绝了该归档）。每项都有变更日志片段。
- **不是回归：** `sidebar-terminal`。受限的调用是变更文件卡片在 `workspace-write` 默认值下执行的 `git rev-parse`；规格现在禁止对终端本身做任何限制，并允许该 git 探测。同一文件中有一次运行还出现颜色测试失败，重跑后通过（负载下不稳定）。

<a id="host-state"></a>
## 主机状态

- **WebKit 库。** 参考主机缺少 WebKit 的 GTK 与 WPE 系统库，因此 (a) 类文件中的 WebKit 启动失败。Chromium 可完整解析。
- **IPv6 loopback。** 主机上 IPv6 loopback 被禁用，因此 `::1` 监听失败，报 `EADDRNOTAVAIL`。
- **负责人决定。** 负责人于 2026-11-06 推迟了这两项主机修复。(a) 类的失败属于主机状态的结果，本页按主机现状记录。[议题 #58](https://github.com/twickas/delorun/issues/58) 跟踪这两项修复。
- **负载。** 两轮运行期间主机上还有其他任务，如[参考主机与代码树](#reference-host-and-tree)所述。第一轮的单独重跑以及 (c) 类文件显示出与负载相关的失败。

<a id="green-base-on-main"></a>
## main 上的绿色基线

绿色基线是 `main`：上游单元测试套件、上游录制会话回放与 Delorun 完整门禁均通过，且不带入任何已知失败：无法通过的测试要么被修复，要么按名称排除并在本页记录原因。下列运行于 Node `v24.22.0` 上、在 `main` 的某一提交（本次运行的提交）处进行；修复是在更早的一个提交之上完成的。

### 运行步骤

在 Node 24（`nvm use 24`）上，执行 `pnpm install --frozen-lockfile` 之后，且主机上没有其他测试套件运行时：

```sh
DSH_BUILD_CLIENT_PROFILE=official pnpm check:full
env -u NoDefaultCurrentDirectoryInExePath DSH_TELEMETRY_DISABLED=1 DSH_BUILD_CLIENT_PROFILE=official DSH_COVERAGE_TEST_TIMEOUT_MS=90000 \
  pnpm run test -t '^(?!.*(?:mock LLM server wire behaviors formats an IPv6 listener as a valid base URL))'
DSH_EXAMPLE_MODE=lib node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only tests:snapshots --no-cache
```

- `pnpm run test` 运行上游自己的脚本 `pnpm run build:native-system && vitest run`，pnpm 会把 `-t` 参数追加到其后。`pnpm run test -- -t …` 会同时转发 `--`，此时 vitest 把该模式读作文件过滤器，排除项便不再生效。
- Vitest 将 `-t` 与测试的完整名称（以空格连接）匹配，而不是与其列表输出所用的、以 `>` 分隔的形式匹配。
- 在完整运行中失败的文件会被单独重跑。单独重跑时消失的失败属于资源争用，记录于[资源争用](#contention)之下；仍然失败的则予以修复或排除。

### 前置条件

上游的 CI 通过 `pnpm run test` 运行测试套件，它为每个规范提供下文的第一、第三与第四项设定；参考主机上第一次绿色基线运行直接调用 vitest，因而缺少这些设定。第二项来自 WSL：Windows 一侧把 `NoDefaultCurrentDirectoryInExePath` 传入 Linux shell，而上游的 CI 从不设定它。

| ID | 设定 | 缺少它时失败的文件 | 规范为何需要它 |
| --- | --- | --- | --- |
| P1 | `npm_execpath` 指定仓库的 pnpm | `apps/desktop/tests/macos-notarization-proxy.spec.ts`，15 个测试 | 该规范运行的桌面打包脚本通过 `npm_execpath` 所指定的 pnpm 构建 flock addon；缺少它时，脚本会以 `flock addon is not built` 停止。 |
| P2 | 取消设置 `NoDefaultCurrentDirectoryInExePath` | `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts`，1 个测试 | 上游在 `runner-launch.ts` 中的 Windows 命令查找，无论在哪个平台，都从进程环境读取该变量，然后把当前目录排除在规范所期望的搜索根之外。 |
| P3 | 固定版本的 pnpm 11.28.5，即 `packageManager` 所固定的版本，置于 `PATH` 首位 | `packages/boot/plugin-manager/tests/manager.spec.ts`，1 个测试 | 规范的 fixture（测试前置数据）会启动 `pnpm`；主机上的全局 pnpm 10.34.7 会对构建批准返回 `restart-required`，而固定版本则使该批准失败。 |
| P4 | `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` | `scripts/release/pack.spec.ts`，1 个测试 | pnpm 11 在 `pnpm exec` 之前校验工作区的依赖；依赖看似过期时，它会运行 fixture 的 `prepare` 钩子，而规范断言这不会发生。`pnpm run` 为其脚本及脚本的子进程设定 `pnpm_config_verify_deps_before_run=false`。 |

P4 是针对参考主机的牵头人决定，作出于 2026-11-07：该设定重现了 `pnpm run test` 在上游 CI 中为每个上游规范提供的值，因此不改变规范所检查的任何内容。另一种做法是按名称排除 `release pack CLI > does not broaden an empty parallel family to the whole workspace`，但这会带入一个已知失败。

上文的运行步骤提供了全部四项设定：`pnpm run test` 提供 P1、P3 与 P4，`env -u` 提供 P2。Delorun 的检查运行器没有运行上游整个单元测试套件的通道，但其各通道获得相同的设定。`delorun/apps/tools/src/checks/machine.ts` 中的 `checkEnvironment` 在 WSL 上为每个检查移除 P2，并与其他 Windows 侧变量一并移除；对于规划了运行 pnpm 的检查（或标记为 `pnpmScript` 的检查，如 `tests:upstream-changed`）的任何运行，运行器从 pnpm 读取 P1、P3 与 P4（[工具 README](../../../apps/tools/README.zh.md#local-checks)）。

### 结果

| 套件 | 结果 |
| --- | --- |
| `pnpm check:full` | 44 通过，0 失败 |
| 经检查运行器的录制会话回放 | 9 个文件；260 个测试通过，2 个跳过 |
| 单元测试套件，`node_modules/.bin/vitest run`，带排除项且不带前置条件 | 41 个文件失败，2531 通过，20 跳过；88 个测试失败，52556 通过，1 个预期失败，241 跳过；2 个未处理的 Promise 拒绝 |

每个失败的单元文件都单独重跑。26 个文件单独运行时通过：它们的 38 个失败测试属于资源争用。15 个文件仍然失败，共 58 个失败测试：其中 50 个在完整运行与重跑中都失败，8 个只在重跑中失败。下表给出每个文件的原因与修复。

| 文件 | 类别 | 原因 | 修复 |
| --- | --- | --- | --- |
| `apps/desktop/tests/macos-notarization-proxy.spec.ts` | 前置条件 | 缺少 P1 | 运行步骤 |
| `scripts/ci-workflow.spec.ts` | Delorun 改动 | Delorun 的仓库守卫，以及 `ci.yml`、`ci-windows.yml`、`ci-master.yml`、`ci-python.yml` 中的运行器路由，还有发布、审批与议题工作流 | 规范通过 `scripts/tests/delorun-repository-guard.ts` 读取受守卫的字段 |
| `scripts/tests/ci-release-selfhosted.spec.ts` | Delorun 改动 | Delorun 在 `cua-helper-package.yml` 与 `release-publish.yml` 中的仓库守卫 | 同上 |
| `scripts/tests/ci-master-platforms.spec.ts` | Delorun 改动 | Delorun 在 `build-exe-for-python-sdk.yml`、`ci-python.yml` 与 `ci-master.yml` 中的仓库守卫 | 同上；`ci-master.yml` 中的 `serial-macos` 恢复为上游的 `if: false`，无需守卫 |
| `scripts/client-bundle-css.spec.ts` | Delorun 改动 | Delorun 的 `.woff2` 包资源媒体类型；规范把 `.woff2` 用作不受支持的资源 | 规范改用 `.woff` 作为不受支持的字体 |
| `scripts/verify-client-packages.spec.ts` | Delorun 改动 | 同上 | 规范期望 `.woff2` 说明符，并使一个 `.woff` 说明符保持不被收集 |
| `scripts/translation-prompt.expected.spec.ts` | Delorun 改动 | Delorun 在 `docs/i18n/terminology.md` 中的各行，组装好的提示词会嵌入这些行 | 预期输出以 `DSH_SNAPSHOT=refresh` 重新录制 |
| `scripts/release/pack.spec.ts` | 前置条件 | 缺少 P4 | 运行步骤 |
| `scripts/desktop-publish-workflow.spec.ts` | Delorun 改动 | Delorun 在 `desktop-publish.yml` 中的仓库守卫 | 同 `ci-workflow.spec.ts` |
| `scripts/ci-compatible-selfhosted.spec.ts` | Delorun 改动 | Delorun 在 `ci.yml` 中的运行器路由 | 同 `ci-workflow.spec.ts`，另加一个用例：在上游仓库之外，每种故障转移模式都运行于 `ubuntu-latest` |
| `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts` | 前置条件 | 缺少 P2 | 运行步骤 |
| `packages/boot/plugin-manager/tests/manager.spec.ts` | 前置条件 | 缺少 P3 | 运行步骤 |
| `packages/subagent/subagent/tests/continuation.spec.ts` | 资源争用 | 见[资源争用](#contention) | 无 |
| `packages/experimental/client-ui-forge/tests/local-diff-safety.host.spec.ts` | 资源争用 | 见[资源争用](#contention) | 无 |
| `packages/experimental/client-ui-forge/tests/controller.host.spec.ts` | 资源争用 | 见[资源争用](#contention) | 无 |

每项对上游规范的编辑，以及辅助文件，在差异台账中都有一条 `delorun-feature` 条目。

修复后，15 个文件中的每一个都在 Node `v24.22.0` 上、带前置条件（`env -u NoDefaultCurrentDirectoryInExePath pnpm exec vitest run <file>`，并使用运行步骤中的变量）单独运行一次，全部通过：共 800 个测试，无一失败。`server.spec.ts` 带排除项运行，通过 45 个测试，被排除的那个测试被跳过。

### 排除项

按名称排除一个测试：`packages/test-support/llm-mock-server/tests/server.spec.ts` 中的 `mock LLM server wire behaviors > formats an IPv6 listener as a valid base URL`。该测试单独运行时每次都因 `Error: listen EADDRNOTAVAIL: address not available ::1` 而失败，原因是参考主机上禁用了 IPv6 loopback（[主机状态](#host-state)）。主机修复落地时，排除项即告结束；[议题 #58](https://github.com/twickas/delorun/issues/58) 跟踪该修复与 WebKit 库。

<a id="contention"></a>
### 资源争用

主机与其他智能体的测试套件共享，因此这些结果取决于运行时的负载。

- 单独通过的 26 个文件，是在至少另有一个 vitest 进程运行时重跑的。
- `packages/subagent/subagent/tests/continuation.spec.ts` 与 `packages/experimental/client-ui-forge/tests/local-diff-safety.host.spec.ts` 各自在完整运行中失败，并在其他 vitest 进程运行期间开始的重跑中失败。在本次运行的提交上单独运行时，两者各通过 3 次中的 3 次（分别为 164 与 17 个测试）；在更早的提交上单独运行时，两者各通过一次。这些运行期间，主机的平均负载在 7 至 15 之间。两个提交都没有失败，因此无需二分查找；标签与 `main` 之间没有提交触及这两个包，且两个文件在标签处都属于 (c) 类。
- `packages/experimental/client-ui-forge/tests/controller.host.spec.ts` 在完整运行中有两个失败，单独运行时均通过；在与另一个 vitest 进程同时开始的重跑中，出现一次 90000 ms 超时。在更早的提交上、主机另有四个 vitest 进程运行时单独运行，它通过了全部 118 个测试。该文件在标签处属于 (c) 类。

## 下一步

[对等清单](parity.zh.md)记录与原版 DeepSeek Harness 的每项差异的状态。[套件反馈日志](../harness-feedback.zh.md)记录运行这些套件时遇到的问题。[参考索引](../README.zh.md)列出其他开发者页面。
