---
description: "Delorun 网站和文档站共用的部分：页眉、页脚、主题控件、外观样式表，以及外观如何在两个站点之间传递，供任一站点的维护者阅读。"
kind: "package-library"
---

# @delorun/site-design

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/site-design` 收纳 `delorun.com` 和 `docs.delorun.com` 共用的部分，让两个应用用起来像一个站点：页眉、页脚、主题控件、搜索框、外观样式表、提示消息和更新日志读取器。这些组件只用 `@delorun/brand` 绘制，显示的每个词都来自调用方的语言。

## 目录

- [使用这个包](#use-this-package)
- [外观](#the-looks)
- [在两个站点之间传递外观](#carrying-a-look-between-the-sites)
- [共用部分](#the-shared-parts)
- [体积](#weight)
- [测试和工具](#tests-and-tools)

## 使用这个包

每个站点都是独立的工作区根，因此各自以 `"@delorun/site-design": "link:../../packages/site-design"` 列出这个包，并通过 tsconfig 和 Vite 配置里的 `@design/*` 路径别名导入它的源码。仓库的根工作区也包含这个包，这样包状态检查能看到两个站点都用到了它。

## 外观

`scripts/looks.ts` 导入 `@delorun/plugin-theme` 的调色板生成器，为每个主题的浅色和深色解析出品牌令牌读取的颜色角色。`src/looks.css` 和 `src/look-swatches.ts` 是它的输出。一个外观是一条以 `data-look` 为键的规则（自定义主题还有 `data-accent`）。对比度是在 CSS 中混合的一个数值，档位为 `default`、`high` 和 `highest`：调色板把次要文字恰好放在 AA 下限，所以任何档位都不会让它变弱。密度是一个乘数。调色板改变后，在本包里运行 `node scripts/write-looks.ts`；文件过期时测试会失败。样式表保留 T3 Code 的版权注释，`scripts/notices.ts` 读取网站声明页展示的许可证文本。

## 在两个站点之间传递外观

从一个站点到另一个站点的链接用 `?look=ocean` 携带外观；当 `accent`、`density`、`contrast` 和 `scheme` 与默认值不同时，也一并携带。`src/head-script.ts` 是两个站点放进 `<head>` 的脚本：它跟随设备的浅色或深色设置，只读取一次查询参数，忽略任何它不认识的值，把这些参数从地址中移除，并把外观写成根元素上的属性。不会向 Cookie 或存储写入任何内容，所以重新加载会回到默认外观。

## 共用部分

- **页眉和页脚。** `SiteHeader` 和 `SiteFooter` 的文字和链接都来自调用方。标志始终是桃色（`ProductMark`），不随外观变化。
- **主题控件。** 一个按钮，打开紧挨着它放置的原生弹出层。它只在脚本运行后绘制。菜单和提示消息在首次使用时才加载。
- **搜索框。** `SearchForm` 是指向文档 `?search=` 地址的普通 GET 表单，脚本运行后用隐藏字段携带外观。

## 体积

产品网站的首屏压缩后必须保持在 120 KB 以内。`scripts/chunk-modules.ts` 根据源码映射（`vite build --sourcemap`）按源模块列出已构建的分块，用来找出入口脚本里有什么。

## 测试和工具

`tests/` 检查样式表是最新的、主题及其名称与工作室一致、每个外观里每个表面上的文字都达到 AA、头部脚本与 `src/looks.ts` 一致，以及标志保持桃色。`scripts/shots.ts` 为本地提供的页面截图，并打印页面在存储和 Cookie 中保留了什么。
