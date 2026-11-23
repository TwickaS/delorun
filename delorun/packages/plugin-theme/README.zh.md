---
description: "Delorun 在整个 studio 中的外观，以及回到 stock 外观的开关，供维护者修改调色板、强调色、字体、「外观」和「对话」部分及其「通用」行，或 `studio_additions` 开关时阅读。"
kind: "package-reference"
---

# @delorun/plugin-theme

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/plugin-theme` 拥有 C16 开关 `studio_additions`。开关开启期间，它把 Delorun 的 Soft 调色板、强调色和 Delorun 的字体叠加在上游的主题令牌之上，向设置添加「外观」和「对话」部分以及四个「通用」行，设置 Delorun 的「新建 Session」标题和词汇，并提供 `delorunStudio` 浏览器服务，每个其他 Delorun studio 插件都需要它。关闭开关会卸载所有这些内容，studio 即为上游的 studio。此后插件注册一个「通用」行（`settings.general.item`，id 为 `delorun-look`），用于重新开启该开关。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [外观](#the-look)
- [Alerts and pop-ups](#alerts-and-pop-ups)
- [stock 外观](#the-stock-look)
- [调色板与署名](#palettes-and-attribution)
- [测试](#tests)
- [限制](#limits)

<a id="contract"></a>

## 约定

- **开关。** `studioAdditions` 设置是 `delorun-theme` 行的 `Config`（[`THEME_ROW_ID`](src/config.ts)）中一个可实时编辑的布尔值。它的默认值是 `false`，也就是一致性值：挂载该行却不设置它的 profile 得到的是上游的外观。`@delorun/bundle-studio` 的行把它设为 `true`，即 Delorun 的默认组合（[C16](../../docs/contracts/c16-parity-composition.zh.md)）。该开关改变本人所见，不影响模型读到的任何内容。
- **`ctx.delorunStudio`。** `@delorun/plugin-theme/client` 把 `delorunStudio: DelorunStudio` 合并进浏览器 `Context`。该服务恰好在已存储的开关开启期间存在，关闭时被撤回。Delorun studio 插件在 `ctx.inject(['delorunStudio'], …)` 之内注册所有内容，所以 stock 外观会释放它的注册，而其条目保持激活；顶层的 `inject` 条目会让该条目保持挂起，上游的 web 启动会把这报告为启动失败。`DelorunStudio.useStockLook(): Promise<boolean>` 通过上游的配置表单写入 `studioAdditions: false`，并返回 Host 是否接受了该写入。
- **Host 应答之前。** 在设置表单第一次应答之前，插件跟随 host 一半打印到页面中的设置（`delorunThemeSettings`，[`src/boot-settings.ts`](src/boot-settings.ts)），所以在以 Delorun 外观提供的页面上，外观、各部分和 `ctx.delorunStudio` 在 studio 启动时就已就位，每个 Delorun studio 插件都在 studio 首次渲染之前注册，而不是在 stock 侧栏已经显示之后。表单的第一次应答会取代它们：如果在页面提供之后开关被关闭，则变为 stock 外观；Host 不提供该行时则什么都没有。以 stock 外观提供的页面不携带任何设置，校验不通过的已打印设置会以控制台警告报告；两种情形下，插件在表单应答之前都不注册任何内容，也不提供任何服务，并在表单之后重新加载时释放所有内容。
- **导出。** `@delorun/plugin-theme/client` 导出 `THEME_ROW_ID`（`'delorun-theme'`）、带选项列表和类型的 `ThemeSettings`（`ACCENT_CHOICES`、`PALETTES`、`TYPEFACES`、`DENSITIES`、`EFFORT_DISPLAYS`、`DEFAULT_SETTINGS`）、`DelorunStudio`、各部分和行的 id（`SECTION_ID`、`CONVERSATION.id`、`LOOK_ROW.id`、`STUDIO_ROWS`）及其顺序、`STOCK_ATTRIBUTE` 和 `ThemeController`。在别处（例如引导）提供外观选择的包，通过 `ctx.configForms` 写入 `THEME_ROW_ID` 的 `studioAdditions` 字段。
- **品牌。** 主题行的 `branding` 设置保存本人自己的品牌：显示或隐藏标志、名称、图标（Delorun 标志、选取的工作区图标，或上传的不超过 256 KB 的 PNG、JPEG 或 WebP）以及问候语。[`@delorun/brand/branding`](../brand/src/branding.ts) 在每个读取它的位置校验每个字段：浏览器（「外观」部分的「品牌」块、hero、侧栏页眉、标签页标题和 favicon）、host 的固定图标路由 `/delorun/branding/icon`，以及 `@delorun/home-auth`（它读取同一设置行来为其登录和配对页面加上品牌）。校验不通过的记录显示 Delorun 的默认值，并在该块中给出提示。上传的图像只存储一次，位于 home 之下的 `storages/delorun-theme/branding-icon`，更新时的会话数据复制已包含它；该行只保存其 SHA-256 哈希。对图标路由的 `POST` 在 host 上检查字节（按前几个字节判断为 PNG、JPEG 或 WebP，最大 256 KB，绝不接受 SVG），原子地写入文件并应答哈希；已批准的设备可以像写入任何日常设置那样提交它。`GET` 只在文件的哈希与该行的哈希相符时才提供该文件，所以被替换或缺失的文件显示默认值。文件存储出现之前的行（以 base64 保存图像）仍可读取，并在下次保存时迁移到文件；重置 profile 会留下与任何文件都不匹配的哈希，此时显示默认值。host 把不含任何上传内容的记录打印到页面中。选取的图标按 id 从随附的图形集中绘制（`@delorun/brand/picked-icon`）用于登录页面和标签页图标，在 studio 中则通过 `@delorun/plugin-sidebar` 以 `ctx.delorunSidebar` 共享的组件绘制。
- **Host 一半。** [`src/index.ts`](src/index.ts) 存储这些设置，并告知设置服务不要为该行构建自动表单，因为「外观」部分和「通用」行会编辑它。开关开启期间，它通过 `webserver/index-inject` 把调色板、强调色、密度和对比度打印为一行 `style`，使首次绘制就已是 Delorun 的外观；打印一行 `global` 行 `dshBootWordmark` = `Delorun`（`BOOT_WORDMARK_GLOBAL`、`BOOT_WORDMARK`），上游的启动页把它读作自己的字标；并打印一行 `global` 行 `delorunThemeSettings`（`BOOT_SETTINGS_GLOBAL`），保存当前设置，浏览器一半在其设置表单应答之前跟随它。开关关闭期间，host 不打印其中任何一项。

<a id="configuration"></a>

## 配置

| 字段 | 值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `studioAdditions` | 布尔值 | `false` | C16 开关 `studio_additions`：开启时是 Delorun 的外观和每个 Delorun studio 插件；关闭时是上游的 stock 外观。 |
| `palette` | `soft`、`t3-code`、`t3-chat`、`grove`、`ocean`、`ember`、`iris`、`custom` | `soft` | 调色板。前七个是预设，各自固定自己的颜色和强调色：Soft、Slate（`t3-code`）、Berry（`t3-chat`）、Grove、Ocean、Ember 和 Iris。`custom` 使用 Soft 的界面色，外加下面的强调色和对比度。这两个 id 保留已保存选择所用的名称。保存的设置里若预设旁边带有被更改的强调色或对比度，会被读作 `custom`（[`lookOf`](src/palette/migrate.ts)）：Soft 保留它的强调色和对比度，而对比度被更改的 T3 Code 预设只保留它的强调色。 |
| `accent` | `peach`、`cobalt`、`moss`、`mono`、`custom` | `peach` | 主要按钮、链接、开关和焦点的强调色，只在 `custom` 调色板下读取。 |
| `customAccent` | `#RRGGBB` | `#E5734A` | `accent` 为 `custom` 时使用的颜色。 |
| `typeface` | `delorun`、`system` | `delorun` | Schibsted Grotesk 和 JetBrains Mono，或上游的字体栈。 |
| `density` | `compact`、`comfortable`、`spacious` | `comfortable` | `--dsh-density`，间距规则所乘的比例：0.8、1 和 1.2。 |
| `contrast` | 50 到 200，步长 5 | `100` | 低于 100 时，次要文字和分隔线向页面靠拢；高于 100 时向主要文字靠拢。 |
| `effort` | `label`、`bars` | `label` | 模型选择器如何显示推理强度。 |

