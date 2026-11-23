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
- **交接。**当打开的对话把工作交给队友、子智能体、Claude Code 或 Codex 时，只要还有空闲窗格，新智能体就会自行固定并打开 Multiview，每次都是如此，包括本人关闭它之后。对话打开时已经存在的智能体不会被固定。
- **返回。**Multiview 的打开或关闭是按对话记录的，并且会被保留：打开过 Multiview 的对话，在本人回到它时会再次显示它，页面重新加载后也是如此，对其中一个智能体使用“Open full chat”之后也是如此。用按钮关闭 Multiview 会使它保持关闭。

## 窗格

Multiview 是 `conversation.main.body` Slot 中的一个层，该 Slot 包裹主 Conversation 在其头部之下的内容（记录和输入框）。Multiview 关闭时，该层原样渲染这些内容。打开时，该层在不变的头部（标题、模式、智能体列表和 Multiview 按钮）之下绘制窗格布局，主对话的窗格就是那些内容本身。智能体的窗格是真实的对话，由共享的 Conversation 内容以它的 `pane` 变体绘制，因此工具行、批准卡片和智能体的横幅看起来和用起来都与主视图中一样。窗格显示对话最新的部分，并跟随末尾。

- **头部。**依次是用来拖动窗格的把手、智能体的字母标识和名称、它的任务、状态徽章（`Working` 并显示运行开始后的时间，`Needs approval`，`Done` 并显示这次运行的时长；主对话在空闲时显示 `Ready`），然后是“Move to…”菜单（也可以与另一个窗格交换位置）、“Open full chat”、“Stop”（在对话运行且可以停止时）和“Close”。对于运行中的 Claude Code 或 Codex 智能体，一行标签会显示该程序的版本、套餐以及五小时和每周的用量；当 `@delorun/plugin-agent-seats` 提供 `agentSeat` 投影时从中读取，其他对话没有这一行。已完成的智能体会保留它的窗格并带有 Done 徽章，直到被关闭。对话在等待批准的窗格带有琥珀色的环。
- **回复框。**智能体的窗格显示单行回复框（编辑器和发送按钮）；`compactComposer` 关闭时显示完整的输入框。主对话的窗格始终显示完整的输入框。
- **Stop** 只停止那个对话。**Open full chat** 在主视图中打开该对话，因此原先拥有这个 Multiview 的对话不再显示在屏幕上。**Close** 会移除固定项和窗格，关闭最后一个窗格会回到普通对话。
- **引用。**只要窗格还在布局中，每个窗格就用 `multiviewPane` 引用来源保留它的对话；引用由层持有，而不是由布局持有，因此拖动窗格、因空间不足而隐藏它，或在手机上翻过它，都不会关闭它的对话。关闭 Multiview 会释放所有引用。窗口小到放不下所有固定项时，会绘制放得下的前几个窗格，并说明有多少个被隐藏；它们仍保持固定。
- **在手机上。**宽度低于 768 px 时，该层绘制来自 `src/phone` 的分页器，而不是布局：主对话是第一页，每个固定项按固定顺序依次排在后面。一页显示智能体的头部、对话、“Open full chat”和“Stop”按钮，以及回复框上方表示位置的圆点；这些圆点是对 `conversation.input.dock` 的贡献。

## Layouts

Every layout only places the panes the pins name; none opens or closes one. The engine is [`src/layout/presets.ts`](src/layout/presets.ts) (the layouts), [`fit.ts`](src/layout/fit.ts) (the least pane size), [`arrange.ts`](src/layout/arrange.ts) (what a chat shows) and [`shape.ts`](src/layout/shape.ts) (Yours). The picker ([`LayoutPicker.tsx`](src/layout/LayoutPicker.tsx)) is a radio group with a thumbnail and an English and Chinese name per layout, in a `row` variant for the agents list's footer and a `grid` variant for a dialog.

