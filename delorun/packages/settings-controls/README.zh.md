---
description: "Delorun 的各个设置分区共用的设置控件，供维护者构建或修改 Delorun 的分区或“通用”行。"
kind: "package-library"
---

# @delorun/settings-controls

[English](README.md) | 中文

## 摘要

`@delorun/settings-controls` 重新导出 [`@delorun/brand`](../brand/README.zh.md)（唯一来源）中、每个 Delorun 设置分区所用的控件，使不同插件的分区外观与行为一致：带句首大写标题的卡片、单项设置的标题与帮助、“通用”行的框架、单选分段控件和预览图块。插件专用的控件，例如顶部图案条或对比度滑块，仍留在各自的插件中。入口是 `src/index.ts`，以 `.` 从源码导出。

## 目录

- [使用本包](#use-this-package)
- [约定](#contract)
- [测试](#tests)

<a id="use-this-package"></a>
## 使用本包

带设置界面的 Delorun 插件从 `@delorun/settings-controls` 导入这些控件，在 `dependencies` 中列出本包，并像内联约定包那样，通过 `tsdown.config.ts` 中本包与 `@delorun/brand` 的别名把它内联进浏览器包：页面的模块表在运行时不提供 Delorun 的包。`@delorun/plugin-theme`、`@delorun/plugin-sidebar`、`@delorun/plugin-chat-states` 和 `@delorun/bundle-local` 使用本包。

| 导出 | 绘制内容 |
| --- | --- |
| `SettingsCard` | 由其 `<h3>` 标题命名的 `<section>`，可选的一句话描述，然后是带边框的框；`cardCss` 提供卡片栈、框内的块与行以及失败提示行所用的类 |
| `SettingHeading` | 卡片内单项设置的标题和一行帮助 |
| `SettingRow` | 与上游偏好行布局一致的“通用”行：标题、描述和失败提示行，之后是控件；图块的控件则位于下方 |
| `ChoiceGroup` | 两到三个互斥选项，排成一行分段，作为单选组公开：被选中的分段是唯一的 Tab 停靠点，方向键移动选择 |
| `TileGroup` | 需要配图的互斥选项，作为预览图块的单选组 |

<a id="contract"></a>
## 约定

- **标题。**卡片标题读取上游的 `--dsh-settings-card-heading-*` 属性，这些属性由 `@delorun/plugin-settings-layout` 为设置面板绘制的卡片设置，因此 Delorun 分区的标题与面板的标题一致；没有这些属性时，标题保持同样的句首大写外观。
- **选项是单选。**`ChoiceGroup` 和 `TileGroup` 是受控组件：它们仅在值不同于当前选中值时调用 `onChange`，从不以当前选中值调用；已禁用的组拒绝一切选择。
- **间距。**卡片和图块使用 Delorun 外观的 `--delorun-space-*` 档位；`SettingRow` 声明自己的间距，因为原版外观中切回 Delorun 外观的开关会用到它，而那里没有这些档位。
- **文案。**每个控件的文本都由调用方本地化后传入，控件自身不含任何文案。

<a id="tests"></a>
## 测试

规格与源码放在一起：`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/brand` 运行 [`settings-choice-group.client.spec.tsx`](../brand/tests/settings-choice-group.client.spec.tsx)（检查单选语义和方向键）与 [`settings-cards.client.spec.tsx`](../brand/tests/settings-cards.client.spec.tsx)（检查卡片、单项设置标题、行框架和图块）。
