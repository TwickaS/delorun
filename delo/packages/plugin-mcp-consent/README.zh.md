---
description: "@delo/plugin-mcp-consent 插件：Delo 的 MCP 添加时同意（mcpAddConsent），home 受保护状态下的接受存储，让已接受的 stdio 服务器命令启动，并把其他每个命令留到本人接受为止。"
---

# @delo/plugin-mcp-consent

[English](README.md) | 中文

## 摘要

本包是 Delo 的 MCP 添加时同意（MCP add-time consent）中 `mcpAddConsent` 服务的 Service Provider，该保护由 C16 开关 [`mcp_add_consent`](../../docs/contracts/c16-parity-composition.zh.md) 打开。stdio MCP 服务器命令作为本地子进程在 agent（智能体）沙箱之外运行，因此在这类服务器启动之前，mcp-client 插件会询问已挂载的 `mcpAddConsent` 服务：所配置的命令是否获得许可。本包根据接受存储（acceptance store）作答——home 受保护状态下的一个 JSON 文件：本人以受审查的参数列表、工作目录和已配置环境原样接受过的命令立即启动，其余每次审查都让服务器保持停止，并以写明该命令的拒绝请本人接受。没有任何界面或命令记录接受（[记录一次接受](#recording-an-acceptance)），因此实际上存储中尚未持有的每个 stdio 服务器都保持停止。关闭该开关，或没有已挂载的 Service Provider 时，mcp-client 启动每个已配置服务器的方式与上游完全一致；`@delo/bundle-local` 在 `delorun` 启动的 CLI profile 中挂载并打开它，`@delo/bundle-headless` 在 `delorun headless` 运行的 profile 中挂载并打开它，桌面应用运行上游的 profile，不挂载它。

## 目录

- [服务](#the-service)
- [接受存储](#the-acceptance-store)
- [审查](#reviews)
- [记录一次接受](#recording-an-acceptance)
- [mcp_add_consent 开关](#the-mcp_add_consent-switch)
- [开发](#development)

<a id="the-service"></a>

## 服务

`DeloMcpConsent` 扩展 `@deepseek-ai/dsh-mcp-client` seam 的抽象 `McpAddConsent` 服务；在启动每个已配置的 stdio 服务器之前，mcp-client 会咨询它的 `review`。审查从不久等本人：允许一个命令即启动服务器；拒绝一个命令则让 mcp-client 的激活失败，失败带类型的拒绝会写明该命令及其参数，并附带 Service Provider 自己的原因，于是服务器保持停止。在该命令被接受之前，每次启动该服务器时拒绝都会重复出现；拒绝之后给出的一次接受，会让下一次启动该服务器。

审查看到服务器的完整启动：命令、其参数、其工作目录及其已配置的环境条目。拒绝写明工作目录和已配置环境变量的名称，但不写其中任何值，因为值可能是凭据。

本模块把 `providesMcpAddConsent` 导出为 `true`，这是 mcp-client 的同意查找在 Loader 下读取的声明：找不到 `mcpAddConsent` 服务的 mcp-client 配置项，会等到每个配置项都导入了其模块、且本配置项已启动，因此服务器绝不会因为其配置项先于本配置项启动而未经审查就启动。本配置项启动失败时，服务器以 `McpConsentUnavailableError` 保持停止；开关关闭时，本配置项启动但不注册任何内容，服务器以与上游一致的方式启动。

服务在每次审查时都解析本进程运行所在的 home：[`@delo/home`](../home/README.zh.md) 的 `resolveDeloHome` 从 `DELO_HOME` 或 `~/.delo` 解析它，因此无法解析的 home 也只是又一次让本人再次询问的审查。

<a id="the-acceptance-store"></a>

## 接受存储

存储位于解析得到的 home 之下的 `secrets/mcp-add-consent/acceptances.json`。它是约定 C1（[`@delo/home`](../home/README.zh.md)）的受保护文件：读取时应用拒绝规则，以 0600 模式写入以 0700 模式创建的目录，且位于 home 的 `secrets/` 目录之下——沙箱的隔离（confinement）规则向受限命令否认该目录——一条接受本会让它在 agent 沙箱之外运行的命令，既读不到这份列表，也无法把自己加进去。

文件是一个 JSON 对象 `{ v, acceptances }`，其 `v` 是格式版本 2，其 `acceptances` 把一个命令映射到与它一起接受的内容：参数列表、工作目录、已配置环境变量的名称（已排序）、按名称排序的环境名值对的 SHA-256 摘要，以及接受时间。存储不以明文保存任何环境值，且无论环境的键以何种顺序写出，摘要都相同。版本 1 的存储写于接受覆盖工作目录和环境之前，已被取代：任何审查都不把其中的接受算数，下一次接受会把它替换为只持有该次接受的版本 2 存储。其他已存在但不属于本版本格式的存储——没有 JSON 文档、不是对象、另一个版本、未知字段、错误的接受——整体被拒绝：任何审查都不把任何命令算作已接受，且 Service Provider 绝不向被拒绝的存储添加接受，因此本人先修复或删除该文件。

<a id="reviews"></a>

## 审查

`review(command)` 回答一次已配置的服务器启动：

- 存储持有该命令的接受、且参数、工作目录和环境与受审查的完全一致时，允许该命令；
- 不存在的存储、不可读、已被取代或不属于本版本格式的存储、没有接受的命令、变更过的参数列表、变更过的工作目录、变更过的环境变量名称或值，以及无法解析的 home，都以请本人再次询问的原因拒绝；任何原因都不写出环境值。

<a id="recording-an-acceptance"></a>

## 记录一次接受

`accept(start)` 记录本人接受了一次服务器启动——命令、其参数、其工作目录及其已配置环境——成为审查所允许的那次接受。再次接受一个命令会替换它早先的接受，因此变更过的启动以它现在携带的参数、工作目录和环境被接受后即获得许可。Delo 的 MCP 服务器添加流程中向本人询问的界面调用它；在这样的界面挂载之前，存储只经由它增长，每个未被接受的命令都让它的服务器保持停止。

<a id="the-mcp_add_consent-switch"></a>

## mcp_add_consent 开关

`enabled` 配置键，即 C16 开关 `mcp_add_consent`，决定本插件是否注册该服务。它默认关闭——对等取值——由 Delo 的组合打开；一条 `cordis.yml` 配置项挂载本包并写明该开关的取值。关闭时，本插件不注册任何内容，每个已配置服务器都以与上游完全一致的方式启动。

<a id="development"></a>

## 开发

规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-mcp-consent` 运行，包的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/packages/plugin-mcp-consent/tsconfig.json` 运行。
