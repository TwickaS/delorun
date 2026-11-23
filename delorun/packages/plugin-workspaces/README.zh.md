---
description: "主对话的账户工具所用的工作区提供方，供维护者修改 Delorun 在一个根目录下创建、导入、读取、移入回收站与恢复工作区文件夹的方式，以及克隆时某个主机能收到的令牌。"
kind: "package-bundle"
---

# @delorun/plugin-workspaces

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

`@delorun/plugin-workspaces` 提供 `delorunWorkspaces` 服务，主对话的账户工具调用它的[服务定义](src/service.ts)。它在一个已配置的根目录下创建空的工作区文件夹，用 `git clone` 把一个仓库导入新文件夹，读写工作区的 `AGENTS.md`，并把包含工作区的文件夹移入 `root/.delorun-trash`，恢复时再移回。每个工作区都是上游工作区注册表中的一项；移入回收站时注销其中的工作区，恢复时重新注册。导入与回收站记录保存在插件自己的存储域中，因此重启后仍然保留。标准组合不挂载本插件；Delorun 的 studio bundle 以其配置挂载它。

## 目录

- [约定](#contract)
- [配置](#configuration)
- [沿用审查](#carry-forward-review)
- [已知限制](#known-limitations)
- [测试](#tests)

<a id="contract"></a>

## 约定

- **创建。** `create` 在 `root/<directory>` 下创建文件夹，模式为 0755 去掉 umask 之后的值，并以 `title` 注册它，`title` 默认为文件夹名。名称必须是文件夹名：首字符为字母或数字，其后最多 99 个字母、数字、点、下划线或连字符。不合格的名称应答 `invalid`，不能作为工作区的文件夹应答 `location`（[`workspaceLocationProblem`](../home/src/workspace-location.ts)）。已存在的文件夹应答 `taken`。注册表拒绝新文件夹时，移除这个空文件夹，调用应答 `failed`。
- **导入。** `startImport` 只接受不含用户名、密码、查询或片段的 `https` URL（[`cloneUrlProblem`](src/git.ts)），其他 URL 在任何进程启动之前即以 `invalid` 拒绝。文件夹名取自请求中的名称，否则取 URL 最后一段路径去掉 `.git` 之后的部分。调用会记录一条导入记录，并立即应答其 id 与文件夹。克隆通过上游的 `subprocess` 服务在后台进行（[`cloneRepository`](src/clone.ts)），最长耗时 `importTimeoutMs`。每次克隆都在没有 askpass 程序、没有钩子、没有文件监视器且只允许 `https` 的条件下运行，不读取任何 git 配置——既不读系统的，也不读本人的全局配置——并且其环境会清除可能把它指向其他仓库、传输方式或程序的 git 变量（[`git.ts`](src/git.ts)）；因此私有仓库需要这份凭据。克隆成功时，文件夹以其名称注册为工作区，记录变为 `done` 并带上该工作区。克隆失败或超过时限时，若没有工作区持有该文件夹，则移除它，记录变为 `failed`，原因为经过脱敏的 git 原文，或 `the clone took longer than N minutes`。克隆进行期间，`list` 显示 git 最新的进度行。
- **指令。** `instructions` 读取工作区的 `AGENTS.md`，应答其路径、文本、以文件字节计算的 SHA-256 修订值，以及字节上限。`setInstructions` 只在文件仍是所给修订值时写入文件；空文本则移除文件。`null` 表示文件不存在。修订值不符应答 `conflict`，文本超限应答 `too-large`。未知的工作区应答 `not-found`，根目录之外的工作区应答 `outside`。访问会从根目录到文件逐个名称地打开路径上的每一项，任何一项是符号链接或非目录都以 `O_NOFOLLOW` 拒绝（[`files.ts`](src/files.ts)）。在 Linux 上，它通过 `/proc/self/fd` 命名每个已打开的目录，因此被检查的名称就是被打开的名称；在其他系统上它用 `lstat` 检查每个名称，这不能关闭 proc 方式所关闭的竞态窗口——同一用户的进程可以在检查与随后打开其内部名称之间替换该名称。这一残留风险为可移植的访问方式所接受；Windows 拒绝这些调用。
- **回收站。** `trash` 把持有某个工作区的文件夹，连同其下的全部已注册工作区，移入 `root/.delorun-trash/<id>`（该文件夹模式为 0700），并注销这些工作区。移动之前，它们中每个尚未归档的对话都会以 `stopActivity` 归档，即请求停止该对话正在运行的工作。移动之前失败时不改变任何内容，并取消本次调用所归档对话的归档。回收站记录保存每个工作区的标题、路径、有序的对话以及被归档的对话，并于移入时间加 `trashDays` 时到期。
- **恢复。** `restore` 把记录项的文件夹移回其记录的名称下。该名称已再次存在时应答 `taken`；记录项或其文件夹已不存在时应答 `not-found`。它以标题重新注册每个工作区，先创建最后一个，使注册表保持记录的顺序；按记录顺序重新挂接对话；并取消回收站所归档对话的归档。
- **清理。** `list` 与插件启动时，移除已过期的回收站记录，以及文件夹已不存在的记录，并删除超过一天的已结束导入。进程并未在运行的导入会被结算：持有某个工作区的文件夹，使其导入变为 `done`；其他文件夹被移除，导入变为 `failed`，原因为 `the harness restarted while it cloned`。
- **令牌。** 配置 `credential: { host, file }` 后，URL 主机与 `host` 相同的克隆会收到 `file` 中保存的令牌，并在每次克隆时读取。主机以小写匹配；`https` 的默认端口 `443` 可以写出并会被去掉，其他端口属于主机的一部分，因此不同的主机或端口绝不匹配。令牌文件必须直接位于本人主目录的 `secrets` 目录中，并在插件加载时通过受保护文件检查，否则加载失败。令牌通过一个凭据助手交给 git，该助手只对克隆 URL 的主机和路径作答（[`git.ts`](src/git.ts)）。令牌从不出现在 argv、保存的 URL、导入记录、`.git/config` 或日志行中；克隆报告的每条原因都会用令牌做脱敏。
  - **残留风险。** git 运行期间，令牌位于 git 的环境变量中，也位于 git 启动的进程的环境变量中。同一用户的其他进程可以在那里读取它，例如通过 `/proc/<pid>/environ`，直到克隆结束为止。
- **根目录与主目录。** 根目录会被规范化，并在加载时创建。根目录若是 Delorun 主目录、位于其内或包含它，则加载失败，因此主目录绝不会位于可写的根目录之内。主目录由 [`resolveDelorunHome`](../home/src/resolve.ts) 解析。
- **证书颁发机构。** `caFile` 替换每次克隆时 git 使用的 CA 证书包，它以 `http.sslCAInfo` 传入，因此 git 不再读取系统证书包。私有证书颁发机构因此需要一个同时包含公共根证书的文件。可将系统证书包与私有颁发机构的 PEM 拼接生成：在基于 Debian 的系统上可执行 `cat /etc/ssl/certs/ca-certificates.crt private-ca.pem > ca-bundle.pem`，也可使用操作系统导出的证书包，然后让 `caFile` 指向该结果。文件路径必须是绝对路径。未配置 `caFile` 时，克隆使用 git 的默认证书包。
- **重命名工具。** 模型工具 `rename_workspace`（[`workspace-rename.ts`](../bundle-local/src/workspace-rename.ts)）。
- **错误。** 每一次拒绝都是 `WorkspaceRefusedError`，其代码取自 [`service.ts`](src/service.ts)。非预期的失败应答 `failed` 并附错误代码，若无代码则为 `unexpected error`；该消息不含路径也不含凭据，并且会被记录到日志中。

<a id="configuration"></a>

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 保存工作区文件夹与回收站的绝对目录；加载时若不存在则创建。 |
| `trashDays` | 30 | 回收站保留文件夹的天数，取值 1 至 3650。 |
| `instructionsMaxBytes` | 65536 | 读写的 `AGENTS.md` 最大长度，以 UTF-8 字节计，取值 1 至 16 MiB。 |
| `importTimeoutMs` | 1800000 | 克隆可以耗费的时间，以毫秒计，取值 1000 至 86400000。 |
| `credential` | 无 | `host` 与 `file` 须同时给出：接收令牌的克隆主机，以及直接位于主目录 `secrets` 目录中的令牌文件。 |
| `caFile` | 无 | git 为每次克隆信任的 CA 证书包。它会替换系统证书包，因此也必须包含公共根证书。 |

<a id="carry-forward-review"></a>

## 沿用审查

本包沿用了早期实现（V4）的工作区操作，并已针对当前代码树审查。

- **沿用：** 创建文件夹，并在注册表拒绝时将其移除；克隆的参数、脱敏与进度行，现位于 [`clone.ts`](src/clone.ts) 与 [`git.ts`](src/git.ts)；导入记录，其进度保存在内存中；回收站，含被归档的对话，移动失败时取消归档；恢复时的重新注册与对话重新挂接；对过期回收站、已结束导入以及重启遗留导入的清理；按修订值进行的 `AGENTS.md` 读写，现以 [`files.ts`](src/files.ts) 重新实现；时限，以及在卸载时取消克隆。
- **改编：** 令牌来自为一个主机配置的凭据文件，并在每次克隆时读取，而早期实现通过账户控制为每次克隆签发一个 GitHub 令牌；文件夹名取 URL 最后一段去掉 `.git`，不做百分号解码，因为 URL 检查已经拒绝了文件夹名无法容纳的字符；恢复时先创建最后一个工作区，因为注册表会把新工作区放在最前，而早期实现按记录顺序创建，使显示顺序颠倒；重启清理还会把工作区已经持有其文件夹的导入结算为 `done`，这是注册与记录写入之间的崩溃所留下的状态；失败携带错误代码而非 HTTP 状态，因为路由现在属于 studio。
- **删除：** 集群的命令运行器、它的容器移除、它的主对话主目录，以及运行器协议中的名称，因为工作区就是根目录下的一个文件夹，不需要容器；账户控制的 GitHub 令牌签发、撤销与仓库列表，因为 Delorun 不持有 GitHub 密钥，凭据文件取而代之；文件夹的密钥名称，它们由账户控制保存；Connection 路由及其 JSON 线路格式，由 studio 绑定到本服务；配置的严格二次校验，加载时的 schema 已经完成这项工作。

<a id="known-limitations"></a>

## 已知限制

- `AGENTS.md` 的访问在 Linux 上通过 `/proc/self/fd` 命名已打开的目录；在其他系统上它用 `lstat` 检查名称，这不能关闭 proc 方式所关闭的竞态窗口，而 Windows 会拒绝这些调用。
- 克隆期间令牌的暴露即契约中的残留风险：同一用户的其他进程可以读取 git 的环境变量，直到克隆结束。
- 回收站会停止它所归档对话中正在运行的工作，被停止的轮次不会因回收站而恢复。
- 在归档与移动之间崩溃，会使对话保持归档；回收站记录在下一次清理时若其文件夹已不存在，便会被遗忘，而对话仍保持归档。
- 重启后 git 的进度行只保存在内存中，因此重启后该行即消失。
- 凭据文件在每次克隆时读取，因此令牌轮换在下一次克隆时生效；若文件不再私有，该次导入以 `the credential file is refused` 失败。
- 注册在根目录之外的工作区会应答 `outside`，本包从不移动它。
- 本包不提供路由；主对话与 studio 通过 `delorunWorkspaces` 访问服务。
- 标准组合不挂载本插件，[`cordis.patch.yml`](cordis.patch.yml) 也没有配置，因此 bundle 必须提供 `root`。

<a id="tests"></a>

## 测试

[`tests/workspaces.integration.spec.ts`](tests/workspaces.integration.spec.ts) 在 JSON 存储目录上挂载真实组合：存储中枢、存储域、上游的工作区注册表以及本提供方。它覆盖创建及其拒绝、通过服务读写指令、加载时拒绝的配置、来自本地 HTTPS git 夹具（[`tests/fixtures/git-server.ts`](tests/fixtures/git-server.ts)）的导入及凭据规则、重启结算、回收站、恢复顺序与清理。[`tests/files.integration.spec.ts`](tests/files.integration.spec.ts) 覆盖指令的文件访问：链接、FIFO、目录、大小与修订值。[`tests/clone.integration.spec.ts`](tests/clone.integration.spec.ts) 与 [`tests/git.spec.ts`](tests/git.spec.ts) 覆盖克隆步骤与 git 选项。夹具提供一个公开仓库、一个需要令牌的私有仓库、一个重定向到私有仓库的仓库，以及一个永不发送广告信息的仓库，因此克隆会一直等待直到被停止。规格在 Linux 上运行，并需要 `openssl` 位于路径中以生成夹具证书。
