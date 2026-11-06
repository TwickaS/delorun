---
description: "Delo 的本地组合包，供维护者修改 Delo 的 CLI profile 在上游 web 模板之上所组合的内容：组合包列表、该组合包写入的行，以及使组合与上游保持一致的 spec 测试。"
kind: "package-bundle"
---

# @delo/bundle-local

[English](README.md) | 中文

## 摘要

`@delo/bundle-local` 是 Delo 的 CLI profile 在上游的 `web` profile 模板之后加入的组合包。它的 patch 保存 Delo 的本地集成行，每一行的理由都列在 [`LOCAL_ROWS`](src/profile.ts) 中，因此 Delo 的 CLI profile 在组合上游的 web profile 时，只改变或新增这些行，其他一概不变。该组合包目前尚未写入任何行：Delo 的基础设施插件到达时，会各自添加自己的行。

## 目录

- [使用本组合包](#use-this-bundle)
- [行](#rows)
- [测试](#tests)
- [限制](#limits)

<a id="use-this-bundle"></a>
## 使用本组合包

- **组合包列表。**[`DELO_PROFILE_BUNDLES`](src/profile.ts) 是 Delo CLI profile 有序的 `dsh.profile.bundles` 列表：先是上游的 `web` 模板，从 `@deepseek-ai/dsh-official-bundles` 读取，然后是 `@delo/bundle-local`。`delorun` 会把它写入每个创建于 `~/.delo/profiles/` 之下的 CLI profile（[C1](../../docs/contracts/c01-home-layout.zh.md#profiles)）。上游自身的模板并不列出本组合包，因此 `dsh --profile web`、录制会话的回放以及[对等组合](../../docs/contracts/c16-parity-composition.zh.md)只组合上游的组合包。
- **层顺序。**本组合包在每个上游组合包之后、profile 自身的 `cordis.patch.yml`、home patch 与 `--patch` overlay 之前生效，因此本人在 profile 中的设置仍然优先于此处的行（[上游的 profile 层](../../../apps/cli/README.zh.md#profiles)）。
- **读取组合结果。**`dsh --profile <name> --dump-config` 会在每个 `# ==` 行之下打印全部组合后的行。该标注写明插入此行的组合包，以及修补此行的每个组合包；本组合包写入的行，在该标注中写有 `@delo/bundle-local`。
- **加载。**本组合包未声明 `engines.dsh` 范围，也没有上游的对等依赖，因此版本变更之后，上游的兼容性检查从不会跳过它；若 profile 的组合包列表中列出了它却无法解析，则会把该组合包报告为已跳过。

<a id="rows"></a>
## 行

[`LOCAL_ROWS`](src/profile.ts) 列出 Delo CLI profile 与上游 web profile 有所不同的每一行：其 id、该组合包是改变上游的某一行还是新增一行，以及原因。该列表为空。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/bundle-local` 运行 [`composition.spec.ts`](tests/composition.spec.ts)。该文件在临时的 `DSH_HOME` 下构建一个 Delo CLI profile，并通过上游真实的 `dsh --profile <name> --dump-config` 读取它：

- 列表中的每个组合包都已加载，且没有一个被跳过；
- 转储结果中，每一行都位于一个标注之下，该标注的写入者是列表中的组合包；第一个标注之前不打印任何内容，stderr 上也没有任何输出；列出的恰是本组合包所写入的 `LOCAL_ROWS` 各行；
- 组合结果与上游的 `web` profile 逐行相同，但 `LOCAL_ROWS` 中的行例外：它们按各项的说明，或就地改变，或添加在上游各行之后。

这些 spec 导入上游已构建的包，因此需要 `pnpm run build:artifacts`；若缺少构建产物，Delo 的检查运行器会启动它。

<a id="limits"></a>
## 限制

- 组合包列表是供 `delorun` 写入的常量；没有任何已发布的上游模板列出它，因此 C16 对等回放不挂载本组合包。
- 在 `DELO_PROFILE_BUNDLES` 变更之前创建的 profile，保留其创建时的列表。
