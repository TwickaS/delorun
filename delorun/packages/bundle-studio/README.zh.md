---
description: "Delorun 的 studio bundle，供维护者修改 Delorun 的 CLI profile 挂载哪些 studio 插件，以及回到 stock 外观的唯一开关如何触达它们。"
kind: "package-bundle"
---

# @delorun/bundle-studio

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/bundle-studio` 是在每个 Delorun CLI profile 中挂载 Delorun studio 增强功能的 bundle：主题、设置布局、chat 状态、侧栏和引导，以及两个可选插件，即费用计量器和「思考」标签页，它们的行在本人开启之前保持禁用。它不含代码；其 [`cordis.patch.yml`](cordis.patch.yml) 为每个插件插入一行，并在主题行上开启 [C16](../../docs/contracts/c16-parity-composition.zh.md) 开关 `studio_additions`。设置中的一个开关即可关闭所有这些功能，只留下上游的 studio，即 stock 外观。

## 目录

- [使用此 bundle](#use-this-bundle)
- [行](#rows)
- [首次运行的密钥对话框](#the-first-run-key-dialog)
- [stock 外观](#the-stock-look)
- [测试](#tests)

<a id="use-this-bundle"></a>

## 使用此 bundle

- **bundle 列表。** `@delorun/bundle-local` 的 [`DELORUN_PROFILE_BUNDLES`](../bundle-local/src/profile.ts) 把此 bundle 列在 `@delorun/bundle-local` 之后，所以 `delorun setup` 会把它写入创建的每个 CLI profile，并像链接每个 Delorun bundle 那样把它链接进 profile。在此 bundle 出现之前创建的 profile 没有列出它，保持 stock 外观。
- **层顺序。** 此 bundle 在每个上游 bundle 和 `@delorun/bundle-local` 之后、profile 自己的 `cordis.patch.yml` 之前应用，所以本人在设置中修改的、写入 profile 补丁的设置，优先于这里的行。
- **加载。** `delorun` 拒绝启动其 loader 跳过了 `@delorun/` 作用域内某个 bundle 的 CLI profile，所以列出此 bundle 却无法解析它的 profile 不会带着一半的 studio 启动。
- **构建。** 每个插件的 `pnpm --filter <package> run build` 会写出其 `lib/index.js` 和 `lib/client.js`；上游的 `pnpm run build:artifacts` 不构建 Delorun 的包。
- **详情页。** `locale/en.json` 在 `meta.detail` 中指明 `docs/DETAIL.md`，即 Plugins 为此 bundle 显示的、代替本 README 的简短文字：它新增了什么、如何打开某个附加功能，以及如何切换回 stock 外观。

<a id="rows"></a>

## 行

| 行 | 插件 | 它添加的内容 |
| --- | --- | --- |
| `delorun-theme` | [`@delorun/plugin-theme`](../plugin-theme/README.zh.md) | Delorun 的调色板、强调色、字体和密度，「外观」和「对话」部分，以及开关 `studioAdditions`（此处设为 `true`） |
| `delorun-settings-layout` | [`@delorun/plugin-settings-layout`](../plugin-settings-layout/README.zh.md) | 按主题分组并带搜索的设置 |
| `delorun-chat-states` | [`@delorun/plugin-chat-states`](../plugin-chat-states/README.zh.md) | 暂缓和搁置 chat，以及对应的搁架 |
| `delorun-sidebar` | [`@delorun/plugin-sidebar`](../plugin-sidebar/README.zh.md) | 以卡片形式显示的 chat 列表、工作区图标和页眉图案 |
| `delorun-onboarding` | [`@delorun/plugin-onboarding`](../plugin-onboarding/README.zh.md) | 以新 chat 结束的首次运行引导；此 bundle 把它的 `plugins` 设为随 DeepSeek Harness 一起发布的五个实验性插件：会话搜索、终端 bundle、worktree 工具、会话标题和 DeepSeek 网站 chat 导入（可选 bundle，开启前保持关闭），并把它的 `optionalRows` 设为下面两行，引导会提议开启它们 |
| `delorun-preview-flags` | [`@delorun/preview-flags`](../preview-flags/README.zh.md) | 预览开关：插件声明为尚未面向所有人的工作室功能，在本行的 `flags` 打开之前均为关闭（`delorun preview on <flag>`） |
| `delorun-cost-meter` | [`@delorun/plugin-cost-meter`](../plugin-cost-meter/README.zh.md) | 输入框下方的 chat 估算费用；以 `disabled: true` 插入，所以只有在本人于侧栏「插件」的 Delorun studio 页面中「组件」下开启后才会挂载 |
| `delorun-thinking-rsvp` | [`@delorun/plugin-thinking-rsvp`](../plugin-thinking-rsvp/README.zh.md) | 「思考」标签页，在右侧栏逐词显示模型的推理和回复；与费用计量器一样以 `disabled: true` 插入 |

<a id="the-first-run-key-dialog"></a>

## 首次运行的密钥对话框

- **关闭。** 此 bundle 的 `ui-settings-models` 补丁设置 `credentialOnboarding: false`（并重申来自 `@delorun/bundle-local` 的 `welcomeNotice: false`，因为补丁会替换该行的整个配置），所以上游的「添加 API 密钥」对话框从不打开，重新加载后也是如此。`@delorun/plugin-onboarding` 的无密钥横幅取代了它；设置 → Agent → 模型以及模型选择器仍可添加密钥。stock 外观保留该补丁，因此上游的对话框不会在那里重新出现。

<a id="the-stock-look"></a>

## stock 外观

- **一个开关。** 主题行的 `studioAdditions` 就是 C16 开关 `studio_additions`。它的 Config 默认值是 `false`，即一致性值；此 bundle 把它设为 `true`，注册表的默认值 `true` 由 `parity-switches` 规格对照此行检查，所以两者不会漂移。
- **它如何触达每个插件。** 开关开启时，主题的浏览器一半提供 `delorunStudio` 服务。这里其他每个插件的浏览器一半，都在对该服务的一次注入之内注册其全部内容，所以关闭开关会释放这一切，studio 显示上游的侧栏、设置和外观。harness 一半继续运行：已暂缓和已搁置的 chat 保持存储，并在重新开启开关时恢复。
- **本人在哪里找到它。** 开启 Delorun 外观时，设置 → 通用 → 外观提供该选项；使用 stock 外观时，上游的「通用」部分显示一行用于重新开启 Delorun 外观，Delorun 外观的其余内容都不保留。
- **一致性组合。** 录制会话回放所运行的 profile 都不挂载此 bundle，所以该开关保持其 Config 默认值（关闭），任何插件都不会挂载。

<a id="tests"></a>

## 测试

- `delorun/apps/tools/tests/parity/switches.spec.ts` 让注册表中 `studio_additions` 的默认值符合此 bundle 补丁的主题行。
- `delorun/packages/bundle-local/tests/composition.integration.spec.ts` 带着此 bundle 组合 Delorun CLI profile，并检查它插入的各行。
