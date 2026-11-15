---
description: "chat 状态插件，供希望暂时让 chat 离开侧栏视线的本人，以及修改状态存放位置、由哪些路由提供状态、studio 一半使用哪些侧栏接缝的维护者阅读。"
kind: "package-bundle"
---

# @delorun/plugin-chat-states

[English](README.md) | 中文

## 摘要

本人可以把 chat 暂缓到稍后，或把已完成的 chat 搁置，它随即移到侧栏 chat 列表下方折叠的「已暂缓」或「已搁置」搁架。harness 把每个 chat 的状态保存在自己的存储中，位于 session 日志之外，所以模型永远看不到它，每个浏览器和手机显示的侧栏也相同。studio 一半注册这些搁架，在 chat 菜单中添加「暂缓」和「搁置」，添加悬停的搁置按钮，并在设置中编辑暂缓预设和自动搁置。暂缓预设和暂缓对话框移植自 T3 Tools 的 [T3 Code](https://github.com/pingdotgg/t3code)，采用 MIT 许可（[声明](THIRD_PARTY_NOTICES.md)）。`@delorun/bundle-studio` 以行 `delorun-chat-states` 挂载本包。

## 目录

- [使用方式](#using-it)
- [约定](#contract)
- [配置](#configuration)
- [限制](#limits)
- [测试](#tests)

<a id="using-it"></a>

## 使用方式

- **暂缓。** chat 的菜单提供「暂缓」，它会打开暂缓对话框。对话框把本人的预设列为快速选项，每个都显示 chat 回来的时间，今天已经过去的预设不会出现；然后是日期和时间，或以分钟、小时或天为单位的时长，并在暂缓之前显示 chat 回来的时间。已暂缓的 chat 提供「立即唤醒」。暂缓在到时间时结束，或在本人向该 chat 发送新消息时结束。因到时而结束暂缓的 chat 会被标记为已唤醒，直到本人打开它或关闭该标记。
- **搁置。** chat 的菜单和悬停按钮提供「搁置」，已搁置的 chat 提供「返回列表」。已搁置的 chat 可从其搁架正常打开，新消息会使它返回列表。
- **同一时间只在一个搁架。** 搁置会结束暂缓，暂缓会结束搁置。置顶的 chat 仍留在「置顶」下，正在运行或在等待本人的 chat 仍留在列表中，已归档的 chat 两个操作都不提供。
- **设置 → 侧栏 → 暂缓与闲置 chat。** 该部分是一个由其 `<h3>` 标题命名的 `<section>`，位于一个带边框的框之上；标题读取设置布局的 `--dsh-settings-card-heading-*` 变量。暂缓预设显示为芯片，措辞与暂缓菜单相同，最多八个。选择一个芯片会打开该类型的编辑器，然后是它的时长（一分钟到三十天）或它的日期和时间，以及移除它的操作，「添加」则开始一个新预设。「搁置闲置 chat」默认关闭；开启后，它按 3 个闲置日（1 到 90）计，之后 chat 算作已搁置，直到它发生变化或本人将其返回。
- **stock 外观。** studio 一半只在 Delorun 外观开启时生效。使用 stock 外观时，chat 在 harness 上保持其状态，并在没有搁架的 stock 侧栏中显示；切换回 Delorun 外观会恢复搁架。
- **没有 Delorun 的侧栏时**，搁架显示在上游的单列表视图中（Group by、In one list）；在工作区视图中，已暂缓或已搁置的 chat 仍留在其工作区。

<a id="contract"></a>

## 约定

- **harness 一半**（[`src/index.ts`](src/index.ts)）需要 `connection` 和 `storageDomain`，并在清理时读取 `sessionQuery`。它在存储域 `delorun_chat_states`（版本 1，表 `chats`，以 session id 为键）中保存每个 chat 的 `settledAt`，或 `snoozedAt` 和 `snoozedUntil`，以及 `wokeAt` 和 `keptAt`（本人最近一次将 chat 返回列表的时间），还有 chat 在 session 列表中缺失期间的 `missingSince`；并注册两条精确的 Connection Fetch 路由（[`src/wire.ts`](src/wire.ts)）。时间取自 harness 的时钟。harness 一半不依赖 Delorun 外观。
- **`GET /api/delorunChatStates.list`** 以 `{ chats }` 应答所有已搁置、已暂缓或已唤醒的 chat。因到时而结束的暂缓，在读取列表时变为 `wokeAt`，即它的结束时间。**`POST /api/delorunChatStates.set`** 接收对某个 session 的一次变更：`settle`、`unsettle`、`snooze`（带 `until`）、`wake` 或 `seen`（清除 `wokeAt`），并应答变更之后的状态。两种应答都是 `no-store`。
- **线路上的校验。** 请求体按 `ChatStateRequest` 解析（严格对象，session id 为 1 到 200 个来自 `A-Z a-z 0-9 . _ : -` 的字符，`until` 为正整数）。不是 JSON、指明未知动作、带有多余字段或 id 无效的请求体，以状态 400 和错误码 `invalid-request` 拒绝；结束时间不在现在到一年之后之间的暂缓，以 400 和 `snooze-out-of-range` 拒绝。被拒绝的请求不会存储任何内容。存储失败会连同原因记录日志，并以 500 和 `failed` 应答；应答携带一句固定的话，不含失败的任何文字。
- **已存储记录的校验。** 存储域接受表中任何已存储的值，插件每次读取一条记录时，都按 `ChatState`（由非负整数时间组成的严格对象）校验它。校验失败的记录不会出现在列表中，每个 chat 以校验信息记录一次日志，并由该 chat 的下一次变更替换。格式错误的记录不会妨碍插件启动或列表应答。
- **清理。** harness 一半在启动时清理，之后每隔 `pruneMinutes` 清理一次。清理把已存储的 chat 与 `ctx.sessionQuery.listSessions()` 返回的完整 session 列表比较。第一次发现已存储 chat 缺失的清理，会在其记录上记下 `missingSince`（已存储记录中经过校验的字段，路由从不发送它）；再次发现该 chat 的清理会清除它；chat 缺失达到 `@delorun/contract-archive-and-trash` 的 `TRASH_RETENTION_DAYS`（即被移入回收站的 chat 可恢复的时间）后，清理就会遗忘该记录。无效的记录不会被标记，而是留给上限处理。然后清理遗忘变更最旧的那些状态（取 `settledAt`、`snoozedAt`、`wokeAt` 和 `keptAt` 中最晚的一个；无效记录视为最旧），直到最多剩下 `maxRecords` 条。列表在变更队列之内读取，所以不会有变更落在读取列表时尚未包含的 chat 上。当 harness 没有 session 查询服务、读取列表失败（警告会说明原因）或列表为空（这与语料尚未加载无法区分）时，不会标记或遗忘缺失 chat 的任何内容；每种情形下都仍适用上限。
- **变更顺序。** harness 一半让每次读取和变更都在前一次之后运行，所以针对某个 chat 的并发请求，结果就如同它们依次发送。失败的变更不会阻止其后的变更。
- **studio 一半**（[`src/client/index.ts`](src/client/index.ts)）需要 `slots`、`locale`、`uiWorkspace`、`configForms`、`contextMenus`、`workspaces` 和 `connection`，并在 `ctx.inject(['delorunStudio'], applyStudio)` 之内注册所有内容。`delorunStudio` 是 `@delorun/plugin-theme` 在 Delorun 外观开启期间提供的服务，所以使用 stock 外观时，该条目保持激活（上游的 web 启动要求如此），但不注册任何内容，也不提供服务。它在启动时、按配置的间隔以及窗口重新获得焦点时读取状态。在有变更等待期间开始的读取，或在某个变更之后才开始的读取，其应答不会显示，而较早变更的应答也不会取代较晚变更的应答。读取失败时保留最后的状态。
- **搁架。** `ctx.uiWorkspace.registerShelf` 在单列表视图中添加「已暂缓」（`delorun-snoozed`，顺序 10）和「已搁置」（`delorun-settled`，顺序 20）。当 chat 最新的提示词比它被搁置的时间更新时，它就离开搁架。
- **chat 菜单条目。** 针对 `session` 目标向 `ctx.contextMenus` 贡献的两项数据：`delorun-chat-states.snooze`（顺序 350）和 `delorun-chat-states.settle`（顺序 360），位于 fork（300）与复制 session id（450）之间。每一项在状态、归档或语言变化时重新解析，对已归档的 chat 不提供任何内容，并在运行时再次读取状态。它们的图标在 `contextMenu.icon` 席位中注册。
- **悬停按钮。** `sidebar.workspaces.session.row.action` 中的 `delorun-settle`（顺序 50），位于归档（100）和置顶（200）之前。
- **覆盖层条目。** 暂缓对话框以及变更无法保存的提示是 `shell.overlay` 条目。保存失败（无论来自 chat 操作还是设置）是一个会自行消失的小提示。
- **连接播报。** [`ConnectionStatus.tsx`](src/client/ConnectionStatus.tsx) 是 `shell.overlay` 条目 `delorun-chat-states.connection`：一个覆盖在 `connection.state` 之上、视觉上隐藏的礼貌型实时区域（`role="status"`），它播报「Lost the connection to Delorun. Reconnecting.」、设备已离线，以及在两者之后播报「Connected to Delorun again.」，首次连接时不播报任何内容。上游侧栏底部的连接指示器是一个按钮而不是实时区域，所以屏幕阅读器否则要等到本人移动到它才会听到变化。在侧栏包拥有连接依赖之前，该区域与 studio 其他的 Delorun 外观覆盖层条目一同放在这里。
- **设置部分。** `settings.section`，id 为 `delorun-chat-states`，顺序 3，位于「侧栏」部分之后。设置编辑器的类型和单位，以及暂缓对话框选择结束时间的方式及其单位，都是单选组（来自 [`@delorun/settings-controls`](../settings-controls/README.zh.md) 的 `ChoiceGroup`，浏览器 bundle 从其源码内联它），该部分是它的卡片之一。只有 Host 提供 `delorun-chat-states` 设置命名空间时它才注册，并通过 `ctx.configForms` 写入。harness 一半不向设置服务请求该命名空间的生成表单。
- **`ctx.delorunChatStates`**（类型 `DelorunChatStates`，从 `@delorun/plugin-chat-states/client` 导出）以可观察对象的形式共享 `states`、`snoozed`、`settled`、`woke`、`kept` 和 `autoSettleDays`，以及 `change(request)`、`snoozeOptions()`、`snoozeLeft(until)` 和 `openCustom(sessionId)`。绘制自己搁架的侧栏把它作为可选服务读取。自动搁置由该侧栏推导而不存储：自 chat 最近一次变更或其 `keptAt` 起经过 `autoSettleDays` 之后，chat 算作已搁置。
- **暂缓规则**是纯函数，可在浏览器中安全使用，位于 [`src/snooze.ts`](src/snooze.ts)，每个函数都接收它所读取的时钟；其措辞来自字典和浏览器的 `Intl` 格式，位于 [`src/client/snooze-text.ts`](src/client/snooze-text.ts)。
- **文案**有英文和中文（[`src/client/locales.ts`](src/client/locales.ts)）；「插件」页面的行名称来自 [`locale/`](locale/en.json)。CSS 只使用主题令牌：颜色、字体和圆角用 `--dsw-*`，间距用 `@delorun/plugin-theme` 的 `--delorun-space-*`，后者只在 Delorun 外观开启时存在，studio 一半同样如此。

<a id="configuration"></a>

## 配置

行 `delorun-chat-states` 有五个易变字段（[`src/config.ts`](src/config.ts)），在配置加载时校验，并可在 studio 运行时更改。studio 的「暂缓与闲置 chat」部分编辑前两个；后两个限制 harness 的存储。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `snoozePresets` | T3 Code 的五个：1 小时后、3 小时后、当天 18:00、次日 09:00、周一 09:00 | 一到八个预设，每个为 `{ kind: after, minutes }`（1 到 43,200）或 `{ kind: at, day, time }`，其中 day 取自 `today` 到 `sunday`，time 为 `HH:MM`。 |
| `autoSettleDays` | `0` | 闲置天数（0 到 90），之后 chat 算作已搁置，直到它发生变化或被返回；0 表示关闭。 |
| `refreshSeconds` | `30` | studio 两次读取状态之间等待的秒数（5 到 3600）。 |
| `maxRecords` | `2000` | harness 保存其状态的 chat 数量（100 到 100,000）；超出之后，变更最旧的状态被遗忘。 |
| `pruneMinutes` | `60` | 两次清理之间的分钟数（1 到 1440）。 |

最长的暂缓为一年，这是路由的限制，而不是设置。

<a id="limits"></a>

## 限制

- 在工作区视图中，studio 不为已暂缓或已搁置的 chat 显示任何标记。
- 被移入回收站的 chat，其状态一直保留并带有 `missingSince` 标记，直到该 chat 缺失达到回收站保留期（30 天）；在此之前恢复的 chat 保留其状态。之后该状态被遗忘，通过其他方式恢复的 chat 会回到列表。因任何其他原因缺失的 chat，处理方式相同。
- `maxRecords` 可能会遗忘仍在保留期内的 chat 的状态，变更最旧的先遗忘。
- harness 在下次读取列表时记录一次唤醒；已打开的 studio 则按自己的时钟在暂缓结束时显示唤醒。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-chat-states` 运行这些规格；harness 规格导入上游已构建的包，所以需要 `pnpm run build:artifacts`。

- [`chat-states.spec.ts`](tests/chat-states.spec.ts) 检查清理（缺失的 chat 被标记并保留、返回时标记被清除、状态仅在保留期之后遗忘且在保留期内恢复时完整无损、列表读取失败、为空或缺失时不作任何更改、上限先遗忘最旧的、周期性清理直到释放）、变更（搁置、返回、暂缓、唤醒、已查看、同一时间只在一个搁架、已结束的暂缓变为唤醒）、对现在、过去或一年之后结束的暂缓的拒绝、并发变更的顺序、路由（应答、不缓存、带错误码和状态的拒绝、不含其文字的存储失败应答、随插件一同关闭）以及设置限制。拒绝测试：每个格式错误的请求体都被拒绝且不存储任何内容；每条格式错误的已存储记录（无论在内存中，还是在真实 JSON 存储下的文件中）都被排除在列表之外，只记录一次日志，由下一次变更替换，且不会使列表或启动停止。
- [`api.client.spec.tsx`](tests/api.client.spec.tsx) 检查 studio 的调用，以及与文档规定的消息不符的应答被拒绝。
- [`store.client.spec.tsx`](tests/store.client.spec.tsx) 检查搁架的成员、暂缓结束时的唤醒、按间隔和获得焦点时的读取、间隔的重新计时、失败的读取、失败变更的提示，以及乱序到达的应答。
- [`actions.client.spec.tsx`](tests/actions.client.spec.tsx) 检查悬停按钮、失败提示，以及暂缓对话框的快速选项、日期和时长、拒绝和键盘提交。
- [`connection.client.spec.tsx`](tests/connection.client.spec.tsx) 检查连接播报是在任何内容被播报之前就已存在的礼貌型实时区域、连接状态的每次变化播报什么，以及首次连接不播报任何内容。
- [`settings.client.spec.tsx`](tests/settings.client.spec.tsx) 检查预设芯片及其编辑器、自动搁置、被拒绝或失败的保存，以及只读状态。
- [`plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) 检查各项注册及其移除、没有 Delorun 外观时插件不注册任何内容、菜单条目及其发送的内容，以及 `ctx.delorunChatStates`。
- [`snooze.client.spec.tsx`](tests/snooze.client.spec.tsx) 检查预设、它们在各个工作日和已过去时间下的标签与时间、选择、剩余时间、自定义暂缓及其拒绝，以及措辞。