每个字段都是易变的，所以「外观」部分和「通用」行在 studio 运行时即可编辑它。

<a id="the-look"></a>

## 外观

开关开启期间，浏览器一半（[`src/client/index.ts`](src/client/index.ts)）注册以下内容，并在开关关闭或插件被释放时释放它们：

- **令牌层**，通过 `ctx.theme.overrideTokens`，每层一个来源：调色板、强调色、字体、密度和对比度（[`LAYERS`](src/client/controller.ts)）。颜色是 OKLCH 种子，从上游的令牌表生成两种配色方案；强调色是单独的一层，每个文字角色得到一个在其表面上达到 4.5:1 的文字安全色度。调色板还会加深或提亮次要和第三级标签角色，直到在默认强调色和对比度下、两种配色方案中，每个都在每个不透明背景角色（[`TEXT_SURFACES`](src/palette/soft.ts)）上达到 4.5:1。密度层还定义间距令牌 `--delorun-space-1` 到 `--delorun-space-9`（2、4、6、8、12、16、20、24 和 32 px），每个都乘以 `var(--dsh-density, 1)`，它们只在外观开启期间存在。浅色、深色和跟随系统仍是上游的偏好设置。
- **字体和强度条**，作为一个 `<style data-plugin="@delorun/plugin-theme">` 元素：构建时 `scripts/copy-brand-fonts.ts` 从 `@delorun/brand` 复制到 `src/client/assets/fonts` 的两个拉丁字体文件，以及在 `effort` 为 `bars` 期间，把模型选择器的 `data-effort-level` 说明文字绘制成条形的规则。
- **设置部分。** 每个部分绘制自己的 `<h3>` 卡片标题，由设置面板的 `--dsh-settings-card-heading-*` 变量设定样式，所以无论是否使用分组的设置布局，显示效果都相同。`delorun-appearance`（顺序 1）是两张卡片：「Colours」（配色方案为一行分段控件，主题为以“自定义”结尾的方块网格，外加一个紧凑的实时示例；只有选择“自定义”时，强调色和对比度才会内联显示）和「Branding」（`BrandingSection`，由该部分用它自己的字典 `settings.delorunBranding` 渲染）。`delorun-conversation`（顺序 2）在两张卡片中编辑上游 `ui-chat` 的显示设置：「Detail」（带实时预览的显示预设、作为选择框的思考、步骤分组、实时详情和终端输出）和「Folding」（折叠已完成的轮次、何时折叠以及哪些回复保持展开）。它只在 Host 提供该命名空间时出现。
- **「通用」行**（`settings.general.item`，使用「外观」字典），每一行写入此插件设置的一个字段（[`STUDIO_ROWS`](src/client/index.ts)）：

  | Id | 顺序 | 标题 | 控件 | 写入 |
  | --- | --- | --- | --- | --- |
  | `delorun-look` | 1 | Delorun look | 一个开启状态的开关 | 关闭它会通过 `useStockLook()` 写入 `studioAdditions: false` |
  | `delorun-typeface` | 10.5 | Typeface | 带样本的图块 | `typeface` |
  | `delorun-density` | 11.5 | Density | 以各档间距显示行的图块 | `density` |
  | `delorun-effort-labels` | 20.5 | Reasoning effort labels | Name / Bars | `effort` |

  这些顺序在没有布局安排它们时，把它们放在上游的行之间：Typeface 位于配色方案（10）和字号（11）之间，Density 位于字号之后，Reasoning effort labels 位于输入框的 Enter 行为（20）之后。`delorun-look` 也是 stock 外观的行 id；两者从不同时注册。
