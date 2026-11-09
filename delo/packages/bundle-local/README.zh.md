---
description: "Delo 的本地组合包，供维护者修改 Delo 的 CLI profile 在上游 web 模板之上所组合的内容：组合包列表、上游两个选择加入项的隐私默认值、设置中的“隐私”分区，以及使组合与上游保持一致的 spec 测试。"
kind: "package-bundle"
---

# @delo/bundle-local

[English](README.md) | 中文

## 摘要

`@delo/bundle-local` 是 Delo 的 CLI profile 在上游的 `web` profile 模板之后加入的组合包。它的 patch 保存 Delo 的本地集成行，每一行的理由都列在 [`LOCAL_ROWS`](src/rows.ts) 中，因此 Delo 的 CLI profile 在组合上游的 web profile 时，只改变或新增这些行，其他一概不变。它关闭上游的两个选择加入项，即 DeepSeek 的会话日志上传与桌面端分析，并新增设置中的“隐私”分区；本人在该分区中经同意对话框后打开每一项，也可以再次关闭（[C11](../../docs/contracts/c11-setup-answers.zh.md)）。Delo 的基础设施插件到达时，会各自添加自己的行。

## 目录

- [使用本组合包](#use-this-bundle)
- [行](#rows)
- [“隐私”分区](#the-privacy-section)
- [测试](#tests)
- [限制](#limits)

<a id="use-this-bundle"></a>
## 使用本组合包

- **组合包列表。**[`DELO_PROFILE_BUNDLES`](src/profile.ts) 从 `@delo/bundle-local/profile` 导出，是 Delo CLI profile 有序的 `dsh.profile.bundles` 列表：先是上游的 `web` 模板，从 `@deepseek-ai/dsh-official-bundles` 读取，然后是 `@delo/bundle-local`。上游自身的模板并不列出本组合包，因此 `dsh --profile web` 与录制会话的回放只组合上游的组合包。
- **`delorun` 的职责。**`delorun` 负责创建 `~/.delo/profiles/` 之下的 CLI profile（[C1](../../docs/contracts/c01-home-layout.zh.md#profiles)），把 `DELO_PROFILE_BUNDLES` 写入其创建的每个 CLI profile；当上游的 profile 加载器在 `skippedBundles` 中报告本组合包时，它拒绝启动该 CLI profile，因为隐私默认值只在本组合包加载时才成立。本包两件事都不做。
- **层顺序。**本组合包在每个上游组合包之后、profile 自身的 `cordis.patch.yml`、home patch 与 `--patch` overlay 之前生效，因此本人在 profile 中的设置仍然优先于此处的行（[上游的 profile 层](../../../apps/cli/README.zh.md#profiles)）。“隐私”分区写入 profile 的 `cordis.patch.yml`。
- **读取组合结果。**`dsh --profile <name> --dump-config` 会在每个 `# ==` 行之下打印全部组合后的行。该标注写明插入此行的组合包，以及修补此行的每个组合包；本组合包写入的行，在该标注中写有 `@delo/bundle-local`。
- **加载。**本组合包未声明 `engines.dsh` 范围，也没有上游的对等依赖，因此版本变更之后，上游的兼容性检查从不会跳过它；若 profile 的组合包列表中列出了它却无法解析，则会把该组合包报告为已跳过。
- **声明文字。**`./statements` 导出即隐私分区的英文词典（[`src/client/locales.ts`](src/client/locales.ts)），`delorun` 的 setup 读取它，使提问与该分区陈述相同的句子。
- **构建。**`pnpm --filter @delo/bundle-local run build` 写出 `lib/index.js`（即 `delo-privacy` 行的 Host 部分）与 `lib/client.js`（即“隐私”分区）。上游的 `pnpm run build:artifacts` 不构建 Delo 的包。

<a id="rows"></a>
## 行

[`LOCAL_ROWS`](src/rows.ts) 列出 Delo CLI profile 与上游 web profile 有所不同的每一行，以及该行在 C16 对等组合中的形式：

| 行 | 类型 | 在 Delo CLI profile 中 | 在上游的 web profile 中 | 在对等组合中 |
| --- | --- | --- | --- | --- |
| `session-log-deepseek` | 改变 | `config.enabled: false`：模型请求不携带 `dsh_session_log` 字段 | 插件的默认值，即 `true` | 沿用上游的组合：覆盖层省略该行，因为它跟随每次回放的根配置，而根配置按语料库设定上传 |
| `deepseek-account` | 改变 | `disabled: true`：没有 DeepSeek 账户登录、Platform、用量或充值页面；`llm-deepseek-account` 在没有账户的情况下保持不可用 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `product-analytics` | 改变 | `config.enabled: false`，重申上游的 `appVersion`，并保留上游的 `disabled` 条件，因此该行只在桌面 profile 中挂载，并且在 Delo CLI profile 中不接受任何事件 | `config.enabled: true` | 与此处所写相同；回放不挂载桌面端 Host |
| `session-telemetry-otel` | 改变 | `disabled: true`：反馈时不再把会话日志前缀发往 DeepSeek 的收集端 | 已启用，`FEEDBACK_ONLY` | 沿用上游的组合：覆盖层省略该行 |
| `tool-fs-search` | 改变 | `config.protectedReads: true`，并重申各组合包的 `sampleOverCapGlobResults: false`：`glob` 与 `grep` 拒绝 Delo 主目录下的路径，与文件工具一致 | 插件的默认值，即 `false`：该防护关闭，因此搜索可以到达主目录 | 沿用上游的组合：覆盖层省略该行 |
| `command-feedback` | 改变 | `disabled: true`：没有 `/feedback` 命令 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `ui-message-feedback` | 改变 | `disabled: true`：没有赞、踩以及反馈对话框；上游没有打开外部页面的行 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `ui-settings-account` | 改变 | `disabled: true`：没有账户菜单项、登录对话框与账户分区 | 已启用 | 沿用上游的组合：覆盖层省略该行 |
| `ui-settings-models` | 改变 | `config.welcomeNotice: false`：上游的预览提示关闭；`credentialOnboarding` 保持上游的值 | `welcomeNotice: true` | 沿用上游的组合：覆盖层省略该行 |
| `delo-privacy` | 新增 | “隐私”分区（位于设置中）、Delo 侧栏品牌（产品名称的文字形式，不显示标志），以及 Delo 自己的预览提示 | 无 | 存在且已禁用，因为录制的 Web 场景比较的是上游的界面输出、品牌与提示 |

[对等覆盖层](../../apps/tools/src/parity/composition/parity.overlay.yml) 以该形式重述本组合包的 patch，从而挂载本组合包；[`parityPatches`](src/rows.ts) 从本组合包的 `cordis.patch.yml` 推导出该形式，覆盖层与之不一致时，`parity-switches` 失败。Delo 的组合不向 DeepSeek 的反馈收集端发送任何内容：`session-telemetry-otel` 已禁用，反馈界面已隐藏，因为 Delo 目前还没有反馈的去处。上游自己的组合保留它们，对等组合沿用上游的行。没有任何行指明 Delo 主机。

<a id="the-privacy-section"></a>
## “隐私”分区

浏览器端部分（[`src/client/index.ts`](src/client/index.ts)）还注册 Delo 自己的预览提示（[`src/client/DeloNotice.tsx`](src/client/DeloNotice.tsx)），位于 `settings.onboarding` 插槽中、模型提供方的引导之前。它的文案在 locale 字典中，每个提示版本在每个浏览器只显示一次（`NOTICE_VERSION`），记录在本地存储中，仅作为每个查看者的便利。文档标题由 `DSH_CLIENT_TITLE` 构建，`delo/apps/tools/src/build-web.ts` 将其设为 `Delo`。在上游的“插件”分区之后，注册 `settings.section` `delo-privacy`（[`PRIVACY_SECTION_ID`](src/client/index.ts)）。它展示 C11 的声明（Delo 没有自己的遥测；两个选择加入项在本人打开之前均为关闭；发送反馈时会附带会话日志前缀，且只在发送反馈时发送），然后为每个选择加入项各列一行： 浏览器端部分还注册侧栏品牌的 occupant `sidebar.brand.name` 与 `sidebar.brand.mark`（[`src/client/brand.tsx`](src/client/brand.tsx)），以文字形式显示产品名称，不显示标志。两者都来自同一个 `delo-privacy` 行，因此禁用该行的对等组合保持上游的品牌。文档标题是构建设置 `DSH_CLIENT_TITLE`，不在 slot 系统之内。

- **DeepSeek 会话日志上传**编辑 `session-log-deepseek`，**桌面端分析**编辑 `product-analytics`，两者都通过上游为该行提供的配置表单进行（[`OPT_IN_ROWS`](src/client/index.ts)，来自 `@delo/contract-setup-answers`）。一次写入只改变该行的 `config.enabled`。
- **打开时**会弹出一个对话框，写明发送什么内容以及发往何处；在本人选择“打开”之前不写入任何内容，选择“取消”同样不写入。**关闭时**立即写入。
- 开关显示 Host 接受的值。被拒绝或失败的写入会使其保持不变，并在该行中予以说明。
- 未提供某选择加入项所对应行的 profile，不会为该项显示开关；对于桌面端分析，该行会说明只有桌面应用会收集它。

初始设置流程与其他界面通过 `ctx.settingsShell.openSection('delo-privacy')` 打开该分区。上游自身的 **设置 → 通用** 中的会话日志上传开关仍然保留，它编辑同一行，且不经对话框。该分区的文案同时提供英文与中文。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/bundle-local` 运行本包的 spec，它们导入上游已构建的包，因此需要 `pnpm run build:artifacts`；构建产物缺失时，Delo 的检查运行器会启动它。

- [`composition.spec.ts`](tests/composition.spec.ts) 在临时的 `DSH_HOME` 下构建一个 Delo CLI profile，并通过上游真实的 `dsh --profile <name> --dump-config` 读取它：列表中的每个组合包都已加载，且没有一个被跳过；转储结果中，每一行都位于一个标注之下，该标注的写入者是列表中的组合包，第一个标注之前不打印任何内容，stderr 上也没有任何输出，并且列出的恰是本组合包所写入的 `LOCAL_ROWS` 各行；组合结果与上游的 `web` profile 逐行相同，但 `LOCAL_ROWS` 中的行例外，它们按各项的说明，或就地改变，或添加在上游各行之后。 它还把已启用的行所指明的 DeepSeek 主机限定在列出的例外之内：没有已启用的 `deepseek-account` 行；除模型 API 外，只有反馈导出器的收集端，而它仍是一个待决定事项。 它还把每个已启用行所指明的 DeepSeek 主机限定为：只有 `api.deepseek.com`（使用用户自己密钥的模型提供方 API）可以出现，反馈导出器、账户界面与反馈界面均不被组合。
- [`privacy-defaults.spec.ts`](tests/privacy-defaults.spec.ts) 使用各 profile 所组合的行挂载上游自身的插件，并针对本地网络 fixture（测试前置数据）运行。在 Delo CLI profile 的各行下，发往 mock DeepSeek API 的任何模型请求体都不携带 `dsh_session_log`，本地 OTLP 收集器也收不到任何分析记录；在上游 web profile 的各行下，同样的 fixture 会收到两者。组合中没有任何字符串（包括 `!!js` 表达式）指向 Delo 主机，且唯一指明 Delo 包的行就是本组合包新增的各行。
- [`notice.client.spec.tsx`](tests/notice.client.spec.tsx) 渲染 Delo 的预览提示：它陈述 Delo 自己的状态，在每个浏览器上每个提示版本只显示一次，确认后报告其引导步骤已完成。
- [`privacy-section.client.spec.tsx`](tests/privacy-section.client.spec.tsx) 渲染该分区（并验证插件注册侧栏品牌 occupant）：每个选择加入项只有在对话框中点击“打开”之后才会打开，且只写入自己的行，并可通过同一开关再次关闭；“取消”不写入任何内容；写入失败时保留已接受的值；profile 未提供的桌面端分析行会显示其原因；该插件注册该分区，并把每个选择加入项写入其上游的行。
- `apps/web/tests/delo-privacy-consent.e2e.ts` 构建本包，以它作为 profile 组合包启动 studio，针对 mock DeepSeek API 运行，并在 Chromium 中操作该分区：第一次模型请求不携带会话日志；桌面端分析与会话日志上传各自在同意后单独打开；下一次请求携带会话日志；再从该分区关闭上传后，其后的请求便不再携带会话日志。

<a id="limits"></a>
## 限制

- 组合包列表是供 `delorun` 写入的常量；没有任何已发布的上游模板列出它，因此录制会话的回放只经由对等覆盖层挂载本组合包。
- 在 `DELO_PROFILE_BUNDLES` 变更之前创建的 profile，保留其创建时的列表。
- 隐私默认值只有在 profile 加载本组合包时才成立。上游会把无法加载的组合包报告为已跳过，并在不含它的情况下启动，此时会话日志上传处于开启状态；`delorun` 拒绝启动此类 profile，正是它保住了这些默认值。
- 桌面端分析只挂载于上游的 `desktop` profile，而 `delorun` 不运行该 profile，因此 Delo CLI profile 的“隐私”分区显示该行的原因，而不显示开关。
