---
description: "Delorun 的品牌合为一个包：令牌、六角插头标志，以及工作室、PIN 模式、网站和文档共用的组件集，供维护者增加或修改组件或品牌取值。"
kind: "package-library"
---

# @delorun/brand

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/brand` 是 Delorun 品牌的唯一来源：颜色、字体、圆角与间距、六角插头标志，以及承载这些取值的组件。每个组件都渲染上游工作室的原语，由它负责键盘、焦点与无障碍行为，再加上 Delorun 的外观与 API。本包不需要 Cordis 宿主：工作室插件、网站和文档都把它当作普通的 React 与 CSS 来导入。`@delorun/plugin-theme` 仍是在工作室中注册这套外观的插件。

## 目录

- [使用本包](#use-this-package)
- [令牌](#tokens)
- [组件](#components)
- [约定](#contract)
- [漂移检查](#the-drift-gate)
- [桌面图标](#the-desktop-icon)
- [测试](#tests)

<a id="use-this-package"></a>
## 使用本包

本包导出源码，与 [`@delorun/settings-controls`](../settings-controls/README.zh.md) 相同。

- **工作室插件**在 `dependencies` 中列出 `@delorun/brand`，并在自己的 `tsdown.config.ts` 中用 `@delorun/brand` 的别名把它内联进浏览器包；只导入标志时，再加 `@delorun/brand/mark` 的别名。`@delorun/bundle-local` 和 `@delorun/plugin-theme` 各示范了一种。
- **网站和文档**通过各自 tsconfig 的 `paths` 导入 `@brand` 和 `@design/mark`，`@delorun/site-design` 的 `tokens.css` 导入本包的 `tokens.css` 与 `fonts.css`。网站的链接、注册字段和按钮就是本包的 `Link`、`TextField` 和 `Button`。两个网站都在 Vite 配置和 tsconfig `paths` 中把 `#upstream` 解析到 `src/upstream.web.tsx`。

| 导出 | 内容 |
| --- | --- |
| `@delorun/brand` | 组件、`Mark`、`MARK` 和令牌；导入它会加载 `tokens.css`，因此清单不声明 `sideEffects` |
| `@delorun/brand/tokens` | 以数据形式给出的 `BRAND_COLOURS`、`BRAND_FONTS`、`BRAND_MOTION`、`BRAND_RADII`、`BRAND_SPACE` |
| `@delorun/brand/tokens.css` | 同样的取值，写成 `--dl-*` 自定义属性 |
| `@delorun/brand/fonts.css` | Schibsted Grotesk 与 JetBrains Mono 的 `@font-face`，拉丁子集，SIL OFL 1.1 |
| `@delorun/brand/mark` | `MARK`（路径数据）和 `Mark`（组件） |
| `@delorun/brand/alert` | `Alert`, `ALERT_CLASSES` and `ALERT_EXIT_MS`, the studio's alert (also exported from the index) |
| `@delorun/brand/toast` | `Toaster`、`showToast` 和 `ToastCard`，仅供网站和文档使用：通知通过 Sonner 绘制，而工作室不加载 Sonner |

<a id="tokens"></a>
## 令牌

- **唯一的品牌色。** 桃色 `#E5734A` 是所有界面上的品牌色：填充、焦点环和标志的插头。桃色底上的白字只有 3.05:1，所以桃色填充上的文字用 `#111110`，对比度 6.19:1。
- **链接用文字安全的桃色。** 在浅色页面上，链接和强调文字用 `#B84A1B`：在白色上 5.21:1，在 `#FCFCFC` 上 5.07:1，高于 WCAG AA 对正文要求的 4.5:1。在深色页面上，桃色本身在 `#111110` 上就有 6.19:1。`tests/tokens.spec.ts` 会计算这些比值。
- **字体。** 所有界面的文字用 Schibsted Grotesk，代码用 JetBrains Mono。
- **深色模式跟随系统。** `tokens.css` 设置 `color-scheme: light dark`，并用 `light-dark()` 定义每种颜色；页面自己设置 `color-scheme` 或带有 `.dark` 祖先元素时，以页面的设置为准。
- **动效。** 同一套缓动：到达用 `--dl-ease-out`，跨屏移动用 `--dl-ease-in-out`，颜色变化用 `--dl-ease`；不使用任何 ease-in。时长有 `press`（120 ms）、`quick`（180 ms）、`move`（260 ms）、`explain`（360 ms，仅用于主题切换）和 `leave`（100 ms，短于任何到达）。`--dl-duration-*` 为颜色和不透明度计时；`--dl-motion-*` 为 transform 和 clip-path 计时，在减少动效时变为 0 ms，此时 `--dl-scale-pressed`（0.97）和 `--dl-scale-enter`（0.95）也变为 1。本库的样式表不含其他缓动曲线或时长，`tests/tokens.spec.ts` 会检查这一点。
- **优先使用工作室角色。** 每个 `--dl-*` 令牌在有对应的工作室 `--dsw-*` 角色时读取它，因此在工作室内组件跟随调色板、强调色设置和密度；没有工作室的页面则使用品牌取值。