- **「新建 Session」hero。** 文字字标（`hero.mark`，品牌字典中的「Delorun」）位于 `conversation.hero.brand.mark`，其宽高至少与上游对所请求大小的标志一样大，使标题保持其位置；标题位于 `conversation.hero.headline`。侧栏中的品牌标志属于 `@delorun/bundle-local`。
- **词汇。** 对 [`src/client/vocabulary.ts`](src/client/vocabulary.ts) 的每个命名空间和语言区域各做一次 `ctx.locale.override`，在上游说「session」之处说「chat」，然后是 [`src/client/copy.ts`](src/client/copy.ts) 中手写的修正，有英文和中文。`scripts/gen-vocabulary.ts` 根据上游的字典写出第一个文件。
- **`ctx.delorunStudio`**，在同一时段内提供。

各部分和行的 CSS 使用上游的令牌（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-*`）和间距令牌；不属于这两者的几何尺寸，是每个部分或行各声明一次的命名自定义属性；除卡片标题（其字重是设置面板的变量）之外，字重不超过 500；过渡只在 `prefers-reduced-motion: no-preference` 之下运行；调色板种子是 TypeScript 中的数据。卡片、行框架、单选组和预览图块来自 [`@delorun/settings-controls`](../settings-controls/README.zh.md)：两三个简短的选项是单选组（`ChoiceGroup`），只有一个 Tab 停靠点，方向键移动选择；需要图示的选项是预览图块（`TileGroup`）；五种思考显示方式是一个选择框，即位于按钮之后的上游 `Menu`。各部分在手机宽度下重新排布：图块保持各自的行并缩小，其他每一行换行。

<a id="the-stock-look"></a>

<a id="alerts-and-pop-ups"></a>

## Alerts and pop-ups

While the look is on, the style element also carries [`src/client/alerts.css`](src/client/alerts.css), the one quiet glass style of every alert and pop-up in the studio. The stock look removes it with the rest of the element, so upstream's toast and dialog keep upstream's styles.

- **Surface tokens** on `body`, which follow the scheme: `--delorun-glass-fill` (`--dsw-alias-bg-layer-1` at 86% opacity), `--delorun-glass-fill-solid`, `--delorun-glass-blur` (a 24 px backdrop blur), `--delorun-glass-edge` (a 1 px `--dsw-alias-border-l2` hairline), `--delorun-glass-shadow` and `--delorun-glass-shadow-raised` (a contact shadow under a soft drop, stronger in dark, where a 1 px top highlight is added), `--delorun-glass-radius` (`--dsw-radius-md`) and `--delorun-glass-radius-dialog` (`--dsw-radius-lg`). The surface is opaque where `backdrop-filter` is unsupported, under `prefers-reduced-transparency: reduce` and under `prefers-contrast: more`, which also takes the stronger `--dsw-alias-border-l4` edge.
- **The alert** is [`@delorun/brand`'s `Alert`](../brand/README.zh.md): a 24 px tinted circle with a 14 px glyph of its own for each kind (info, success, warning, error, progress), a 14 px title at weight 500, one 13 px line in `--dsw-alias-label-secondary`, a tinted text button (`--delorun-alert-action`, the accent's text colour mixed 80% with the primary text, on 8% of the accent, 12% in dark), a quiet button and an optional close. Its variants are `inline` (a column such as the sidebar), `toast` (at most 380 px) and `banner` (actions on the text's row). A dialog uses `delorun-glass` with `data-variant="dialog"` (440 px, 24 px padding) and puts its actions in `delorun-alert-dialog-actions`, secondary first and primary last.
- **Motion:** an 8 px slide and fade in over 200 ms (`--delorun-alert-ease`, a soft ease-out) and out over 150 ms, as transitions on `transform` and `opacity`, so a leave that starts mid-enter turns back from where the card is. Under `prefers-reduced-motion: reduce` nothing slides or fades, and the progress glyph stops turning.
- **Upstream's surfaces,** through stable attributes and without edits: the toast (`[data-toast-area] > [role='alert']`) becomes the glass card, with its glyph in a tinted circle and its action in the action colour, and it enters and leaves by the same slide toward the toast position the person chose; the dialog (`[role='presentation'] > [role='dialog'][aria-modal='true']`, so also `@delorun/brand`'s `Dialog`) takes the glass at dialog size and the same enter.
- **Contrast:** the title, the line and the tinted action reach 4.5:1 on the glass in every preset palette and both schemes, over a page covered in dense text under the blur ([`alerts.client.spec.ts`](tests/alerts.client.spec.ts)).

## stock 外观

开关关闭期间，Delorun 外观的任何内容都不生效：没有令牌层，没有字体，没有 style 元素，没有首次绘制样式，没有各部分，没有标题，没有词汇，也没有服务。插件在 `settings.general.item` 中注册一行（`delorun-look`，位于「语言」之后），带一个标为「Delorun look」的开关和一行说明；开启它会写入 `studioAdditions: true`，studio 无需重新加载即可恢复。它还在 `<html>` 上设置 `data-delorun-stock`，并移除页面提供时带有的首次绘制 style 元素（通过 `FIRST_PAINT_MARK`，即其文本的开头找到它），所以上游的颜色立即恢复。释放浏览器一半也会移除该元素。studio 一半的「外观」行是同一个开关的另一面：它处于开启状态，关闭它会调用 `useStockLook()`。

<a id="palettes-and-attribution"></a>

## 调色板与署名

Soft 是 Delorun 自己的。T3 Code 的六个主题以 [`src/palette/t3-themes.ts`](src/palette/t3-themes.ts) 为种子，该文件由 [`scripts/sync-t3-themes.ts`](scripts/sync-t3-themes.ts) 在记录的提交上从 T3 Code（MIT，© 2026 T3 Tools Inc.）复制而来；[`src/palette/t3.ts`](src/palette/t3.ts) 据此推导每个调色板：灰色的色调、浅色页面和侧栏的明度，以及它在两种配色方案中的强调色。生成器填充其余部分。[`src/palette/stock.ts`](src/palette/stock.ts) 是上游令牌表的副本，由 `scripts/sync-stock-palette.ts` 写出。字体是 Schibsted Grotesk 和 JetBrains Mono，各自采用 SIL Open Font License 1.1。许可文本和 T3 Code 的声明位于 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 和 [`fonts/`](fonts)，本包同时发布两者。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-theme` 运行本包的规格。`.spec.ts` 规格导入上游已构建的包，需要 `pnpm run build:artifacts`；`.spec.tsx` 规格在 jsdom 中针对上游的源码运行。

