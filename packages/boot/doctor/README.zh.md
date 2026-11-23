---
description: "dsh doctor：运行 `dsh --profile doctor`，检查 dsh 所运行的机器和组合，并从任何包注册你自己的检查。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-doctor

[English](README.md) | 中文

## 概述

`dsh-doctor` 用一条命令回答“dsh 在这里能否正常工作？”。`dsh --profile doctor` 启动共享的基础组合，运行每个已注册的检查，每项检查打印一行，并给出计数；没有失败时退出 0，否则退出 1。包通过 `doctor` 服务添加检查，因此检查与它所检查的代码放在一起。内置检查覆盖 Node.js 版本，以及命令沙箱在部署模式下对命令的限制程度。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在你要工作的目录中运行：

```sh
dsh --profile doctor
```

```text
ok    Node.js version: Node.js 24.9.0 is in the supported range >=24.9.0.
warn  Command sandbox: This machine enforces workspace-write only in part, such as on a kernel with an older Landlock ABI; a newer kernel enforces it in full.

1 passed, 1 warned, 0 failed
```

`ok` 表示通过；`warn` 表示能工作但不如预期；`FAIL` 表示无法工作，其所在行会说明该怎么做。profile 在首次使用时从内置的 `doctor` 模板初始化，即 `dsh-base` bundle 加本包的 bundle。

应用的 `doctor` 开关会开启检查运行。它是一个经过校验的 Config 字段，默认关闭，这是 Delorun C16 的对等值；内置的 `doctor` profile 会将其设为开启。未挂载该开关的应用不运行任何检查，向 stderr 写入一行并以退出码 1 结束。

沙箱检查不会启动它所限制的命令。它对一个空操作命令调用 `confine`，取部署默认模式下的限制，并读取 enforcement。在 Linux 上，沙箱的第一次 `confine` 调用会运行它自己的功能探测（每个 provider 生命周期执行一次），即在 `bwrap` 或 Landlock launcher 下运行 `true`，以选择 runner。

### 添加检查

注入 `doctor` 的插件会在自身生命周期内注册一项检查：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-doctor'

export const inject = ['doctor']
export function apply(ctx: Context) {
  ctx.doctor.register({
    id: 'my-cache',
    title: 'Cache directory',
    async run(signal: AbortSignal) {
      return { status: 'pass', detail: 'The cache directory is writable.' }
    },
  })
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `checkTimeoutMs` | `10000` | 一项检查在被报告为失败前可以运行的时长 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`DoctorRegistry`（`doctor`）按 id 保存检查；`register()` 是调用方插件的 effect，并拒绝已使用的 id。`run(signal)` 并发运行每项检查，每项各有自己的截止时间，并按注册顺序为每项检查返回一个结果：拒绝或超过 `checkTimeoutMs` 的检查被报告为失败并附原因；取消运行的 signal 会使 run 被拒绝。`./checks` 插件注册内置检查；沙箱检查在 `sandboxPolicy` 默认模式下对一个空操作命令进行 confine，并读取沙箱报告的 enforcement。`./app` 插件等待 `ctx.appReady`，在 stdout 上打印报告，并调用 `ctx.appExit`。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `DoctorRegistry`、`DoctorCheck`、`DoctorOutcome`、`DoctorResult` |
| [`src/checks.ts`](src/checks.ts) | 内置的 Node.js 和沙箱检查 |
| [`src/app.ts`](src/app.ts) | 单次运行的应用及其报告 |
| [`cordis.patch.yml`](cordis.patch.yml) | `doctor` profile 叠加在 `dsh-base` 之上的 bundle patch |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-cmdline](../cmdline/README.zh.md) — 应用使用的启动器退出请求和就绪信号。
- [dsh-sandbox](../../sandbox/sandbox/README.zh.md) — 沙箱检查读取的 enforcement。

-----

<a id="model-experience"></a>
## 模型体验

### Doctor run

#### 模型看到的内容

无：doctor 在会话之外运行，没有模型能看到它的检查（`ctx.doctor`）或报告。

#### Token 影响

无；doctor 不向任何模型请求添加内容。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只有两项内置检查** — 其他包尚未贡献它们的检查，因此 doctor 不对凭据、存储或 Web 服务器给出结论。
- **检查只看到基础组合** — `doctor` profile 只叠加在 `dsh-base` 之上，因此由其他 bundle 注册的检查只会在挂载了注册表和该 bundle 的 profile 中运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

本开发备注是面向维护者的工作上下文，不是已发布的行为。可贡献检查的候选项：默认模型路由的凭据、可写的 `DSH_HOME`，以及 Web 服务器的绑定地址。

</details>
