---
description: "Multiview 插件，面向同时关注多个智能体的人，以及修改它的入口、设置和布局的维护者。"
kind: "package-library"
---

# @delorun/plugin-multiview

[English](README.md) | 中文

## 概述

Multiview 把固定的智能体（队友、子智能体、Claude Code 和 Codex）显示在主对话旁边，布局由本人安排。这个包包含把智能体放入 Multiview 的入口：头部智能体列表每一行上的固定按钮、头部带有布局菜单的 Multiview 按钮、在交接时固定并打开的观察器，以及设置。布局引擎在 `src/layout` 中；绘制各窗格的 `main` 面板属于 Multiview 构建的窗格工作线。

## 目录

- [使用方式](#using-it)
- [Panes](#panes)
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
- **返回。**打开过 Multiview 的对话，在本人回到它时会再次打开它，页面重新加载后也是如此。用按钮关闭 Multiview，或用“Open full chat”离开它，会使它保持关闭。

## Panes

Multiview is a layer in the `conversation.main.body` slot, which wraps the main Conversation's content (transcript and composer) under its header. While Multiview is closed the layer renders that content as it is. While it is open the layer draws the pane layout under the unchanged header (title, mode, agents list and the Multiview button), and the main chat's pane is that content itself. An agent's pane is the real chat, drawn by the shared Conversation content in its `pane` variant, so tool rows, approval cards and an agent's banner look and work as in the main view. A pane shows the newest part of its chat and follows the tail.

- **The header.** A grip to drag the pane by, the agent's monogram and name, its task, a status badge (`Working` with the time since the run began, `Needs approval`, `Done` with the run's duration; the main chat shows `Ready` at rest), then a Move to… menu (also swap places with another pane), Open full chat, Stop (while the chat runs and may be stopped) and Close. For a live Claude Code or Codex agent a line of chips shows the program's version, plan and five-hour and weekly use, read from the `agentSeat` projection when `@delorun/plugin-agent-seats` provides it; any other chat has no such line. A finished agent keeps its pane with the Done badge until it is closed. A pane whose chat waits for approval has an amber ring.
- **The reply box.** An agent's pane shows a one-line reply box (the editor and Send); with `compactComposer` off it shows the full composer. The main chat's pane always shows the full composer.
- **Stop** stops that chat only. **Open full chat** opens the chat in the main view, so the chat whose Multiview it was is no longer on screen. **Close** removes the pin and the pane, and closing the last pane returns to the normal chat.
- **References.** Each pane retains its chat with the `multiviewPane` reference source for as long as the pane is in the layout, held by the layer and not by the layout, so dragging a pane, hiding it for lack of room or paging past it on a phone never closes its chat. Closing Multiview releases every reference. A window too small for every pin draws the first panes that fit and says how many are hidden; they stay pinned.
- **On a phone.** Below 768 px the layer draws the pager from `src/phone` instead of the layout: the main chat is the first page and each pin follows in pin order. A page shows the agent's header, the chat, Open full chat and Stop buttons and the position dots above its reply box; the dots are a contribution to `conversation.input.dock`.

## 配置

Host 行 `delorun-multiview` 有七个易变字段（[`src/config.ts`](src/config.ts)），在配置加载时验证，工作室运行期间可以更改。

| Field | Default | Meaning |
| --- | --- | --- |
| `autoOpen` | `true` | 新的交接是否打开 Multiview。为 `false` 时，智能体仍会自行固定，头部按钮显示数量和琥珀色圆点，但不会自动打开任何东西。 |
| `maxPanes` | `6` | 最多的窗格数，包含主对话（2 到 12）。 |
| `minPaneWidth` | `340` | 窗格的最小宽度，单位为 CSS 像素（240 到 1200）；较窄的窗口容纳的窗格更少。 |
| `minPaneHeight` | `240` | 窗格的最小高度，单位为 CSS 像素（160 到 1200）。 |
| `compactComposer` | `true` | 窗格是否显示单行的回复框。为 `false` 时每个窗格都显示完整的输入框。窗格工作线读取它。 |
| `reopenOnReturn` | `true` | 打开过 Multiview 的对话在返回时是否重新打开它。 |
| `keepChats` | `50` | 此浏览器中保留多少个对话的已固定智能体和布局（1 到 500）；多保存一个，就会忘掉保存时间最久的那个对话。 |

## 契约

- **Host 一半**（[`src/index.ts`](src/index.ts)）声明 `Config`，不挂载任何东西。设置服务把该行提供给浏览器。
- **浏览器一半**（[`src/client/index.ts`](src/client/index.ts)）需要 `slots`、`locale`、`sessions`、`layout` 和 `configForms`。它注册词典 `delorunMultiview`、`conversation.session.header.actions.subagent.row.trail` 中的固定按钮、`conversation.session.header.actions.subagent.footer` 中的页脚、`conversation.session.header.actions` 中的 Multiview 按钮（顺序 11，位于顺序 10 的智能体列表之后），并提供 `ctx.multiview`。
- **没有面板时不起作用。**只有在注册了键为 `multiview` 的 `main` 面板时才挂载这些入口。没有它，固定按钮、页脚、头部按钮、交接观察器和返回时重新打开都不存在，因为“Open Multiview”什么也不会显示；`ctx.multiview` 仍然提供。面板注册时入口出现，面板移除时入口消失。
- **`ctx.multiview`**（`MultiviewService`）把每个对话的 `{ pins, layout, open }` 作为可观察对象（`of(chat)`）保存，并提供操作 `pin`、`unpin`、`pinAll`、`open`、`close`、`setLayout`、`applyPreset`、`resetLayout` 和 `reportArea`。固定项是哪些智能体拥有窗格的事实来源；布局只负责放置它们，并在每次变化时与固定项对齐。窗格工作线的 `main` 面板（id 为 `multiview`）读取这个服务，并调用 `setLayout` 和 `reportArea`。
- **打开**通过 `ctx.layout.selectPanel` 选中 `multiview` 主面板。
- **交接观察器**订阅会话列表。主对话是保留为 `mainView` 的会话；它的智能体目录是它的 `subagentCatalog` 投影。对话成为主视图时，或它的投影第一次被读取时，目录中已有的智能体就是基线。之后的每个条目都是一次交接。另一个对话成为主视图会开始新的基线。
- **上限**把主对话计入：`maxPanes` 为 6 时，已固定的少于 5 个就还可以再固定一个智能体。窗口最多容纳 `floor(width / minPaneWidth) × floor(height / minPaneHeight)` 个窗格；在布局报告它自己的区域之前，使用窗口的大小。
- **持久化**（[`src/store/persist.ts`](src/store/persist.ts)）是已保存的每个对话状态的唯一所有者，这是 `localStorage` 中的客户端偏好：每个对话一个键（`dsh.multiview.v1.<host>.<chat>`），值为 `{ v: 1, pins, layout, open }`，读取时用 zod 验证。不是 JSON、未通过验证、窗格数多于最大的 `maxPanes`（12）、嵌套深度超过这样的布局所能达到的深度，或布局不一致的值，会被丢弃、移除并以警告报告，该对话从没有任何固定项开始。布局中可以有固定项未列出的窗格；存储会把两者对齐。第二个键（`dsh.multiview-index.v1.<host>`）按最近优先列出已保存的对话；保存超出 `keepChats` 的对话会移除最久未用的那些对话的键。阻止 `localStorage` 的浏览器的表现就像没有保存任何东西。没有任何内容到达模型请求，因此不写入会话事件。
- **文案**有英文和中文（[`src/entry/locales.ts`](src/entry/locales.ts) 和 [`src/panes/locales.ts`](src/panes/locales.ts)）；插件页面从 [`locale/`](locale/en.json) 为该行命名。

## 限制

- 智能体弹出面板提供页脚而不是头部，所以已固定的数量和“Pin running”位于页脚，在“Open Multiview”旁边。
- 固定是按对话进行的。对话的某个智能体所启动的智能体（嵌套行）会固定到顶层对话的 Multiview 中。
- 返回时重新打开是在对话打开之后才选中面板，因此普通对话可能会先显示片刻。

## 测试

`tests/entry/` 用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry` 运行。它覆盖交接监视器、存储（固定项、上限、没有空间、布局、持久化调用）、`Config` 的默认值和范围、注册（新目录条目上自动固定而已有条目不固定、每次自动打开、自动打开关闭、上限、返回时重新打开、来自外部的关闭）以及各组件（固定状态、禁用原因、页脚、数量和琥珀色圆点、布局菜单）。

`tests/store/` 覆盖持久化：往返、每一种丢弃情形、大小限制、裁剪到 `keepChats`，以及被阻止或已满的存储。`tests/entry/browser/shots.mts` 在标准颜色令牌之上构建一个带有真实固定按钮、页脚和头部按钮的页面，并在无头 Chromium 中以 1440 和 390 px 拍摄浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`。该页面的头部和智能体行代替上游的目录组件。

`tests/studio/shots.mts` 在不使用模型密钥的情况下，对已构建的工作室中的入口拍摄图片：它用 `delorun/apps/tools/src/demo-home.ts` 构建一个临时 home，添加一个手写的、列出两个智能体的对话，在端口 18843 上启动工作室，通过固定按钮固定这两个智能体，并在无头 Chromium 中以 1440 px 保存浅色主题的图片：`node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <directory> [--keep]`。请在 `pnpm run build:artifacts` 以及构建具有 `build` 脚本的 `delorun/packages` 之后运行。在面板工作线注册 `multiview` 面板之前，窗格本身不会被绘制。
