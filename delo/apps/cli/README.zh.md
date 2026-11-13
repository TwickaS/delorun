---
description: "delorun 命令：它的命令、如何在上游运行前通过 @delo/home 准备 ~/.delo home、选择 CLI profile、获取 home 锁、把新 home 交给 setup，并运行上游的 profile 命令。"
---

# @delo/cli

[English](README.md) | 中文

## 摘要

本应用即 `delorun` 命令。在任何上游代码运行之前，它通过 [`@delo/home`](../../packages/home/README.zh.md) 解析并准备 Delo home（该包实现 [约定 C1](../../docs/contracts/c01-home-layout.zh.md) 的 home），选择 CLI profile，并通过上游的 profile 运行器运行该 profile，同时把 Delo home 作为 `DSH_HOME`。新 home 先交给 setup 的入口。一次启动会运行该 profile 的 home 进程（home process），它由 [`@delo/home-process`](../../packages/home-process/README.zh.md)（[约定 C19](../../docs/contracts/c19-home-process.zh.md)）实现；它持有该 profile 的 home 锁，因此每个 profile 只运行一个 home 进程，`stop` 与 `status` 通过其更新通道与它通信。

## 目录

- [命令](#commands)
- [home](#the-home)
- [Profile](#profiles)
- [Setup](#setup)
- [home 进程](#the-home-process)
- [打开 studio](#opening-the-studio)
- [delorun 如何运行上游](#how-delorun-runs-upstream)
- [扩展点](#extension-points)
- [尚未实现](#not-yet-implemented)
- [开发](#development)

<a id="commands"></a>

## 命令

| 命令 | 作用 |
| --- | --- |
| `delorun [--profile <name>] [--foreground]` | 若 home 上还没有 CLI profile，则运行 setup；否则像 `delorun start` 那样启动 home 进程——除非 setup 的答复为否或给出了 `--foreground`，否则在后台运行——并像 `delorun open` 那样打开 studio，同时打印 `delorun status`、`delorun logs --follow` 与 `delorun stop` |
| `delorun setup [<section>] [--profile <name>] [--yes \| --config <file>] [--check-key] [--no-update-check] [--list]` | setup：在终端中选择“快速”或“完整”，或用 `--yes` 应用全部默认值，或用 `--config` 应用答案文档；已完成的 setup 保持不变。`--no-update-check` 在任何形式下都关闭发布检查。`<section>` 再次运行某一部分，`--list` 列出各部分 |
| `delorun start [--foreground] [--profile <name>]` | 以脱离终端的方式启动 home 进程，并最多等待 120 秒使其报告 `running`；`--foreground` 则在此终端中运行它，setup 答复选择不在后台运行的启动也是如此；`--open` 在其运行后打开 studio |
| `delorun open [--print] [--port <n>] [--profile <name>]` | 向运行中的 home 进程请求一个 studio 链接（C19 的 `studio.open-token`），并在默认浏览器中打开它；`--print` 则改为打印一次该链接，用于没有浏览器的电脑或 SSH 端口转发。该链接只能在一分钟内、仅在其写明的地址上登录一次；`--port` 为一个转发到 studio 的回环端口生成链接。没有 home 进程运行时以 3 退出，端口不在 1 到 65535 之间时以 2 退出 |
| `delorun stop [--now] [--profile <name>]` | 在运行中的对话结束后停止 home 进程，最多等待 1,800 秒；`--now` 先取消它们，并对 60 秒内不应答、或接受后 120 秒仍未退出的 home 进程先发送 `SIGTERM`，30 秒后再发送 `SIGKILL`，每个信号只发给按进程 id、启动标识与 pid 命名空间确认为锁持有者的进程；未经确认的持有者，以及 Windows 上的任何持有者，都不会收到信号，命令以 1 退出并写明它 |
| `delorun status [--profile <name>] [--json]` | 打印 home、profile、`delorun` 忽略的已继承 `DSH_HOME`，以及 home 进程的状态、进程 id、启动 id、运行时版本、运行中的对话与进行中的更新；Host 提供 studio 后，还打印其回环地址（不含任何查询、片段或令牌）以及 `Run delorun open to open the studio in your browser.` 一行；`--json` 只打印其 `status` 应答 |
| `delorun doctor [--port <n>]` | 检查 home、Docker 引擎、DeepSeek API 密钥的格式以及 studio 的端口，然后读取正在运行的发布所记录的发布日志检查：已验证时为 `pass`；为 `warn` 时附带它保持未检查的时长与记录的原因，或说明没有记录检查；发布日志拒绝它时为 `fail`。不带 `--port` 时，端口检查覆盖 CLI profile 的 studio 所用的端口：即 profile 自己的 `cordis.patch.yml` 在 `webserver` 行上设置的 `port`（由 setup 的 profile 部分写入），profile 未设置时为上游的 3080。当本 home 中该 profile 的 home 进程以该端口上的 studio 地址应答其 `status` 请求时，被占用的端口作为 Delo 的端口通过；被任何其他进程占用时失败。它还报告该 profile 上一次的更新检查，不发送任何请求。每项检查输出一行；它不联系任何模型，不启动容器，也不运行任何命令，只有只读的 `docker version` 探测例外。库存 home 导入那一行只由接入了导入记录读取器的构建打印，本构建没有接入 |
| `delorun trash list [--json] \| restore <id> \| purge <id> [--clear-logs] \| empty [--clear-logs] [--profile <name>]` | 列出已删除的对话与工作区，以及各自在回收站 30 天中剩余的天数，并列出每个损坏的条目目录及其原因；恢复一个对话；在终端上答复“是”之后永久删除一个或全部条目，从会话世代、投影缓存、没有其他对话引用的附件、溢出文件与回收站中删除，写明它触及的每个存储以及它保留了多少共享附件。它说明片段可能在运维日志中保留 14 天；`--clear-logs` 立即清除 home 的每个运维日志（而不只是该条目的记录），并报告它无法清除的每个日志。工作区在 studio 设置中的“回收站”部分恢复，该部分会重新注册它。`restore`、`purge` 与 `empty` 在持有每个 profile 的 home 锁时运行，并在任一 profile 的 home 进程运行时被拒绝（[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md)） |
| `delorun export <chat-or-workspace-id> --out <file> [--profile <name>]` | 把一个对话，或一个工作区及其对话和它们引用的附件，写成以 home 密钥 `secrets/home-auth/home-key.pem` 签名的归档，第一次导出会创建该密钥。在对话历史中发现的秘密会按类型与对话写明，在本人答复“是”之前不写入任何内容；文件以 0600 模式新建，绝不替换已有文件。它在持有每个 profile 的 home 锁时读取存储，并在任一 profile 的 home 进程运行时被拒绝 |
| `delorun import <file> [--profile <name>]` | 在写入任何内容之前完整检查归档，先按密钥指纹打印签名者，再打印归档对自身声明的字段，每个字段都加引号并转义其控制字符，答复“是”之后导入。无法验证的签名被拒绝；home 不信任的密钥需要输入其指纹；未签名的归档只有在输入 `unverified` 之后才会导入。它读取最大 1 GiB 的文件与最大 512 MiB 的条目，在持有每个 profile 的 home 锁时运行，并先完成被崩溃中断的导入。工作区落在 home 中的 `archive/imported/` 下，不进入任何模型请求；studio 尚不能打开导入的对话，自定义内容只列出而不应用 |
| `delorun update [--check \| --report \| --yes] [--data-copy \| --no-data-copy] [--profile <name>]` | 请 home 进程获取并校验频道的最新发布，打印[约定 C3](../../docs/contracts/c03-update-report.zh.md) 的报告，询问后通过更新握手应用它；`--yes` 确认没有被停用、被移除或未校验条目且发布日志检查已通过的报告，并接受会话数据副本，`--no-data-copy` 拒绝该副本。低于正在运行的发布的目标会在安装任何内容之前被拒绝（`TARGET_LOWER`）；`delorun recover rollback` 是唯一的回退方式。`--check` 则立即运行[更新检查](../../docs/design/update-notice.md)，不需要 home 进程，也不需要 git：它校验频道的签名元数据，打印通知的一行与该发布的摘要，或说明本发布已是最新，检查失败时以 1 退出。更新用以校验的每个根，都是锚定在启动 Delo 的启动器的发布根上的 `trust/root.json`，这些发布根由 `DELO_LAUNCHER_ROOTS` 指明；不是由启动器启动的 Delo 会以 `VERIFY_FAILED` 与 `ROOT_NOT_ANCHORED` 拒绝更新，并指明启动器。为切换而进行的拆除失败或超过 `drainTimeoutS` 的 Host，会以 `HOST_STOP_FAILED` 将更新结束为 `aborted`，不切换任何内容，Host 重新运行。`--report` 打印完整报告，包括更新会停用的每个插件及其原因，并且不应用任何内容 |
| `delorun recover [status \| rollback [--profile-only] \| restore <version> \| safe-mode [--reason <text>] \| exit-safe-mode \| discard <path>]` | 更新之后 profile 所处的状态，附带更新记录与保留的对话数据；按 C3 的回滚表返回：有 home 进程运行时经由它，否则（除非 `--profile-only`）注册为 home 存储的独占使用者，并在其他进程使用它们时拒绝；某个 profile 历史版本；安全模式；以及移除一个保留副本或被搁置的目录。回滚会在启动器的根所锚定的根之下检查它要返回的版本，没有这些根时以 `ROOT_NOT_ANCHORED` 拒绝；当 `current` 未通过启动检查时，启动器自己以 `delorun recover rollback` 启动 `previous` |
| `delorun import-home [--from <dir>] [--dry-run] [--merge] [--max-size <bytes>] [--profile <name>]` | 把库存 DeepSeek Harness home（`~/.dsh` 或 `--from`）复制到 Delo home 中（[约定 C8](../../docs/contracts/c08-archive-and-trash.zh.md#the-stock-home-import)）。它先打印完整的预览，每个库存名称与文本都经过转义：对话、附件、按标题列出的每个工作区及其文件夹（位于 home 文件夹本身、其隐藏文件夹或某个 Harness home 中的工作区会连同其对话被保留不导入），然后是每个类别中会落地的内容、被保留的内容及原因（profile 及其每个组合包与插件、设置层、指令、技能、按名称列出的已存储密钥），以及留下不导入的内容及原因。`--dry-run` 到此为止，不写入任何内容。否则，它持有每个 profile 的 home 锁，撤回被崩溃中断的导入，询问数据，然后在每屏显示一部分落地的全部文本之后逐个询问每个类别，并按要求显示技能自身的指令；除“是”之外的每个答复都会排除该类别。已有对话的 home 需要 `--merge`；冲突会被拒绝。它从不更改库存 home，也从不运行插件、脚本或 `pnpm install`；对每个有待安装包的 profile，它打印 `delorun plugin --profile <name> install` |
| `delorun verify [--release <version>] [--offline] [--json]` | 检查正在运行的发布或某个已安装的发布，并为每项已注册的检查打印一行（[约定 C15](../../docs/contracts/c15-verification-checks.zh.md)）：`passed`、`failed` 或 `not run`，并附原因。`Launcher` 一行指明启动器所报告的版本（`DELO_LAUNCHER_VERSION`）以及发布已签名的 manifest 为其给出的完整性值，以便与 `npm view delorun@<version> dist.integrity` 比对。`release-signature` 经由安装走过的链，把 `trust/root.json` 锚定在启动它的启动器所携带的根上（由 `DELO_LAUNCHER_ROOTS` 指明），并检查其有效期；然后检查已存储 manifest 的签名、`trust/timestamp.json` 的新鲜度与发布日志 bundle，并在没有 `--offline` 时在线证明日志一致（[约定 C18](../../docs/contracts/c18-release-log.zh.md)）。没有启动器的根时，它只依据根自身的签名检查该根，说明这一点，并让 `release-signature` 保持 `not run`。`runtime-files` 依据签名文件清单检查每个已安装文件。其他已注册的检查为 `not run`。它打印受信任根的版本与密钥、它所锚定的启动器根目录、执行安装的启动器在 `trust/channel.json` 中记录的发布频道与发布日志、该发布自何时起保持未检查，以及一段说明这并非对 Delo 的完整校验的摘要。它把发布日志状态与校验通过的检查点记录在 `trust/` 下；当某项检查失败，或 `release-signature` 因日志不可达以外的任何原因未能通过时，以 1 退出；日志无法访问时，以 0 退出并给出警告。`--json` 打印 C15 的报告，附带发布、根、发布日志记录与记录的来源 |
| `delorun reach status \| on tailscale \| off [--profile <name>]` | 通过本人自己的 tailnet 远程访问 studio（[C7](../../docs/contracts/c07-reach-providers.zh.md)）。`on tailscale` 检查 Tailscale 已安装、已登录、已开启 HTTPS 证书并允许该用户配置 `tailscale serve`（不允许时打印 `sudo tailscale set --operator=$USER` 供本人运行；它从不运行 `sudo`），在该地址开启 Tailscale Funnel 时拒绝，移除服务端口上的任何其他 serve 规则（Delo 停止时也移除 home 自己的规则）并确认它已消失，用它一次性选定的固定监听端口写入 profile 的 `delo-reach` 行，并打印地址以及已批准的手机能做与不能做的事。`off` 关闭该选项，移除 Tailscale 在服务端口上提供的任何内容并确认，无法做到时以非零退出并给出原因。`status` 打印该行，并在 Delo 运行时指向 studio 中的“设置 → 设备”以查看实时状态 |
| `delorun devices list \| approve \| remove <id> \| code [--profile <name>]` | 本 home 信任的设备（[C5](../../docs/contracts/c05-device-approval.zh.md)）。`approve` 通过 home 套接字的 `devices.approve` 打开批准窗口，列出每个等待中设备的名称、平台、时间与简短请求 id，询问要批准哪一个，然后询问它显示的 8 位代码，或询问要取消哪个请求以腾出位置；设备自选的文本在打印时会转义控制字符与双向字符；`remove` 立即结束该设备的会话，经由运行中的 studio 或直接在记录上进行；`code` 只向终端打印所有者代码 |
| `delorun workspace full-access [<folder> on \| off] [--profile <name>]` | 工作区的完全访问（[C1](../../docs/contracts/c01-home-layout.zh.md)），位于 [`@delo/plugin-permission-defaults`](../../packages/plugin-permission-defaults/README.zh.md) 的按工作区权限存储中。不带文件夹时，它列出存储中持有的工作区。`on` 打印完全访问对该文件夹意味着什么，并只在终端上答复“是”之后记录授权；没有终端或没有答复“是”时不记录任何内容，在本人作答期间发生变化的授权会作为过期被拒绝。`off` 不经询问撤回授权。Delo 从不作为工作区添加的文件夹会被拒绝。Delo 运行时，该命令随后通过 home 套接字的 `permission.reload` 请它重新读取存储，并报告持有其他条目的 studio；在该文件夹中的 `delorun headless` 在下次启动时读取该授权 |
| `delorun mcp list \| accept <server> \| decline <server> \| revoke <server> [--profile <name>]` | 运行中的 studio 的添加时同意让其保持停止的 stdio MCP 服务器，以及它允许的服务器，每个服务器名称一次接受（[`@delo/plugin-mcp-consent`](../../packages/plugin-mcp-consent/README.zh.md)），通过 home 套接字的 `mcp.list`、`mcp.accept`、`mcp.decline` 与 `mcp.revoke`（[C19](../../docs/contracts/c19-home-process.zh.md)）。`list` 打印每个等待中的服务器自你允许以来有何变化（新服务器；其命令、参数、工作目录或环境变量有变，并写明变化的变量；接受列表无法读取；或对按服务器保存接受之前允许的服务器打印“Delorun now remembers each server separately; review it once”）、你是否拒绝或撤销了它、它的命令、参数、工作目录、环境变量，以及它等待的原因；随后打印每个已允许的服务器及其命令、参数、工作目录、环境变量、是否有已配置服务器使用该名称，以及允许它的时间。只有 `NODE_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`PATH`、`PYTHONPATH` 与 `DYLD_*` 这些会改变运行内容的变量才打印其值。`accept` 打印一个等待中、已拒绝或已撤销的服务器，并只在终端上答复“是”之后，以它显示的审查 id 记录接受，studio 随后启动该服务器；`decline` 让它保持停止，并以已拒绝状态列出，直到其启动变化。`revoke` 打印一个已允许的服务器，只在终端上答复“是”之后以它显示的接受 id 撤回其接受，并说明它是否已停止；它保持停止，并以已撤销状态列出，直到其启动变化或你再次接受它，其他每个服务器仍被允许。每个子命令都需要 Delo 正在运行（否则以 3 退出） |
| `delorun plugin …` | 上游的 `dsh plugin …`，不作改动，针对 Delo home 运行：在上游的 profile 文件锁下，它以给定的参数在 profile 目录中运行 pnpm，更改 profile 的 `package.json`、锁文件与 `node_modules/`，并记录组合包列表。它不启动 Host，也不获得组合、沙箱覆盖、沙箱不变式或启动前步骤：pnpm 作为本进程运行，不受限制，带着它的环境，只有在 profile 的 `pnpm-workspace.yaml` 允许依赖的构建时才运行该依赖的安装脚本，并运行 `exec` 或 `dlx` 等 pnpm 命令所指定的任何内容；组合包检查读取每个新组合包的清单与 patch 文件，不导入任何插件代码。它先注册为 home 存储的共享使用者，因此在 `delorun trash`、`export`、`import` 或离线的 `delorun recover rollback` 运行时，或有更新、回滚或恢复进行时被拒绝，而更新的准备、复制、恢复与回滚在它运行时也会被拒绝 |
| `delorun plugin check <directory>` | 读取插件的 `package.json` 而不运行其文件，打印其 `engines.dsh`、DSH 对等依赖与 `engines.delo` 对本发布接纳什么、哪些未声明、面向本 Delo 次版本的 `engines.delo` 范围，以及安装器是否接纳它（[约定 C22](../../docs/contracts/c22-delo-plugin-interface.md)）；安装器会拒绝它时以 1 退出 |
| `delorun headless …` | home 的 `headless` profile，即上游的 `headless` 模板，并由一次性变更 `headless-bundle` 把 [`@delo/bundle-headless`](../../packages/bundle-headless/README.md) 链接进来，通过 Delo 唯一的组合启动（[约定 C19](../../docs/contracts/c19-home-process.zh.md#host-invariants)）：C1 的沙箱覆盖最后应用，sandbox 行与该组合包的每一行都受其不变式约束，回合闸门把任务的第一步保持到该检查通过；向人询问的防护会拒绝，因为该 profile 没有组合任何审批应答者；对于没有完全访问授权的工作目录，`--permission-mode danger-full-access` 与 `DSH_PERMISSION_MODE=danger-full-access` 会在启动前被拒绝，拒绝信息写明 `delorun workspace full-access <folder> on`；不加载该组合包的 profile 会被拒绝并给出修复办法；上游的 `--profile`、`--patch`、`--from-default-profile` 与配置转储被拒绝，其他每个参数都传给 headless 应用；在 `delorun trash`、`export` 或 `import` 运行时，或有对话数据的更新、回滚或恢复进行时被拒绝，而这些操作在它运行时也会被拒绝 |
| `delorun --version [--json]` | 打印 `Delo <delo>` 与 `DSH <dsh>`，即 Delo 的版本和它所运行于的 DSH 的版本；`--json` 以一行打印 `{"delo":…,"dsh":…}`。`-v` 与 `--version` 相同 |

退出码：0 表示完成，1 表示失败，2 表示命令行错误，3 表示该 profile 没有 home 进程在运行（`status`、`update`）。失败时，以 npm 启动器共用的格式（`@delo/home` 的 `renderRefusal`）在标准错误上打印：一行说明 Delo 做了什么，一行 `Why:` 附带错误代码（例如 `HOME_MODE`）以及它涉及的路径或细节，以及在 `What you can do:` 下有帮助的命令或步骤，并写明命令行给出的 `--profile`。命令行错误打印它自己的消息。没有任何包描述的失败打印 `Delo stopped: <message>`，不带堆栈；`delorun` 不为它自己的失败保留日志。每个拒绝在打印之前都经过 `@delo/logs` 的脱敏器（运维日志所用的同一个），因此错误消息中的密钥、令牌或凭据路径打印为 `[redacted:<kind>]`；在 home 进程中，脱敏器是其日志的脱敏器，它还知道启动令牌。没有任何命令捕获的失败，例如在 `main` 返回、上游的 profile 运行器接管进程之后发生的未处理拒绝，会打印同样经过脱敏的拒绝而不是 Node 堆栈，并以 1 退出：`src/last-resort.ts` 在每个进程中、在任何其他内容注册之前安装一次上游的 `installFailLoud`，并把它的诊断路由到拒绝中，因此它对上游启动已报告的激活拒绝的处理仍然适用。没有注册的拆除时，它在监听器内立即退出。home 进程与 `delorun headless` 注册其当前 Host 的拆除（`registerFatalRelease`），退出最多等待它上游规定的 2 秒，因此崩溃会在进程结束之前销毁 Host。最后一条修复办法说明完整细节在哪里：在 home 进程中，是其 `home-<profile>` 日志中带堆栈的 `error` 记录，`delorun logs home --profile <name>` 会显示它；普通命令、`delorun headless` 与 `delorun plugin` 不保留日志，修复办法会说明这一点。堆栈从不出现在终端上。`src/refusals.ts` 组合每个包在其错误旁导出的描述器；当某个分支包导出的错误类既未在那里描述，也未被列为从不到达 `delorun` 的错误时，一个 spec 会失败；该 spec 通过 TypeScript 的检查器读取每个包的导出、映射到其源码的 `exports` 入口点以及 `src/` 下的每个模块，因此导出列表、重命名导出、默认导出与重新导出都计入。

<a id="the-home"></a>

## home

- **解析。** 当 `DELO_HOME` 已设置且非空白时，home 即为它，否则为 `~/.delo`；`@delo/home` 拒绝约定 C1 所禁止的 home，错误代码为 `HOME_INVALID` 或 `HOME_IS_DSH_HOME`。
- **`DSH_HOME`。** 在任何上游代码运行之前，`delorun` 会把 `DSH_HOME` 与 `DELO_HOME` 设为该 home，把 `DELO_PROFILE` 设为该 profile，因此上游、其 `.env` 层以及每个子进程都使用 Delo home。已继承的 `DSH_HOME` 会被忽略，`delorun status` 会将其指出。
- **`~/.dsh`。** `delorun` 从不读取、写入或迁移上游的 home。
- **`DELO_VERSION`。** 每次调用都会在任何上游代码运行之前把 Delo 自身的版本导出为 `DELO_VERSION`，因此启动前的预检与插件管理器会用正在运行的 Delo 检查插件的 `engines.delo`（[约定 C17](../../docs/contracts/c17-plugin-versions.zh.md)）；每个子进程都会继承它。要求另一个 Delo 版本的插件，或其 `engines.delo` 不是范围的插件，会在安装时被拒绝、在启动时被停用，消息中写明 Delo 与 DSH 两个版本。未声明 `engines.delo` 的插件不受影响。
- **目录树。** 除 `status` 外，每个命令都会以 0700 模式通过 `ensureHomeTree` 创建 home 的目录树；当 home、`secrets/` 或 `run/<profile>/` 的模式更宽松时，它以 `HOME_MODE` 停止，并给出修复命令 `chmod 700 <path>`。`delorun` 自身不修改任何模式。

<a id="profiles"></a>

## Profile

CLI profile 为 `default`，或由 `DELO_PROFILE` 或 `--profile` 选定的名称，遵循[约定 C1](../../docs/contracts/c01-home-layout.zh.md#profiles) 的 profile 命名规则（启动器也应用该规则）：1 到 32 个小写字母、数字、`-` 或 `_`，以字母或数字开头，且不是保留名称 `desktop`、`headless`、`data-users` 与 `node_modules` 之一。保留名称无论字母大小写如何都会以用法退出码被拒绝，消息写明该名称及原因：`desktop` 是桌面应用的 profile，`headless` 是 `delorun headless` 启动的 profile，`run/data-users/` 保存 home 范围排他的记录，`profiles/node_modules/` 是上游的包层。`delorun plugin --profile desktop` 会被上游自身的解析器拒绝，因此 `delorun` 从不运行、初始化或修改 `profiles/desktop/` 或其锁。setup 的入口以 [`@delo/bundle-local`](../../packages/bundle-local/README.zh.md) 的 `DELO_PROFILE_BUNDLES` 创建 CLI profile：上游的 `web` profile 模板（其 Web 应用提供 studio），其后是 `@delo/bundle-local`。随后按上游使其自身组合包可导入的方式使每个 Delo 组合包可导入：上游的运行时解析已提供的组合包（发布的安装把它与上游的包放在一起）保持不变；只有本 `delorun` 自带的组合包（如在源码检出中）则通过上游自己的 `dsh plugin add link:<directory>` 操作加入，该操作把它记入 profile 的 `package.json` 并用 pnpm 安装。该操作的输出写入 profile 的 `home-<profile>` 运维日志，每行一条记录，终端显示一行进度 `Linking Delo's parts into the profile…`，其后为 `done` 或 `failed`；失败操作的错误写明该日志的文件。

启动时按上游启动的方式加载该 profile；若某个 Delo 组合包（`@delo/` 作用域下的任何组合包）因无法解析、读取或接受而被跳过，则拒绝启动它。否则上游会以其余各层及其自身默认值启动，而这些默认值会把会话日志上传给 DeepSeek。错误信息列出每个被跳过的组合包、上游给出的原因及修复方法：在源码检出中，对本 `delorun` 自带的组合包运行 `delorun plugin --profile <name> add link:<directory>`；否则重新安装 Delo，或运行 `delorun plugin --profile <name> install`。profile 启动且其 Loader 稳定后，启动过程还会检查 Delo 组合包插入的每一行以及模块位于 `@delo/` 作用域的每一行：若某个已启用的行未激活（例如导入失败），`delorun` 通过它自己的拆除（不结束任何进程）关闭应用，最多等待 5 秒，然后释放锁并以 1 退出，并在上游给出原因的警告之下列出每一行及其修复方法。失败或耗时更长的拆除会加入拒绝的原因；此时启动不回滚任何内容、不重新启动任何内容并保留锁，进程在拒绝打印后以 1 退出。`delorun headless` 以同样的方式拆除被拒绝的 profile，当其拆除未完成时，在拒绝打印后把进程交给上游有时限的关闭。Web 应用在其 Loader 稳定时在浏览器中打开 studio，因此被拒绝的启动可能留下一个指向已停止服务的 studio 页面。被跳过的上游组合包和未激活的上游行按上游的方式报告，不会阻止启动。

在加载 profile 之前，若某个 CLI profile 的组合包列表列出了 `@delo/bundle-local` 却没有列出 studio 组合包（setup 在 studio 组合包出现之前就是这样创建 profile 的），启动过程会把 `@delo/bundle-studio` 加入其中（[`studio-bundle.ts`](src/studio-bundle.ts)），使用 setup 链接 Delo 组合包的同一操作，其输出写入 home 进程的日志。它打印进度行，并在加入组合包后打印一行；已列出该组合包的 profile，或不是由 Delo 的 setup 创建的 profile，保持原样。无法加入该组合包时，启动以库存外观继续，并说明原因。这一加入是该 profile 的一次性变更之一：完成后，profile 的 `delo-migrations.json` 会列出它，此后任何启动都不会再次加入该组合包，因此移除 studio 组合包的人会保留库存外观。无法读取的记录不会加入任何内容：启动会给出警告，写明该文件，并说明删除它会让下一次启动应用这些变更（[C1](../../docs/contracts/c01-home-layout.zh.md#profiles)）。

插件的密钥从不进入 patch 文件（[约定 C1](../../docs/contracts/c01-home-layout.zh.md#secrets)）。在它启动的每个 Host 上，`delorun` 都会在 Loader 装载任何行之前注册两项拒绝：拒绝把 schema 角色为 `secret` 的配置字段（例如上游网页搜索插件的 DeepSeek API 密钥）的值保存到 profile patch 的配置修改，无论请求来自 studio 的设置、智能体的 `configure` 操作、旧 `settings.yaml` 的导入还是配置编辑器的其他调用方；以及拒绝其 patch 含有此类值的任何 profile 历史版本，包括更新的快照；没有 Host 运行时取得的快照也被拒绝。启动或 `delorun headless` 运行在提供服务之前，会通过 Host 的凭据提供者把 profile patch 或 home 的 `cordis.patch.yml` 中已有的此类值移入 `.credentials.yaml`，前提是插件在旁边的 `credential-ref` 字段中指明所存密钥；启动会打印它改动的每个文件与字段，从不打印值本身；无法移动的值保留原处，每次启动都会在标准错误和 home 日志中打印它以及移动方法，期间历史不保存任何版本（[密钥字段](src/secret-fields.ts)）。无论哪种情况启动都会继续，因此从曾在 patch 中保存密钥的 Delo 进行的更新会提交。

<a id="setup"></a>

## Setup

Setup（[`src/setup/`](src/setup/index.ts)）回答[约定 C11](../../docs/contracts/c11-setup-answers.zh.md)中的问题，并写入 CLI profile。三种形式给出相同的答案，因此产生相同的写入：

- **提问**需要终端。第一个屏幕询问“快速”（预选）或“完整”。“快速”询问隐私说明；当 `~/.dsh` 是目录且 Delo home 中没有对话时，询问是否复制库存 home 的对话、附件与工作区列表，除非本人答复“是”，否则视为否（[`src/import-home/section.ts`](src/import-home/section.ts)）；以及模型密钥和提示问题。“完整”还会在说明之下询问是否检查新版本（预选“是”），并加入后台、远程访问与 profile 部分。“快速”的说明会告诉本人在 Delorun 首次启动之前如何回到那个问题：回到第一个屏幕，然后选择“完整”。第一个问题之后的每个问题都可以返回上一个问题（选择题中的“← 返回”，文本或密钥问题中输入空值），并且在写入任何内容之前，有一个审阅屏幕列出各项答案。输入的密钥在存储之前，会向提供方的源发出一次实时请求进行检查；检查失败时会说明原因，让本人重新输入密钥或继续，本人选择继续的密钥会在审阅屏幕上显示为未验证，并附带原因。隐私说明来自 [`@delo/bundle-local`](../../packages/bundle-local/README.zh.md)，从其 `./statements` 导出读取。Setup 不再询问它只作记录的四个问题（命令在哪里运行、studio 附加功能、其他模型的帮助、桌面端分析）；两个上游选择加入项保持关闭，可在“设置 → 隐私”中更改。
- **`--yes`** 应用全部默认值，并从 `DEEPSEEK_API_KEY` 读取模型密钥；该变量未设置时，它以一条指出变量名的错误停止。除非给出 `--check-key`，否则不对密钥进行实时检查。与其他形式一样，给出 `--no-update-check` 时发布检查关闭。
- **`--config <file>`** 读取答案文档。若文档启用了 reach 或库存 home 导入（后者要先在终端中显示其预览）、携带了 setup 不再询问的键（消息写明被移除的键）、在任何字段中携带了凭据值，或指定了 3 或 2 以外的架构版本，它会拒绝该文档；版本 2 的文档没有 `updateCheck`，按开启检查读取。拒绝信息指出字段，且从不回显任何值。

每个主题都是 [`src/setup/sections.ts`](src/setup/sections.ts) 注册表中的一个部分：`privacy`、`import`、`key` 与 `prompts` 在两种模式中都运行，`privacy` 只在“完整”中提出其问题；`background`、`reach`（远程访问，[`src/reach/setup-section.ts`](src/reach/setup-section.ts)）与 `profile` 只在“完整”中运行。`delorun setup privacy` 询问是否检查新版本，并像“设置 → 通用 → 更新”那样写入答复。`delorun setup <section>` 在已完成 setup 的 profile 上再次运行某一部分，`delorun setup --list` 列出各部分。后来的包以 `SectionRegistry.register(section, { order })` 加入自己的部分；`order` 决定它在其他部分中的位置。一个部分的写入会收到 home、profile 目录、输入的密钥以及 `delorun` 继承的环境。

提示问题的答复会生效：“更安全的提示”与“与库存相同”把 `delo-permission-defaults`、`delo-instruction-consent`、`delo-mcp-consent` 与 `delo-schedule-consent` 各行的 `config.enabled` 分别写为约定 C16 注册表中对应开关的 Delo 默认值与对等取值。抓取防护是拒绝而非提示，保持开启。

Setup 按顺序执行各步骤：创建 CLI profile（使用 profile 部分选定的名称），然后把每个部分的写入（发布检查行、不含凭据的库存 home 导入、以 0600 模式存入上游 `.credentials.yaml` 的输入密钥、提示各行、studio 端口行）写入 profile 的 `cordis.patch.yml`。关闭的发布检查以上游设置服务保存它的形式写入 `delo-update-check` 行：其 id、插件名称以及带 `enabled: false` 的完整配置；开启时，setup 不在该行上留下任何配置。每次写入都在运行启动之前落地，因此在 setup 中关闭的检查不会发出任何请求。在运行未完成期间，`run/<profile>/setup-progress.json` 保存不含任何密钥的答案以及已完成的步骤，因此被中断的运行会从第一个未完成的步骤继续。所有步骤完成后，setup 会删除该文件，并把答案（包括哪些部分被看过、答复过或跳过）写入 `profiles/<profile>/setup-answers.json`，供 studio 的引导流程与启动命令读取；[`readBackgroundAnswer`](src/setup/background.ts) 返回后台答复。在对应部分存在之前，凭据转发记录为关闭。

终端运行在 [`src/setup/ending.ts`](src/setup/ending.ts) 中结束：它提议以启动它的启动器的版本（`DELO_LAUNCHER_VERSION`）运行 `npm install -g delorun@<version>`，启动器未指明版本时则不提议安装；按后台问题的答案在后台或在终端中启动 Delorun，并按 `delorun open` 的方式打开 studio，或在计算机没有显示器、终端是 SSH 会话时打印一行 SSH 端口转发命令与 `delorun open --print`。它会打印 Delorun 在终端关闭后仍会继续运行、取自 home 进程 `status` 应答的地址（不带令牌），以及 `delorun status`、`delorun logs --follow` 与 `delorun stop`。`--yes` 与 `--config` 不启动任何内容，只打印要运行的命令。

<a id="the-home-process"></a>

## home 进程

`delorun start --foreground` 与不带选项的 `delorun` 通过 `HomeProcess.start` 在本进程中运行 home 进程：它获取 `run/<profile>/home.lock`，写入新的启动令牌，在更新通道 `run/<profile>/update.sock` 上监听，并通过上游的 profile 运行器引导该 profile，使其作为 Host 运行。在获取锁之前，它在 `run/data-users/` 下注册为该 profile 的 home 进程，直到退出，因此在它运行期间，另一个 profile 的更新准备、复制、恢复或回滚会以 `CHATS_RUNNING` 拒绝；而在 `delorun trash`、`export` 或 `import` 运行时，或另一个 profile 的更新进行时，它拒绝启动（[约定 C19](../../docs/contracts/c19-home-process.zh.md#the-home-process)）。它写入 `home-<profile>` 运维日志；在前台运行时，终端还会显示其输出。无论有多少次启动，恰好只有一次持有该锁，包括取代已死亡持有者留下的锁。存活的持有者通过更新通道被询问状态：有回应时，第二次启动会打印正在运行的进程并以 0 退出；2 秒内无回应时，本次启动以 `HOME_UNRESPONSIVE` 停止。无论以何种方式结束进程，锁、令牌文件与套接字都会随之移除；被 `SIGKILL` 杀死的进程会留下它们，下一次启动会将其替换。

启动时，profile 带着 C1 的隔离配置启动上游的本地沙箱提供方（行 `sandbox`）：`protectedHome` 为规范化后的 Delo home，`protectedHomeReadable` 为 C1 的读取豁免，`deniedSockets` 为 `run/<profile>/` 下更新通道与监管器的套接字（没有监管器运行，因此只有更新通道的套接字存在）、当前 Docker 上下文的套接字及其真实路径，以及存在时 Docker Desktop 在 macOS 上位于 `~/Library/Containers/com.docker.docker/Data/` 与 `~/.docker/run/` 下的套接字；因此在方言强制这些规则之处，受限的工作区命令无法读取 home 或令牌，也无法连接任一通道：bwrap 与 Seatbelt 强制全部规则，Landlock 强制读写规则但不强制任何套接字规则，Windows 运行器只限制写入。WSL 下与 Linux 上 Docker Desktop 的控制套接字目录不被拒绝。这些设置通过覆盖补丁 `run/<profile>/sandbox.patch.yml`（模式 0600）传递，该文件在 Host 运行期间存在。该覆盖是启动传入的最后一个补丁，因此它应用于设置该行的每一层之上：profile 的组合包、其自身的 `cordis.patch.yml`、应用于每个 profile 的 home 的 `cordis.patch.yml`，以及安全模式的覆盖。一层的 `config` 会替换该行的整个配置，因此覆盖按最后一个配置该行的层所设的值保留该行的其他设置，并保留每一层列出的被拒绝套接字。当组合后的设置含有它无法沿用的表达式时，启动会拒绝；对于设置运行器本身（`runnerCommand` 或 `runnerFailureSignatures`）的任何层，启动也会拒绝并写明每个文件：运行器命令会跳过提供方的内置选择，使该行在提供方报告完全强制的同时以不受限的方式启动。

不带 `--foreground` 的 `delorun start` 会以脱离终端的方式启动 `delorun start --foreground`，标准输入关闭，其输出写入日志，并最多等待 120 秒使 home 进程报告 `running`。若 home 进程先行退出或未及时报告 `running`，则报告失败，并给出其日志的位置。`delorun stop` 与 `delorun status` 读取令牌文件，并通过更新通道发送 `stop` 或 `status`；若没有存活的锁持有者，`stop` 会打印 Delo 未在运行并以 0 退出，`status` 则以 3 退出。

当命令从 C1 仓库的 `runtimes/<version>/` 运行时，home 进程获得 `src/update/` 的更新支持：仓库、锚定在 `trust/` 下根链上的 `@delo/install` 发布渠道、基于 profile 与暂存目标之读取器的 C3 报告、profile 历史以及会话数据副本。从源码检出运行时，它没有仓库，并拒绝更新请求。从仓库运行时，启动还会把更新检查（[notice-host](src/update/notice-host.ts)）挂接到 Host 的 `deloUpdateCheck` 服务上，该服务在启动时（到期时）与每个间隔运行它，每个较新的发布只打印一次其提示行，并把提示提供给 studio；profile 关闭了该检查的启动会移除其记录。后台启动在 home 进程报告 `running` 之后打印上一次检查的提示行。Host 根据上游的 `agent/status` 事件统计其运行中的对话，因此 `delorun stop` 与更新会等待运行中的对话，包括在它们等待期间开始的回合；其健康检查即 C3 的 H1 到 H5（[host](src/update/host.ts)）。文件描述符 3 是套接字或管道的进程是作为某次更新的后继者启动的：它从中读取交接信息并运行 `HomeProcess.takeOver`。

每个 Host 都经过 [`src/compose.ts`](src/compose.ts)，它让组合的行与已启动的行遵守 C19 的 [Host 不变式](../../docs/contracts/c19-home-process.zh.md#host-invariants)：每个必需的行——`sandbox` 以及 Delo 组合包插入的每一行——都由声明它的组合包插入一次并运行该组合包的插件，任何其他层对其 id 的第二次插入都会被拒绝，安全模式不豁免其中任何一行，并且启动之后，这样的行所提供的每个服务（`sandbox`、`fetchGuard`、各同意服务、`deloTurnGate`）都必须由该行的 fiber 提供。在 CLI profile 与 `headless` profile 中，更新闸门把每个回合的第一步保持到启动过程在该检查之后释放它为止。在 Host 启动之前，[`src/pre-start.ts`](src/pre-start.ts) 运行 `delorun start --foreground` 与 `delorun headless` 共用的一个有序步骤列表：撤回被中断的导入与更新提示的检查（这两个槽位目前不做任何事）、完成被中断的恢复，以及 profile 的一次性变更。Host 的启动环境是叠加在 `delorun` 启动时环境之上的上游 `.env` 层；`main` 捕获该环境一次并向下传递，设置 `DELO_` 名称的 `.env` 层会在任何层应用之前被拒绝。

<a id="opening-the-studio"></a>

## 打开 studio

[`src/open/`](src/open/studio.ts) 打开 studio。`delorun open` 以令牌文件中的启动令牌，通过更新通道发送 `studio.open-token`；home 进程向其 Host 的连接请求一个指向 studio 回环根的启动 URL（[host link](src/open/host-link.ts)），在 Delo 的组合下，该 URL 的令牌只能使用一次，并在 60 秒后过期（约定 C4，“启动令牌”）。该链接交给 `xdg-open`、`open`，或在 Windows 与 WSL 下交给 `cmd.exe /c start`，命令写出的其他任何内容都不包含它。`--print` 写出该链接以及一行说明它只能使用一次。链接写明 studio 的回环主机与端口，只在那里登录：通过 `localhost` 而非 `127.0.0.1`，或通过 `ssh -L` 转发到另一个本地端口到达 studio 的浏览器，会被一个写明该链接所针对地址的页面拒绝，`delorun open --print --port <n>` 为转发的端口生成链接。studio 监听在回环以外地址上、或把它发布到公共 URL 的 Host 不给出链接（`STUDIO_UNAVAILABLE`，附带原因）；持有通道但 2 秒内未应答的 home 进程被报告为未应答，而不是未运行。

在 Delo CLI profile 上直接运行上游的 `dsh`（而不是 `delorun start`）无法通过打印的地址登录：开关打开时，`dsh web:` 一行不携带令牌，而 `delorun open` 需要 `delorun` 的 home 进程。只有 `dsh` 自己签发一次性链接的浏览器交接能在那里登录。请用 `delorun start` 启动 profile，并用 `delorun open` 打开 studio。启动从不把链接传给上游的浏览器交接（`--no-open`）：它打印 `Run delorun open to open the studio in your browser.`，而 `delorun start --open`、不带选项的 `delorun` 与 setup 的结束步骤会在 home 进程运行后通过同一请求打开 studio。

<a id="how-delorun-runs-upstream"></a>

## delorun 如何运行上游

`delorun` 只通过上游的 profile 运行器启动应用，这是根目录 `AGENTS.md` 的要求。启动与 `headless` 以 CLI profile 与 `headless` profile 调用 `@deepseek-ai/dsh/profile-boot` 中的上游 `runProfile`，与桌面 Host 为其 profile 所做的相同，每次都经过 Delo 的组合（[`src/compose.ts`](src/compose.ts)）；两者都传入 `failLoud: false`，因为入口点唯一的最后兜底处理器会报告崩溃并销毁已注册的 Host；启动还传入 `signals: false`，因为其 home 进程唯一的信号监听器为它启动的每个 Host 服务，而 `headless` 保留上游的信号处理器；`plugin` 调用上游的 `runCli`，并以其 `argv` 选项传入 `dsh` 会收到的参数。该选项是 Delo 为此命令对上游所做的唯一改动，记录在差异台账中，类别为 `generic-fix`；上游已从 `DSH_HOME` 解析其 home，因此 home 不需要改动。

<a id="extension-points"></a>

## 扩展点

- **命令**是导出一个 `CliCommand`（`src/command.ts`）的模块，并在 `src/main.ts` 的 `COMMANDS` 中添加一行。`delorun doctor` 属于 `src/doctor/`，`delorun logs` 属于 `src/logs/`，二者都通过这一行接入。
- **`delorun doctor` 的密钥查找顺序。** 依次读取：home 的 `.credentials.yaml` 中 setup 保存的引用，进程环境变量 `DEEPSEEK_API_KEY`，调用目录的 `.env`，最后是 home 的 `.env`。采用第一个含有密钥的来源并检查它。检查只输出来源名称，从不打印密钥；格式检查在本地进行，不把密钥发送给 DeepSeek。
- **Setup** 是 `src/setup/index.ts` 中的 `runSetup`，`delorun setup` 与首次运行都会调用它。它的各部分位于 `src/setup/sections.ts`，支持返回的步骤运行器位于 `src/setup/steps.ts`，经由 `src/setup/prompts.ts` 的 `Prompter` 接口，因此测试可用脚本化的提问器运行它们。
- **home 进程的依赖**是 `src/start.ts` 中的 `StartDependencies`：profile 的准备与运行器、环境加载器、持有者探测（更新通道的 `status` 请求）、退出钩子、输出捕获与 studio 打开器，因此规格测试可以用替身运行一次启动。

<a id="not-yet-implemented"></a>

## 尚未实现

- 登录时启动（`delorun start --at-login`、`delorun stop --at-login`）、`delorun status --follow`，以及启动顺序中的隔离探测。
- 对话闸门不保持定时投递：在更新等待期间到期的投递，其回合会以 `UPDATE_PENDING` 被拒绝。报告不读取任何吊销列表，因为没有任何发布公布吊销列表（[`@delo/update`](../../packages/update/README.zh.md#not-yet-implemented)）。
- setup 的 reach 问题。setup 将 reach 记录为关闭。
- Windows 的 DACL 检查（[#48](https://github.com/Delo-Run/delo/issues/48)）：在 Windows 上，目录检查不检查任何内容，受保护文件的检查只查看文件类型。
- `reach`、`devices` 与 `dev`。
- 在 studio 中打开导入的对话。
- `delorun verify --mode`，以及除 `release-signature` 与 `runtime-files` 之外的每个已注册检查。`delorun verify` 报告默认模式 `warn`，因为目前没有任何内容读取 `integrity.mode`。

<a id="development"></a>

## 开发

在检出的代码中用 `pnpm --filter @delo/cli delorun <command>` 运行 `delorun`；它需要先执行 `pnpm run build:artifacts` 和 `pnpm --filter @delo/bundle-local run build`，因为上游的构建不会构建 Delo 的包；setup 会把该组合包链接到 CLI profile 中。规格测试用 `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli` 运行，应用的类型检查用 `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json` 运行。规格测试使用临时的操作系统 home，从不触及真实的 `~/.delo` 或 `~/.dsh`。
