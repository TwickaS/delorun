---
description: "Delo 的按工作区权限默认值，供维护者修改新工作区以哪个预设开始、何时询问完全访问，以及防护会拒绝哪种模式切换。"
---

# @delo/plugin-permission-defaults

[English](README.md) | 中文

## 概述

上游为整个部署组合一套权限：每个新对话都从同一个预设开始，选择 `danger-full-access` 立即生效。本插件改为让预设成为工作区的属性。新对话从个人为其文件夹选择的预设开始——无人选择过的工作区从 `workspace-write` 开始——与部署默认值无关，完全访问只在该工作区获得一次同意之后生效。个人在 home 自己的电脑上给出同意：在 studio 中选择完全访问时或在设置的“工作区访问”部分，或使用 `delorun workspace full-access`。同意写入 home 的受保护状态，因此它覆盖该文件夹，直到个人在那里选择另一个预设；显式选择更安全的预设会撤回该同意，因此再次回到完全访问会重新询问。

拒绝未经同意的完全访问切换的防护，会在会话记录任何内容之前运行。因此被拒绝的切换不会追加 `sandbox/mode` 事件，也不会追加预设标识，会话继续解析它原本的模式，在同一步中启动的命令仍在沙箱内运行。防护覆盖整个选择，而不只是模式变更：保持模式但放弃审批策略的预设同样会被拒绝，因此审批提示不是绕过同意的办法。按调用的 `sandbox_permissions` 升级不是模式切换：它走上游的按调用审批，本防护看不到它。拒绝的措辞指明工作区并说明该怎么做，所以模型读到的是它，而不是堆栈信息。

一切（包括路由）都位于开关 `permission_defaults` 之后，默认关闭；`@delo/bundle-local` 在 `delorun` 启动的 CLI 配置中开启它，而 `delorun headless` 与桌面应用运行不含它的上游配置。关闭时插件不挂载任何内容：部署默认值按上游的方式抵达每个新对话，每次模式切换都被记录，这正是 parity 组成所断言的。

## 哪个预设生效

三个层级决定一个对话的权限，由强到弱：

1. 对话自身的日志。对话已持有的预设标识或旋钮事件优先于其工作区的默认值，因此恢复、分叉或播种的对话保留它记录的权限。显式的 `sandbox/mode` 切换也优先于预设标识——另一个界面的控件、已批准的升级或委派播种——当旋钮不匹配任何已配置的预设时，该对话随后报告 `custom`；个人再次选择时 `select()` 会重新确认所选预设。
2. 工作区的默认值。`select()` 记录它，而本插件只把它播种到新对话：播种只作用于尚未持有任何权限选择、也从未被播种的对话。
3. 部署默认值。`sandbox-policy` 的模式与审批策略的默认值位于两者之下：它们适用于工作区没有条目的对话，以及对话从未覆盖的任何旋钮。

## 提供什么

- `permissionDefaults` —— 开关背后的服务。`defaultPreset(cwd)` 与 `granted(cwd)` 读取工作区记录的预设以及它是否持有完全访问授权，`select(agent, preset)` 是界面为工作区选择预设的唯一写入路径，`review(session, mode)` 是防护的判断。条目在挂载时读取一次并保存在内存中，因此防护无需文件系统调用即可作答；`storeProblem` 指出无法读取的存储。
- `sandboxModeGuard` —— `@deepseek-ai/dsh-sandbox-policy` 会话模式 seam 的模式切换钩子，挂载后 `setSandboxMode` 会拒绝在无人同意的工作区切换到完全访问。它是该 seam 唯一的提供方，因此一个组成只开启本同意或另一个插件的防护，不会两者都开。
- 存储 —— [`src/store.ts`](src/store.ts) 保存格式与文件处理：每个工作区一条条目，以工作区的规范路径为键（[`src/workspace.ts`](src/workspace.ts)），位于 home 的 `secrets/` 目录下，模式 0600，因此受限命令既不能读取这些同意，也不能为自己添加一条；在 Windows 上，运行器不限制读取，受限命令无法写入它们，但可以读取。符号链接的存储、比 0600 更宽松的存储，或保存其他格式的存储都会被拒绝，在个人修复之前任何同意都不作数。
- `select()` 通过组合的审批服务询问，说明文件夹以及完全访问放弃的边界，除授权之外的一切答复都以 `FullAccessConsentRefusedError` 拒绝：不记录任何内容，工作区保持更安全的预设。选择更安全的预设会撤回工作区的授权，因此之后的完全访问选择会重新询问。审批服务只在对话进行中的回合内询问，因此没有任何 studio 界面调用它。