| Layout | Panes |
| --- | --- |
| Auto (the default) | Up to `autoColumns` panes (3) side by side. From four: stacked rows when the area is taller than wide (tabs when a row would be lower than `minPaneHeight`), Centred main when the area's aspect is at least 2.1 or it is at least 2560 px wide, and Main and stack with a grid stack otherwise. |
| Main and stack | The main chat on the `mainSide` beside the others, stacked as rows, columns, a grid or a spiral (`stackStyle`), at the `mainShare` (56 %, 25 to 75). Dragging the divider changes the share. A layout saved as `main-column` reads as Main and stack on the left with rows. |
| Side by side, Stacked rows, Grid, Main on top | Columns, rows, a grid that fills by rows, the main chat over a row of the others. |
| Spiral | Each pane halves the space left, turning right, down, left and up. Dwindle is left out because its thumbnail reads like Spiral. |
| Centred main | The main chat in the middle at about 50 %, the others alternately right and left. |
| Activity mosaic | Working and waiting panes in a grid over the top 72 %, finished ones in a strip below. It changes 700 ms after the activity settles and never while the person is busy. |
| Tabs | Every pane as a tab of one leaf; unrelated to the header's focus key. |
| Yours | The person's own arrangement, kept as a shape of slots (slot 0 the main chat, then pin order, unless a swap changed it) rather than chat ids, so it applies to any chat's agents. |

- **The least pane size.** A pane that would be narrower than `minPaneWidth` or lower than `minPaneHeight`, after the `paneGap` space around it, joins its nearest neighbour as a tab, the smallest first; no pane is hidden.
- **When Auto rearranges.** On a pin or unpin at once, and on a resize of the area 200 ms after it settles. Not while the pointer is down in the layout or within 1.5 s of a key typed in a pane's text field ([`src/panel/busy.ts`](src/panel/busy.ts)); the layout keys are not typing.
- **Motion.** A layout change glides each pane from its old to its new place by a transform only, for 240 ms, interruptible ([`flip.ts`](src/layout/flip.ts)). Reduced motion turns it off, and `mosaicMotion` `reduced` turns it off for the mosaic.
- **Yours.** Moving a pane (and resizing, unless `saveOn` is `move`) saves the arrangement as Yours for the `rememberScope` and makes it the default. A toast says "Saved as your default layout · Undo", naming the workspace or the chat for those scopes; Undo restores the previous default and the chat's previous arrangement. When the Host refuses the write (an approved device writes these settings without an unlock, but a computer-only switch or a failed request still refuses), the chat keeps the arrangement, the default stays as it was and the toast says so, without Undo. Reset to Auto clears Yours and the default at the studio and in the chat's workspace. Choosing a layout in the picker also makes it the default for new Multiviews; a chat already arranged keeps its own until the person chooses for it.

## Settings

Settings has a Multiview page (`settings.section` `delorun-multiview`, order 18, after Browser) with four groups, each option with one sentence and the default layout with thumbnails: **Layout** (`defaultLayout`, `mainSide`, `stackStyle`, `mainShare`, `autoColumns`, `mosaicMotion`), **Your arrangement** (`rememberScope`, `saveOn`, and Reset to Auto), **Panes** (`maxPanes`, `minPaneWidth`, `minPaneHeight`, `paneGap` as a slider with its number, `compactComposer`) and **Behaviour** (`autoOpen`, `reopenOnReturn`, `keepChats`). The page writes through `configForms`, and the Plugins page's row form edits the same fields. The studio and workspace defaults are Host settings, so every device of the studio shares them; which workspace a chat belongs to comes from `ctx.workspaces`. The narrowest scope that has a value wins: the chat's own arrangement, then its workspace's, then the studio's.

## Keyboard

The commands register in `ctx.shortcuts` with no keys, so the person binds them in Settings, Keyboard: `multiview.layout.next` and `.previous`, `multiview.focus.left`, `.right`, `.up` and `.down`, `multiview.pane.swapMain` and `multiview.main.grow` and `.shrink` ([`src/panel/keys.ts`](src/panel/keys.ts)). They act on the most recently opened Multiview and pass when none is open. They ship unbound because every conventional chord for these moves types a character with AltGr on many keyboards or switches desktops in common window systems. Focus moves to the nearest pane in that direction; grow and shrink change the main share by 5 points, or the main chat's own size in Yours.

## 配置

