---
description: "Multiview 插件，面向同时关注多个智能体的人，以及修改它的入口、设置和布局的维护者。"
kind: "package-library"
---

# @delorun/plugin-multiview

[English](README.md) | 中文

## 概述

Multiview 把固定的智能体（队友、子智能体、Claude Code 和 Codex）显示在主对话旁边，布局由本人安排。这个包包含把智能体放入 Multiview 的入口：头部智能体列表每一行上的固定按钮、头部带有布局菜单的 Multiview 按钮、在交接时固定并打开的观察器，以及设置。布局引擎在 `src/layout` 中，窄窗口用的分页器在 `src/phone` 中，各窗格在 `src/panes` 中，把它们绘制在主对话内容里的层在 `src/panel` 中。

## 目录

- [使用方式](#using-it)
- [窗格](#panes)
- [Layouts](#layouts)
- [Settings](#settings)
- [Keyboard](#keyboard)
- [配置](#configuration)
- [契约](#contract)
- [限制](#limits)
- [测试](#tests)

## 使用方式

- **从智能体列表固定。**“N subagents”列表的每一行都有一个固定按钮。已固定的智能体显示实心图钉，同一个按钮可取消固定。当达到窗格上限，或窗口已没有空间再放一个窗格时，未固定智能体的按钮会被禁用，它的提示和说明会给出原因。
- **弹出面板的页脚。**页脚显示“3 pinned · room for 3 more”，并提供“Pin running”（在上限允许的范围内，固定每个未固定的运行中智能体）和“Open Multiview”。没有智能体在运行，或每个运行中的智能体都已固定时，“Pin running”被禁用并说明原因。
- **Multiview 按钮。**对话头部在智能体列表之后显示一个 Multiview 按钮，带有已固定智能体的数量，当某个已固定的智能体正在等待本人批准时还带有一个琥珀色圆点。按一次会在主对话旁边打开每个已固定的智能体，再按一次则关闭。没有任何固定时，第一次按下会先固定每个运行中的智能体；没有固定也没有运行时，按钮被禁用并说明这一点。智能体自己的对话不显示该按钮。
- **布局菜单。**Multiview 显示期间，按钮旁的箭头会打开布局菜单：Main and column、Side by side、Grid、Main on top 和 Reset to default。预设会重新排列窗格，从不关闭任何一个。
- **交接。**当打开的对话把工作交给队友、子智能体、Claude Code 或 Codex 时，只要还有空闲窗格，新智能体就会自行固定并打开 Multiview。对话打开时已经存在的智能体不会被固定。本人做出的关闭优先于此：只要本人在某个对话中关闭了 Multiview 且此后没有再次打开它，交接仍会固定它的智能体，但会让 Multiview 保持关闭。以任何方式再次打开它（切换按钮、页脚的“Open Multiview”、聚焦命令）都会清除这一状态，于是下一次交接会像以前一样打开它。`autoOpen` 设置仍然决定交接是否打开 Multiview；把它打开并不会覆盖本人的手动关闭。
- **返回。**Multiview 的打开或关闭是按对话记录的，并且会被保留：打开过 Multiview 的对话，在本人回到它时会再次显示它，页面重新加载后也是如此，对其中一个智能体使用“Open full chat”之后也是如此。用按钮关闭 Multiview 会使它保持关闭，并且会阻止交接再次打开它。

## 窗格

Multiview 是 `conversation.main.body` Slot 中的一个层，该 Slot 包裹主 Conversation 在其头部之下的内容（记录和输入框）。Multiview 关闭时，该层原样渲染这些内容。打开时，该层在不变的头部（标题、模式、智能体列表和 Multiview 按钮）之下绘制窗格布局，主对话的窗格就是那些内容本身。智能体的窗格是真实的对话，由共享的 Conversation 内容以它的 `pane` 变体绘制，因此工具行、批准卡片和智能体的横幅看起来和用起来都与主视图中一样。窗格显示对话最新的部分，并跟随末尾。

- **头部。**依次是用来拖动窗格的把手、智能体的字母标识和名称、它的任务、状态徽章（`Working` 并显示运行开始后的时间，`Needs approval`，`Done` 并显示这次运行的时长；主对话在空闲时显示 `Ready`），然后是“Move to…”菜单（也可以与另一个窗格交换位置）、“Open full chat”、“Stop”（在对话运行且可以停止时）和“Close”。对于运行中的 Claude Code 或 Codex 智能体，一行标签会显示该程序的版本、套餐以及五小时和每周的用量；当 `@delorun/plugin-agent-seats` 提供 `agentSeat` 投影时从中读取，其他对话没有这一行。已完成的智能体会保留它的窗格并带有 Done 徽章，直到被关闭。对话在等待批准的窗格带有琥珀色的环。
- **回复框。**智能体的窗格显示单行回复框（编辑器和发送按钮）；`compactComposer` 关闭时显示完整的输入框。主对话的窗格始终显示完整的输入框。
- **Stop** 只停止那个对话。**Open full chat** 在主视图中打开该对话，因此原先拥有这个 Multiview 的对话不再显示在屏幕上。**Close** 会移除固定项和窗格，关闭最后一个窗格会回到普通对话。
- **引用。**只要窗格还在布局中，每个窗格就用 `multiviewPane` 引用来源保留它的对话；引用由层持有，而不是由布局持有，因此拖动窗格、因空间不足而隐藏它，或在手机上翻过它，都不会关闭它的对话。关闭 Multiview 会释放所有引用。窗口小到放不下所有固定项时，会绘制放得下的前几个窗格，并说明有多少个被隐藏；它们仍保持固定。
- **在手机上。**宽度低于 768 px 时，该层绘制来自 `src/phone` 的分页器，而不是布局：主对话是第一页，每个固定项按固定顺序依次排在后面。一页显示智能体的头部、对话、“Open full chat”和“Stop”按钮，以及回复框上方表示位置的圆点；这些圆点是对 `conversation.input.dock` 的贡献。

## 布局

每种布局只放置固定项所指名的窗格；没有一种会打开或关闭窗格。引擎是 [`src/layout/presets.ts`](src/layout/presets.ts)（各布局）、[`fit.ts`](src/layout/fit.ts)（最小窗格尺寸）、[`arrange.ts`](src/layout/arrange.ts)（对话显示什么）与 [`shape.ts`](src/layout/shape.ts)（Yours）。选择器（[`LayoutPicker.tsx`](src/layout/LayoutPicker.tsx)）是一个单选组，每种布局带一张缩略图和英文、中文名称，在智能体列表的页脚使用 `row` 变体，在对话框中使用 `grid` 变体。

| 布局 | 窗格 |
| --- | --- |
| Auto（默认） | 最多 `autoColumns` 个窗格（3 个）并排。从四个起：区域高于宽时用叠放的行（当一行会低于 `minPaneHeight` 时用标签页），区域的宽高比至少为 2.1 或宽度至少为 2560 px 时用 Centred main，否则用带网格堆叠的 Main and stack。 |
| Main and stack | 主对话位于 `mainSide`，在其他窗格旁边，其他窗格按行、列、网格或螺旋（`stackStyle`）叠放，比例为 `mainShare`（56 %，25 到 75）。拖动分隔条会改变该比例。保存为 `main-column` 的布局读作左侧带行的 Main and stack。 |
| Side by side、Stacked rows、Grid、Main on top | 列、行、按行填充的网格、主对话位于其他窗格一行之上。 |
| Spiral | 每个窗格把剩余空间减半，依次向右、向下、向左、向上转。Dwindle 被略去，因为它的缩略图读起来像 Spiral。 |
| Centred main | 主对话位于中间、约占 50 %，其他窗格交替位于右侧和左侧。 |
| Activity mosaic | 工作和等待中的窗格位于上方 72 % 的网格中，已完成的位于下方的一条带中。它在活动稳定 700 ms 之后变化，且绝不在本人忙碌时变化。 |
| Tabs | 每个窗格作为一个叶子的标签页；与头部的聚焦键无关。 |
| Yours | 本人的自有排列，保存为槽位形状（槽位 0 是主对话，然后按固定顺序，除非某次交换改变了它）而不是 chat id，因此它适用于任何 chat 的智能体。 |

- **最小窗格尺寸。** 在计入其周围 `paneGap` 空间之后，会比 `minPaneWidth` 更窄或比 `minPaneHeight` 更低的窗格，会作为标签页并入它最近的邻居，最小的先并入；没有窗格被隐藏。
- **Auto 何时重新排列。** 在固定或取消固定时立即进行，以及在区域调整大小稳定 200 ms 之后进行。不在指针按在布局中时进行，也不在窗格文本框中输入按键后的 1.5 秒内进行（[`src/panel/busy.ts`](src/panel/busy.ts)）；布局按键不算输入。
- **动态效果。** 布局变化只通过变换让每个窗格从旧位置滑到新位置，持续 240 ms，可中断（[`flip.ts`](src/layout/flip.ts)）。减少动态效果会关闭它，而 `mosaicMotion` 为 `reduced` 会为 mosaic 关闭它。
- **Yours。** 移动窗格（以及调整大小，除非 `saveOn` 为 `move`）会把该排列保存为 `rememberScope` 的 Yours，并使其成为默认值。一条 toast 会说 “Saved as your default layout · Undo”，并为那些作用域指名工作区或对话；Undo 会恢复先前的默认值和对话先前的排列。当 Host 拒绝写入时（已配对的设备无需解锁即可写入这些设置，但仅限电脑的开关或失败的请求仍会拒绝），对话保留该排列，默认值保持原样，toast 会说明这一点，且没有 Undo。Reset to Auto 会清除 studio 和该对话工作区中的 Yours 与默认值。在选择器中选择某个布局也会使它成为新 Multiview 的默认值；已经排列过的对话保留自己的排列，直到本人为它选择。

## 设置

“设置”中有一个 Multiview 页面（`settings.section` `delorun-multiview`，顺序 18，位于 Browser 之后），包含四个分组，每个选项配一句说明，默认布局配缩略图：**Layout**（`defaultLayout`、`mainSide`、`stackStyle`、`mainShare`、`autoColumns`、`mosaicMotion`）、**Your arrangement**（`rememberScope`、`saveOn` 与 Reset to Auto）、**Panes**（`maxPanes`、`minPaneWidth`、`minPaneHeight`、带数值的 `paneGap` 滑块、`compactComposer`）以及 **Behaviour**（`autoOpen`、`reopenOnReturn`、`keepChats`）。页面通过 `configForms` 写入，而 Plugins 页面的行表单编辑同样的字段。studio 与工作区的默认值是 Host 设置，因此 studio 的每台设备都共享它们；某个 chat 属于哪个工作区来自 `ctx.workspaces`。有值的最窄作用域胜出：先是 chat 自己的排列，然后是它所在工作区的，最后是 studio 的。

## 键盘

这些命令在 `ctx.shortcuts` 中注册且不带按键，因此本人在“设置”的“键盘”中为它们绑定：`multiview.layout.next` 与 `.previous`、`multiview.focus.left`、`.right`、`.up` 与 `.down`、`multiview.pane.swapMain` 以及 `multiview.main.grow` 与 `.shrink`（[`src/panel/keys.ts`](src/panel/keys.ts)）。它们作用于最近打开的 Multiview，在没有打开时直接放行。它们随附时未绑定，因为在许多键盘上这些移动的每个常规组合键都会在 AltGr 下输入一个字符，或在常见的窗口系统中切换桌面。焦点移动到该方向上最近的窗格；放大与缩小把主对话的比例改变 5 个点，或在 Yours 中改变主对话自身的大小。

## 配置

Host 行 `delorun-multiview` 有十八个易变字段（[`src/config.ts`](src/config.ts)），在配置加载时验证，工作室运行期间可以更改。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `autoOpen` | `true` | 新的交接是否打开 Multiview。为 `false` 时，智能体仍会自行固定，头部按钮显示数量和琥珀色圆点，但不会自动打开任何东西。把它打开并不会覆盖本人的手动关闭。 |
| `maxPanes` | `6` | 最多的窗格数，包含主对话（2 到 12）。 |
| `minPaneWidth` | `340` | 窗格的最小宽度，单位为 CSS 像素（240 到 1200）；较窄的窗口容纳的窗格更少。 |
| `minPaneHeight` | `240` | 窗格的最小高度，单位为 CSS 像素（160 到 1200）。 |
| `paneGap` | `0` | 窗格之间以及布局边缘周围的空间，单位为 CSS 像素（0 到 32），实时更改；最小窗格尺寸与分隔条的命中区域（至少 12 px，手指下为 24 px）仍然成立。 |
| `compactComposer` | `true` | 窗格是否显示单行的回复框。为 `false` 时每个窗格都显示完整的输入框。该层读取它。 |
| `reopenOnReturn` | `true` | 打开过 Multiview 的对话在返回时是否重新打开它。 |
| `keepChats` | `50` | 此浏览器中保留多少个对话的已固定智能体和布局（1 到 500）；多保存一个，就会忘掉保存时间最久的那个对话。 |
| `defaultLayout` | `auto` | 新 Multiview 采用的布局：上述布局之一，或 `yours`。 |
| `mainSide` | `left` | Main and stack 中主对话所在的一侧（`left` 或 `right`）。 |
| `stackStyle` | `rows` | Main and stack 如何放置其他窗格：`rows`、`columns`、`grid` 或 `spiral`。 |
| `mainShare` | `56` | 主对话所占的百分比（25 到 75）；拖动分隔条会设置它。 |
| `autoColumns` | `3` | Auto 在改变布局之前并排放几个窗格（1 到 6）。 |
| `mosaicMotion` | `on` | `reduced` 会关闭 mosaic 的滑动效果。 |
| `rememberScope` | `studio` | Yours 保存在哪里：`studio`、`workspace` 或 `chat`。 |
| `saveOn` | `move-or-resize` | 为 `move` 时，调整窗格大小会把该更改保留在该对话中。 |
| `yours` | `null` | 隐藏：studio 的 Yours 形状。 |
| `workspaceLayouts` | `{}` | 隐藏：按工作区 id，其 `defaultLayout`、`yours`、`mainSide` 与 `stackStyle`。 |

## 契约

- **Host 一半**（[`src/index.ts`](src/index.ts)）声明 `Config`，不挂载任何东西。设置服务把该行提供给浏览器。
- **浏览器一半**（[`src/client/index.ts`](src/client/index.ts)）需要 `slots`、`locale`、`sessions`、`configForms`、`uiWorkspace`、`workspaces` 和 `shortcuts`。它注册 `conversation.main.body` 中的层 `multiview`、Slot `multiview.pane.header` 和 `multiview.pane.body`、`conversation.input.dock` 中的圆点、词典 `delorunMultiview`、`delorunMultiviewPanes` 和 `delorunMultiviewLayouts`、Multiview 设置分区、`conversation.session.header.actions.subagent.row.trail` 中的固定按钮、`conversation.session.header.actions.subagent.footer` 中的页脚、`conversation.session.header.actions.subagent.end` 中的切换按钮，并提供 `ctx.multiview`。它注册命令 `multiview.toggle` 和各个布局按键，它们在每个 profile 上都未绑定，因为键盘设置的 Web 与 Desktop profile 之间不存在空闲且符合惯例的组合。
- **没有层时不起作用。**只有在 `conversation.main.body` 中注册了该层时才挂载这些入口。没有它，固定按钮、页脚、切换按钮、聚焦命令和交接观察器都不存在，因为“Open Multiview”什么也不会显示；`ctx.multiview` 仍然提供。层注册时入口出现，层移除时入口消失。
- **`ctx.multiview`**（`MultiviewService`）把每个对话的 `{ pins, layout, open, closedByPerson }` 作为可观察对象（`of(chat)`）保存，并提供操作 `pin`、`unpin`、`pinAll`、`open`、`close`、`closeByPerson`、`setLayout`、`applyPreset`、`resetLayout` 和 `reportArea`，以及布局操作 `defaultsOf`、`arrangementOf`、`layoutFor`、`chooseLayout`、`adoptArrangement`、`undoDefault`、`resetToAuto`、`setMainShare`、`setStackOptions`、`cycleLayout`、`swapWithMain` 和 `resizeMain`。固定项是哪些智能体拥有窗格的事实来源；布局只负责放置它们，并在每次变化时与固定项对齐。该层读取这个服务，并调用 `setLayout`、`unpin`、`close` 和 `reportArea`。
- **打开**会在对话的状态中设置打开标志并清除 `closedByPerson`；不会选中或导航到任何东西，该层会立即显示窗格。**关闭**有两条路径：`closeByPerson` 用于本人自己的关闭（切换按钮、页脚的按钮、聚焦命令），它会设置 `closedByPerson`；`close` 用于该层自身的原因（智能体目录被清空、`reopenOnReturn` 关闭），它不会改动该标志。交接观察器只在 `autoOpen` 开启且未设置 `closedByPerson` 时才打开。Slot `conversation.main.body` 由 `@deepseek-ai/dsh-client-ui-conversation` 声明，Delorun 台账列出了它（Multiview U3）。
- **交接观察器**订阅会话列表。主对话是保留为 `mainView` 的会话；它的智能体目录是它的 `subagentCatalog` 投影。对话成为主视图时，或它的投影第一次被读取时，目录中已有的智能体就是基线。之后的每个条目都是一次交接。另一个对话成为主视图会开始新的基线。
- **上限**把主对话计入：`maxPanes` 为 6 时，已固定的少于 5 个就还可以再固定一个智能体。窗口最多容纳 `floor(width / minPaneWidth) × floor(height / minPaneHeight)` 个窗格；在布局报告它自己的区域之前，使用窗口的大小。
- **持久化**（[`src/store/persist.ts`](src/store/persist.ts)）是已保存的每个对话状态的唯一所有者，这是 `localStorage` 中的客户端偏好：每个对话一个键（`dsh.multiview.v1.<host>.<chat>`），值为 `{ v: 2, pins, layout, open }`，并且自布局选择器起还有可选的 `arrangement`（该对话所遵循的布局，或 `custom`）、`slots` 和 `shape`（该对话自己的 Yours 副本），自手动关闭起还有可选的 `closedByPerson`；在这些字段之前保存的值会原样加载并保留其布局，版本 1 的记录读作未记录手动关闭的记录。读取时用 zod 验证。不是 JSON、未通过验证、窗格数多于最大的 `maxPanes`（12）、嵌套深度超过这样的布局所能达到的深度，或布局不一致的值，会被丢弃、移除并以警告报告，该对话从没有任何固定项开始。布局中可以有固定项未列出的窗格；存储会把两者对齐。第二个键（`dsh.multiview-index.v1.<host>`）按最近优先列出已保存的对话；保存超出 `keepChats` 的对话会移除最久未用的那些对话的键。阻止 `localStorage` 的浏览器的表现就像没有保存任何东西。没有任何内容到达模型请求，因此不写入会话事件。
- **文案**有英文和中文（[`src/entry/locales.ts`](src/entry/locales.ts)、[`src/panes/locales.ts`](src/panes/locales.ts) 和 [`src/layout/locales.ts`](src/layout/locales.ts)）；插件页面从 [`locale/`](locale/en.json) 为该行命名。

## 限制

- 智能体弹出面板提供页脚而不是头部，所以已固定的数量和“Pin running”位于页脚，在“Open Multiview”旁边。
- 固定是按对话进行的。对话的某个智能体所启动的智能体（嵌套行）会固定到顶层对话的 Multiview 中。
- `reopenOnReturn` 关闭时，打开过 Multiview 的对话会在本人离开它时被关闭，页面加载时发现它是打开的也会关闭。那次关闭是该层自己的，因此不会抑制交接。
- 手动关闭是按对话的，并一直持续到本人在该对话中再次打开 Multiview。它不是一项设置：`autoOpen` 决定交接是否打开 Multiview，而手动关闭决定它此刻在这个对话中是否打开。

## 测试

`tests/entry/` 用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry` 运行。它覆盖交接监视器、存储（固定项、上限、没有空间、布局、持久化调用）、`Config` 的默认值和范围、注册（新目录条目上自动固定而已有条目不固定、每次交接都自动打开、自动打开关闭、手动关闭会阻止交接打开且能经受重新加载、上限、返回时重新打开、来自外部的关闭）以及各组件（固定状态、禁用原因、页脚、切换按钮的按下状态、缺席、说明、琥珀色圆点和提示按键、布局选择器、右键与长按时的弹出面板、提示及其偏好）以及聚焦命令（列出时未绑定、切换与返回时保留固定项和布局、它的拒绝情形、它赋予切换按钮的按键）。

`tests/layout/tiling.spec.ts` 在 1440×900、3440×1440 和 900×1400 下以一到八个窗格运行每一种布局，覆盖最小窗格尺寸、Auto 的切换点、Main and stack、各种形状、键盘移动和循环切换。`tests/store/defaults.client.spec.ts` 覆盖作用域解析、跨对话的 Yours、撤销、Reset to Auto 以及仅移动规则。`tests/layout/browser/tiling-shots.mts` 在 1440 px 下以 2、3、5 和 7 个窗格拍摄每一种布局、选择器以及浅色和深色下的设置页面：`node --import tsx/esm delorun/packages/plugin-multiview/tests/layout/browser/tiling-shots.mts <directory>`。

`tests/store/` 覆盖持久化：往返、每一种丢弃情形、大小限制、裁剪到 `keepChats`，以及被阻止或已满的存储。`tests/entry/browser/shots.mts` 在标准颜色令牌之上构建一个带有真实固定按钮、页脚和头部按钮的页面，并在无头 Chromium 中以 1440 和 390 px 拍摄浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`。该页面的头部和智能体行代替上游的目录组件。

`tests/panes/` 覆盖状态和用量标签、窗格引用（保留一次、关闭时释放、卸载后不留任何引用）、头部（徽章状态、按钮、“Move to…”菜单）、主体变体、该层（每个固定项一个窗格、Stop 只作用于它自己的对话、Close、简洁与完整的输入框、等待时的环、手机分页器）以及手机上的圆点。

`tests/studio/shots.mts` 在不使用模型密钥的情况下，对已构建的工作室中的入口拍摄图片：它用 `delorun/apps/tools/src/demo-home.ts` 构建一个临时 home，添加一个手写的、列出两个智能体的对话，在端口 18843 上启动工作室，通过固定按钮固定这两个智能体，并在无头 Chromium 中以 1440 px 保存浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <directory> [--keep]`。请在 `pnpm run build:artifacts` 以及构建具有 `build` 脚本的 `delorun/packages` 之后运行。
