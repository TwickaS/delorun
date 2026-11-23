---
description: "Delorun 的设置布局，供想知道某项设置位于何处的人，以及放置新分区或新行的维护者阅读。"
kind: "package-library"
---

# @delorun/plugin-settings-layout

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

Delorun 的“设置”是一个大面板，导航按主题分组，带搜索框，并把上游的“通用”行汇集成带标题的卡片页面。本包通过上游的设置布局 seam（`ctx.settingsLayout`）向上游的设置外壳注册一个布局，因此所有原版和第三方的分区与行都继续可用。它只在 Delorun 外观和上游的通用设置都开启时加载；使用原版外观时，上游的平铺列表及其 800 × 800 面板会恢复。

## 目录

- [使用设置](#using-settings)
- [约定](#contract)
- [测试](#tests)
- [开发](#development)
- [限制](#limits)

<a id="using-settings"></a>
## 使用设置

导航有五个分组：通用、智能体、安全、设备和数据。每个页面只显示已注册的分区和行，没有内容的页面会被省略。每个标题都使用句首大写：布局为卡片加标题，Delorun 的每个分区也绘制自己的标题，因此在其他不带此布局的设置中显示时，读起来相同。

| 分组 | 页面 | 内容 | 它放置的 id |
| --- | --- | --- | --- |
| 通用 | 通用 | 语言；外观风格（Delorun 或原版外观）；更新（发布检查和当前版本合为一行）；键盘快捷键；开始使用（重新显示引导）；高级（编码视图） | 行 `language`、`delorun-look`、`delorun-update-check`、`delorun-versions`、`shortcuts`、`delorun-onboarding`、`developer-tools` |
| 通用 | 外观 | Delorun 的“颜色”分区，然后是“文字与密度”卡片：字体、字号（含更多字体设置）、密度 | 分区 `delorun-appearance`；行 `delorun-typeface`、`font-size`、`delorun-density` |
| 通用 | 侧边栏 | 侧边栏的“顶部图案”和“对话列表”，然后是“延后与闲置对话” | 分区 `delorun-sidebar`、`delorun-chat-states` |
| 通用 | 对话显示 | “详细程度”和“收起” | 分区 `delorun-conversation` |
| 通用 | 对话 | 输入框（忙碌时的发送行为、推理强度标签）、链接与用量 | 行 `composer-enter`、`delorun-effort-labels`、`link-opening`、`performance-usage` |
| 通用 | 账户 | 上游的账户分区；Delorun 的组合将其隐藏，因此该页只在它已注册时显示 | 分区 `account` |
| 智能体 | 模型 | 上游的模型提供商 | 分区 `models` |
| 智能体 | 模式 | 上游的智能体预设 | 分区 `agent-presets` |
| 智能体 | 工具 | 工具设置：链接到“插件”中每个工具的页面 | 分区 `delorun-tool-settings` |
| 智能体 | 插件 | 上游的内置插件清单 | 分区 `plugins` |
| Agent | Browser | Whether agents may use a web browser, its status, a download and a test | section `delorun-browser` |
| 安全 | 权限 | “新对话”卡片，含默认权限模式，然后是“完全访问”和 MCP 服务器 | 行 `permission`；分区 `delorun-permissions` |
| 安全 | 外部智能体 | 委派同意：外部智能体运行前询问的开关、运行时间上限，以及被允许不经询问就启动的智能体（各带“撤销”） | 分区 `delorun-external-agents` |
| 安全 | 网络 | 每个工作区中沙箱内命令和 `web_fetch` 的网络访问 | 分区 `delorun-network` |
| 安全 | 隐私 | 会话日志上传开关、桌面端分析一行说明和反馈 | 分区 `delorun-privacy` |
| 设备 | 设备 | 远程访问和已批准的设备 | 分区 `delorun-devices` |
| 数据 | 回收站 | 已删除的对话和工作区 | 分区 `delorun-trash` |
| 数据 | 变更 | 对插件与 harness 变更的审查，保护开启或关闭 | 分区 `delorun-changes` |
| 数据 | 设置版本 | profile 历史的各个版本、切换会改变什么，以及“保存此设置”和“切换到此版本” | 分区 `delorun-setup-versions` |
| 数据 | 关于 | “版本”卡片（Delorun 与 DeepSeek Harness）、许可证和项目链接，均由“关于”分区绘制 | 分区 `delorun-about` |

在“数据”之后，每个在 `settingsPluginGroups` 中声明了自己分区的第三方插件都有独立的分组，以该插件的显示标题命名，每个分区一页。搜索框按名称以及中英文关键词查找页面、卡片和行。布局和插件分组都未放置的内容，例如未命名的第三方分区或上游新增的“通用”行，会出现在“其他”之下，因此没有任何分区或行会消失。

“隐私”在“安全”之下单独成页，因为它包含一项同意决定，人们应能按名称和搜索找到。上游的会话日志上传行被隐藏：“隐私”分区的开关在其同意对话框之后编辑同一个配置行，且每个 Delorun CLI profile 都与本布局一起挂载“隐私”分区。

<a id="contract"></a>
## 约定

- **原版外观与其他设置。**客户端部分在 `apply` 内注入 `delorunStudio` 和 `settingsLayout`（`ctx.inject(['delorunStudio', 'settingsLayout'], applyStudio)`），因此在原版外观下，以及在某个插件关闭上游的通用设置（`ui-settings-general`，即 `settingsLayout` 的提供方）并绘制自己的设置时（如 DS Bot），它的入口仍保持激活；上游的 web 启动要求每个入口都激活。`@delorun/plugin-theme` 仅在 Delorun 外观开启时提供 `delorunStudio`。两项服务缺一，本插件便不注册任何内容。主机部分不挂载任何内容。
- **布局**（[`src/client/layout.ts`](src/client/layout.ts)）按注册 id 命名分区和“通用”行；`SECTIONS` 和 `ITEMS` 列出它们。“设备”和“回收站”使用各自分区在 `settings.section.icon` 下注册的图标；其余页面都有自己的图形。`HIDDEN_ITEMS` 包含 Delorun 的分区所取代的三个上游行：`appearance`（浅色、深色和跟随系统，由“外观”取代）、`transcript-view`（工作详情，由“对话显示”取代）和 `session-log-deepseek`（上传开关，由“隐私”取代）。被隐藏的行在任何位置都不显示，连“其他”之下也不显示。
- **插件分组。**布局注册期间，本插件提供 `ctx.settingsPluginGroups`（[`src/client/plugin-groups.ts`](src/client/plugin-groups.ts)）。第三方插件，或适配它的桥接，注入该服务并注册 `{ id, label, sections }`：它的包名、显示标题和 `settings.section` id。布局会再次注册，在“数据”之后为每个插件增加一个分组（按注册顺序），每个分区一页，以该分区注册的标签命名；布局已放置的分区保持原位。`register` 返回释放函数，并在已注册同 id 的分组时抛出错误。
- **面板**约 1080 宽、窗口高度的 88%，导航最宽 220，在窄窗口中至多占五分之二。[`PANEL_STYLE`](src/client/index.ts) 在一个标记为 `@delorun/plugin-settings-layout` 的 style 元素中设置上游的面板自定义属性。上游自己在 768px 以下的规则会让面板占满整个窗口。行填满内容栏，因此每个控件和开关都位于其右边缘。同一个 style 元素还设置上游的 `--dsh-settings-card-heading-*` 属性，使卡片标题成为标签颜色的句首大写标题；Delorun 的分区为自己的标题读取同样的属性。
- **文案**为中英文（[`src/client/locales.ts`](src/client/locales.ts)）；词典在 `settings.delorunLayout` 命名空间下加载。每个页面标题都来自布局，因此上游的“智能体预设”和“内置插件”分区显示为“模式”和“插件”；在有标题的页面上，上游的分区隐藏自己的标题。
- **工具设置**（[`src/client/ToolSettingsSection.tsx`](src/client/ToolSettingsSection.tsx)）是 `delorun-tool-settings` 分区。它按 id 和当前语言的名称列出上游的 `plugins.item` 清单，且仅在上游的 `pluginNavigation` 服务存在时才列出。点击一行会调用 `openItem(id)` 并关闭设置。没有工具拥有设置页时，该分区不渲染任何内容。长工具名会换行，因此完整名称保持可见。
- **释放。**释放本插件，或失去 `delorunStudio`，会移除布局、词典、“工具设置”分区和 style 元素。
- **语言文件。**[`locale/en.json`](locale/en.json) 和 [`locale/zh.json`](locale/zh.json) 包含“插件”页的 `meta.title` 和 `meta.description`。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts --maxWorkers=2 packages/plugin-settings-layout/` 运行这些 spec。

- [`tests/layout.client.spec.tsx`](tests/layout.client.spec.tsx) 将布局投射到已注册的分区和行上：它命名的每个 id 都在 `SECTIONS` 或 `ITEMS` 中，每个窗格按顺序堆叠其分区和带标题的卡片，“外部智能体”和“网络”在其分区注册后显示，无归属的分区或行落在“其他”之下，而插件分组的分区落在该插件的分组中，被隐藏的行在任何位置都不显示，搜索能找到页面、卡片和行，中文文案包含每个英文键，并且插件在没有 `delorunStudio` 或 `settingsLayout` 时不注册任何内容、保持激活，在其中任一消失或插件被释放时移除一切，并在插件分组增减时重新注册布局。
- [`tests/tool-settings.client.spec.tsx`](tests/tool-settings.client.spec.tsx) 检查来自清单的列表、没有导航时不显示任何内容、一行打开其页面并关闭设置，以及没有工具时不渲染任何内容。
- [`tests/ids.spec.ts`](tests/ids.spec.ts) 检查上游的客户端源码仍然注册布局所命名的上游分区和“通用”行 id。
- [`tests/host.spec.ts`](tests/host.spec.ts) 检查主机入口不挂载任何内容。

<a id="development"></a>
## 开发

`pnpm --filter @delorun/plugin-settings-layout run build` 用上游的客户端预设写出 `lib/index.js` 和 `lib/client.js`。浏览器页面的模块表不提供 Delorun 的包，因此客户端部分在运行时不导入其中任何一个。

<a id="limits"></a>
## 限制

- **工具表单在“插件”页中打开。**它们注册到“插件”页自己的插槽中，设置无法渲染该插槽，因此“工具设置”链接到每个页面，而不是容纳这些表单。
- **上游新增的“通用”行**会出现在“其他”之下，直到布局放置它。