Host 行 `delorun-multiview` 有七个易变字段（[`src/config.ts`](src/config.ts)），在配置加载时验证，工作室运行期间可以更改。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `autoOpen` | `true` | 新的交接是否打开 Multiview。为 `false` 时，智能体仍会自行固定，头部按钮显示数量和琥珀色圆点，但不会自动打开任何东西。 |
| `maxPanes` | `6` | 最多的窗格数，包含主对话（2 到 12）。 |
| `minPaneWidth` | `340` | 窗格的最小宽度，单位为 CSS 像素（240 到 1200）；较窄的窗口容纳的窗格更少。 |
| `minPaneHeight` | `240` | 窗格的最小高度，单位为 CSS 像素（160 到 1200）。 |
| `paneGap` | `0` | The space between panes and around the layout's edge in CSS pixels (0 to 32), changed live; the least pane size and the divider hit areas (at least 12 px, 24 px under a finger) still hold. |
| `compactComposer` | `true` | 窗格是否显示单行的回复框。为 `false` 时每个窗格都显示完整的输入框。该层读取它。 |
| `reopenOnReturn` | `true` | 打开过 Multiview 的对话在返回时是否重新打开它。 |
| `keepChats` | `50` | 此浏览器中保留多少个对话的已固定智能体和布局（1 到 500）；多保存一个，就会忘掉保存时间最久的那个对话。 |
| `defaultLayout` | `auto` | The layout a new Multiview takes: one of the layouts above, or `yours`. |
| `mainSide` | `left` | Main and stack's side for the main chat (`left` or `right`). |
| `stackStyle` | `rows` | How Main and stack places the others: `rows`, `columns`, `grid` or `spiral`. |
| `mainShare` | `56` | The main chat's share in percent (25 to 75); dragging the divider sets it. |
| `autoColumns` | `3` | How many panes Auto puts side by side before it changes layout (1 to 6). |
| `mosaicMotion` | `on` | `reduced` turns off the mosaic's glide. |
| `rememberScope` | `studio` | Where Yours is saved: `studio`, `workspace` or `chat`. |
| `saveOn` | `move-or-resize` | With `move`, resizing a pane keeps the change with that chat. |
| `yours` | `null` | Hidden: the studio's Yours shape. |
| `workspaceLayouts` | `{}` | Hidden: per workspace id, its `defaultLayout`, `yours`, `mainSide` and `stackStyle`. |

## 契约

- **Host 一半**（[`src/index.ts`](src/index.ts)）声明 `Config`，不挂载任何东西。设置服务把该行提供给浏览器。
- **浏览器一半**（[`src/client/index.ts`](src/client/index.ts)）需要 `slots`、`locale`、`sessions`、`configForms` 和 `uiWorkspace`。它注册 `conversation.main.body` 中的层 `multiview`、Slot `multiview.pane.header` 和 `multiview.pane.body`、`conversation.input.dock` 中的圆点、词典 `delorunMultiview` 和 `delorunMultiviewPanes`、`conversation.session.header.actions.subagent.row.trail` 中的固定按钮、`conversation.session.header.actions.subagent.footer` 中的页脚、`conversation.session.header.actions` 中的 Multiview 按钮（顺序 11，位于顺序 10 的智能体列表之后），并提供 `ctx.multiview`。
- **没有层时不起作用。**只有在 `conversation.main.body` 中注册了该层时才挂载这些入口。没有它，固定按钮、页脚、头部按钮和交接观察器都不存在，因为“Open Multiview”什么也不会显示；`ctx.multiview` 仍然提供。层注册时入口出现，层移除时入口消失。
- **`ctx.multiview`**（`MultiviewService`）把每个对话的 `{ pins, layout, open }` 作为可观察对象（`of(chat)`）保存，并提供操作 `pin`、`unpin`、`pinAll`、`open`、`close`、`setLayout`、`applyPreset`、`resetLayout` 和 `reportArea`。固定项是哪些智能体拥有窗格的事实来源；布局只负责放置它们，并在每次变化时与固定项对齐。该层读取这个服务，并调用 `setLayout`、`unpin`、`close` 和 `reportArea`。
- **打开**会在对话的状态中设置打开标志；不会选中或导航到任何东西，该层会立即显示窗格。Slot `conversation.main.body` 由 `@deepseek-ai/dsh-client-ui-conversation` 声明，Delorun 台账列出了它（Multiview U3）。
- **交接观察器**订阅会话列表。主对话是保留为 `mainView` 的会话；它的智能体目录是它的 `subagentCatalog` 投影。对话成为主视图时，或它的投影第一次被读取时，目录中已有的智能体就是基线。之后的每个条目都是一次交接。另一个对话成为主视图会开始新的基线。
- **上限**把主对话计入：`maxPanes` 为 6 时，已固定的少于 5 个就还可以再固定一个智能体。窗口最多容纳 `floor(width / minPaneWidth) × floor(height / minPaneHeight)` 个窗格；在布局报告它自己的区域之前，使用窗口的大小。
- **持久化**（[`src/store/persist.ts`](src/store/persist.ts)）是已保存的每个对话状态的唯一所有者，这是 `localStorage` 中的客户端偏好：每个对话一个键（`dsh.multiview.v1.<host>.<chat>`），值为 `{ v: 1, pins, layout, open }`，读取时用 zod 验证。不是 JSON、未通过验证、窗格数多于最大的 `maxPanes`（12）、嵌套深度超过这样的布局所能达到的深度，或布局不一致的值，会被丢弃、移除并以警告报告，该对话从没有任何固定项开始。布局中可以有固定项未列出的窗格；存储会把两者对齐。第二个键（`dsh.multiview-index.v1.<host>`）按最近优先列出已保存的对话；保存超出 `keepChats` 的对话会移除最久未用的那些对话的键。阻止 `localStorage` 的浏览器的表现就像没有保存任何东西。没有任何内容到达模型请求，因此不写入会话事件。
- **文案**有英文和中文（[`src/entry/locales.ts`](src/entry/locales.ts)、[`src/panes/locales.ts`](src/panes/locales.ts) 和 [`src/layout/locales.ts`](src/layout/locales.ts)）；插件页面从 [`locale/`](locale/en.json) 为该行命名。

