---
description: "@delo/plugin-mcp-consent 插件：Delo 的 MCP 添加时同意（mcpAddConsent），home 受保护状态下的接受存储，让已接受的 stdio 服务器启动得以运行，并把其他每次启动留到本人接受为止。"
---

# @delo/plugin-mcp-consent

[English](README.md) | 中文

## 摘要

本包是 Delo 的 MCP 添加时同意（MCP add-time consent）中 `mcpAddConsent` 服务的 Service Provider，该保护由 C16 开关 [`mcp_add_consent`](../../docs/contracts/c16-parity-composition.zh.md) 打开。stdio MCP 服务器命令作为本地子进程在 agent（智能体）沙箱之外运行，因此在这类服务器启动之前，mcp-client 插件会询问已挂载的 `mcpAddConsent` 服务：所配置的命令是否获得许可。本包根据接受存储（acceptance store）作答——home 受保护状态下的一个 JSON 文件：本人以受审查的参数列表、工作目录、已配置环境以及解析得到的可执行文件路径、命令 shell 和工作目录原样接受过的命令立即启动，其余每次审查都让服务器保持停止，并以写明该命令的拒绝请本人接受。没有任何界面或命令记录接受（[记录一次接受](#recording-an-acceptance)），因此实际上存储中尚未持有的每个 stdio 服务器都保持停止。关闭该开关，或没有已挂载的 Service Provider 时，mcp-client 启动每个已配置服务器的方式与上游完全一致；`@delo/bundle-local` 在 `delorun` 启动的 CLI profile 中挂载并打开它，`@delo/bundle-headless` 在 `delorun headless` 运行的 profile 中挂载并打开它，桌面应用运行上游的 profile，不挂载它。

## 目录

- [服务](#the-service)
- [接受存储](#the-acceptance-store)
- [审查](#reviews)
- [记录一次接受](#recording-an-acceptance)
- [待处理的审查](#pending-reviews)
- [mcp_add_consent 开关](#the-mcp_add_consent-switch)
- [开发](#development)

<a id="the-service"></a>

## 服务

`DeloMcpConsent` 扩展 `@deepseek-ai/dsh-mcp-client` seam 的抽象 `McpAddConsent` 服务；在启动每个已配置的 stdio 服务器之前，mcp-client 会咨询它的 `review`。审查从不久等本人：允许一次启动即启动服务器；拒绝一次启动则让 mcp-client 的激活失败，失败带类型的拒绝会写明该命令及其参数，并附带 Service Provider 自己的原因，于是服务器保持停止。在该启动被接受之前，每次启动该服务器时拒绝都会重复出现；拒绝之后给出的一次接受，会让下一次启动该服务器。

审查看到服务器的完整启动：命令、其参数、其工作目录及其已配置的环境条目，以及 mcp-client 将它们解析得到的绝对可执行文件路径和规范工作目录，在 Windows 上还有运行 `.cmd` 或 `.bat` 文件的 `COMSPEC` 的规范路径。mcp-client 将空的或相对的工作目录相对于 Host 的工作目录解析，并在服务器将以之启动的 `PATH` 中查找裸命令，然后以这些解析得到的路径 spawn 服务器，因此即使 Host 在另一个目录中启动或其 `PATH` 发生变化，已接受的启动运行的仍是本人接受过的可执行文件。它无法解析的命令会在任何审查之前以 `McpServerStartUnresolvedError` 让服务器保持停止。拒绝写明解析得到的可执行文件、工作目录和已配置环境变量的名称，但不写其中任何值，因为值可能是凭据。

本模块把 `providesMcpAddConsent` 导出为 `true`，这是 mcp-client 的同意查找在 Loader 下读取的声明：找不到 `mcpAddConsent` 服务的 mcp-client 配置项，会等到每个配置项都导入了其模块、且本配置项已启动，因此服务器绝不会因为其配置项先于本配置项启动而未经审查就启动。本配置项启动失败时，服务器以 `McpConsentUnavailableError` 保持停止；开关关闭时，本配置项启动但不注册任何内容，服务器以与上游一致的方式启动。

服务在每次审查时都解析本进程运行所在的 home：[`@delo/home`](../home/README.zh.md) 的 `resolveDeloHome` 从 `DELO_HOME` 或 `~/.delo` 解析它，因此无法解析的 home 也只是又一次让本人再次询问的审查。

<a id="the-acceptance-store"></a>

## 接受存储

存储位于解析得到的 home 之下的 `secrets/mcp-add-consent/acceptances.json`。它是约定 C1（[`@delo/home`](../home/README.zh.md)）的受保护文件：读取时应用拒绝规则，以 0600 模式写入以 0700 模式创建的目录，且位于 home 的 `secrets/` 目录之下——沙箱的隔离（confinement）规则向受限命令否认该目录——一条接受本会让它在 agent 沙箱之外运行的命令，既读不到这份列表，也无法把自己加进去。

文件是一个 JSON 对象 `{ v, acceptances }`，其 `v` 是格式版本 4，其 `acceptances` 把一个命令映射到与它一起接受的内容：参数列表、已配置的工作目录、它们解析得到的绝对可执行文件路径和规范工作目录、Windows 批处理文件的规范 `COMSPEC`（记为 `resolvedShell`，其他情况下不存在）、已配置环境变量的名称（已排序）、按名称排序的环境名值对的 SHA-256 摘要，以及接受时间。存储不以明文保存任何环境值，且无论环境的键以何种顺序写出，摘要都相同。版本 1 的存储写于接受覆盖工作目录和环境之前，版本 2 的存储写于接受覆盖解析得到的可执行文件路径和工作目录之前，版本 3 的存储写于接受覆盖命令 shell 之前，三者都已被取代：任何审查都不把其中的接受算数，下一次接受会把它替换为只持有该次接受的版本 4 存储。其他已存在但不属于本版本格式的存储——没有 JSON 文档、不是对象、另一个版本、未知字段、错误的接受——整体被拒绝：任何审查都不把任何命令算作已接受，且 Service Provider 绝不向被拒绝的存储添加接受，因此本人先修复或删除该文件。

<a id="reviews"></a>

## 审查

`review(command)` 回答一次已配置的服务器启动：

- 存储持有该命令的接受、且参数、工作目录、解析得到的可执行文件路径、命令 shell、解析得到的工作目录和环境与受审查的完全一致时，允许该命令；
- 不存在的存储、不可读、已被取代或不属于本版本格式的存储、没有接受的命令、变更过的参数列表、变更过的工作目录、现在解析到另一个可执行文件的命令、现在通过另一个 `COMSPEC` 运行或不再通过 `COMSPEC` 运行的批处理文件、现在解析到另一个目录的工作目录、变更过的环境变量名称或值，以及无法解析的 home，都以请本人再次询问的原因拒绝；任何原因都不写出环境值。

审查覆盖的是可执行文件的路径，而不是该文件的内容或符号链接的目标；脚本 `#!` 行所指定的解释器会在 spawn 之后于服务器自己的 `PATH` 中查找。

每个拒绝的原因都以本人在何处接受该服务器结尾：Delo 运行期间在 home 的电脑上使用 `delorun mcp accept <name>`，或在 studio 的设置的“权限”部分（[`acceptHint`](src/review.ts)）。

<a id="recording-an-acceptance"></a>

## 记录一次接受

`accept(start)` 记录本人接受了一次服务器启动——命令、其参数、其工作目录、其已配置环境，以及审查看到的解析得到的可执行文件路径、命令 shell 和工作目录——成为审查所允许的那次接受；解析得到的路径不是绝对路径的启动会被拒绝。再次接受一个命令会替换它早先的接受，因此变更过的启动以它现在携带的参数、工作目录、环境和解析得到的路径被接受后即获得许可。Delo 的 MCP 服务器添加流程中向本人询问的界面调用它；在这样的界面挂载之前，存储只经由它增长，每个未被接受的命令都让它的服务器保持停止。

<a id="pending-reviews"></a>

## 待处理的审查

每次被拒绝的审查都在本进程中保留，作为该服务器的待处理审查：每个服务器名称一条，即最新的一条，因此审查之后发生变更的启动会替换那条审查。该服务也以 `mcpReviews` 提供（[`src/review.ts`](src/review.ts)）：

- `pending()` 以界面显示的形式（[`PendingServer`](src/wire.ts)）列出每条待处理审查：服务器名称、命令、其参数、其工作目录、已配置的环境变量、拒绝的原因、该审查所询问的内容、变化的变量、其状态、审查时间及其审查 id——启动的每个字段的摘要，环境通过其摘要计入（[`mcpReviewId`](src/review.ts)）。只有当 [`showsEnvValue`](src/wire.ts) 对变量名成立时才显示其值：`NODE_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`PATH`、`PYTHONPATH` 以及每个 `DYLD_` 变量，它们会改变运行的内容；其他值从不显示。`change` 取自 [`SERVER_CHANGES`](src/wire.ts)：`new` 表示没有接受的服务器、不存在的存储或已被取代的存储；`command`、`arguments`、`directory` 或 `environment` 表示启动中第一个与该服务器的接受不同的部分，`changedVariables` 写明每个增加、删除或变更的变量；`unreadable` 表示被拒绝的存储或无法解析的 home；`upgraded` 表示某条版本 2 记录原样覆盖的启动。`state` 取自 [`SERVER_STATES`](src/wire.ts)：`waiting`、`declined` 或 `revoked`。
- `acceptReview(serverName, reviewId, confirmed)` 通过 `accept` 原样记录该审查所显示的启动（无论处于何种状态），移除该审查，并以各自的配置再次启动本同意为该服务器拒绝过的每个 Loader 配置项，因此服务器无需重启 studio 即可运行；没有 Loader 时，下一次启动会运行它。`declineReview(serverName, reviewId)` 让该审查以 `declined` 状态继续列出，把该启动记录为已拒绝，且不记录任何接受；服务器保持停止，直到其启动变化或本人接受它。存储无法读取或写入时，拒绝只在本进程中生效，并有一条警告说明这一点。
- `accepted()` 列出每次接受（[`AcceptedServer`](src/wire.ts)）：其 id、服务器名称、命令、其参数、其工作目录、其环境变量、接受时间，以及是否有已配置的 Loader 配置项使用该服务器名称；只有当 `showsEnvValue` 成立、且该服务器的已配置配置项设置的值正是接受所持摘要对应的值时，才出现变量的值。存储不存在或无法读取时，它不列出任何内容。`revokeAcceptance(acceptanceId, confirmed)` 移除该次接受，把其启动记录为已撤销，随后以各自的配置再次应用该服务器名称的每个 Loader 配置项，于是其审查以 `revoked` 拒绝该启动，服务器停止，直到其启动变化或本人再次接受它；它答复停止了多少个配置项，并保留其他每次接受。
- 遇到 `UNCONFIRMED`（没有 `confirmed: true` 的接受或撤销）、`STALE_REVIEW`（该服务器没有带此 id 的待处理审查，因为它在显示之后被再次审查或被接受；或没有接受带有被撤销的 id，因为它已被替换或撤销）以及（对接受或撤销而言）`STORE_REFUSED` 时，这些答复都以 `McpReviewError` 拒绝且不记录任何内容。每次答复记录一行日志。
- 在 Connection 为 studio 提供服务的地方，`/api` 下的五条精确路由承载它们（[`src/wire.ts`](src/wire.ts)、[`src/routes.ts`](src/routes.ts)）：`GET /api/deloMcpConsent.pending`（待处理的审查与已接受的启动）、`GET /api/deloMcpConsent.waiting`、`POST /api/deloMcpConsent.accept`、`POST /api/deloMcpConsent.decline` 与 `POST /api/deloMcpConsent.revoke`。除 `waiting` 外，每条路由只回答经回环监听器到达且 `Host` 为回环地址的请求；远程访问设备在请求体被读取之前就以 `403 LOOPBACK_REQUIRED` 被拒绝，因此服务器只能在 home 的电脑上被接受或撤销。`waiting` 还接纳远程访问已准入设备的 Peer（`admitPeer`），只答复每条状态为 `waiting` 的审查的名称与 `change`，从不答复已拒绝或已撤销的审查，也从不答复命令、参数、目录或环境，因此手机可以说明有服务器在等待、需在电脑上批准。studio 的“权限”部分、MCP 服务器审查与等待中服务器的提示位于 [`@delo/bundle-local`](../bundle-local/README.zh.md#the-consent-surfaces)；`delorun mcp` 通过 home 进程的 `mcp.list`、`mcp.accept`、`mcp.decline` 与 `mcp.revoke`（[C19](../../docs/contracts/c19-home-process.zh.md)）到达同样的调用，只有本人自己的命令可以得到它们的答复。

<a id="the-mcp_add_consent-switch"></a>

## mcp_add_consent 开关

`enabled` 配置键，即 C16 开关 `mcp_add_consent`，决定本插件是否注册该服务。它默认关闭——对等取值——由 Delo 的组合打开；一条 `cordis.yml` 配置项挂载本包并写明该开关的取值。关闭时，本插件不注册任何内容，每个已配置服务器都以与上游完全一致的方式启动。

<a id="development"></a>

## 开发

`tests/consent.spec.ts` 覆盖存储、其版本 1 与版本 2 前身以及审查；`tests/reviews.spec.ts` 覆盖带有变化的待处理审查、哪些变量与哪些值被显示、跨新服务实例保持的已拒绝与已撤销状态、再次启动的配置项、按服务器名称分开保存的已接受启动及其撤销，以及路由，并包括拒绝情形：远程访问设备只能读取等待中服务器的名称与变化，其他每条路由都拒绝它；未确认或过期的答复与撤销都不记录任何内容。`tests/restart.spec.ts` 在真实 Loader 下运行接受与撤销。规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-mcp-consent` 运行，包的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/packages/plugin-mcp-consent/tsconfig.json` 运行。
