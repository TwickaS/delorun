---
description: "Delorun 的预览开关，供为工作室添加尚未面向所有人的功能的维护者：插件如何声明开关、配置档如何打开它，以及 Host、工作室和 CLI 如何读取它。"
kind: "package-library"
---

# @delorun/preview-flags

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

**预览开关**标记一项工作室功能：它已经做到可以看一看，但还不足以面向所有人发布。插件声明开关，配置档中的一行打开它，Host、工作室和 `delorun preview` 读取同一状态。在该行设置之前，每个开关都是关闭的。本包是该行的 Host 插件（`src/index.ts`，以 `.` 导出）和一个工作室库（`./client`），二者均从源码导出。

## 目录

- [声明开关](#declare-a-flag)
- [打开开关](#turn-a-flag-on)
- [读取开关](#read-a-flag)
- [约定](#contract)
- [测试](#tests)

<a id="declare-a-flag"></a>
## 声明开关

开关有 id、种类、拥有它的插件的包名，以及英文和中文的标题与描述。id 是以点分隔的驼峰单词：先是功能领域，再是开关自己的名称，例如 `onboarding.previewSteps`。目前唯一的种类是 `boolean`；`PreviewFlagDeclaration` 是按 `kind` 区分的联合类型，新增种类时在那里添加一个成员，并把它的值加入该行的 `flags` 模式。

开关在两处声明，由一个门禁检查保证二者一致。

1. 插件把声明放在 `src/preview-flags.ts` 中，以 `PREVIEW_FLAGS` 导出，其 Host 部分在插件运行期间以 effect 的方式逐个声明：

   ```ts
   export const PREVIEW_STEPS: PreviewFlagDeclaration = {
     id: previewFlagId('onboarding.previewSteps'), kind: 'boolean', owner: '@delorun/plugin-onboarding',
     title: { en: 'Planned setup steps', zh: '计划中的设置步骤' },
     description: { en: 'Shows setup steps that are planned and not built yet.', zh: '显示已计划但尚未实现的设置步骤。' },
   }
   export const PREVIEW_FLAGS: readonly PreviewFlagDeclaration[] = [PREVIEW_STEPS]
   ctx.inject(['previewFlags'], (child) => { for (const flag of PREVIEW_FLAGS) child.effect(() => child.previewFlags.declare(flag)) })
   ```

2. 插件自己的 `package.json` 列出这些 id：

   ```json
   "delorun": { "previewFlags": ["onboarding.previewSteps"] }
   ```

需要这份列表，是因为有两个读取者无法运行插件：`delorun preview`（Delorun 停止时也能使用），以及面对其所在行已关闭的插件的 Host。二者都从配置档的各行（无论是否启用）找到这些包，并依次从安装位置、配置档和带来该包的 bundle 解析它。Host 会为 Delorun 运行期间新增的插件重新读取这些列表，然后拒绝其所有者的包未列出其 id 的声明。当包的列表与其 `PREVIEW_FLAGS` 不一致时，`gates:preview-flags` 门禁检查（[`@delorun/tools`](../../apps/tools/README.zh.md)）会失败；`assertFlagsIndexed`（`./manifest`）在插件自己的测试中做同样的检查。

<a id="turn-a-flag-on"></a>
## 打开开关

`@delorun/bundle-studio` 插入的 `delorun-preview-flags` 行保存配置档设置的开关。

| 字段 | 含义 |
| --- | --- |
| `flags` | 开关 id 到 `true` 或 `false` 的记录。未出现的开关为关闭。默认没有任何开关。 |

`delorun preview on <flag>` 和 `delorun preview off <flag>` 在持有配置档写入锁的情况下，把该行写入配置档自己的 `cordis.patch.yml`；`delorun preview list` 显示每个开关、它是否打开以及声明它的插件。也可以手动写这一行，写在配置档的补丁或 `--patch` 覆盖文件中：

```yaml
- id: delorun-preview-flags
  config:
    flags:
      onboarding.previewSteps: true
```

更改在 Delorun 下次启动时生效。该行在加载时检查自己的 `flags`：

- 配置档中没有任何插件列出的开关会使该行停止，消息会指出这个开关、已知的开关以及移除它的命令。`delorun start` 在缺少 Delorun 自己的 bundle 中的任何一行时不会运行，因此会在此停止并打印该消息；随后 `delorun doctor` 会在上次启动时未加载的插件中列出该行，`delorun preview list` 也会标出这个开关。`delorun preview on` 在写入前拒绝这样的开关，`delorun preview off` 可以移除已经设置的这类开关，例如其插件被移除之后。
- 开关已打开而声明它的插件处于关闭时，会记录一条警告，且不产生任何变化；`delorun preview list` 会在该开关旁说明。
- 无法读取其列表的包会被记录为错误，在修复之前它的开关是未知的。

<a id="read-a-flag"></a>
## 读取开关

| 读取者 | 方式 |
| --- | --- |
| Host 插件 | 当该行设置了开关且其插件在运行时，`ctx.previewFlags.isOn(id)` 为 true。对既未声明也未列出的 id，它会抛出错误。 |
| 工作室 | `GET /api/delorunPreviewFlags.list` 返回正在运行的插件所声明的开关，每个都带有 `on`。任何已登录的设备都可以读取。 |
| 工作室组件 | 在持有一个 `createPreviewFlagsStore()` 的 `PreviewFlagsProvider` 之下调用 `usePreviewFlag(id)`。在 Host 应答之前、读取失败时，以及开关或其插件关闭时，它为 false。 |
| 终端 | `delorun preview list`。 |

`PreviewChip` 是被预览的功能所带的标签：“预览”二字，小而低调，并带有提示。插件把标签的词典（`./locales`）并入自己的词典，并传入自己绑定的翻译函数；`tooltip` 属性用该功能自己的句子替换通用的句子。工作室库不导入 Cordis，由插件的浏览器包内联。

<a id="contract"></a>
## 约定

- **预览开关只改变工作室界面。** 它绝不改变到达模型的内容：任何提示词、工具、工具结果或请求字段都不得依赖开关。将来若有开关会改变模型可见的输入，必须先添加一个会话事件，使该输入仍可从会话日志重建；请求由该事件构建，而不是由开关构建。唯一的例外是 `@delorun/plugin-agent-seats`：它的 Host 在单个文件中读取 `externalAgents.liveAgents`，以决定实时 agent 交接工具是否存在；会话日志记录了模型看到的工具列表，因此输入仍可从日志重建。
- **默认关闭。** 只有配置档的这一行把开关设为 `true` 时它才打开；任何插件和 bundle 补丁都不会打开它。
- **没有设置页面。** 该行由 `delorun preview` 或手动写入。
- **每个开关只有一个所有者。** 两个包列出同一个 id、插件声明另一个包的开关，以及对同一开关的第二次声明，都会被拒绝。

有两项检查在代码力所能及的范围内保证第一条规则。`tests/ui-only.spec.ts`：本包不导入会话、模型或工具相关的包，Host API 也不提供在 Delorun 运行期间更改开关的途径。`gates:preview-flags` 门禁检查：除非该检查的列表列出该文件并说明该读取不会到达模型的原因，否则任何 Host 源码都不得用 `isOn` 读取开关；目前没有列出任何文件，工作室通过路由读取开关。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/preview-flags` 运行 [`registry.spec.ts`](tests/registry.spec.ts)（索引、对未知开关的拒绝、声明和 `isOn`）、[`plugin.spec.ts`](tests/plugin.spec.ts)（已挂载的行及其路由）、[`ui-only.spec.ts`](tests/ui-only.spec.ts)、[`client.client.spec.tsx`](tests/client.client.spec.tsx)（存储、钩子和标签）和 [`chip-style.spec.ts`](tests/chip-style.spec.ts)（标签低调的外观）。CLI 的往返测试是 [`command.integration.spec.ts`](../../apps/cli/tests/preview/command.integration.spec.ts)。
