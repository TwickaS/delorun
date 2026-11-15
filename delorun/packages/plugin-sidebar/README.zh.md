---
description: "Delorun 的 chat 列表，供想了解侧栏显示什么以及如何更改的本人，以及修改其行、搁架、图案、工作区图标或设置的维护者阅读。"
kind: "package-library"
---

# @delorun/plugin-sidebar

[English](README.md) | 中文

## 摘要

Delorun studio 的 chat 列表，采用 T3 Code 侧栏的风格：chat 以卡片呈现，每张卡片右上角带状态；「运行中」「已暂缓」和「已搁置」搁架固定在底部；此外还有搜索、工作区筛选、工作区文件夹、Alt 跳转、悬停时的详情卡片、工作区图标、位于侧栏顶部之后的生成式或 T3 Code 页眉图案，以及在有更新的 Delorun 发布版本时出现的安静提示。本包在上游的侧栏席位中注册列表、图案、底部和设置的「侧栏」部分，所以上游的行、菜单和对话框继续工作。行、排序规则、搁架和图案移植自 T3 Tools 的 [T3 Code](https://github.com/pingdotgg/t3code)，采用 MIT 许可（[声明](THIRD_PARTY_NOTICES.md)）；数据来自 harness 的 Session 和 Workspace。`@delorun/bundle-studio` 以行 `delorun-sidebar` 挂载本包。它只在 Delorun 外观开启时加载；使用 stock 外观时，上游的列表、底部和「新建 Session」按钮会恢复。

## 目录

- [使用方式](#using-it)
- [约定](#contract)
- [配置](#configuration)
- [限制](#limits)
- [测试](#tests)

<a id="using-it"></a>

## 使用方式

- **卡片。** 置顶的 chat 排在最前，按置顶顺序排列，其余的按最近变更在前排列（或按设置，最近创建的在前）。卡片显示其工作区的徽标和名称、一个状态（带运行时间的「运行中」、「审批」、「提问」、「计划」、已完成但未读的运行为「完成」、暂缓结束为「已唤醒」）或 chat 的存在时长、chat 标题以及其模型的标记。运行中的 chat 和安静就绪的 chat 会淡化。
- **悬停与焦点。** 卡片的状态让位于「暂缓」「搁置」和一个「…」按钮；置顶的卡片显示「取消置顶」。让指针停留会打开一张详情卡片：工作区及其文件夹、模型和模式。「…」按钮、右键点击和菜单键（或 Shift+F10）会打开 chat 的菜单，其中包含所有插件的条目。双击或按 F2 重命名；按 Enter 打开。在没有悬停或指针精度较粗的屏幕上，状态保持显示，「…」按钮位于其旁，点击区域为 32px，与置顶和状态按钮相同；行在此不渲染「暂缓」和「搁置」，由 chat 的菜单提供它们。
- **搁架。** 「运行中」「已暂缓」和「已搁置」折叠在底部并显示其数量，每位查看者的折叠状态保存在浏览器中。已暂缓的 chat 显示剩余时间并提供「立即唤醒」；已搁置的 chat 提供「返回列表」。「已搁置」显示十个 chat，每次「显示更多」再增加二十五个。等待本人或正在运行的 chat 从不会出现在「已暂缓」或「已搁置」搁架上。
- **拖动**，在卡片视图中使用鼠标或手写笔：把卡片放到置顶项之间会在该处置顶它；把置顶的卡片放到分隔线下方会取消置顶；把卡片放到「已搁置」上会搁置它；把已搁置或已暂缓的行放到卡片之间会将其返回或唤醒。被拖动的行会说明放下后的效果，指针停在列表顶部或底部附近时列表会滚动，按 Escape 取消。置顶项保持被拖入的顺序，该顺序保存在浏览器中。移动不到六像素的按下是一次点击。触摸按下会滚动列表；每个放置操作也都可以通过行的按钮和菜单完成。
- **撤销。** 搁置、返回、暂缓、唤醒、置顶和取消置顶会在侧栏底部以一个小行的形式显示变更内容和「撤销」，持续六秒。它不获取焦点，也从不遮挡列表。
- **底部**是一行：一个「设置」按钮、作为图标按钮的全局面板（「插件」「自动化任务」「更多」）、撤销提示以及上游的其他底部操作。
- **更新提示。** 当 harness 的发布检查发现有更新的 Delorun 发布版本时，列表下方会出现一个带边框的小块：它给出该版本（「Delorun 0.1.3 is available」，当发布版本迁移到另一个上游版本时还带有「on DeepSeek Harness 0.3.0」）、更新的类型（安全修复，或补丁、次要或主要版本）、它会关闭本人多少个插件、位于「Release note:」标签之下的发布摘要（这样发布版本自己的文字就不会被误读为 studio 的指示；摘要为两行，点击可展开全文），以及要在终端中运行的命令 `delorun update`。它不应用任何内容。屏幕阅读器会播报标题以及类型和插件行；关闭按钮和摘要位于该播报之外。其关闭按钮会在此浏览器上对该发布版本隐藏它；更新的发布版本会再次显示。在由远程访问监听器提供的页面（即远程会话）上，它只显示文字、没有任何控件，并指出运行 Delorun 的电脑是运行该命令的地方。
- **搜索**同时匹配标题和工作区，然后通过上游的搜索匹配 chat 的消息；用方向键和 Enter 选择结果。按 Escape 清除查询并让键盘保留在输入框中；输入框为空时，Escape 留给页面处理，所以它会关闭手机宽度的抽屉，抽屉关闭后焦点返回到打开它的控件。输入框获得键盘时显示 studio 的焦点环。页眉较窄或指针较粗时，快捷键提示排在最前；标签为「Search」留出空间。
- **筛选、添加工作区和新建 chat**位于搜索框旁。筛选可保留一个或多个工作区，其子菜单可更改工作区的图标、重命名或移除它。
- **Alt 跳转。** 按住 Alt 会在前九个可见 chat 上显示 1 到 9；Alt 加数字打开对应的 chat，数字取自物理按键，所以 Alt 会输入其他字符的键盘布局仍可跳转。文本框或可编辑区域占用按键时不会发生任何事。
- **工作区图标。** 筛选中的「更改图标」会打开图标选择器：一到三个字母、36 个图标之一、一个 emoji（提供 32 个，也可输入任意 emoji）或由种子生成的图案（镜像的 5×5 网格），采用工作区自己的颜色、八种命名颜色之一或任意颜色，圆角、圆形、方形或六边形形状，以及柔和、实心或轮廓样式，并带有「Surprise me」和「Use initials」。所选图标会显示在工作区徽标出现的所有位置。
- **设置 → 侧栏**包含三个带标题的分组。**Header** 选择页眉图案（无、夜空、蓝图，或六种生成式场景之一：waves、aurora、contours、constellation、halftone、shards，每种都由种子绘制，Shuffle 会替换种子），以一排可通过滑动条横向滚动的图块呈现；以及它的调色板（Blueprint、Rose、Grove、Ocean、Ember、Iris 或 studio 的强调色）、强度（subtle、standard、vivid）、样式（位于顶部之后，或位于名称旁的药丸形）以及它渐隐进侧栏的方式（short、soft、long 或 none，以当前场景预览的图块呈现）。**Chat list** 选择列表的样式（卡片，或带单行行的工作区文件夹，折叠的文件夹上用圆点表示其中有待处理内容）、排序（最近变更或最近创建）、运行中的 chat 是否汇集到其搁架、取消置顶前是否询问，以及侧栏宽度（滑块范围 240 到 420 px，在 T3 Code 的 256 和上游的 280 处有刻痕）。强度、样式、列表样式和排序是单选组（来自 [`@delorun/settings-controls`](../settings-controls/README.zh.md) 的 `ChoiceGroup`）：所选分段是唯一的 Tab 停靠点，方向键移动选择。每个分组是同一个包的卡片：一个由其 `<h3>` 标题命名的 `<section>`，位于一个带边框的框之上。**Collapsed sidebar** 有 *Expand on hover*（开关，默认开启）和 *Hover delay*（滑块，0 到 1,500 ms，步长 50，默认 350，开关关闭时禁用）；更改立即生效。回到 stock 外观的途径只有设置 → 通用 → 外观。

<a id="contract"></a>

## 约定

- **stock 外观。** 客户端一半在 `apply` 之内注入 `delorunStudio`（`ctx.inject(['delorunStudio'], applyStudio)`），所以它的条目在 stock 外观下保持激活，这是上游的 web 启动对每个条目的要求。`@delorun/plugin-theme` 只在 Delorun 外观开启期间提供该服务，所以没有它时，插件不注册任何内容，也不更改任何布局。释放插件，或失去 `delorunStudio`，会移除所有注册，并恢复对 `ctx.sidebarLayout` 和 `ctx.layout` 所做的每项更改。
- **列表**用 [`src/client/Sidebar.tsx`](src/client/Sidebar.tsx) 填充上游的 `sidebar.workspaces.list` 插槽。插槽所有者的 props 向它提供 Session 列表、Workspace、打开和开始 chat、添加工作区的流程、重命名和删除对话框、消息搜索以及 `openSessionMenu`，所以每个 chat 的菜单就是带有所有插件条目的上游 Session 菜单。列表读取 `ctx.contextMenus.active`，使菜单已打开的那一行保持高亮。它挂载期间，`ctx.sidebarLayout.setNewSessionButton(false)` 从宽侧栏中去掉上游的「新建 Session」按钮，`setFootRow(true)` 把底部排成一行，`setPanelPlacement('footer')` 把全局面板（「插件」「自动化任务」「更多」）作为图标按钮移入该行，所以品牌标识直接位于列表页眉之上。`setHoverPeek` 把 `peekOnHover` 和 `peekDelayMs` 传给折叠导轨的悬停预览，并实时跟随变化。
- **排序**是纯函数，位于 [`src/client/sections.ts`](src/client/sections.ts)：等待本人或正在运行的 chat 从不出现在「已暂缓」或「已搁置」搁架上；否则，被搁置时间不早于其最新提示词的 chat 会出现在那里。子 agent、空白 chat 和已归档 chat 不计入。自动搁置在列表中根据 chat 状态推导，而不存储。
- **chat 状态**通过可选服务 `ctx.delorunChatStates` 来自 `@delorun/plugin-chat-states`，随其出现和消失而跟随。没有它时，列表没有「已暂缓」或「已搁置」搁架，也没有「暂缓」或「搁置」按钮。
- **拖动**是 [`src/client/drag.ts`](src/client/drag.ts)：窗口指针事件，用 `document.elementFromPoint` 找到指针下的行，使用 `sections.ts` 中 T3 Code 的放置规则，以及一个防止放置之后的点击打开该行的守卫。它不使用任何库。
- **更新提示。** [`update-notice.ts`](src/client/update-notice.ts) 在 studio 启动时、每次 `connection/reset` 时、窗口重新获得焦点或变为可见时，以及每隔 `updateNoticeRefreshMinutes`，读取 `GET api/delorunUpdateCheck.notice`（`@delorun/contract-update-report` 的 `UPDATE_NOTICE_PATH`，相对文档）；应答用 zod 按 `UpdateNoticeResponse` 校验，404（检查已关闭，所以路由未注册）、失败的请求或校验不通过的应答，都视为没有提示。只显示最新一次读取的应答。已关闭的版本是一项偏好设置，保存在本地存储的 `delorun:sidebar:update.dismissed` 中；存储拒绝时则仅在该页面内保持。[`UpdateNotice.tsx`](src/client/UpdateNotice.tsx) 渲染在列表滚动区域之下，所以从不遮挡或移动任何一行；其 `role="status"` 区域只包含标题以及类型和插件行，关闭和摘要按钮位于它之外；列表向它传入 `updateNotice`（`UpdateNoticeFace`），当 `ctx.connection.remoteMedia` 为 `placeholder` 时，其 `dismiss` 为 null。浏览器 bundle 从源码内联 `@delorun/contract-update-report`、`@delorun/contract-release-manifest` 和 `@delorun/settings-controls`，因为页面的模块表不提供它们。
- **底部。** [`FootLauncher.tsx`](src/client/FootLauncher.tsx) 以优先级 -2 填充上游的 `settings.launcher` 席位，覆盖上游的账户启动器，带一个 32px 的「设置」按钮。[`UndoNotice.tsx`](src/client/UndoNotice.tsx) 以顺序 -2 填充 `sidebar.footer.action`。列表和提示共用一条撤销线（[`undo.ts`](src/client/undo.ts)）。
- **图案**用 [`StageArt.tsx`](src/client/StageArt.tsx) 和 [`GenerativeArt.tsx`](src/client/GenerativeArt.tsx) 填充上游的 `sidebar.backdrop` 插槽。调色板的字面颜色在 [`art-palettes.css`](src/client/art-palettes.css) 中被命名为 `--delorun-art-<palette>-<role>` 自定义属性，值为 `light-dark()`，这是图案字面颜色唯一存在的位置；[`StageArt.module.css`](src/client/StageArt.module.css) 把调色板的名称映射到场景所绘制的颜色上，强调色调色板则把 `--dsw-alias-brand-primary` 与命名锚点混合。在侧栏顶部之后，整个图案保持可见，如同 T3 Code，上游的侧栏在其上以白色绘制品牌标识和切换按钮。图案在上游绘制它们所用的 id（`INK_EDGE_IDS`）下挂载边缘的 SVG 滤镜（`InkEdgeFilters`）：每个滤镜按 `INK_EDGE_RADIUS` 扩大墨迹的形状，并以墨迹自身不透明度的 `INK_EDGE_OPACITY` 倍，用静态的近黑色（`INK_EDGE_TOKEN`）填充扩出的部分，位于柔和的阴影（`INK_EDGE_SHADE`）之上，墨迹则绘制在最上层。相对于任何场景所绘制的每一种颜色之上的自身边缘，标题的对比度为 4.5:1，切换按钮为 3:1 或更高；实心底板或行下方的一条侧栏填充色带会遮住该设置所选的图案。设置中图块的品牌标识通过该部分在自己的 id 下挂载的滤镜绘制。药丸样式和无图案不挂载任何滤镜，并让标题留在侧栏上。生成式场景使用带种子的 mulberry32 随机源，以调色板的 `--stage-art-*` 颜色绘制。药丸样式会标记自身为 `data-backdrop-plain`，使品牌标识保持其颜色。
- **工作区图标**是已存储的数据。`workspaceIcons` 设置接受任何值，使一个有问题的图标不会妨碍行加载；列表在读取每个图标的位置校验它（[`readWorkspaceIcons`](src/workspace-icon.ts)），已存储图标格式错误的工作区（例如指名了选择器已不再提供的图标）显示其字母组合。该设置最多保存 `MAX_WORKSPACE_ICONS`（200）个条目：已存储值超过该数量的行，host 一半会拒绝加载并抛出 `RangeError`，因为 schema 本身不带 studio 无法重新水合的转换；保存图标会使它成为最新条目，并丢弃超出上限的最旧条目（`withWorkspaceIcon`），Workspace 列表加载完成后，列表会丢弃已不存在的工作区的图标（`pruneWorkspaceIcons`），列表仍在加载时则从不丢弃。图形是上游的 `Icon*Medium` 组件，在 [`WorkspaceBadge.tsx`](src/client/WorkspaceBadge.tsx) 中选择。
- **设置。** 只要 `ctx.layout.setSidebarWidths` 所属的服务存在，宽度就会传给它，拖动下限为 264 px，或在更窄时取该宽度。「侧栏」部分（[`SettingsSection.tsx`](src/client/SettingsSection.tsx)）的 id 为 `delorun-sidebar`，顺序 2，只在 Host 提供 `delorun-sidebar` 设置命名空间时才注册，通过 `ctx.configForms` 写入，写入失败时显示提示。harness 一半不向设置服务请求该命名空间的生成表单。该部分没有 stock 外观按钮。
- **样式。** 间距是 `--delorun-space-1` 到 `--delorun-space-9`，字号是 `--dsw-font-*`，圆角和颜色是 studio 的令牌，所以列表跟随主题；T3 Code 指定的长度（16px 状态图标、36px 瘦行、32px 底部按钮）是在每个样式表顶部声明一次的命名自定义属性，徽标的颜色在 [`badge-colors.css`](src/client/badge-colors.css) 中命名。文字使用主要或次要标签，字重不超过 500。仅悬停时的样式位于 `@media (hover: hover)` 之内，过渡和动画位于 `@media (prefers-reduced-motion: no-preference)` 之内；较粗的指针获得 32px 的点击区域。[`styles.spec.ts`](tests/styles.spec.ts) 在样式表文本上检查这些规则。
- **添加工作区的提议。** 列表挂载期间，`ctx.delorunSidebar`（`DelorunSidebar`）提供 `canAddWorkspace()` 和 `addWorkspace()`，由 `sidebar.workspaces.list` 的最新 `canAddWorkspace` 和 `addWorkspace` 所有者 props 支持；列表卸载或 Delorun 外观离开时，它被撤回。
- **导出。** `@delorun/plugin-sidebar/client` 导出 `apply`、`inject`、`NS`、`SECTION`、`LAUNCHER_PRIORITY`、`UNDO_NOTICE`、`DelorunSidebar`，品牌行的边缘（`InkEdgeFilters`、`INK_EDGE_IDS`、`INK_EDGE_OPACITY`、`INK_EDGE_RADIUS`、`INK_EDGE_SHADE`、`INK_EDGE_TOKEN`、`InkEdgePart`），行和列表的类型，`createUndoLine`，更新提示（`UpdateNoticeStore`、`UpdateNoticeResponseSchema`、`fetchUpdateNotice`、`DISMISSED_KEY`、`UpdateNoticeCard`），`useListDrag`，图案、徽标和选择器组件，`sections.ts` 和 `workspace-icon.ts` 的纯函数，以及辅助函数 `optionalSource`、`snoozeEnds` 和 `stateActions`。`@delorun/plugin-sidebar` 导出 `apply`、`Config`、`MAX_WORKSPACE_ICONS`、`UPDATE_NOTICE_REFRESH_MINUTES`、设置类型和图标 schema。
- **文案**有英文和中文（[`src/client/locales.ts`](src/client/locales.ts)）；「插件」页面的行名称来自 [`locale/`](locale/en.json)。

<a id="configuration"></a>

## 配置

行 `delorun-sidebar` 有十二个易变字段（[`src/config.ts`](src/config.ts)），在配置加载时校验，并可在 studio 运行时更改。设置 → 侧栏可编辑它们，只是 Shuffle 会替换 `artSeed`，图标选择器编辑 `workspaceIcons`，而 `updateNoticeRefreshMinutes` 只能在 `cordis.yml` 中设置。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `headerArt` | `blueprint` | `none`、`night`、`blueprint`、`waves`、`aurora`、`contours`、`constellation`、`halftone` 或 `shards`。 |
| `artPalette` | `accent` | `blueprint`、`rose`、`grove`、`ocean`、`ember`、`iris` 或 `accent`。 |
| `view` | `cards` | `cards`，或每个工作区一个文件夹的 `folders`。 |
| `workingShelf` | `true` | 运行中的 chat 是否汇集到「运行中」搁架。 |
| `artSeed` | `1` | 绘制生成式场景所用的种子（1 到 2,147,483,647）。 |
| `artStrength` | `standard` | `subtle`、`standard` 或 `vivid`。 |
| `artFade` | `soft` | `short`、`soft`（T3 Code 的）、`long` 或 `none`（边框颜色的一条细线）。 |
| `artStyle` | `artwork` | 位于侧栏顶部之后的 `artwork`，或位于品牌标识旁的 `pill`。 |
| `sort` | `updated` | `updated`（最近变更）或 `created`。 |
| `confirmUnpin` | `false` | 取消置顶前是否询问，无论通过按钮还是拖动。 |
| `width` | `256` | 侧栏宽度，单位为像素，240 到 420，步长 4。 |
| `peekOnHover` | `true` | 指针停留在折叠导轨上时，是否在页面之上显示完整侧栏。 |
| `peekDelayMs` | `350` | 指针停留在导轨上到侧栏展开之间的毫秒数，0 到 1500，步长 50。 |
| `workspaceIcons` | `{}` | 按工作区 id 保存的每个工作区的图标，最多 200 个，最旧的在前；读取时忽略无效条目。 |
| `updateNoticeRefreshMinutes` | `60` | studio 两次读取更新提示之间的分钟数，5 到 1440 的整数分钟。 |

<a id="limits"></a>

## 限制

- 置顶项的顺序是每个浏览器各自的：harness 自己不为置顶 chat 保存任何顺序，所以拖动出的顺序只在它被拖动的地方显示。
- 列表不显示工作区的 git 分支，底部也没有单元状态、用量或更新按钮，因为此 studio 中没有浏览器服务提供它们；更新提示给出命令而不应用任何内容。
- 拖动适用于鼠标或手写笔。触摸和键盘使用行的按钮和菜单完成同样的操作。
- T3 Code 的归档和删除确认不再重复：上游的归档提示提供「撤销」，删除工作区则总是会询问。
- 折叠的导轨保留上游的列表。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts packages/plugin-sidebar/` 运行这些规格；[`sidebar.spec.ts`](tests/sidebar.spec.ts) 导入上游已构建的包，所以需要 `pnpm run build:artifacts`。客户端规格将上游解析到其源码。

- [`sections.client.spec.ts`](tests/sections.client.spec.ts) 检查状态、淡化、列出哪些 chat、各部分和搁架（等待或运行中的 chat 从不被搁置）、搜索、筛选、徽标、文件夹、自动搁置，以及放置规则、动词和置顶项的顺序。
- [`workspace-icon.client.spec.tsx`](tests/workspace-icon.client.spec.tsx) 检查图标 schema、读取图标时格式错误的已存储图标被排除、随机图标、带种子的图案，以及已存储图标的上限和清理。
- [`title-contrast.client.spec.tsx`](tests/title-contrast.client.spec.tsx) 测量标题和切换按钮的白色墨迹（取自上游的浅色规则，并按该比例绘制在其边缘之上），对照该边缘合成到每种命名图案颜色和强调色混合（每种强度下）之上，以及侧栏填充之上，覆盖每个主题调色板和配色方案，并从源码导入主题的调色板生成器；当标题的对比度低于 4.5:1 或切换按钮低于 3:1、当某个边缘比能读清的最浅边缘重四个点以上、没有边缘，或切换按钮取标题的比例时，测试失败。它检查上游通过 `INK_EDGE_IDS` 绘制品牌标识和切换按钮的图标、滤镜的绘制、侧栏顶部之后的每种图案都在不带标记的情况下挂载它们，以及无图案和药丸样式不挂载任何滤镜。
- [`styles.spec.ts`](tests/styles.spec.ts) 读取样式表，检查字面颜色、字重、长度、悬停、动效、文字角色、粗指针的点击区域、搜索框的收窄和焦点环，以及使更新提示的「Release note:」标签与其他文字区分开的字重。
- [`sidebar.client.spec.tsx`](tests/sidebar.client.spec.tsx) 检查更新提示位于滚动区域之下、卡片和搁架、搁架的折叠状态被保留、带「撤销」的搁置、暂缓、唤醒和取消置顶、通过按钮、右键点击和菜单键打开的 chat 菜单、打开和重命名、没有 chat 状态时的列表、关闭「运行中」搁架、筛选和图标选择器、按标题和按消息搜索、搜索框中的 Escape（用键盘清除查询并保留键盘；输入框为空时 Escape 留给手机宽度的抽屉，抽屉关闭并将焦点返回给打开它的控件）、文件夹视图、Alt 跳转（输入时不触发）、每一种放置、触摸屏上的行、已移除工作区图标的清理，以及添加工作区的提议。
- [`drag.client.spec.tsx`](tests/drag.client.spec.tsx) 检查六像素阈值、放置目标、Escape 和取消、触摸和按钮的排除、点击守卫以及边缘滚动。
- [`icons.client.spec.tsx`](tests/icons.client.spec.tsx) 检查每种图标的徽标和选择器。
- [`art.client.spec.tsx`](tests/art.client.spec.tsx) 检查每种场景和调色板、带种子的场景以及药丸样式。
- [`settings-section.client.spec.tsx`](tests/settings-section.client.spec.tsx) 检查每项设置的写入、宽度滑块、「Collapsed sidebar」行（「Expand on hover」关闭时延迟被弱化并禁用）、滑动条、失败的写入、只读状态，以及图块的品牌标识通过该部分自己的边缘滤镜绘制在图案之上。
- [`update-notice.client.spec.tsx`](tests/update-notice.client.spec.tsx) 检查 `null`、404、失败的请求和每种无效应答都读作没有提示、提示的文字（针对安全修复、带基础迁移和摘要的次要版本，以及插件数量）、不含控件的实时区域、摘要的「Release note:」标签（英文和中文）、按发布版本关闭及其存储（包括拒绝写入的存储）、远程会话的提示不提供任何控件，以及在启动、重置、获得焦点、可见性变化和间隔时的读取、以最新应答为准和释放。
- [`plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) 检查各项注册及其移除、通过 studio 一半进行的更新提示读取、关闭和远程会话、没有 Delorun 外观时插件不注册任何内容也不更改任何布局、可选的 chat 状态服务、底部、`ctx.delorunSidebar`、已保存图标的上限，以及文案遵循术语表且每个英文键都有对应项。
- [`sidebar.spec.ts`](tests/sidebar.spec.ts) 检查 `Config` 的默认值和拒绝、按 studio 设置表单重建方式序列化再重新水合的 schema 仍能校验已存储的值、加载时 Workspace 图标的上限，以及 host 一半。
- `apps/web/tests/delorun-update-notice.e2e.ts` 构建 Delorun 的 studio 包，把一个固定的检查附加到 Host 的 `delorunUpdateCheck` 服务，使真实路由提供它的提示，跳过全新 profile 中遮住侧栏的引导对话框，并在 Chromium 中检查提示的文字和实时区域、其关闭按钮会隐藏它，以及远程会话的页面不显示关闭按钮。
