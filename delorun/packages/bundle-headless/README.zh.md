---
description: "Delorun 的 headless bundle，供维护者修改 delorun headless 在上游 headless profile 之上挂载哪些守卫行，以及 Host 不变量对这些行取值的要求。"
kind: "package-bundle"
---

# @delorun/bundle-headless

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/bundle-headless` 是为 home 的 `headless` profile 提供 Delorun 守卫的 bundle。它不含代码；其 [`cordis.patch.yml`](cordis.patch.yml) 在上游的 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-headless` bundle 之后，关闭两个隐私默认值，插入七个守卫行，并保护它们不被插件管理修改。`delorun headless` 把它链接进 profile，拒绝未加载它的 profile，并在启动前后用 [C19](../../docs/contracts/c19-home-process.zh.md#host-invariants) 的 Host 不变量检查它的各行。

## 目录

- [使用此 bundle](#use-this-bundle)
- [行](#rows)
- [拒绝情形](#refusals)
- [一致性组合](#parity-composition)
- [测试](#tests)

<a id="use-this-bundle"></a>

## 使用此 bundle

- **链接。** 首次运行 `delorun headless` 会根据上游的模板创建 `headless` profile，并把此 bundle 作为一次性变更 `headless-bundle` 链接进去，该变更记录在 `profiles/headless/delorun-migrations.json` 中（[C1](../../docs/contracts/c01-home-layout.zh.md#profiles)）。同一次运行也会把此 bundle 带给由更早版本创建的 profile。
- **层顺序。** 此 bundle 在上游各 bundle 之后、profile 自己的 `cordis.patch.yml` 之前应用。
- **被移除的 bundle。** profile 未加载此 bundle 时，`delorun headless` 在启动前停止，并指出补救办法：删除 `profiles/headless/delorun-migrations.json`，让下次运行重新链接此 bundle；或删除 `profiles/headless` 文件夹，让 Delorun 重新创建该 profile。
- **没有设置答案。** headless profile 没有设置答案，所以每一行取 Delorun 的默认值（[`compose.ts`](../../apps/cli/src/compose.ts) 中的 `HEADLESS_ROW_VALUES`），Host 不变量拒绝任何其他取值。

<a id="rows"></a>

## 行

| 行 | 插件 | 它在 headless 任务中的作用 |
| --- | --- | --- |
| `session-log-deepseek` | 上游的会话日志上传 | `enabled: false`：DeepSeek 的会话日志上传关闭（[C11](../../docs/contracts/c11-setup-answers.zh.md)） |
| `session-telemetry-otel` | 上游的反馈遥测导出器 | `disabled: true` |
| `delorun-instruction-consent` | [`@delorun/plugin-instruction-consent`](../plugin-instruction-consent/README.zh.md)，带 `approvedPluginWrites` | 模型撰写的对 skill、预设或 `AGENTS.md` 的写入，以及 agent 在 chat 中首次写入「变更」中已批准插件的文件夹，会请求同意；没有人回答，因此被拒绝 |
| `delorun-mcp-consent` | [`@delorun/plugin-mcp-consent`](../plugin-mcp-consent/README.zh.md) | 本人自己的补丁新增的 stdio MCP 服务器，其命令被接受之前不会启动 |
| `delorun-schedule-consent` | [`@delorun/plugin-schedule-consent`](../plugin-schedule-consent/README.zh.md) | 本人自己的补丁使之成为可能的定时后续任务会请求同意；没有人回答，因此被拒绝 |
| `delorun-permission-defaults` | [`@delorun/plugin-permission-defaults`](../plugin-permission-defaults/README.zh.md) | 对没有授权记录的工作区切换到完全访问，会被拒绝 |
| `delorun-fetch-guard` | [`@delorun/plugin-fetch-guard`](../plugin-fetch-guard/README.zh.md) | 对私有、回环或链路本地地址的抓取会被拒绝 |
| `delorun-tool-failure-guard` | [`@delorun/plugin-tool-failure-guard`](../plugin-tool-failure-guard/README.zh.md)，带 `stderrNotice` | 工具调用接连失败（连续 6 次，或最近 12 次中有 8 次）的轮次会在下一次模型请求前停止，并在标准错误输出一行说明原因 |
| `delorun-plugin-changes` | [`@delorun/plugin-changes`](../plugin-changes/README.zh.md) | agent 通过 `plugin_manager` 进行的安装或移除不会执行；它作为等待本人在自己电脑上审阅的变更，记录在 profile 的变更日志中（[C21](../../docs/contracts/c21-changes.zh.md#the-agent-and-plugins)）；该 profile 不提供 studio，因此插件不注册「变更」路由 |
| `delorun-update-gate` | `@delorun/bundle-local/update-gate`，带 `holdUntilChecked` | 每个轮次的第一步都会等到 `delorun headless` 检查完已启动 Host 的行和服务；任何更新或停止都不会等待 headless 运行中的 chat；等待超过 `checkWaitSeconds`（默认 60）的轮次，以 `START_CHECK_PENDING` 结束，而不是无提示地一直等待 |
| `delorun-prompt-wording` | `@delorun/bundle-local/prompt-wording` | 系统提示词中 Delorun 的措辞（C16 开关 `model_prompt`），与 CLI profile 中相同 |
| `plugin-manager` | 上游的插件管理，`protectedPlugins` | 上面的守卫行和沙箱行不能通过 `plugin_manager` 工具被禁用、重新配置或移除；完全访问模式下，该工具不经提示即运行，这与 [`@delorun/bundle-local`](../bundle-local/README.zh.md) 中相同 |

<a id="refusals"></a>

## 拒绝情形

- **需要询问本人的守卫。** 该 profile 不组合审批应答器，因此询问会得到 `unavailable`，守卫连同原因拒绝该操作。
- **启动前的完全访问。** 对没有完全访问授权的工作目录，`--permission-mode danger-full-access` 和 `DSH_PERMISSION_MODE=danger-full-access` 会被拒绝（授权由本人在 home 所在的电脑上以 `delorun workspace full-access <folder> on` 或在 studio 中记录）；授权记录无法读取时同样拒绝；任务不会启动。
- **轮次门。** 任务的第一步等待启动后的检查。检查拒绝的 Host 会随任务一起停止。

<a id="parity-composition"></a>

## 一致性组合

录制会话回放所运行的 profile 都不挂载此 bundle：[一致性组合](../../docs/contracts/c16-parity-composition.zh.md)保持上游的 `headless` profile 不变。`instruction_layer_consent`、`permission_defaults`、`fetch_guard`、`tool_failure_guard` 和 `update_turn_refusal` 由这些插件和 `@delorun/bundle-local` 注册，而一致性检查只读取 `@delorun/bundle-local` 和 `@delorun/bundle-studio` 的补丁，因此此 bundle 不增加开关，也不向注册表增加条目。

<a id="tests"></a>

## 测试

- `delorun/apps/cli/tests/compose.spec.ts` 分别在带有和不带此 bundle 的情况下组合 `headless` profile，并在启动前后让它的各行符合 `HEADLESS_ROW_VALUES`。
- `delorun/apps/cli/tests/headless.spec.ts` 覆盖启动前对完全访问的拒绝以及轮次门的释放。
- `delorun/apps/cli/tests/headless-bundle.spec.ts` 覆盖把此 bundle 作为一次性变更 `headless-bundle` 进行链接。
- `delorun/apps/cli/tests/headless-guards.integration.spec.ts` 带着此 bundle 启动 profile，并检查每个守卫在 headless 运行中都会拒绝。