<a id="components"></a>
## 组件

每个都是带有已文档化属性接口的函数组件。“上游”指 `@deepseek-ai/dsh-client-ui-primitives` 中的原语。

| 组件 | 所组合的上游行为 | 增加的内容 |
| --- | --- | --- |
| `Button` | `Button` | `primary`、`secondary`、`destructive`、`ghost` 四种变体；按下时缩小，仅在精确指针下有悬停效果，焦点环，以及 `unavailable`：`aria-disabled`、仍可获得焦点、按下和悬停都不变化、文字达到 AA 可读 |
| `TextField` | `Input` | 可见标签、用 `aria-describedby` 关联的帮助行和错误行，错误会被朗读 |
| `Pill` | `Pill` | 色调 |
| `Dialog` | `Modal` | 操作区页脚和 `warning` 色调 |
| `Card` | 无 | 由 `<h3>` 命名的带边框分区 |
| `Alert` | none | The studio's alert: kinds `info`, `success`, `warning`, `error` and `progress`, each with its own glyph in a tinted circle; a title, one muted line, a tinted primary and a quiet secondary action, an optional close; `inline`, `toast` and `banner` variants; role `alert` for a warning or an error and `status` otherwise unless the caller names one; `closing` plays the leave and `onClosed` reports its end. It holds no styles: `@delorun/plugin-theme` styles `ALERT_CLASSES` while the Delorun look is on (its README, "Alerts and pop-ups") |
| `Notice` | 无 | 四种色调、可选图标、标题、说明和操作，实时区域角色由调用方选择 |
| `OutcomePanel` | 无 | 居中的整块结果：图标圆盘、标题、说明、操作 |
| `StatusCard` | `Pill` | 图标圆盘、标题、细节和状态标签 |
| `PinDots`、`Keypad` | 无 | PIN 输入：不携带任何值的圆点，以及由真实按钮组成的 72 px 圆形键盘 |
| `ConfirmAction` | `Button` | 带一次行内确认的破坏性操作 |
| `Link` | 无 | 文字安全的桃色，带下划线 |
| `SectionHeading` | 无 | 放在 `<hgroup>` 中的分区标题（1 到 3 级）和引导句，流式字号、紧凑字距、均衡断行 |
| `TabList`、`TabPanel` | 无 | 一个 Tab 停靠点，方向键、Home 和 End 选择；面板由所选标签命名，可放在标签行上方或旁边，含有控件时用 `focusable={false}` 移出 Tab 顺序；没有禁用的标签；窄屏上标签行横向滚动并吸附 |
| `CodeBlock` | 无 | 用品牌等宽字体显示的代码，带一个就地回应的复制按钮（成功时按钮中显示对勾和已复制文字，失败时在代码下方单独一行显示失败文字，并选中代码），每次复制都会朗读；所有文字都是属性；按钮在脚本运行后出现，不会移动代码块 |
| `Frame` | 无 | 放置复刻界面的框：12 px 圆角、线条颜色、由内容宽高固定的尺寸，以及在内容就绪前显示的静态图 |
| `Toaster`、`showToast`（`@delorun/brand/toast`） | 无（Sonner） | 一次只显示一条通知，新的替换旧的；它在获得焦点或指针停留时保持，操作是可用键盘到达的真实按钮（也可用 Alt+T），并可滑动关闭 |
| `Mark` | 无 | 六角插头标志；螺母取文字颜色，插头取 `--dl-accent` |
| `LookChooser` | 无 | 配色方案一行、以“自定义”结尾的主题方块网格、自定义面板（仅在选择“自定义”时显示）和实时示例；“设置”→“外观”与新手引导的“外观”步骤都用它自己的文字渲染它 |
| `ChipGroup`、`ThemePicker`、`AccentPicker`、`StudioLookSwitch` | 无 | 芯片单选组（44 px 目标、一个 Tab 停靠点、方向键）以及建立在其上的主题和强调色选择器（设置 → 外观与新手引导的“外观”步骤共用它们），还有设置 → 通用使用的 Delorun 外观开关（默认开启；关闭即选择原版）；`@delorun/plugin-theme/controls` 会重新导出它们 |
| `SettingsCard`、`SettingHeading`、`SettingRow`、`ChoiceGroup`、`RadioList`、`TileGroup` | 无 | 设置分区的控件。它们（以及芯片控件）的 CSS 读取 studio 的 `--dsw-*` 与 `--delorun-space-*` 属性，并带有 `--dl-*` 或像素回退值，因此在 studio 之外也能渲染，网站的包管理器选择器就是如此。`ChoiceGroup` 支持方向键、Home 和 End，以及用于以品牌等宽字体显示的全宽组的 `fill` 和 `mono`。[`@delorun/settings-controls`](../settings-controls/README.zh.md) 会重新导出它们 |

<a id="contract"></a>
## 约定

