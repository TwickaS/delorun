---
description: "@delorun/plugin-mcp-consent 插件：Delorun 的 MCP 添加时同意（mcpAddConsent），home 受保护状态下的接受存储，让已接受的 stdio 服务器启动得以运行，并把其他每次启动留到本人接受为止。"
---

# @delorun/plugin-mcp-consent

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包是 Delorun 的 MCP 添加时同意（MCP add-time consent）中 `mcpAddConsent` 服务的 Service Provider，该保护由 C16 开关 [`mcp_add_consent`](../../docs/contracts/c16-parity-composition.zh.md) 打开。stdio MCP 服务器命令作为本地子进程在 agent（智能体）沙箱之外运行，因此在这类服务器启动之前，mcp-client 插件会询问已挂载的 `mcpAddConsent` 服务：所配置的启动是否获得许可。本包根据接受存储（acceptance store）作答——home 受保护状态下的一个 JSON 文件，每个已配置的服务器名称持有一条接受：接受恰好覆盖受审查的命令、参数、工作目录和已配置环境，以及它们解析得到的绝对可执行文件路径、命令 shell 和工作目录，且其固定文件仍保持被接受时的内容的服务器立即启动，其余每次审查都让服务器保持停止，并以写明该命令的拒绝作答。Which servers ask depends on where their definition lives and on the `ask` setting ([Origins and the ask mode](#origins-and-the-ask-mode)); by default a server the person's own configuration or one of Delorun's packs brings starts unasked。本人在 home 自己的电脑上，于 studio 的“设置 → 权限”中或用 `delorun mcp accept` 接受被挂起的服务器，服务器随即启动而无需重启；本人在同样的位置或用 `delorun mcp revoke` 拒绝它或撤销一条接受后，该服务器保持停止，直到其启动发生变化或本人接受它（[待处理的审查](#pending-reviews)）。关闭该开关，或没有已挂载的 Service Provider 时，mcp-client 启动每个已配置服务器的方式与上游完全一致；`@delorun/bundle-local` 在 `delorun` 启动的 CLI profile 中挂载并打开它，`@delorun/bundle-headless` 在 `delorun headless` 运行的 profile 中挂载并打开它，桌面应用运行上游的 profile，不挂载它。

## 目录

- [服务](#the-service)
- [接受存储](#the-acceptance-store)
- [审查](#reviews)
  - [Origins and the ask mode](#origins-and-the-ask-mode)
- [记录一次接受](#recording-an-acceptance)
- [待处理的审查](#pending-reviews)
- [mcp_add_consent 开关](#the-mcp_add_consent-switch)
- [开发](#development)

<a id="the-service"></a>

## 服务

`DelorunMcpConsent` 扩展 `@deepseek-ai/dsh-mcp-client` seam 的抽象 `McpAddConsent` 服务；在启动每个已配置的 stdio 服务器之前，mcp-client 会咨询它的 `review`。审查从不等待本人：允许一次启动即启动服务器；拒绝一次启动则让 mcp-client 的激活失败，失败带类型的拒绝会写明该命令及其参数，并附带 Service Provider 自己的原因，于是服务器保持停止。在该启动被接受之前，每次启动该服务器配置项时拒绝都会重复出现；拒绝之后给出的一次接受，会让下一次启动运行该服务器。

审查看到服务器的完整启动：服务器名称、命令、其参数、其工作目录及其已配置的环境条目，以及 mcp-client 将它们解析得到的绝对可执行文件路径和规范工作目录，在 Windows 上还有运行 `.cmd` 或 `.bat` 文件的 `COMSPEC` 的规范路径。mcp-client 将空的或相对的工作目录相对于 Host 的工作目录解析，并在服务器将以之启动的 `PATH` 中查找裸命令，然后以这些解析得到的路径 spawn 服务器，因此即使 Host 在另一个目录中启动或其 `PATH` 发生变化，已接受的启动运行的仍是本人接受过的可执行文件。它无法解析的命令会在任何审查之前以 `McpServerStartUnresolvedError` 让服务器保持停止。拒绝写明解析得到的可执行文件、工作目录和已配置环境变量的名称，但不写其中任何值，因为值可能是凭据。审查还会固定可执行文件以及每个由参数指名的文件的内容（[固定文件](#pinned-files)），但不固定程序自行加载的文件：当工作目录或某个固定文件位于 chat 可以写入的位置时，之后写到那里的模块会在下一次启动或重连时在沙箱之外运行，审查会说明这一点而不是拒绝它（[chat 可以写入的位置](#places-chats-can-write)）。

使用 `expandTemplates` 时，mcp-client 在启动时用已存储的凭据填充参数和普通环境值中的 `${credential:NAME}` 部分，因此审查看到并固定的是模板文本，而不是任何密钥。三条规则使已存储的凭据无法改变审查所批准的内容。`command`、`cwd` 或影响运行的变量的值（[`showsEnvValue`](src/wire.ts) 所列的名称）中的模板，会在服务器加载时被拒绝，并写明服务器和字段；应直接写出该值，或改用另一个变量名。被审查的命令和工作目录始终是服务器所 spawn 的那个，因此名字像模板的文件绝不会被展开。完全由一个模板构成、并解析为以 `-` 开头的值的参数，会在启动时被拒绝，并写明服务器和参数序号而绝不写该值；像 `--token=${credential:NAME}` 这样的部分模板仍被允许。审查把带模板的参数以未解析的形式显示，并注明它在启动时由已存储的凭据填充。

本模块把 `providesMcpAddConsent` 导出为 `true`，这是 mcp-client 的同意查找在 Loader 下读取的声明：找不到 `mcpAddConsent` 服务的 mcp-client 配置项，会等到每个配置项都导入了其模块、且本配置项已启动，因此服务器绝不会因为其配置项先于本配置项启动而未经审查就启动。本配置项启动失败时，服务器以 `McpConsentUnavailableError` 保持停止；开关关闭时，本配置项启动但不注册任何内容，服务器以与上游一致的方式启动。

mcp-client 在每次启动服务器配置项时请求审查，并在连接断开后每次重连 spawn 服务器之前再次请求。重连时的拒绝会停止重连循环并注销该服务器的工具；配置项保持活动，其审查处于待处理状态，接受它会让该配置项再次启动。

服务在每次审查时都解析本进程运行所在的 home：[`@delorun/home`](../home/README.zh.md) 的 `resolveDelorunHome` 从 `DELORUN_HOME` 或 `~/.delorun` 解析它，因此无法解析的 home 也只是又一次让本人再次询问的审查。

<a id="the-acceptance-store"></a>

## 接受存储

存储位于解析得到的 home 之下的 `secrets/mcp-add-consent/acceptances.json`。它是约定 C1（[`@delorun/home`](../home/README.zh.md)）的受保护文件：读取时应用拒绝规则，以 0600 模式写入以 0700 模式创建的目录，且位于 home 的 `secrets/` 目录之下，在 Linux 和 macOS 上沙箱的隔离（confinement）规则向受限命令否认该目录（Windows 运行器不限制读取）——一条接受本会让它在 agent 沙箱之外运行的命令，既读不到这份列表，也无法把自己加进去。

文件是一个 JSON 对象 `{ v, acceptances, setAside }`，其 `v` 是格式版本 7：

- `acceptances` 把一个已配置的服务器名称映射到为它接受的启动：命令、参数列表、已配置的工作目录、它们解析得到的绝对可执行文件路径和规范工作目录、Windows 批处理文件的规范 `COMSPEC`（记为 `resolvedShell`，其他情况下不存在）、以每个变量的名称及其名值 SHA-256 摘要表示的环境、固定文件（`files`，见[固定文件](#pinned-files)），以及接受时间，and the origin of the server's definition the person accepted it for (`origin`, one of `profile`, `settings`, `chat`, `unknown`, `pack:<plugin>` or `plugin:<plugin>`, at most 300 characters; absent when the acceptance was recorded before origins were kept). An acceptance covers a server of its own origin only, and one that holds none counts as `unknown`'s ([`acceptanceCovers`](src/store.ts)), so accepting a server of one origin does not accept a server of the same name from another. 不同的服务器名称从不共享或覆盖一条接受，因此两个以 `npx` 启动的服务器各自保留接受；接受同一服务器变化后的启动会替换其接受。接受的 id（[`acceptanceIdOf`](src/store.ts)）是服务器名称与整个启动（包括解析得到的路径）的摘要，因此一次撤销指名一条接受。
- `setAside` 把一个服务器名称映射到本人拒绝的、或本人撤销了其接受的启动：状态 `declined` 或 `revoked`，以及整个启动（包括解析得到的路径）的摘要（[`startDigest`](src/store.ts)）。对恰好这一启动的审查会以该状态被拒绝，不等待答复，跨重启有效；对该服务器另一个启动的审查，或对同一启动但现在解析到别处的审查，会删除该条目并等待，接受该服务器也会删除它。

A version-6 store, which recorded no origin, is read forward: its acceptances and set-aside starts are kept, each acceptance with no origin, which counts as an acceptance for the `unknown` origin only: a plugin's or a chat's server that asks is asked about once more, and the next write is version 7. 存储不以明文保存任何环境值，且无论环境的键以何种顺序写出，摘要都相同。已存在但不属于本格式的存储——没有 JSON 文档、不是对象、a version other than 7 and 6、an unknown field、an origin that is not one of the forms above、错误的条目、不是绝对路径的解析路径——整体被拒绝：任何审查都不把任何内容算作已接受，Service Provider 从不写入它，且每次拒绝都写明该文件，请本人修复或删除它并重新接受每个服务器。

对存储的每次更改（一次接受、一次拒绝、一次撤销、删除一个被搁置的启动）都在持有其锁文件——它旁边的 `acceptances.json.lock`，即 `@delorun/home` 的锁文件——期间读取、更改并写入它：存储由 home 的每个 profile 共享，因此一个 profile 进程中的撤销与另一个进程中的接受绝不会互相覆盖。对存活的持有者最多等待十秒，之后该更改被拒绝且不记录任何内容；已死亡持有者的锁会被移除。

<a id="reviews"></a>

## 审查

`review(command, client)` answers one configured server start; `client` is the context of the mcp-client plugin that starts it, which the origin is judged from ([Origins and the ask mode](#origins-and-the-ask-mode)). A server that does not ask under the `ask` setting is allowed at once, with no pending review and no acceptance. Otherwise:

- 该服务器名称的接受恰好覆盖受审查的命令、参数、工作目录、环境、解析得到的可执行文件路径、命令 shell 和解析得到的工作目录时，允许该启动；
- 存储不存在、无法读取或不属于本版本格式，服务器没有接受，命令、参数列表或工作目录发生变化，环境变量被添加、删除或更改，命令现在解析到另一个可执行文件，批处理文件现在通过另一个 `COMSPEC` 运行或不再通过任何 `COMSPEC` 运行，工作目录现在解析到另一个目录，本人搁置了该启动，以及 home 无法解析，这些情况都以请本人再次确认的原因拒绝。原因写明发生变化的变量和解析得到的路径，但不写任何环境值，另一个服务器名称对同一启动的接受从不算数。

<a id="origins-and-the-ask-mode"></a>

### Origins and the ask mode

The review decides by where a stdio server's definition lives, judged from the Loader rows whose plugins mounted the server's mcp-client and from the patch layer that added or changed each of those rows ([`originOf`](src/origin.ts)), never from the server's name, command or configuration, so a server a plugin or a bundle brings cannot pass for a pack's or the person's by naming itself after one. Booting a profile flattens every bundle's patches and the person's own into one row list, so the review reads the layers from the profile's files at each review ([`readRowSources`](src/layers.ts)): upstream's `profileContext` names the files, and they are the ones upstream's hot reload rebuilds the running profile from, so a bundle installed, switched or configured since counts at the next review. Which bundles are packs or Delorun's own comes from the launcher's `delorunPackLayers` service, which the Delorun CLI provides on the Host's root context: `runtime` for the bundles the runtime ships and its profiles require, `pack` for a layer that loads from the folder the running release installs that pack in or from its Changes review copy (a pack's name alone is not enough), and `other` for every other bundle. The origin is one of [`ServerOrigin`](src/wire.ts), checked in this order:

- `plugin` named by the bundle: an `other` bundle inserted or changed the client's row or any row around it, so a third-party bundle's mcp-client row asks, and so does a pack's plugin it adds with its own config or a pack's or Delorun's row it changes;
- `pack`: a `pack` layer inserted the nearest row;
- `profile`: the client is a row the person's own patch file (the profile's `cordis.patch.yml` or the home's) inserts and no bundle inserts or changes; bundles apply before that file, so none can change its rows;
- `settings`: a server of the Settings list of the MCP manager's row (judged by its plugin class), when that row comes from a `runtime` bundle or the person's own file;
- `plugin` named by the module: any other plugin, or a server a plugin registers through the MCP manager;
- `chat`: mounted by one chat's own setup, which an editor's ACP session uses for the servers it brings;
- `unknown`: no Loader row owns the mount, the mcp-client passed no context, or the client is a row of no source above.

Without `profileContext`, or when the profile's files do not read, no row counts as the person's, Settings' or a pack's, and without `delorunPackLayers` every bundle counts as `other`; both fail towards asking.

The `ask` field of the consent row decides which origins wait for the person ([`asksFor`](src/wire.ts)): `outside`, the default, asks for `plugin`, `chat` and `unknown` servers; `always` asks for every stdio server; `never` asks for none. Settings, Permissions offers the three as "Ask for project servers", "Always ask" and "Never ask". An acceptance is keyed by origin and server name ([The acceptance store](#the-acceptance-store)), so accepting a server from one origin does not accept the same name from another.

<a id="pinned-files"></a>

### 固定文件

每次审查都会固定启动所运行的文件（[`src/pins.ts`](src/pins.ts)）：解析得到的可执行文件，顺着每个符号链接直到文件本身，因此 `node_modules/.bin` 条目固定的是它指向的脚本；以及每个相对于解析得到的工作目录解析后指名一个已存在普通文件的参数，例如 `node server.js` 中的 `server.js`，同样顺着其链接解析。形如 `--option=value` 的参数（例如 `--import=./hook.js` 或 `--require=./hook.js`）在整个参数不指名任何文件时，固定其值指名的文件。每个固定项是规范路径及其内容的 SHA-256 摘要，通过一个以不等待、且不跟随最后一个符号链接的方式打开的句柄读取，因此被换成 FIFO 或设备的路径会立即被拒绝，而不会让审查挂起；句柄自身的状态必须指名一个普通文件，其设备、inode、大小、修改时间和变更时间在读取前后必须一致，且读取之后路径必须解析到同一个文件。一条接受持有其审查所显示的固定项；固定项不同的审查以变化 `contents` 被拒绝，并写明该文件：被改写的文件、现在解析到另一个文件的路径，或现在才指名、或不再指名文件的参数。无法读取的文件会以 `contents` 拒绝该启动，且不带固定项。每次审查都会重新读取每个文件；审查之间不保留任何摘要，因为不维护变更时间的文件系统（drvfs、9p、部分 FUSE 挂载）会让原地改写保持每个状态值不变。对一个 121 MiB 的 Node.js 二进制文件计算哈希约需 0.15 秒。

被允许的启动以其固定可执行文件的规范路径（决定中的 `spawnCommand`）spawn，而不是以命令解析得到的路径，因此像 `node_modules/.bin` 条目这样的符号链接在审查之后被指向别处，也不会改变实际运行的文件；当该文件与解析得到的命令不同时，审查会显示它。被 spawn 的文件把配置的命令视为自己的 `argv[0]`，因此按调用名定位自身的程序会像从该命令启动时一样运行：虚拟环境中的 `python` 链接能找到自己的虚拟环境，BusyBox 这类多功能二进制文件能看到 applet 名称。这一点在 Windows 上未经测试，`.cmd` 或 `.bat` 包装脚本保留运行它的命令 shell 的 `argv[0]`。

固定项只覆盖这些文件。程序自行加载的文件（脚本的其他模块、包的其余部分、共享库、解释器自身的模块、`python -m` 指名的模块、`NODE_OPTIONS` 指名的文件）、参数指名的目录、值不以 `=` 连接的选项（`-r./hook.js`）、脚本的 `#!` 行在 spawn 之后于服务器的 `PATH` 中查找的解释器，以及包运行器（`npx`、`pnpm dlx`、`bunx`、`uvx`、`pipx run`）启动时下载的代码，都不会被固定。在最后一次审查与 spawn 之间，被原地改写的固定文件，或参数经过的链接被指向别处，会在下一次审查之前未经审查地运行；审查紧挨每次 spawn 之前运行，以缩短这段时间。

<a id="places-chats-can-write"></a>

### chat 可以写入的位置

待处理的审查会写明位于本 profile 的 chat 可以写入之处的规范工作目录和固定文件（[`src/writable.ts`](src/writable.ts)）：profile 工作区注册表中的某个工作区，或 `/tmp` 以及平台的临时目录，每个受限命令都可以写入这些位置。studio 的审查和 `delorun mcp accept` 会在本人作答之前显示它们，因为 chat 可以更改这样的文件，或从这样的目录加载的模块，而对模块的更改不会被审查。拥有完全访问权限的 chat 也会写入这些位置之外；这些不会被检测到。

每次拒绝的原因都以本人接受该服务器的位置结尾：Delorun 运行期间在 home 的电脑上执行 `delorun mcp accept <name>`，或 studio 的“设置 → 权限”（[`acceptHint`](src/review.ts)）。

<a id="recording-an-acceptance"></a>

## 记录一次接受

`accept(start, files?)` 把本人接受了某个服务器启动——审查所显示的服务器名称、命令、其参数、其工作目录、其已配置环境，以及解析得到的可执行文件路径、命令 shell 和工作目录——记录为该服务器名称的接受，附带给定的固定文件，省略时则当场固定；解析路径不是绝对路径的启动，或文件无法固定的启动，会被拒绝。再次接受一个服务器会替换其先前的接受，因此变化后的启动通过按其现状接受而获得许可。这次接受会删除该服务器被拒绝或被撤销的启动。存储中的接受只通过它增加；`acceptReview` 以待处理审查所显示的启动调用它。

<a id="pending-reviews"></a>

## 待处理的审查

每次被拒绝的审查都在本进程中作为该服务器的待处理审查保留：每个服务器名称一条，取最新的，因此审查之后发生变化的启动会替换该审查。该服务还以 `mcpReviews` 提供（[`src/review.ts`](src/review.ts)）：

- `pending()` 按界面显示的样子列出每条待处理审查（[`PendingServer`](src/wire.ts)）：服务器名称、its origin (`origin`)、命令、其参数、其工作目录、启动解析得到的绝对可执行文件（`resolvedCommand`）和规范工作目录（`resolvedCwd`），在 Windows 上还有运行批处理文件的命令 shell（`resolvedShell`），因此界面在本人作答之前显示实际运行的文件；已配置的环境变量、固定文件（`files`）、chat 可以写入的工作目录和固定文件（`writableByChats`）、拒绝的原因、审查询问的内容、发生变化的变量、其状态、审查时间及其审查 id——启动每个字段的摘要，环境通过其摘要计入（[`mcpReviewId`](src/review.ts)）。只有当 [`showsEnvValue`](src/review.ts) 对某个环境变量的名称成立时才显示其值：`PATH`、`BASH_ENV`、`ENV`、`GCONV_PATH`、`JAVA_TOOL_OPTIONS`、程序选择器，以及每个以 `LD_`、`DYLD_`、`NODE_`、`PYTHON`、`PERL5`、`RUBY` 或 `OPENSSL_` 开头的名称（`@deepseek-ai/dsh-mcp-client` 中 `isRunAffectingEnv` 的列表，它也拒绝在这些名称中使用凭据模板），它们会改变实际运行的内容；其他任何值都从不显示。`change` 是 [`SERVER_CHANGES`](src/wire.ts) 之一：`new` 表示服务器没有接受或存储不存在；`command`、`arguments`、`directory` 或 `environment` 表示启动中第一个与该服务器的接受不同的部分，`changedVariables` 写明每个被添加、删除或更改的变量；`resolved` 表示按已接受的样子配置、但其命令现在解析到另一个可执行文件、其工作目录解析到另一个目录、或其批处理文件通过另一个命令 shell 运行的启动；`contents` 表示固定文件与接受中的不同或无法读取的启动；`unreadable` 表示被拒绝的存储或无法解析的 home。`state` 是 [`SERVER_STATES`](src/wire.ts) 之一：`waiting`、`declined` 或 `revoked`。
- `acceptReview(serverName, reviewId, confirmed)` 先用 mcp-client 的 `resolveServerStart` 重新解析所显示启动的命令和工作目录，并重新固定其文件；当它们现在解析到另一个可执行文件、目录或命令 shell，某个文件与所显示的固定项不同，或启动或某个文件不再能解析或读取时，它不记录任何内容并以 `STALE_REVIEW` 拒绝，而解析到别处或运行其他内容的启动会被再次审查，因此列表以新的审查 id 显示新的路径和文件。否则它通过 `accept` 恰好记录该审查所显示的启动和固定项（无论处于何种状态），移除该审查，并以各自的配置再次启动该服务器的每个 Loader 配置项——本同意在启动时拒绝的配置项，以及其重连被拒绝的活动配置项——and the MCP manager's server of that name when a failed start stopped it (`mcpManager.restart`), 因此服务器无需重启 studio 即可运行；没有 Loader 时，下一次启动会运行它。A chat that is open gets the server's tools from its next model request, because the agent loop resolves tools at each step。`declineReview(serverName, reviewId)` 让该审查以 `declined` 保留在列表中，把该启动记录为已拒绝，且不记录任何接受；服务器保持停止，直到其启动发生变化或本人接受它。在存储无法读取或写入期间，这次拒绝只在本进程中有效，并会有一条警告说明这一点。
- `accepted()` 列出每条接受（[`AcceptedServer`](src/wire.ts)）：其 id、服务器名称、命令、其参数、其工作目录、它解析得到的可执行文件、工作目录和命令 shell、其环境变量、其固定文件、接受时间，以及是否有已配置的 Loader 配置项具有该服务器名称；变量的值只在 `showsEnvValue` 成立、且该服务器已配置的配置项所设的值正是接受所持摘要对应的值时出现。存储不存在或无法读取期间，它不列出任何内容。`revokeAcceptance(acceptanceId, confirmed)` 移除该接受，把其启动记录为已撤销，然后以各自的配置再次应用该服务器名称的每个 Loader 配置项，因此其审查以 `revoked` 拒绝该启动，服务器停止，直到其启动发生变化或本人再次接受它；它答复有多少配置项停止，并保留其他每条接受。
- 这些答复以 `McpReviewError` 拒绝且不记录任何内容的情况有：`UNCONFIRMED`（不带 `confirmed: true` 的接受或撤销）、`STALE_REVIEW`（该服务器没有带此 id 的待处理审查，因为它在显示之后被再次审查或已被接受，其启动现在解析到与审查所显示不同的路径，或没有接受带有被撤销的 id，因为它已被替换或撤销），以及对接受或撤销而言的 `STORE_REFUSED`，它也拒绝解析路径不是绝对路径的所显示启动。每次答复记录一行日志。
- 在 Connection 为 studio 提供服务的地方，`/api` 下的五条精确路由承载它们（[`src/wire.ts`](src/wire.ts)、[`src/routes.ts`](src/routes.ts)）：`GET /api/delorunMcpConsent.pending`（待处理的审查与已接受的启动）、`GET /api/delorunMcpConsent.waiting`、`POST /api/delorunMcpConsent.accept`、`POST /api/delorunMcpConsent.decline` 和 `POST /api/delorunMcpConsent.revoke`。除 `waiting` 外，每条路由只答复经回环监听器、以回环 `Host` 到达的请求；远程访问设备会在请求体被读取之前以 `403 LOOPBACK_REQUIRED` 被拒绝，因此服务器只能在 home 的电脑上被接受或撤销，但危险模式持续期间除外：此时持有解锁的设备可以进入这四条路由（[`@delorun/home-auth`](../home-auth/README.zh.md#dangerous-mode)）。`waiting` 还准入远程访问已准入设备的 Peer（`admitPeer`），只答复处于 `waiting` 状态的每条审查的名称和 `change`，从不答复被拒绝或被撤销的审查，也从不答复命令、参数、目录或环境，因此手机可以说明某个服务器正在等待、需要在电脑上批准。studio 的权限部分、MCP 服务器审查和 the card above the message box that says a server wants to start 位于 [`@delorun/bundle-local`](../bundle-local/README.zh.md#the-consent-surfaces)；`delorun mcp` 通过 home 进程的 `mcp.list`、`mcp.accept`、`mcp.decline` 和 `mcp.revoke`（[C19](../../docs/contracts/c19-home-process.zh.md)）到达同样的调用，只有本人自己的命令可以答复它们。

<a id="the-mcp_add_consent-switch"></a>

## mcp_add_consent 开关

`enabled` 配置字段，即 C16 开关 `mcp_add_consent`，决定插件是否注册该服务。它默认关闭——这是对等值（parity value）——Delorun 的组合会打开它；`cordis.yml` 配置项挂载本包并写明开关的值。关闭时，插件不注册任何内容，每个已配置的服务器都以与上游完全一致的方式启动。The `ask` field (`outside`, `always` or `never`, default `outside`) then decides which servers ask ([Origins and the ask mode](#origins-and-the-ask-mode)). `enabled` and `ask` are computer-only switches of `@delorun/home-auth`: a reach device's settings write to either is refused, because turning the consent off or changing which servers ask lets a server start unasked. Changing the ask mode restarts the consent row, and the restarted consent reviews again each server the previous mode left stopped, a Loader row that failed with a consent refusal or an MCP manager server whose start failed (`DelorunMcpConsent.startRefused`): a server the new mode no longer asks for starts at once without a restart, and one it still asks for is refused again and listed.

<a id="development"></a>

## 开发

`tests/consent.spec.ts` 覆盖存储、它对其他每个版本的拒绝、它的锁以及审查；`tests/reviews.spec.ts` 覆盖待处理的审查及其变化内容、显示哪些变量和哪些值、跨新服务实例的已拒绝与已撤销状态、重新启动的配置项、按服务器名称分开保存的已接受启动及其撤销，以及路由，并包含拒绝情形：远程访问设备只能读取等待中服务器的名称和变化内容，其他每条路由都被拒绝，未确认或过期的答复或撤销不记录任何内容。`tests/pinning.spec.ts` 和 `tests/pin-races.spec.ts` 覆盖固定项及其拒绝情形：被改写的可执行文件或脚本、被改指向的 `.bin` 链接、被删除或新指名的参数文件、无法读取的文件、读取期间发生变化的文件、被链接替换的规范路径、任何状态值都看不出的改写、被允许的启动 spawn 所用的路径、chat 可以写入的路径，以及对显示之后文件发生变化的审查的答复。`tests/pin-fifo.integration.spec.ts` 覆盖指名 FIFO 的路径，它不等待即被拒绝；`tests/store-lock.integration.spec.ts` 覆盖在撤销等待期间持有存储锁的第二个进程。`tests/restart.spec.ts` 在真实的 Loader 下运行接受和撤销，以及在服务器运行期间被改写的脚本，重连会再次审查它并将其挂起，直到本人接受。spec 用 `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-mcp-consent` 运行，本包用 `node_modules/.bin/tsc --noEmit -p delorun/packages/plugin-mcp-consent/tsconfig.json` 进行类型检查。

<a id="when-the-service-fails"></a>

## 服务失败时

服务启动失败的同意行不处于激活状态，MCP 客户端会让每个 stdio 服务器保持停止，并给出指名该行的错误（[`fail-closed.spec.ts`](tests/fail-closed.spec.ts)）。`enabled` 关闭时，服务器按 stock 方式启动。
