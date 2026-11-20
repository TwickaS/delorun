---
description: "设置向导与新建工作区流程共用的“浏览器”选项，供绘制或修改它的维护者：就绪状态读取器、组件的属性及其文案。"
kind: "package-library"
---

# @delorun/browser-setup

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

有两处界面会询问智能体是否可以使用网页浏览器：设置向导的“浏览器”步骤（[`@delorun/plugin-onboarding`](../plugin-onboarding/README.zh.md)）和新建工作区流程。二者都从本包绘制同一个组件，并通过同一个读取器读取“浏览器”是否已就绪。本包是一个从源码导出的工作室库：它在浏览器中运行，不导入 Cordis，由插件的浏览器包内联。

## 目录

- [读取“浏览器”是否已就绪](#read-whether-browser-is-ready)
- [home 的选择与页面的状态](#the-homes-choice-and-the-pages-states)
- [绘制选项](#draw-the-choice)
- [约定](#contract)
- [测试](#tests)

<a id="read-whether-browser-is-ready"></a>
## 读取“浏览器”是否已就绪

`createBrowserSetup(fetch, language)`（以 `.` 导出）是页面对 Host 需求检查的副本，即 [`@delorun/bundle-local`](../bundle-local/README.zh.md) 的 `GET /api/delorunRequirements.check`，并收窄到“浏览器”插件包（`BROWSER_BUNDLE`）。它提供 `getSnapshot`、`subscribe` 和 `refresh`；在调用 `refresh` 之前不会读取任何内容，重叠的调用共用一次请求。Host 在每次请求时都会重新读取这台电脑，因此用户刚满足的条件会在下一次读取时消失。

| `BrowserReadiness` | 含义 |
| --- | --- |
| `checking` | 尚未得到第一次应答 |
| `not-added` | Host 没有列出该插件包的任何行：它不在配置档中，或尚未加载 |
| `ready` | 所有条件均已满足 |
| `needs-setup` | Host 给出的 `reason`（使用工作室的语言），以及满足它的 `fix`：一条命令、一个设置分区或一个页面 |
| `problem` | 无法读取该插件包自己的声明；`message` 说明原因 |
| `failed` | 无法读取检查本身 |

对于 Host 就该插件包本身报告的三种状态，`browserAdded(readiness)` 为 true。就绪状态无法说明找到的是哪个浏览器；`ready` 同时涵盖已安装的 Chrome 和已下载的 Chromium。

<a id="the-homes-choice-and-the-pages-states"></a>
## home 的选择与页面的状态

`resolveBrowserSwitch(recorded, declined)`（`./switch`，以 `.` 导出）把 studio 所记录的内容转换为 `on` 或 `off`：记录的 `on` 或 `off` 保持不变；没有记录时，对本人在 Plugins 中关闭了的插件包、或从未做过选择且没有该插件包的已有 home（`declined`）为 `off`；其余一切情况，包括从未做过选择的新 home 和已损坏的值，为 `on`。studio 只在从未做过选择的新 home 中，或本人把 Browser 打开时，才自行添加该插件包。`browserPageState({ choice, pack, packReason, readiness })` 把选择、添加插件包的进展（`PackProgress`：`checking`、`available`、`installing`、`slow`、`restart`、`installed`、`offline`、`unavailable` 或 `failed`）以及需求检查合并为设置页的一个 `BrowserPageState`：`off`、`checking`、`installing`（添加等待之后为 `slow`）、`restart`、`ready`、带有 Host 所给原因与解决办法的 `needs-setup`，或带有 `BrowserFailure`（`offline`、`unavailable`、`failed`、`unread` 或 `problem`）的 `failed`。选择优先于其他一切，Host 自己的应答优先于安装器最后报告的状态，无法读取的检查显示 `unread`，而不是一直等待。

`REAL_BROWSER_BUNDLE` 指明本人自己的 Chrome 所用的插件包，`createBrowserSetup(fetch, language, bundle)` 和 `browserReadinessOf(answer, bundle)` 读取两种插件包中任一种的行。`BrowserCommand`（`./client`）为设置页绘制带复制按钮的命令。

<a id="draw-the-choice"></a>
## 绘制选项

`BrowserChoices`（`./client`）绘制一个单选组，并在选择独立浏览器时在其下方显示就绪状态。

| 属性 | 含义 |
| --- | --- |
| `t` | 调用方绑定的翻译函数。调用方把本包的词典（`./locales`）并入自己的词典。 |
| `heading` | 选项上方的问题，用于调用方的问题不同于面向整个主目录的“智能体可以使用网页浏览器吗？”时 |
| `choice`、`onChoice` | 当前生效的选项（`isolated` 或 `none`），以及发生更改时的回调。调用方保存该选项并决定它的作用。 |
| `disabled` | 锁定两个选项，例如在正在应用更改时 |
| `readiness` | 一个 `BrowserReadiness` |
| `notAdded` | 就绪状态为 `not-added` 时代替它绘制的内容，例如添加插件包的进度，或一行用于打开“浏览器”的内容 |
| `onRetry`、`onOpenSettings` | 读取失败后再次读取就绪状态；打开满足某个条件的设置分区 |

<a id="contract"></a>
## 约定

- **仅负责呈现。** 该组件不发出请求，也不写入任何内容。存储由调用方负责：设置向导把该选项对应到“浏览器”插件包的开或关，新建工作区流程则按工作区保存它。
- **只有选择独立浏览器时才显示就绪状态。** 选择“不使用浏览器”时，不会绘制任何有关“浏览器”所需条件的内容。
- **样式变量。** 样式读取工作室的 `--dsw-*` 角色和 Delorun 外观的间距级别，并带有像素回退值，因此该组在设置向导内外看起来一致。

<a id="tests"></a>
## 测试

[`switch.spec.ts`](tests/switch.spec.ts) 涵盖选择规则和页面的每种状态，包括选择了关闭的 home、在 Plugins 中被关闭的插件包，以及无法读取的检查。 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/browser-setup` 运行 [`browser-choices.client.spec.tsx`](tests/browser-choices.client.spec.tsx)：检查的每种应答对应的就绪状态、存储，以及组件的选项、禁用的第三个选项、每种就绪状态和每种解决办法。