- **`#upstream` 是唯一的接缝。** 组件从 `#upstream` 导入 `Button`、`Input`、`Modal`、`Pill` 和 `Switch`。包的 `imports` 字段把它解析到 `src/upstream.ts`，后者重新导出上游原语，所以工作室得到上游的行为。静态网站无法携带上游原语（它们会引入工作室的存储和语法高亮），所以网站和文档把 `#upstream` 解析到 `src/upstream.web.tsx`：原生的 `button`、`input`、带 `switch` 角色的 `button` 和模态 `<dialog>`，焦点、键盘和 Escape 行为由浏览器提供。组件需要两个文件都没有导出的原语时，两处都要加。
- **没有产品文案。** 每个组件的文字都由调用方以本地化文本传入，本包不含文案。
- **DOM 中没有机密。** `PinDots` 不渲染已输入的值，无论在文本还是属性中，并带有 `aria-hidden`。
- **关闭时。** 工作室的外观关闭时，`--dl-*` 仍通过上游的 `--dsw-*` 角色解析，组件采用上游的调色板。
- **动效。** 每个过渡和动画都读取动效令牌；在 `prefers-reduced-motion: reduce` 下移动停止，颜色和不透明度变化保留各自的时长。
- **React。** 对等依赖范围是 `^18.2.0 || ^19.0.0`：工作室运行 React 18，网站运行 React 19。

<a id="the-drift-gate"></a>
## 漂移检查

[`gates:brand-drift`](../../apps/tools/src/checks/gates/brand-drift.ts) 在每个 Delorun 包的源码中，以及网站和文档（本包除外）的源码、公开文件和脚本中，拒绝品牌色字面量（`#E5734A`、`#B84A1B`）、`font-family` 中的具名字体，以及第二份标志路径。保留字面量的文件须连同理由列入 [`brand-drift.allowlist.json`](../../apps/tools/src/checks/gates/brand-drift.allowlist.json)；这个清单只会变短。

网站的社交卡片页面 `apps/website/scripts/og.html` 由 `scripts/render-og.ts` 根据标志和品牌的自定义属性生成（`node_modules/.bin/tsx delorun/packages/brand/scripts/render-og.ts --write`）。它的标志路径是唯一列入允许清单的副本，已提交的页面与 [`src/og.ts`](src/og.ts) 不同时 `tests/og.spec.ts` 会失败。`public/og.png` 是该页面按 1200 × 630 截取的屏幕截图：在仓库根目录运行 `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og-png.ts`，它在 127.0.0.1 的 browse 会话中加载该页面，等待品牌字体，并写出 PNG。`tests/og.spec.ts` 检查 PNG 的尺寸。

社交卡的源页 `apps/website/scripts/og.html` 由 `scripts/render-og.ts` 从本包生成（`node_modules/.bin/tsx delorun/packages/brand/scripts/render-og.ts --write`）；`tests/og.spec.ts` 在提交的页面与 `src/og.ts` 不一致时失败。`public/og.png` 是该页 1200×630 的截图，由 `scripts/render-og-png.ts` 生成（从仓库根目录运行 `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og-png.ts`）：它通过 127.0.0.1 上的 browse 会话加载页面，等待品牌字体加载，然后写入 PNG。`tests/og.spec.ts` 还检查 PNG 的尺寸。

<a id="the-desktop-icon"></a>
## 桌面图标

[`src/icons.ts`](src/icons.ts) 根据标志和品牌色绘制所有应用图标：墨色底板，螺母为纸色，插头为桃色。`node_modules/.bin/tsx delorun/packages/brand/scripts/render-icon.ts --write` 会重写 `apps/desktop/resources/icon*.svg|png`、`tray-windows.ico`（通过 `apps/desktop/scripts/render-tray-icon.ts`，它会为 16 到 64 px 放大 `tray-glyph` 组中的六角标志）以及网页应用的网站图标和 PNG 图标。`--previews <dir>` 在浅色和深色背景上写出 16、32、256 和 1024 px 的预览。已提交的 SVG 与其生成器不一致时，`tests/icons.spec.ts` 会失败。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/brand` 运行 [`tests/tokens.spec.ts`](tests/tokens.spec.ts)，检查对比度比值，以及 `tokens.css`、`tokens.ts`、两个网站图标和工作室主题的默认强调色是否一致；以及动效令牌是否一致、是否为样式表中仅有的时长；还运行 [`tests/components.client.spec.tsx`](tests/components.client.spec.tsx)，检查每个组件的角色、名称和回调，以及 [`tests/site-parts.client.spec.tsx`](tests/site-parts.client.spec.tsx) 和 [`tests/toast.client.spec.tsx`](tests/toast.client.spec.tsx)，检查网站使用的部件。`preview/` 是用于截图的本地图库，端口 18620：`vite --config delorun/packages/brand/preview/vite.config.ts`；加上 `BRAND_PREVIEW_SEAM=web` 时，`/parts.html` 在浅色和深色两栏中显示网站使用的部件。
