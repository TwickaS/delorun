---
description: "Delorun 的 plugin_changes_pending 开关背后的拦截、对运行中 profile 每次重新加载之前的检查、studio 的「变更」路由以及设置中的「变更」部分，供维护者在 agent 请求 plugin_manager 更改插件、运行中的 Host 重新组合其 profile，或 studio 及其恢复屏幕读取变更或对其执行操作时修改相应行为。"
kind: "package-bundle"
---

# @delorun/plugin-changes

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

只要「变更」的保护处于开启状态，`@delorun/plugin-changes` 就会阻止 agent 更改 harness 运行哪些插件。在其 C16 开关 `plugin_changes_pending` 开启且保护开启时，动作为 `install_bundle` 或 `remove_bundle` 的 `plugin_manager` 调用不会运行：`tools/pre-execute` 监听器把它作为待处理变更记录到 profile 的变更日志中（[C21](../../docs/contracts/c21-changes.zh.md#the-agent-and-plugins)），并以模型可读的结果拒绝该调用：`Recorded as a change waiting for the person's review at their computer: delorun changes show <id>. Nothing was installed.` 对这些动作，该工具永远不会到达它自己的完全访问审批，本人在自己的电脑上通过 `delorun changes` 或在 studio 中应用或丢弃该变更。agent 其他会更改运行内容的 `plugin_manager` 动作（`set_bundle`、`set_plugin`、`configure`、`set_version_exemption`、`undo`、`restore`）以 `PLUGIN_CHANGE_AT_COMPUTER` 拒绝，且不记录任何内容。保护关闭（默认）时，每个这样的调用都继续交给上游，仅由上游的完全访问审批决定。无论开关如何，该插件都提供上游热重载的 `profileReconcileCheck`，在任何内容停止之前检查 profile 的每次重新组合（[C21](../../docs/contracts/c21-changes.zh.md#reloads-and-restores)）。无论开关如何，它还在 `/delorun/changes/` 下注册 studio 的「变更」路由，供上游的启动页读取，用于其恢复屏幕（[C21](../../docs/contracts/c21-changes.zh.md#routes-and-the-recovery-screen)），其浏览器一半添加设置中的「变更」部分和工作会话徽章，它们通过同样的路由执行操作（[C21](../../docs/contracts/c21-changes.zh.md#the-studios-changes-section)）。开关关闭（默认值，也是一致性值）时，插件不注册监听器或守卫，工具的运行和询问方式与上游相同。

## 目录

- [约定](#contract)
- [studio 的「变更」部分](#the-studios-changes-section)
- [配置](#configuration)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **保护设置。** 对每个动作会更改运行内容的 `plugin_manager` 调用，监听器都读取该 profile 的 Delorun home 的 `readProtection`，所以 `delorun changes protection on|off` 在运行中的 Host 的下一次调用时生效。设为默认的 `off` 时，对每个这样的调用它都调用 `next()`，与开关关闭时完全相同，因此由上游的完全访问审批决定，Creator 模式也可以在 chat 中开启 bundle。已运行的、来自文件夹的安装（`link:<folder>`）在它引起的重新组合时纳入「变更」管理：重新加载之前的检查把插件链接到其活动目录，并把该文件夹的内容记录为已应用的 `plugin-install`，决定为 `unreviewed`。注册表安装或移除不在「变更」管理之下；上游记录的 profile 历史就是它的记录，插件对此不记录任何内容。无法读取的保护记录会拦下调用：以 `PLUGIN_CHANGE_UNRECORDED` 拒绝，并说明无法读取该设置。以下内容均在保护为 `on` 时成立。
- **被拦下的内容。** `install_bundle` 记录为 `plugin-install`；当规格是 profile 已有插件的某个注册表版本时，记录为 `plugin-update`；该工具不提供更新动作，所以 agent 以此方式请求更新。`remove_bundle` 记录为 `plugin-remove`。其他所有动作和工具继续交给下一个监听器。
- **记录的内容。** `@delorun/changes/install` 的 `recordPluginRequest` 在 profile 写锁之下，向 Host 所运行的 profile（`ctx.profileContext`）写入一个带 `subject.spec` 的待处理条目；当规格指明插件时，还带 `subject.plugin`。它不写入清单、锁文件、`node_modules` 或批准记录。仍在等待的请求保留其 id；对已决定请求的重复是一个新变更。
- **模型读到的内容。** 已记录的请求以错误码 `PLUGIN_CHANGE_PENDING` 和该变更的 id 被拒绝；更新时写 `Nothing was installed or updated.`，移除时写 `Nothing was removed.` 没有目标的调用、pnpm 不会接受的规格、移除并非依赖项的名称、没有 profile 的 Host，或无法写入的日志，都以 `PLUGIN_CHANGE_UNRECORDED` 及原因被拒绝，且不记录任何内容。拒绝就是该工具调用的已记录结果，所以不增加任何 session 事件。
- **由本人完成的内容。** `set_bundle`、`set_plugin`、`configure`、`set_version_exemption`、`undo` 和 `restore` 不会运行：模型读到的是该变更由本人在自己的电脑上、在 studio 中或用 `delorun plugin` 完成，错误码为 `PLUGIN_CHANGE_AT_COMPUTER`，且不记录任何内容。
- **守卫。** 若某个 `pre-execute` 监听器不调用 `next()` 就放行了这样的调用，会跳过本插件的监听器。本插件的工具守卫在所有监听器之后运行且无法被覆盖，在两种保护设置下，它都会拒绝其监听器未处理的每个这样的调用；保护关闭时监听器放行的调用算作已处理。
- **重新加载之前的检查。** `profileReconcileCheck.check(profile)` 为 Host 所运行的 profile 运行 `@delorun/changes` 的 `prepareReload`：在 profile 写锁允许时，指向某个文件夹的 `link:` 依赖会被移动到插件的活动目录；与「变更」所保存内容不同的链接或活动目录，会以 `LOAD_REFUSED` 拒绝这次重新组合，所以不会停止任何内容，也不会加载任何内容。当链接指向运行时存储，或指向 Host 已用来加载该包的目录（`loadedLinks`）时，它算作 harness 自己的链接。
- **studio 的路由。** web 服务器和 Connection 就绪后，[`src/routes.ts`](src/routes.ts) 注册 `GET /delorun/changes/state` 和 `show`，以及 `POST` 的 `apply`、`discard`、`undo`、`off`、`on`、`work`、`done`、`safe-mode`、`create`、`request` 和 `reveal`，harness 路由 `harness-apply`、`harness-undo`、`harness-discard` 和 `harness-copy`，`restart` 和 `restart-cancel`（[`src/restart-route.ts`](src/restart-route.ts)，与 `harness-apply` 同级别），以及 `protection-on`、`protection-off` 和 `notice-seen`，插件通过索引全局变量 `dshRecoveryRoutes` 向启动页告知它们的前缀。每个请求都先由 Connection 准入；任何已准入的会话都可读取，而 `POST` 在读取请求体之前按以下顺序决定。先看站点：另一个站点发来的浏览器请求以 `403 CROSS_SITE` 拒绝（在电脑上，依据 `Sec-Fetch-Site` 或不是该请求回环源的 `Origin`；来自已配对设备时，依据不是 `https://<Host>` 的 `Origin` 或外部的 `Sec-Fetch-Site`）。再看控件的级别（[`src/access.ts`](src/access.ts)）：电脑前的本人（回环 `Host`、凭据，以及 session Connection 的 `isReachPeer` 未指明的会话；没有 `isReachPeer` 的 Connection 没有路由）可以使用每个控件，由 `attestStudio` 证明；已配对设备只有在本人输入了解锁（从不是批准宽限期）、且手机权限级别允许时才可使用控件（撤销和丢弃插件的变更、丢弃对 Delorun 自身的变更以及打开保护在两个级别下都可以；除 `notice-seen` 外的其他控件只在 Full 下可以），由 `attestDevice` 证明。其他请求以 `403 LOOPBACK_REQUIRED` 拒绝，没有新解锁的设备以 `403 ELEVATION_REQUIRED` 拒绝。两种证明都记录为在 studio 中决定（[C21](../../docs/contracts/c21-changes.zh.md#who-may-do-what-from-where)、[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#phone-powers)）。在本人再次确认被标记的变更之前，`apply` 和 `done` 应答 `409 CONFIRM_RISK`；对 agent 插件请求的 `apply` 总是先应答 `409 CONFIRM_RISK` 并指明其规格（种类为 `dependency-or-build`，对安装或更新还有 `not-shown` 及规格，因为 pnpm 安装的内容都不会显示），确认之后用 Host 的插件操作（`@delorun/changes/plugin-operation` 的 `upstreamPluginOperation`，即 `delorun changes apply` 运行的操作）运行 `applyInstallChange`，从 profile 启动器的目录出发，带其安装锚点和 pnpm，输出写入 Host 的日志，并应答已应用的条目、Host 如何重新加载，对于文件夹规格还应答保存该文件夹内容的变更；对于来自 harness 日志的、对 Delorun 自身的变更，`apply`、`discard` 和 `undo` 以 `409 HARNESS_ROUTE` 拒绝，因为 harness 路由依据正在运行的运行时的签名文件列表来决定它，该列表由 home 进程作为 `changesHarness` 交给 Host（没有它的 Host，例如源码检出，应答 `409 HARNESS_UNAVAILABLE`）；`harness-apply` 接收 `show?pending` 列出的完整 `to` 版本，对其他版本应答 `409 CHANGED_SINCE_REVIEW`；操作通过 `reloadProfile` 在自己的进程内重新加载 Host。在请求带着 `confirmed: true` 重发之前，`protection-off` 应答 `409 CONFIRM_PROTECTION` 及 `willLoad {plugins, harnessFiles}`；这第二次询问只防误点，不能防御坐在电脑前的人。来自已配对设备的保护变更会写入一条通知，`state.notices` 把它显示给电脑，`notice-seen` 只在电脑上清除它。`state` 还给出 `access`（请求方、手机权限级别以及每个控件需要什么）、`harnessAvailable`、`unreviewedSinceOff` 和 `restart`。对 studio 构建出的客户端资源所作的已决定变更，通过位于 Connection 围栏之下的、精确匹配的 web 服务器路由立即提供，其他变更则等待 Restart，后者由 home 进程的 `changesRestart` 服务运行（[`src/live-apply.ts`](src/live-apply.ts)，[C21](../../docs/contracts/c21-changes.zh.md#live-changes-and-restart)）。`state` 只读取记录（`@delorun/changes` 的 `recordedChanges` 和 harness 的日志），不写入任何内容，也不读取任何插件的文件夹；对 Delorun 自身变更的 `show?id=` 从存储中审阅其两个版本；`show?pending` 读取文件夹并存储其内容。应答从不携带 Delorun home 的路径：措辞中含有该路径的拒绝，会应答其错误码和一句固定的话并记录原文，记录下来的失败把 home 写作 `<Delorun home>`。
- **线路格式。** [`src/wire.ts`](src/wire.ts) 存放路由的路径、拒绝码以及每个路由应答的 JSON 字段，且不导入任何内容；路由构造这些字段，浏览器一半读取它们，所以 Host 一旦不再发送某个字段，就会使 Host 的类型检查失败。启动时被遗漏的条目，携带该次启动记录的失败，作为 `leftOut`。
- **setup 路由。** `POST /delorun/changes/setup-export`、`setup-inspect` 与 `setup-apply`（[`src/setup-actions.ts`](src/setup-actions.ts)）通过 `@delorun/changes/setup-transfer` 把 profile 的 setup 写成已签名的文件、检查文件并规划其导入，以及应用已规划的导入（[合约 C21](../../docs/contracts/c21-changes.zh.md)、[C8](../../docs/contracts/c08-archive-and-trash.zh.md#the-setup-archive)）。它们只回答在电脑上发出的请求，到达与站点检查与动作相同，且发生在读取请求体之前。被检查的文件以随机的一次性令牌保存在内存中十分钟；`setup-apply` 接收令牌，而不是文件。超过 32 MiB 的文件请用命令迁移。
- **没有其他决定入口。** 除路由之外，插件不导入任何用于应用、丢弃或撤销变更、打开或结束工作会话或更改保护设置的函数；`delorun/packages/changes/tests/reach.spec.ts` 约束它这一点，并约束路由使用 `attestStudio`、`attestDevice`、`changeProtection` 和 harness 操作，而不使用 `attestTerminal`、`setProtection` 或 `discardAllHarnessChanges`。这些路由用 `applyInstallChange` 和 studio 的证明来应用 agent 的插件请求。

<a id="the-studios-changes-section"></a>

## studio 的「变更」部分

浏览器一半 [`src/client/index.ts`](src/client/index.ts)（`@delorun/plugin-changes/client`）随 `delorun-plugin-changes` 行加载，并注册：

- `settings.section` `delorun-changes`（[`ChangesSection.tsx`](src/client/ChangesSection.tsx)）：带「完成」的工作会话，或带「开始工作」的上次启动的插件；启动遗漏的变更，带「重新应用」和「撤销」；等待审阅的变更，每个都通过「审阅」（[`ChangeDetail.tsx`](src/client/ChangeDetail.tsx)）打开，带「应用」和「丢弃」；agent 的插件请求，带终端命令、「应用」和「丢弃」；最近的变更，带「撤销」；对 Delorun 自身的变更，带只读的「审阅」和决定每项的终端命令；以及保护设置 `on` 或 `off`，带 `delorun changes protection on|off`，没有控件；保护关闭时，介绍下方的一条说明指出变更无需审阅即加载，链接的插件每次保存都会实时重新加载。被检查标记的变更会要求第二次确认，由路由的 `409 CONFIRM_RISK` 触发并指明种类和 diff 不显示的文件，之后「应用」或「完成」才发送 `confirmedRisk`；对 agent 请求的「应用」先要求第一次确认，再要求路由对每个请求都要求的第二次确认，它会指明请求及其规格。`atComputer: false`，或某个操作被应答 `403 LOOPBACK_REQUIRED` 时，所有操作都被禁用，该部分显示「This needs you at your computer.」；
- `sidebar.footer.action` `delorun-changes.work-badge`（[`WorkBadge.tsx`](src/client/WorkBadge.tsx)），在工作会话持续期间显示插件名称，位于 Delorun 的撤销通知之后；
- 一个 `shell.overlay` toast（[`ChangesToast.tsx`](src/client/ChangesToast.tsx)），用于每个操作的结果。

[`controller.ts`](src/client/controller.ts) 负责每个请求以及两者读取的状态；它在加载时、每次操作之后以及页面可见期间每隔 `STATE_REFRESH_MS`（15 秒）读取 `state`。该部分在打开时、每次操作之后以及本人要求时通过 `show?pending` 读取文件夹，从不在 15 秒的读取中读取。文案位于带类型的英文和中文字典（[`locales.ts`](src/client/locales.ts)），命名空间为 `delorunChanges`。

**构建。** harness 一半像 Delorun 其他没有 studio 界面的插件那样从 `src/index.ts` 运行；`pnpm --filter @delorun/plugin-changes run build` 只用上游的客户端预设（[`tsdown.config.ts`](tsdown.config.ts)）写出浏览器一半 `lib/client.js`。编译面为 `tsconfig.host.json`（harness 一半及其规格）、`tsconfig.client.json`（浏览器一半）和 `tsconfig.tests.client.json`（其规格），位于解决方案 `tsconfig.json` 之下。

<a id="configuration"></a>

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | false | Delorun 的 C16 开关 `plugin_changes_pending`：保护开启时，agent 的插件变更等待本人处理。`@delorun/bundle-local` 在其 `delorun-plugin-changes` 行中以 `enabled: true` 挂载该插件；一致性叠加层把该行重述为禁用。 |
| `restartWaitSeconds` | 600 | studio 的 Restart 在让 Delorun 保持现状之前，等待运行中的对话的时长，单位为秒，取值 10 至 86,400。等待期间新回合被拒绝。 |
| `installationBundles` | `[]` | studio 安全模式持续加载的 bundle。`@delorun/bundle-local` 的行重述 Delorun 的 profile bundle 列表（本插件无法导入它），其 `plugin-changes-row.spec.ts` 约束二者相等。为空时，安全模式路由应答 `503 SAFE_MODE_UNAVAILABLE` 并指出 `delorun recover safe-mode`。 |

<a id="known-limitations"></a>

## 已知限制

- 配置中遗漏了 `delorun-plugin-changes` 行的 profile，在下次启动之前重新加载时没有该检查。

<a id="tests"></a>

## 测试

[`tests/plugin-changes.spec.ts`](tests/plugin-changes.spec.ts) 通过真实的工具管线运行上游的 `plugin_manager` 工具：保护开启时，安装、更新和移除各记录一个待处理变更，使 profile 的文件与原来逐字节相同，且从不到达审批；无法记录的调用被拒绝；先放行该调用的监听器被守卫覆盖；其他动作保持上游的审批；由本人完成的动作被拒绝；保护关闭（默认）时，每个这样的调用都到达上游的审批和管理器，守卫放行；无法读取的保护记录会拦下调用；在同一插件实例的两次调用之间切换该记录无需重启即切换行为；开关关闭时，安装和移除像上游那样请求工具的审批。[`tests/reload-check.spec.ts`](tests/reload-check.spec.ts) 带着插件管理器和热重载启动一个真实的 profile：被篡改的活动目录不加载任何内容；保护开启时，指明文件夹的恢复和另一个进程的 `link:<folder>` 安装都不加载任何内容，上游也不对没有已批准内容的插件求值任何内容；保护关闭时，这样的安装会加载该文件夹，记录为决定为 `unreviewed` 的已应用变更。[`tests/unrecorded.spec.ts`](tests/unrecorded.spec.ts) 覆盖不是 `Error` 的失败；[`tests/host-operation.spec.ts`](tests/host-operation.spec.ts) 覆盖 Host 的插件操作；[`tests/loaded-links.spec.ts`](tests/loaded-links.spec.ts) 覆盖 harness 链接规则。[`tests/routes.spec.ts`](tests/routes.spec.ts) 在回环端口上提供这些路由：没有凭据的调用方、远程会话和另一个站点都被拒绝且请求体不被读取，每个都在 2 秒内应答，没有路由更改保护设置，格式错误的请求被拒绝，没有任何应答含有 home 的路径；[`tests/routes-state.integration.spec.ts`](tests/routes-state.integration.spec.ts) 约束 `state` 不写入任何内容也不读取任何文件夹；[`tests/routes.integration.spec.ts`](tests/routes.integration.spec.ts) 在带有历史的真实 profile 上执行操作，包括被标记变更的第二次确认，并在保护开启时，经第二次确认后通过插件操作应用排队中的 agent 安装，同时拒绝远程会话和另一个站点；[`tests/restart-route.spec.ts`](tests/restart-route.spec.ts) 在每个手机权限级别上，把 Restart 约束在 `harness-apply` 的级别，`CROSS_SITE` 最先，并检查 `state` 的 `restart` 部分；[`tests/live-apply.spec.ts`](tests/live-apply.spec.ts) 只通过围栏提供实时资源，从不提供服务器文件，并在实时读取失败时保留先前的字节并把该变更排除在外；[`tests/routes-plugin.spec.ts`](tests/routes-plugin.spec.ts) 覆盖注册，以及没有 `isReachPeer` 时不注册。[`tests/changes-section.client.spec.tsx`](tests/changes-section.client.spec.tsx) 针对替代的 harness 渲染浏览器一半：状态的每个部分，带风险摘要、diff 不显示的文件和 diff 的审阅，被标记变更应用或批准之前的第二次确认，带两次确认的 agent 请求「应用」，保护关闭时带实时重新加载说明的保护设置，「撤销」，「重新应用」，「丢弃」，以及以恰好显示的那个版本进行的「开始工作」和「完成」，每个结果的 toast，能看到一切但不能执行任何操作的远程会话，以及工作会话持续期间出现、之后消失的工作会话徽章。