## 同意界面

studio 与 CLI 自行询问同意，并通过该服务记录答复，且只在 home 自己的电脑上进行。同意的措辞来自 [`fullAccessNote`](src/review.ts)：此后该工作区中的命令可以在沙箱外运行并写入任何位置，读取个人的用户能读取的一切（包括 Delo 的 home 及其密钥与令牌），并连接 Docker 监管器与 Delo 的更新通道；答复只覆盖该工作区。

- **服务调用。** `workspaces()` 列出界面显示的每个工作区——已注册的工作区、存储中持有的工作区以及打开的对话所在的文件夹——每个都带有其完全访问状态与一个审查 id（[`src/review.ts`](src/review.ts)）；`reviewChat(sessionId)` 是一个打开的对话的工作区。`setFullAccess({ workspace, reviewId, on, confirmed })` 记录个人的答复：开启时记录授权与完全访问预设，关闭时撤回授权，并把该工作区中以完全访问运行的每个打开的对话设回更安全的预设，这会追加该对话的 `sandbox/mode` 与 `permission/preset` 事件。遇到 `UNCONFIRMED`（没有 `confirmed: true`）、`UNKNOWN_WORKSPACE`、`STALE_REVIEW`（显示同意之后该工作区的完全访问已改变）和 `STORE_REFUSED` 时，它以 `FullAccessChangeError` 拒绝且不记录任何内容。每次变更都先从磁盘读取存储，因此 CLI 写入的变更绝不会被撤销，并记录一行不含文件夹路径的日志。
- **重新读取存储。** `reload()` 在 `delorun workspace full-access` 写入存储后读取它，把失去授权的工作区中打开的对话设回更安全的预设，并返回条目的摘要，让 CLI 可以核对 Host 持有的正是它写入的内容；home 进程为更新通道的 `permission.reload` 调用它（[C19](../../docs/contracts/c19-home-process.zh.md)）。
- **路由。** 在 Connection 为 studio 提供服务的地方，`/api` 下有三条精确路由（[`src/wire.ts`](src/wire.ts)、[`src/routes.ts`](src/routes.ts)）：`GET /api/deloPermission.workspaces`、`POST /api/deloPermission.review` 与 `POST /api/deloPermission.setFullAccess`。每条路由只回答经回环监听器到达且 `Host` 为回环地址的请求；远程访问设备在请求体被读取之前就以 `403 LOOPBACK_REQUIRED` 被拒绝（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#tailnet-membership)）。studio 的同意、其工作区访问部分，以及上游权限控件询问的 `permissionSwitchConsent` 问题位于 [`@delo/bundle-local`](../bundle-local/README.zh.md)。

## 配置

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `false` | Delo 的 C16 开关 `permission_defaults`，在 parity 组成中关闭；开启时，插件按工作区为每个新对话播种，并挂载拒绝无人同意的工作区使用完全访问的防护。 |

## 测试

`tests/store.spec.ts` 覆盖存储的路径、格式的往返、使存储不作数的各种拒绝（更宽松的模式、符号链接、其他格式）、条目查询，以及让一个目录成为一个工作区的工作区键。`tests/permission-defaults.spec.ts` 覆盖关闭状态的开关、新工作区获得的播种、每个文件夹询问一次的同意、不记录任何内容的拒绝、防护拒绝的模式切换，以及已持有授权的工作区。`tests/surfaces.spec.ts` 覆盖这些界面的调用与路由：列出的工作区、让切换通过的授权、把打开的对话设回的撤回、CLI 写入后被保留并重新读取的存储，以及拒绝情形——远程访问设备、未确认的答复与过期的审查都不记录任何内容。