- [`palette.spec.ts`](tests/palette.spec.ts) 让生成的调色板符合上游的令牌表和 WCAG：正文文字角色在其表面上达到 4.5:1，标记达到 3:1，覆盖 Soft 的每个预设强调色和边缘情形的自定义强调色，以及每个 T3 Code 主题，两种配色方案均如此；次要和第三级标签角色在两种配色方案中、每个调色板的每个不透明背景角色上都达到 4.5:1。它还覆盖间距令牌、对比度设置、首次绘制样式和颜色运算。
- [`t3.spec.ts`](tests/t3.spec.ts) 和 [`t3-broken.spec.ts`](tests/t3-broken.spec.ts) 覆盖 T3 Code 源解析器、随附的主题，以及对缺少某个角色的主题文件的拒绝。
- [`vocabulary.spec.ts`](tests/vocabulary.spec.ts) 在已提交的词汇与生成器根据上游字典写出的内容不同时失败，并检查手写修正以及强度条所读取的属性。
- **main 地标。** Delorun 外观开启期间，[`src/client/landmark.ts`](src/client/landmark.ts) 把上游的主面板（`data-slot="main"`，上游框架中的普通 `div`）标记为 `role="main"`，每当框架重新渲染该面板时都会再次标记，并随外观一起去掉该角色。已经带有角色的面板保持不动。
- [`host.spec.ts`](tests/host.spec.ts) 检查设置的默认值、`studioAdditions` 是默认值为 `false` 的易变字段，以及首次绘制样式、启动字标和设置只在开关开启期间打印。
- [`landmark.client.spec.tsx`](tests/landmark.client.spec.tsx) 检查主面板在存在时、之后出现时以及被框架替换时都会被标记，已有角色的面板保持不动，以及释放会移除该角色并停止监视。
- [`boot-settings.client.spec.tsx`](tests/boot-settings.client.spec.tsx) 读回已打印的设置，并拒绝缺少字段或含有配置不接受的字段的值。
- [`alerts.client.spec.ts`](tests/alerts.client.spec.ts) holds the alert sheet to the `Alert` component's classes, the opaque fallbacks, transform-and-opacity motion that stops under reduced motion, and AA contrast on the glass.
- [`studio.client.spec.tsx`](tests/studio.client.spec.tsx) 证明该开关：关闭时没有服务、层、style 元素、字体、部分或词汇，只注册「通用」行；开启时，服务、外观、hero 字标和四个「通用」行都存在，各行通过主题行的表单写入，外观离开或插件被释放之后，首次绘制元素消失；`useStockLook()` 会卸载依赖它的插件；没有已打印的设置时，Host 应答之前不注册任何内容；有已打印的设置时，外观和服务（因而依赖它的插件）在表单加载期间已就位，表单的第一次应答会取代它们，无效的已打印设置会被报告并忽略。
- [`appearance.client.spec.tsx`](tests/appearance.client.spec.tsx)、[`appearance-rows.client.spec.tsx`](tests/appearance-rows.client.spec.tsx)、[`conversation.client.spec.tsx`](tests/conversation.client.spec.tsx)、[`look-row.client.spec.tsx`](tests/look-row.client.spec.tsx) 和 [`controller.client.spec.tsx`](tests/controller.client.spec.tsx) 渲染各部分、各行和控制器：每个控件写入其字段，标题指明各自的部分，「思考」选择框会打开所提供显示方式的菜单。

