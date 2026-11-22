# @delorun/plugin-thinking-rsvp

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

「思考」标签页：在 studio 的右侧栏中，随模型写作逐词阅读它的推理和回复。默认关闭：在侧栏「插件」的 Delorun studio 页面中，于「组件」下开启。用户指南是[逐词阅读模型的思考](../../docs/guide/everyday-use/thinking-tab.zh.md)。

## 使用标签页

打开右侧栏并选择 **Thinking**。标签页跟随你当前所在 chat 的最新轮次。

- **阅读条**在固定位置一次只显示一个词，并标出你的视线所落的字母，让你无需移动视线就能阅读。以句子或分句结尾的词会让阅读条多停留一会儿。
- **页面**让每个词都清晰可读：已读的内容在阅读条上方，尚未读到的在下方，每部分标明「推理」或「回复」。滚动任一侧即可回看或前看；阅读条保持原位。
- **Read** 选择推理、回复，或按模型写作的顺序同时选择两者。
- **Pace** 选择阅读条的移动方式：
  - **Live** 在模型写出每个词时显示该词。
  - **Set rate** 以你选定的每分钟词数播放，取值 100 到 1,000。
  - **Model's rate** 以模型写作的速度播放，该速度按它最新写出的词测得，在测得之前使用你设定的速率。
- 在设定速率或模型速率下，**Delay** 会让每个词在被写出你所选的秒数（最多 30）之后才显示，让你读到的是落后于模型的稳定词流。
- **播放控制**：播放和暂停，向后或向前单步一个词，重新开始，以及跳到最新的词。系统开启了减少动态效果时，标签页以暂停状态开始。

你的选择保存在此浏览器中。界面文字有英文和中文，不带空格书写的中文和日文文本也会逐词阅读。

## 约定

- **仅浏览器，可选。** [`@delorun/bundle-studio`](../bundle-studio/README.zh.md) 插入行 `delorun-thinking-rsvp`，带 `disabled: true`。studio 为指明该包的行提供包的 `./client` 一半，所以 Host 一半（[`src/index.ts`](src/index.ts)）不挂载任何内容。浏览器一半在对 `delorunStudio` 的一次注入之内注册，所以 stock 外观会卸载它。它在插件管理器中的标题和描述来自 [`locale/en.json`](locale/en.json) 和 [`locale/zh.json`](locale/zh.json)。图标（[`icon.svg`](icon.svg)、[`ThinkingArtwork.tsx`](src/client/ThinkingArtwork.tsx)）专为 Delorun 的插件列表绘制；修改它需要所有者批准。
- **标签页**（[`src/client/index.ts`](src/client/index.ts)）注册 `thinking-rsvp` 标签类型（隐藏时保持挂载，使阅读器保留位置）、侧栏起始页上的一个入口，以及位于 `sidebar.right.pane.tab` 席位的标签页主体。它需要 studio 的 `slots`、`locale`、`sessions` 和 `sidebarRightTabs` 服务，以及 `delorunStudio`。
- **每个 Session 一个馈送**（[`src/client/feed.ts`](src/client/feed.ts)）把 Session 的事件窗口折叠成最新轮次的页面：每一步的每个推理块和回复块是一个部分，键为 `<turn>:<step>:<block>`，带有它完整的词。
  - 实时片段追加到所属块，并且只读取它补全的词，所以更早的词保持其对象不变；空白紧跟其后或其块结束时，一个词才算完整。每个词带有页面收到它的时间（取浏览器时钟）；以已定稿形式到达的词则为 0。
  - 定稿消息保留文本与已流式输出内容相符或是其延伸的块，并原地替换与之矛盾的块。以空结果定稿的尝试会丢弃它的各部分。窗口被替换或被前置，或漏掉了某次修订，则会重建页面。词的键不依赖于尝试，所以在所有这些情形下阅读器都保留其位置。
  - 更新的轮次开启新页面；更早的轮次不会被读取。页面每个动画帧最多发布一次。
  - 馈送只在标签页观察窗口时才读取窗口。它的 Session 的作用域结束或插件卸载时，馈送即被释放。
- **控制器**（[`src/client/controller.ts`](src/client/controller.ts)）仅凭时钟决定阅读条显示哪个词，每次调用最多一个词：间隔是每分钟一分钟除以每分钟词数，再乘以该词的停留系数，词要等到被写出达到延迟时长之后才显示。模型的速率按它最新写出的 30 个词测得，至少需要 5 个，并保持在每分钟 60 到 1,500 个词之间。
- **词**（[`src/client/words.ts`](src/client/words.ts)）是文本中空白之间的片段，去除 Markdown 标记后显示：强调标记、代码反引号、链接语法（链接文字保留），以及位于行首的标题井号、列表项目符号、引用标记、分隔线和代码围栏（代码行保留）。每个词单独判断，所以跨片段拆开的标记绝不会改变更早的词或其键。由汉字、平假名或片假名组成的片段由 `Intl.Segmenter` 切分，标点保留在其前一个词上。阅读条周围的页面文本以同样方式清理。
- **偏好设置**是浏览器持久化的存储（[`src/client/store.ts`](src/client/store.ts)），键为 `delorun.thinking-rsvp.reader.v2`。窗格通过 `readerSettings` 读取它们，所以无法使用的字段回退到默认值，数字则保持在其范围之内。

## 开发

`pnpm run build` 使用上游的客户端预设写出 `lib/index.js` 和 `lib/client.js`（`pnpm --filter @delorun/plugin-thinking-rsvp run build`）。浏览器一半内联了 session 和模型类型的少量辅助函数，只导入页面自己的模块。

[`tests/words.client.spec.tsx`](tests/words.client.spec.tsx)、[`tests/feed.client.spec.tsx`](tests/feed.client.spec.tsx) 和 [`tests/controller.client.spec.tsx`](tests/controller.client.spec.tsx) 在不使用 React 的情况下覆盖词、馈送和控制器，其中馈送针对上游的 `MutableSessionEventSource`。[`tests/pane.client.spec.tsx`](tests/pane.client.spec.tsx) 在 jsdom 中渲染标签页，[`tests/plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) 覆盖其注册、stock 外观以及每个馈送的释放。该行的存在及 `disabled: true` 在 `@delorun/bundle-local` 的组合规格中断言。