## 限制

- 智能体弹出面板提供页脚而不是头部，所以已固定的数量和“Pin running”位于页脚，在“Open Multiview”旁边。
- 固定是按对话进行的。对话的某个智能体所启动的智能体（嵌套行）会固定到顶层对话的 Multiview 中。
- `reopenOnReturn` 关闭时，打开过 Multiview 的对话会在本人离开它时被关闭，页面加载时发现它是打开的也会关闭。

## 测试

`tests/entry/` 用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry` 运行。它覆盖交接监视器、存储（固定项、上限、没有空间、布局、持久化调用）、`Config` 的默认值和范围、注册（新目录条目上自动固定而已有条目不固定、每次自动打开、自动打开关闭、上限、返回时重新打开、来自外部的关闭）以及各组件（固定状态、禁用原因、页脚、数量和琥珀色圆点、布局菜单）。

`tests/layout/tiling.spec.ts` runs every layout at one to eight panes in 1440×900, 3440×1440 and 900×1400 and covers the least pane size, Auto's switch points, Main and stack, the shapes, the keyboard moves and cycling. `tests/store/defaults.client.spec.ts` covers scope resolution, Yours across chats, Undo, Reset to Auto and the moving-only rule. `tests/layout/browser/tiling-shots.mts` takes pictures of every layout at 1440 px with 2, 3, 5 and 7 panes, the picker and the Settings page in light and dark: `node --import tsx/esm delorun/packages/plugin-multiview/tests/layout/browser/tiling-shots.mts <directory>`.

`tests/store/` 覆盖持久化：往返、每一种丢弃情形、大小限制、裁剪到 `keepChats`，以及被阻止或已满的存储。`tests/entry/browser/shots.mts` 在标准颜色令牌之上构建一个带有真实固定按钮、页脚和头部按钮的页面，并在无头 Chromium 中以 1440 和 390 px 拍摄浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`。该页面的头部和智能体行代替上游的目录组件。

`tests/panes/` 覆盖状态和用量标签、窗格引用（保留一次、关闭时释放、卸载后不留任何引用）、头部（徽章状态、按钮、“Move to…”菜单）、主体变体、该层（每个固定项一个窗格、Stop 只作用于它自己的对话、Close、简洁与完整的输入框、等待时的环、手机分页器）以及手机上的圆点。

`tests/studio/shots.mts` 在不使用模型密钥的情况下，对已构建的工作室中的入口拍摄图片：它用 `delorun/apps/tools/src/demo-home.ts` 构建一个临时 home，添加一个手写的、列出两个智能体的对话，在端口 18843 上启动工作室，通过固定按钮固定这两个智能体，并在无头 Chromium 中以 1440 px 保存浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <directory> [--keep]`。请在 `pnpm run build:artifacts` 以及构建具有 `build` 脚本的 `delorun/packages` 之后运行。