<a id="limits"></a>

## 限制

- 浏览器一半在运行时不能导入另一个 Delorun 包，因为页面的模块表只提供上游的包。
- 本插件不注册任何侧栏品牌标识。
- 关闭开关不会重新加载页面；首次绘制 style 元素被移除，`<html>` 上的 `data-delorun-stock` 阻止任何副本生效。
- 启动页只在 host 打印了 `dshBootWordmark` 之后提供的页面上显示字标。

## 共享控件与 Safari 边缘

芯片控件（`ChipGroup`、`ThemePicker`、`AccentPicker`）以及设置 → 外观与引导的「外观」步骤共用的 `StudioLookSwitch`，位于 [`@delorun/brand`](../brand/README.zh.md) 这一唯一的控件集中；[`src/client/controls`](src/client/controls) 只把它们重新导出为 `@delorun/plugin-theme/controls`。[`src/client/edges.ts`](src/client/edges.ts) 根据当前主题的令牌绘制两条固定的、`aria-hidden` 的边缘条（在屏幕外 7px、位于页面之上）、`html` 和 `body` 的背景以及一个 `theme-color` 标签，使移动版 Safari 的状态栏和工具栏延续 studio 的样子。它向页面的 viewport 标签添加 `viewport-fit=cover`，并在释放时恢复所有更改。
