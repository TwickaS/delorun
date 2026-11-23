---
description: "约定 C9：运行时提供方 Service Definition 及其能力报告，Docker 形态 S2 与受限的 S3 及各形态的沙箱后端，容器加固，按工作区划分的网络与默认出站，资源预设，凭据转发，带套接字与每次启动令牌的固定结构 Docker 监管器 API，监管器根目录，S2 辅助通道，S2 与 S3 镜像，以及容器拒绝标记。"
---

# C9 运行时与监管器接口

[English](c09-runtime-supervisor.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本约定定义工作区如何选择其命令的运行位置，以及唯一与 Docker 通信的 Delorun 组件。运行时提供方报告机器能隔离和强制执行什么，并以原生方式或以两种 Docker 形态之一运行每个工作区：S2，每个 Docker 工作区有自己的容器；受限的 S3，一个容器隔离计算机，但不隔离各工作区之间。Docker 监管器只从已校验发布所列的镜像摘要运行工作区容器，只在本人于 setup 时选择的根目录之下运行，并通过 `~/.delorun` 下一个套接字上的固定结构 API 提供服务；该套接字只接受当前 home 进程启动的令牌，且从不把请求透传给 Docker。每项限制只有在检查机器表明其生效时才报告为已强制执行。类型包 [`@delorun/contract-runtime-supervisor`](../../packages/contract-runtime-supervisor/README.zh.md) 提供接口、结构、预设与限额。

<a id="status"></a>

## 状态

本页的内容均未被使用：没有任何命令或发布的 profile 运行 Docker 工作区，每个工作区都是原生的。

- **已构建，但无人使用：** `@delorun/supervisor`，带有基于每次启动令牌的固定 schema API、其根目录检查、通过探测容器生成的能力报告、带加固和内部网络的 S2 工作区容器，以及镜像摘要检查。`delorun start` 不向 home 进程传递监管器，因此 home 进程从不启动它，也没有任何东西写入监管器的根目录文件。容器拒绝标记已在上游的沙箱、shell 和 PTC 包中构建，沙箱的 `containerDenialMarker` 选项默认关闭，且没有任何发布的 profile 设置它。
- **尚未构建：** `delorunRuntime` 提供方和 `@delorun/runtime-docker` 包；S2 辅助通道和每个 S3 操作，监管器以 `SHAPE_UNAVAILABLE` 拒绝它们；除无之外的凭据转发，监管器拒绝它；S2 镜像中的出站代理程序；setup 的 Docker 步骤、其限额列表和无 root 引擎提示；studio 的运行时选择；`workspace-isolation` 检查，`delorun verify` 将其报告为未运行；Windows 上的命名管道。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。原生工作区的命令在各平台上能访问什么，是 [C1](c01-home-layout.zh.md) 的主题。

## 目录

- [状态](#status)
- [运行时提供方](#the-runtime-provider)
- [能力报告](#the-capability-report)
- [Docker 形态](#docker-shapes)
- [各形态的沙箱后端](#sandbox-backend-per-shape)
- [容器](#containers)
- [网络与出站](#networks-and-egress)
- [资源预设](#resource-presets)
- [凭据转发](#credential-forwarding)
- [Docker 监管器](#the-docker-supervisor)
- [监管器 API](#the-supervisor-api)
- [监管器根目录](#supervisor-roots)
- [S2 辅助通道](#the-s2-helper-channel)
- [镜像](#images)
- [容器拒绝标记](#the-container-denial-marker)
- [限额](#limits)
- [错误](#errors)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [各平台与方言的强制执行情况](#enforcement-per-platform-and-dialect)

<a id="the-runtime-provider"></a>

## 运行时提供方

运行时提供方是一个 Service Definition，Delorun 的运行时包把它注册为 Cordis 服务 `delorunRuntime`。每个 Host 只有一个活动提供方，它服务该 Host 的每个工作区。

- **种类。** 工作区以 `native`、`docker-s2` 或 `docker-s3` 运行。Docker 形态是在 setup 中选择的机器设置。在 S2 下，原生或 Docker 是工作区设置。在 S3 下，每个工作区都在那一个容器内运行，不提供按工作区的选择。
- **操作。** `report()` 返回[能力报告](#the-capability-report)。`resolve(request)` 把工作区请求转换为完整的规格：它显式地用默认值填充预设、出站模式与凭据选项，并拒绝能力报告无法满足的请求。`start(spec)`、`stop(workspaceId, mode)` 与 `state(workspaceId)` 管理工作区的运行时。Docker 种类的每个 Docker 操作都调用监管器，从不自行调用 Docker。
- **默认值。** 未指定预设的请求解析为 Balanced，未指定出站模式的解析为 `allowlist`，未指定凭据选项的解析为不转发。
- **原生工作区。** `native` 种类以本人自己的访问权限在机器上运行命令，受上游沙箱与 [C1](c01-home-layout.zh.md) 限制规则约束，并报告 [C1](c01-home-layout.zh.md) 各规则的状态。
- **路由。** 上游的 `fs`、`subprocess`、`sandbox`、`terminals`、`lsp` 与 `ptcRuntime` 服务都是单槽位的。S2 包通过它在上游添加的 seam，把 Docker 工作区的调用路由到其容器；本约定规定提供方的操作及其报告的事实，不规定该 seam。

<a id="the-capability-report"></a>

## 能力报告

该报告说明本机运行和强制执行什么。监管器在每次启动时，以及每次带 `refresh` 调用 `capabilities` 时，通过检查构建其中的 Docker 部分。

- **字段。** `v`（1）、`checkedAt`、`machine`（`os`、`arch`）、`confinement`（[C1](c01-home-layout.zh.md) 对原生工作区的各规则状态）、`docker`（没有引擎应答时缺省）以及 `shapes`（`s2` 与 `s3`，各自带 `available`，不可用时带原因代码）。
- **Docker 部分。** `engine`（`docker-engine`、`docker-desktop` 或 `other`）、`version`、`rootless`、`context`（当前 context 的名称）、`endpoint`（`unix`、`npipe`、`tcp` 或 `ssh`，带其路径）、`storageDriver` 与 `limits`。
- **限制项。** `limits` 的每个条目都有 `status`（`enforced`、`not-enforced` 或 `unknown`）和 `evidence` 字符串，后者给出所检查的字段及其值。条目为 `cpu`、`memory`、`pids`、`disk`、`cap-drop`、`no-new-privileges`、`read-only-root`、`seccomp`、`user-namespace`、`network-isolation`、`host-gateway-block`、`host-loopback-block` 与 `egress-allowlist`。
- **检查。** 监管器以 Small 预设从 S2 工作区镜像创建一个探测容器，读取其 `docker inspect` 记录，并在其中运行探测命令：连接监管器在网络网关地址上打开的监听器，连接主机回环上的监听器，向允许列表之外的主机发出请求，以及向允许列表中的主机发出请求。只有当检查记录显示某项限制，并且对于网络条目，探测中被禁止的连接失败而被允许的连接成功时，该项才是 `enforced`。探测网络以桥接驱动的 `isolated` 网关模式创建：应用该模式的引擎完全不给网络分配网关地址，这一缺失即为 `host-gateway-block` 成立的证据；忽略该选项的引擎会保留该地址，由连接结果决定。之后删除探测容器。
- **提供形态的条件。** 本人选择形态之前，setup（[C11](c11-setup-answers.zh.md)）列出每项限制在本机的状态。只有当 `cap-drop`、`no-new-privileges`、`seccomp`、`network-isolation`、`host-gateway-block`、`memory` 与 `pids` 都为 `enforced` 时，才提供 S2 与 S3。其他任何不为 `enforced` 的条目，在 setup 与工作区设置中显示为在本机仅作建议。
- **形态原因。** `docker-unavailable`、`docker-endpoint-network`（context 的端点是 TCP 或 SSH）、`s2-transport-unsupported`（macOS 与 Windows 上的 Docker Desktop）、`image-unverified`（镜像摘要与已校验的 manifest 不符）以及 `limits-missing`。

<a id="docker-shapes"></a>

## Docker 形态

| | S2 | S3，受限 |
| --- | --- | --- |
| harness 运行于 | 机器上，作为 home 进程 | 那一个容器内，以独立用户身份运行于只读目录树之上 |
| Docker 工作区运行于 | 其自己的容器中 | 那一个容器中，与其他每个工作区一起 |
| 隔离 | 每个工作区与计算机之间，以及各工作区之间 | 计算机与各工作区之间，不隔离各工作区之间 |
| 原生工作区 | 在机器上仍可使用 | 没有；不提供按工作区的选择 |
| 远程访问 | 按配置 | 关闭；远程访问拒绝开启 |
| 引擎 | Linux 引擎，rootful 或 rootless | Linux 引擎与 Docker Desktop |
| 镜像 | S2 工作区镜像 | S3 harness 镜像 |

- **studio 对 S3 的标注** 说明它把本计算机与 agent 的命令隔离开，但不隔离各工作区之间。
- **S3 的 harness 用户。** harness 与 home 进程在容器内以用户 `delorun-harness`（uid 1001）运行。容器的根文件系统只读，因此容器内没有用户能修改 harness 代码。Delorun home 位于一个归 `delorun-harness` 所有、权限为 0700 的卷上。工作区命令以用户 `delorun`（uid 1000）运行，因此无法读取或修改 home 的密钥。
- **S3 的权限。** harness 只保留 `CAP_SETUID` 与 `CAP_SETGID`，用于以 `delorun` 身份启动命令；它启动的每条命令都以空能力集和 `no-new-privileges` 运行。
- **S3 的 studio。** 在容器内，studio 在容器运行目录中的一个 Unix 套接字上监听，该目录从机器的 `~/.delorun/run/<profile>/s3/` 绑定挂载。机器上的 home 进程把其回环监听器转发到该套接字，因此容器不发布任何端口。
- **S3 的主机侧。** 在机器上，home 进程持有 [C1](c01-home-layout.zh.md) 的锁与令牌，并运行监管器与回环转发；Host 在容器内运行。
- **文件监视。** 能力报告按形态给出本引擎的 `fileWatching`，取值为 `supported` 或 `unsupported`；不支持时，studio 的文件视图按请求刷新。

<a id="sandbox-backend-per-shape"></a>

## 各形态的沙箱后端

| 运行时 | 命令运行于 | 限制机制 | `workspace-write` | `read-only` | `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| 原生 | 机器上 | 上游方言加 [C1](c01-home-layout.zh.md) 的规则 | 方言的写授权 | 方言 | 不受限制 |
| S2 Docker 工作区 | 其容器中 | 容器 | 容器的可写集合：工作区根目录与 `/tmp` | 探测可用时由容器内的 Landlock 执行；否则为 `partial` 强制执行 | 在容器内不受限制，容器仍限制它 |
| S3 | 那一个容器中 | 容器，以及探测可用时容器内的上游方言 | 方言，否则为容器的可写集合 | 探测可用时由方言执行；否则为 `partial` 强制执行 | 在容器内不受限制，容器仍限制它 |

- 在容器内，丢弃全部能力后 bwrap 无法创建命名空间，因此容器本身就是限制机制。容器内的沙箱模式可以收窄容器允许的范围，但从不扩大它。
- 在 S2 与 S3 下，附加可写根目录以 `ADDITIONAL_ROOTS_UNSUPPORTED` 被拒绝，因为容器只挂载工作区根目录。

<a id="containers"></a>

## 容器

每个工作区容器与 S3 容器都以下列设置运行，监管器拒绝启动缺少这些设置的容器：

- 丢弃全部能力（`--cap-drop ALL`），S3 为其 harness 保留的 `CAP_SETUID` 与 `CAP_SETGID` 除外；
- `no-new-privileges`；
- [C2](c02-release-manifest.zh.md) 的 manifest 为该镜像列出的 seccomp profile（其 `ImageRef` 的 `seccomp` 文件），它派生自 Docker 的默认 profile；manifest 未列出时，使用引擎的默认 profile；从不使用 `unconfined`。所列 profile 的文件与其长度和摘要不符时，以 `IMAGE_NOT_IN_MANIFEST` 拒绝创建该容器；
- 只读的根文件系统，以及大小按预设的 tmpfs `/tmp`；
- 预设的 CPU、内存与 PID 限制，swap 等于内存；
- 存储驱动支持时，通过 `--storage-opt size` 施加预设的磁盘限制，否则报告为 `not-enforced`；
- 没有 Docker 套接字，没有 `--privileged`，没有设备，也不使用主机的网络、PID、IPC 或用户命名空间；
- [S2 辅助通道](#the-s2-helper-channel)规定的用户，从不是主机的 root；
- 一个 init 进程，没有重启策略；
- 名称 `delorun-ws-<12 hex>`（工作区 id 的 SHA-256 摘要的前 12 位十六进制数字）或 `delorun-s3-<profile>`，以及标签 `run.delo.home`（[C1](c01-home-layout.zh.md) 的 `homeId`）、`run.delo.profile`、`run.delo.workspace` 与 `run.delo.shape`。

<a id="networks-and-egress"></a>

## 网络与出站

- **每个工作区一个网络。** 每个 Docker 工作区都有自己的内部网络 `delorun-ws-<12 hex>`，其成员只有该工作区的容器及其出站代理。没有哪个网络以两个工作区为成员，因此任何工作区容器都无法访问另一个工作区的容器。代理还加入第二个网络 `delorun-ws-<12 hex>-out`，这是它唯一的出口路由。
- **主机网关与回环。** 内部网络不给工作区容器任何通往机器的路由，并且以桥接驱动的 `isolated` 网关模式创建：其网桥不携带主机地址，容器没有可连接的网关。代理拒绝位于机器上的目标。从不向容器添加 `host.docker.internal` 与 `host-gateway` 别名。
- **出站代理。** 它从 S2 工作区镜像的摘要运行，使用该工作区的资源限制和入口 `/usr/local/bin/delorun-egress-proxy`，该入口由镜像提供。监管器在 `DELORUN_EGRESS_MODE` 中传入出站模式（`allowlist` 或 `open`），在 `DELORUN_EGRESS_HOSTS` 中传入以逗号分隔的允许主机。它是端口 3128 上的 HTTP 代理，为端口 443 提供 `CONNECT`，为端口 80 提供普通 HTTP。它自行解析每个主机，并拒绝以下目标地址：回环、链路本地（`169.254.0.0/16`、`fe80::/10`）、私有（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7`）、共享（`100.64.0.0/10`）、组播或机器自身的地址。容器的环境把 `HTTP_PROXY`、`HTTPS_PROXY`、`http_proxy` 与 `https_proxy` 设为该代理；忽略这些变量的工具没有出口路由。
- **出站模式。** `allowlist`（默认）允许下列主机及该工作区的追加项。`open` 允许每个公网主机，只能由本人为该工作区选择设置。`none` 不启动代理。
- **默认允许列表。** profile 中所配置模型提供商的主机；npm：`registry.npmjs.org`；PyPI：`pypi.org`、`files.pythonhosted.org`；crates.io：`crates.io`、`static.crates.io`、`index.crates.io`；Go 模块代理：`proxy.golang.org`、`sum.golang.org`；GitHub：`github.com`、`api.github.com`、`codeload.github.com`、`objects.githubusercontent.com`、`raw.githubusercontent.com`、`release-assets.githubusercontent.com`。
- **追加项。** 本人每个工作区最多可追加 64 个主机，每项是精确主机名或以 `*.` 开头的后缀，最多 253 个字符。IP 地址不能作为追加项。运行时提供方把 profile 中所配置模型提供商的主机作为追加项传入，同样计入 64 个的上限。
- **S3。** 那一个容器有同样的内部网络与代理，模式与允许列表相同。

<a id="resource-presets"></a>

## 资源预设

| 预设 | CPU | 内存 | 磁盘 | PID | `/tmp` |
| --- | --- | --- | --- | --- | --- |
| Small | 2 | 4 GiB | 20 GiB | 1,024 | 1 GiB |
| Balanced（默认） | 4 | 8 GiB | 50 GiB | 2,048 | 2 GiB |
| Large | 8 | 16 GiB | 100 GiB | 4,096 | 4 GiB |
| Advanced | 本人的取值 | 本人的取值 | 本人的取值 | 本人的取值 | 本人的取值 |

- **Advanced 的范围。** CPU 从 1 到机器的逻辑 CPU 数；内存从 1 GiB 到机器内存减 1 GiB；磁盘从 10 GiB 到 1,024 GiB；PID 从 256 到 32,768；`/tmp` 从 256 MiB 到内存的一半。超出范围的值以 `PRESET_OUT_OF_RANGE` 被拒绝。
- **超出机器的预设。** CPU 或内存超过机器的预设不会在该机器上提供。
- **强制执行。** 能力报告标为 `not-enforced` 的限制（例如在没有配额的存储驱动上的磁盘限制），会在预设旁显示为在本机仅作建议。

<a id="credential-forwarding"></a>

## 凭据转发

每个工作区默认关闭转发，并按工作区选择。工作区转发凭据时，studio 说明该工作区的代码可以在该凭据的范围内以本人的身份行事。

| 选项 | 容器得到什么 | 范围 |
| --- | --- | --- |
| `deploy-key` | 一个 ssh agent 套接字，其 agent 持有一个用于一个仓库的密钥 | 该仓库的部署密钥权限 |
| `agent-confirm` | 一个 ssh agent 套接字，其 agent 持有本人为该工作区添加的密钥，每个都以 `ssh-add -c` 添加 | 每次使用都在机器上请求确认 |
| `token` | 容器环境中的 `GH_TOKEN` 与 `GITHUB_TOKEN` | 限定于一个仓库的细粒度令牌 |

- **Agent。** 对于 `deploy-key` 与 `agent-confirm`，监管器在机器上为每个工作区启动一个 ssh agent，其套接字位于 `~/.delorun/run/<profile>/agents/<12 hex>/`，并只把该套接字挂载到该工作区容器的 `/run/delorun-agent/agent.sock`，同时设置 `SSH_AUTH_SOCK`。其他工作区的容器从不得到它。本人自己的 agent 从不被转发。
- **确认。** `agent-confirm` 需要机器上有 askpass 程序来显示每次确认；没有时不提供该选项。
- **存储。** 部署密钥与令牌以 0600 存放在 [C1](c01-home-layout.zh.md) 的 `secrets/workspaces/<12 hex>/` 下。二者都不写入日志、命令行、工作区根目录或镜像。

<a id="the-docker-supervisor"></a>

## Docker 监管器

监管器是唯一调用 Docker 的 Delorun 组件。它以本人用户的独立进程运行，从不以 root 运行，所用运行时发行包与 home 进程相同。

- **生命周期。** 机器设置了 Docker 时，home 进程启动它，并通过继承的管道把启动令牌传给它。它随这次 home 进程启动一起停止，后继 home 进程以新令牌启动新的监管器。容器在监管器重启后继续运行。
- **套接字。** 它在 [C1](c01-home-layout.zh.md) 的 `run/<profile>/supervisor.sock` 上监听，Windows 上则在 [C1](c01-home-layout.zh.md) 命名的命名管道上监听。
- **调用方。** 它只接受携带当前启动令牌的请求，并以恒定时间比较；缺失、错误或属于之前某次启动的令牌收到 `UNAUTHENTICATED`，不附任何其他信息。它唯一的调用方是 home 进程。凡 [C1](c01-home-layout.zh.md) 的 `home-connect` 规则得到强制执行之处，工作区命令都无法抵达它；在 Landlock 下，工作区命令可以连接，但无法读取令牌。
- **日志。** 它写入 [C20](c20-operational-logs.zh.md) 的入口 `supervisor-<profile>`。它记录每个请求的操作、工作区 id 与结果，从不记录请求正文、凭据或环境变量的值。
- **它管理的容器。** 它只管理带有其 home 与 profile 标签的容器；对其他任何容器的操作以 `NOT_FOUND` 失败。

<a id="the-supervisor-api"></a>

## 监管器 API

- **帧格式。** 每个连接承载一个请求，编码为一行最多 65,536 字节的 UTF-8 JSON，以及回答它的若干响应行。请求行必须在连接建立后 5 秒内到达，同一时间最多打开 32 个连接。
- **封闭结构。** 每个请求都有 `v`（1）、`token`、`op` 与 `args`。未知的 `op`、未知的字段，或超出其类型或范围的值，都以 `SCHEMA_VIOLATION` 被拒绝。没有字段携带镜像引用、Docker 参数、挂载、环境变量、命令、设备、能力或网络名称；监管器根据本约定推导出其中每一项。

| `op` | `args` | 作用 |
| --- | --- | --- |
| `capabilities` | `refresh`：布尔值 | 返回能力报告的 Docker 部分 |
| `workspace.create` | `workspaceId`、`root`、`preset` 或 Advanced 的 `limits`、`egress`、`allowlistAdditions`、`credentials` | 解析并检查根目录，从 S2 镜像的摘要创建网络、代理与容器 |
| `workspace.start` | `workspaceId` | 启动代理与容器 |
| `workspace.stop` | `workspaceId`，`mode`：`graceful` 或 `kill` | 停止它们；`graceful` 最多等待 10 秒后再强制终止 |
| `workspace.remove` | `workspaceId` | 删除容器、代理、两个网络与该工作区的 agent；工作区根目录不受影响 |
| `workspace.inspect` | `workspaceId` | 返回容器的状态、生效的限制与出站模式 |
| `workspace.list` | 无 | 返回本监管器管理的工作区 |
| `workspace.egress` | `workspaceId`、`egress`、`allowlistAdditions` | 修改代理的模式与追加项 |
| `helper.start` | `workspaceId` | 启动 S2 辅助程序并返回其通道密钥（[S2 辅助通道](#the-s2-helper-channel)） |
| `s3.create`、`s3.start`、`s3.stop`、`s3.inspect` | `stop` 接受 `mode` | 从 S3 镜像的摘要管理 S3 容器 |

- **字段范围。** `workspaceId` 最多 128 个字符；`root` 是最多 4,096 字节的绝对路径；`allowlistAdditions` 最多 64 个主机名。
- **响应。** 每个响应行都有 `ok`；失败行带有 `error`（[错误](#errors)中的代码）和 `detail`，后者指出被拒绝的值，从不包含密钥。

<a id="supervisor-roots"></a>

## 监管器根目录

- **根目录文件。** `supervisor/roots.json`（[C1](c01-home-layout.zh.md)，权限 0600）保存 `{"v":1,"parents":["<absolute path>", ...]}`，最多 16 个父目录。只有 `delorun setup` 在本人的终端中写入它；没有 Host API、工具或配置行写入它。监管器在启动时读取它。
- **父目录。** 每个父目录以其规范绝对路径保存。setup 拒绝 `/`、操作系统 home 目录、Delorun home、任何包含 Delorun home 的路径以及任何位于其内的路径。
- **工作区根目录。** 在 `workspace.create` 时，监管器自行用 `realpath` 解析 `root`。根目录为 `/`、操作系统 home 目录或 Delorun home，包含操作系统 home 目录，包含 Delorun home 或位于其内，位于引擎上另一个带有 Delorun 标签的工作区容器（无论其 home 与 profile）的根目录之内或包含该根目录，或不是本人所有的目录时，以 `ROOT_REFUSED` 拒绝；根目录不严格位于某个父目录之内时，以 `ROOT_NOT_UNDER_PARENT` 拒绝。路径按文件身份比较，因此某目录的别名视同该目录。
- **每次启动之前。** 每次 `workspace.start` 时，监管器再次检查该工作区的容器：每个容器都必须带有其 home 与 profile 的标签，根目录挂载的来源必须仍解析为其自身并通过上述每条规则（`ROOT_REFUSED`），[容器](#containers)的每项设置都必须仍然生效（`LIMITS_MISSING`）。未通过检查的容器不会启动。
- **挂载。** S2 容器的绑定挂载是解析后的工作区根目录、该工作区的辅助程序套接字目录，以及工作区转发 agent 时该 agent 的套接字。S3 容器的挂载是解析后的各工作区根目录、保存其 Delorun home 的卷以及机器的 `~/.delorun/run/<profile>/s3/`。不挂载其他任何主机路径。创建容器后，监管器把检查到的挂载来源与解析后的路径比较，有任何差异就以 `ROOT_REFUSED` 删除该容器。
- **谁能修改根目录。** 凡 [C1](c01-home-layout.zh.md) 的 `home-write` 规则成立之处，受限命令都无法写入该文件；上游的进程内文件工具限于可写根目录，而可写根目录从不包括 home。在 `danger-full-access` 下运行的命令或工具可以写入它。

<a id="the-s2-helper-channel"></a>

## S2 辅助通道

在 S2 下，每个工作区容器内的上游 SSH 辅助程序承载该工作区的文件、进程、终端、LSP 与 PTC 调用。

- **辅助程序。** 辅助程序是安装在 S2 工作区镜像中的上游 `ssh-helper-runtime` 可执行文件，harness 按上游 SSH 连接检查 `helperHash` 的方式检查其摘要。
- **用户。** 监管器通过 Docker exec 以容器的工作区用户启动辅助程序：在 rootful 引擎上是本人的 uid 与 gid，在 rootless 引擎上是 uid 0，引擎把它映射为机器上本人的 uid。工作区命令以同一用户运行。辅助程序从不以比它启动的命令权限更高的用户运行。
- **Linux 引擎上的传输。** 辅助程序的目录（机器上的 `~/.delorun/run/<profile>/s2/<12 hex>/`，权限 0700）以只读方式绑定挂载到 `/run/delorun-helper`，harness 在该处连接套接字。辅助程序唯一可写的子目录 `channel/` 以可写方式挂载到 `/run/delorun-helper/channel`，其中只允许辅助程序的流套接字，因此工作区唯一可写的宿主路径不承载任何自有字节：每次启动时监管器删除上一次会话遗留的套接字，并对任何其他条目拒绝启动。
- **认证。** 每次辅助程序启动时，监管器生成一个 32 字节的通道密钥，在 exec 时把它写入辅助程序的标准输入，并只在 `helper.start` 响应中返回它。该密钥从不写入文件、命令行或环境变量。每个到辅助程序套接字的连接都以辅助程序发出的 32 字节随机挑战开始，harness 以通道密钥对该挑战与字符串 `delorun-helper-v1` 计算 HMAC-SHA-256 作答。回答错误或 5 秒内未到达时，辅助程序关闭该连接。
- **密钥保护什么。** 它拒绝没有密钥的对端：其他容器中的进程（它们没有该套接字目录），以及机器上抵达该目录但没有密钥的进程。它不保护辅助程序免受其自身容器中命令的影响，这些命令以同一用户运行，由容器限制。
- **Docker Desktop。** 在 macOS 与 Windows 的 Docker Desktop 上不提供 S2（`s2-transport-unsupported`）。

<a id="images"></a>

## 镜像

| 镜像 | 名称 | 基础镜像 | 运行 |
| --- | --- | --- | --- |
| S2 工作区 | `ghcr.io/twickas/delorun-workspace-s2` | `docker.io/library/debian:bookworm-slim`，按摘要 | 辅助程序、工作区命令与出站代理 |
| S3 harness | `ghcr.io/twickas/delorun-harness-s3` | `docker.io/library/debian:bookworm-slim`，按摘要 | 带运行时发行包的 harness、工作区命令与出站代理 |

- **构建。** 每个镜像都在 [C2](c02-release-manifest.zh.md) 的可复现重建范围内，从按摘要固定的基础镜像构建。
- **签名与摘要。** 发布 manifest（[C2](c02-release-manifest.zh.md)）列出每个镜像的摘要，manifest 的 Ed25519 签名即该镜像的签名；不信任任何镜像仓库侧的签名。
- **拉取。** 监管器只拉取 `<name>@sha256:<digest>`，摘要取自正在运行的运行时的已校验 manifest，从不按标签拉取，并检查拉取到的镜像的摘要；拉取失败时以 `IMAGE_PULL_FAILED` 拒绝。拉取只访问 `ghcr.io` 与 `pkg-containers.githubusercontent.com`。
- **拒绝。** 监管器以 `IMAGE_NOT_IN_MANIFEST` 拒绝从已校验 manifest 未列出的摘要创建容器。

<a id="the-container-denial-marker"></a>

## 容器拒绝标记

被容器只读根文件系统拒绝的文件操作，是被环境拒绝的，没有任何沙箱模式能解除这种拒绝。因此其结果从不提供提权。

- **特征。** Docker 形态的沙箱封装在上游 `@deepseek-ai/dsh-sandbox` 的 `ConfinedArgv.environmentDenialSignatures` 中声明环境的拒绝特征：`read-only file system`。
- **分类。** 标准错误只匹配环境特征的失败运行，由 `denialOf` 分类为 `deniedBy: 'environment'`；来自 `denialSignatures` 的策略特征优先于它。
- **标记。** 环境拒绝的结果恰好携带一行 `[sandbox: file access denied by the environment the sandbox runs in; no sandbox mode allows it]`（来自 `environmentDenialMarker()`），不带提权提示；`denialMarkers` 只返回这一行。
- **执行器。** bash 与 PowerShell 沙箱执行器应用这一分类与标记。
- **PTC。** PTC 执行器同样应用它：Node PTC 运行时的 worker 用两组特征对失败的程序分类，`run_code` 的结果携带 `sandbox.deniedBy: 'environment'`，其渲染附加环境标记，取代策略语句及其提权指引。
- **原生与对等。** 原生运行时不声明环境特征，因此原生工作区与对等组合（[C16](c16-parity-composition.zh.md)）的输出不变。

<a id="limits"></a>

## 限额

| 限额 | 值 |
| --- | --- |
| 监管器请求行 | 最多 65,536 字节 |
| 从连接到请求行的时间 | 5 秒 |
| 打开的监管器连接 | 最多 32 个 |
| `workspaceId` | 最多 128 个字符 |
| `root` | 最多 4,096 字节 |
| 监管器父目录 | 最多 16 个 |
| 每个工作区的允许列表追加项 | 最多 64 个，每项最多 253 个字符 |
| `graceful` 停止在强制终止前的等待 | 10 秒 |
| 辅助通道密钥 | 32 字节 |
| 辅助程序挑战的作答 | 5 秒内 |
| 出站代理端口 | 3128 |
| 预设与 Advanced 范围 | 见[资源预设](#resource-presets) |
| 协议版本 `v` | 1 |

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `UNAUTHENTICATED` | 请求的令牌缺失、错误或来自之前某次启动 |
| `SCHEMA_VIOLATION` | `op` 或字段未知，或值超出其类型或范围 |
| `REQUEST_TIMEOUT` | 5 秒内未收到请求行 |
| `BUSY` | 已打开 32 个连接 |
| `ROOT_REFUSED` | 根目录为 `/`、操作系统 home 或 Delorun home，包含操作系统 home，包含 Delorun home 或位于其内，位于另一个工作区的根目录之内或包含它，不是本人的目录，或创建后其挂载来源不同，或启动前不再解析为其自身 |
| `ROOT_NOT_UNDER_PARENT` | 根目录不严格位于某个 setup 父目录之内 |
| `IMAGE_NOT_IN_MANIFEST` | 镜像摘要未被已校验 manifest 列出，或拉取到的摘要不同 |
| `IMAGE_PULL_FAILED` | 拉取所列摘要失败 |
| `DOCKER_UNAVAILABLE` | 当前 context 上没有 Docker 引擎应答 |
| `ENGINE_REFUSED` | Docker 引擎拒绝了一次调用；detail 带有引擎的消息 |
| `WORKSPACE_EXISTS` | `workspace.create` 指定的工作区的容器已经存在，或 `workspace.start` 指定的工作区的容器已在运行 |
| `LIMITS_MISSING` | 某形态所需的限制在本机未被强制执行 |
| `PRESET_OUT_OF_RANGE` | Advanced 的某个值超出其范围，或某预设超过机器 |
| `ADDITIONAL_ROOTS_UNSUPPORTED` | 为 Docker 工作区指定了附加可写根目录 |
| `SHAPE_UNAVAILABLE` | 请求的形态不可用，附报告中的原因 |
| `NOT_FOUND` | 该工作区或容器不归本监管器管理 |

<a id="consumers"></a>

## 使用方

- `delorun/packages/supervisor`：监管器、其 API、能力报告、根目录与镜像检查。
- `delorun/packages/runtime-docker`：S2 形态、S3 形态、凭据转发与 Docker 拒绝测试套件。
- studio 的工作区插件：创建工作区时的运行时选择与预设。
- `delorun/apps/release`：S2 与 S3 镜像及其在 manifest 中的摘要（[C2](c02-release-manifest.zh.md)）。
- `delorun/packages/integrity`：`delorun verify` 的隔离与 Docker 限制检查。
- 上游的 `packages/sandbox/sandbox`、`packages/shell/bash-sandbox`、`packages/shell/pwsh-sandbox`、`packages/ptc-runtime/ptc-runtime-node` 与 `packages/core/tool-executor-ptc`：容器拒绝标记。

<a id="compatibility"></a>

## 兼容性

- 监管器协议版本 `v` 与能力报告的 `v` 都是 1。监管器与 home 进程来自同一运行时发行包，因此该协议没有跨版本的调用方；变更时仍会提高 `v`。
- 预设名称、出站模式、凭据选项名称、容器与网络名称及其标签都是外部接口：一个发布创建的工作区由下一个发布管理。修改其中任一项都要在监管器中附带迁移，并在 `delorun/docs/upgrade-guide/` 下附升级指南。
- 根目录文件的 `v` 为 1；监管器读取之前的每个版本。
- 环境标记的文本对模型可见，按上文保持不变；修改它会改变已录制的 Docker 场景。
- 类型包跟随 Delorun 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

### 要求

1. 监管器的 API 是固定结构，从不透传 Docker：没有请求字段指定镜像、参数、挂载、环境变量、命令、设备、能力或网络。
2. 监管器套接字位于 home 之下，只凭当前启动令牌（[C1](c01-home-layout.zh.md)）接受 home 进程。该保护依赖于 [C1](c01-home-layout.zh.md) 对 agent 命令的限制；方言无法强制执行时，`delorun verify` 会报告，setup 会标注 Docker 模式。本约定不声称能防范沙箱之外的本人用户进程，只要本人能使用 Docker，这类进程就能直接驱动 Docker。不存在 root 所有的辅助程序。
3. 凡方言强制执行 [C1](c01-home-layout.zh.md) 的 `docker-connect` 之处，原生沙箱 profile 都拒绝访问位于真实路径的 Docker 套接字。
4. 工作区根目录位于 setup 时选择的父目录之下，这些父目录保存在只有 `delorun setup` 写入的文件中。监管器自行解析每个路径，拒绝 `/`、`$HOME` 与 `~/.delorun`，并只挂载[监管器根目录](#supervisor-roots)列出的路径。
5. 每个工作区都有不与其他工作区共享的内部网络，工作区网络没有通往机器的路由，出站流量只经工作区的代理并按默认允许列表离开；`open` 出站只能由本人选择设置。
6. 凭据转发默认关闭，按工作区选择，且限于部署密钥、需确认的 agent 或限定仓库的令牌；被转发的 agent 只能抵达其自身工作区的容器。
7. setup 推荐 rootless Docker，并说明 `docker` 组的成员身份在机器上等同于 root。
8. 能力报告中每项已强制执行的限制都以对探测容器的检查为依据；没有任何一项仅凭配置就报告为已强制执行。
9. 在 S3 下，harness 以独立用户运行于只读目录树之上，工作区命令以另一个没有能力的用户运行，远程访问关闭。
10. S2 辅助程序以容器的工作区用户运行，只接受证明持有通道密钥的对端。
11. 监管器只运行已校验发布 manifest 列出其摘要的 S2 与 S3 镜像，并按摘要从 `ghcr.io` 拉取。
12. 无论在 shell 执行器还是 PTC 执行器中，容器内的环境拒绝从不附带提权指引。
13. 在只有 Landlock、且当前 Docker context 为 rootful 引擎套接字的系统上，`delorun verify` 通过 [C15](c15-verification-checks.zh.md) 的 `workspace-isolation` 与 `confinement-rule` 检查把 `docker-connect` 报告为未强制执行；setup 给出该套接字的路径，说明受限的原生命令能访问它、这等同于 root，并提供 Docker 的 rootless 引擎。

### 拒绝测试

| 测试 | 证明 |
| --- | --- |
| `docker-from-native-denied` | 在每种强制执行 [C1](c01-home-layout.zh.md) `docker-connect` 的方言上，受限原生工作区命令执行 `docker ps` 失败 |
| `supervisor-connect-denied` | 在每种强制执行 [C1](c01-home-layout.zh.md) `home-connect` 的方言上，受限原生工作区命令连接监管器套接字失败，且无法读取启动令牌 |
| `supervisor-token-required` | 不带令牌、带错误令牌以及带之前启动令牌的请求，都收到 `UNAUTHENTICATED` |
| `supervisor-landlock` | 在 Landlock 下，受限原生工作区命令连接监管器套接字成功，但因无法读取令牌，其请求以 `UNAUTHENTICATED` 失败，`delorun verify` 会报告这一状态 |
| `supervisor-not-enforced-labelled` | 在无法强制执行 [C1](c01-home-layout.zh.md) 规则的方言样例上，`delorun verify` 报告它们，setup 的 Docker 模式选项附带标注 |
| `supervisor-schema-closed` | 带镜像引用、挂载、环境变量、命令或未知 `op` 的请求以 `SCHEMA_VIOLATION` 被拒绝，且不创建任何容器 |
| `supervisor-roots-refused` | 根目录 `/`、`$HOME`、`~/.delorun`、包含 `~/.delorun` 或 `$HOME` 的路径、位于另一个工作区根目录之内或包含它的路径、解析到所有父目录之外的符号链接，以及位于所有父目录之外的路径，都被拒绝；根目录不再解析为其自身的工作区不会启动 |
| `supervisor-image-unlisted` | 从已校验 manifest 未列出的摘要创建容器以 `IMAGE_NOT_IN_MANIFEST` 被拒绝 |
| `capability-report-inspected` | 报告中每项 `enforced` 的限制都与探测容器的 `docker inspect` 一致，引擎忽略的限制报告为 `not-enforced` |
| `cross-workspace-denied` | 工作区容器无法连接另一个工作区的容器或代理 |
| `host-loopback-denied` | 工作区容器无法连接主机回环上的监听器，也无法连接其网络网关地址上的监听器 |
| `egress-allowlist` | 经代理向允许列表之外的主机和向私有地址发出的请求失败，向允许列表中的主机发出的请求成功 |
| `agent-not-shared` | 未转发凭据的工作区以及另一个工作区，都无法使用某工作区被转发的 agent |
| `helper-peer-refused` | 未用通道密钥回答挑战的 S2 辅助程序套接字连接被关闭 |
| `s3-harness-readonly` | 在 S3 下，工作区命令无法写入 harness 目录树，无法读取或写入 home 的密钥，远程访问拒绝开启 |
| `environment-denial-no-escalation` | 在 S2 下，写入容器只读根文件系统时，无论通过 bash 还是通过 `run_code`，都返回环境标记且不带提权提示 |
| `landlock-rootful-docker-named` | 在带 rootful Docker 套接字的 Landlock 样例上，`delorun verify` 把 `docker-connect` 报告为 `not-enforced` 并给出该套接字的路径；在可以选择 Docker 模式之前，setup 的 Docker 步骤给出该路径、说明等同 root，并提供 rootless 引擎 |

### 本约定不能证明的内容

- **Landlock 与 rootful 引擎。** Landlock 无法拒绝原生命令连接 Docker 套接字，因此在只有 Landlock 且使用 rootful 引擎的系统上，任何受限原生命令都能启动挂载机器文件的容器。Delorun 会报告它并提供 rootless 引擎；在那里无法阻止它。
- **经网络的 Docker。** 端点为 TCP 或 SSH 的 context 可被任何有网络访问的命令访问，而没有方言限制网络；报告将其标为 `docker-endpoint-network`，并且不在其上提供 Docker 形态。
- **主机网关与回环。** 内部网络与机器之间的距离由引擎保证：网络以桥接驱动的 `isolated` 网关模式创建，忽略该选项的引擎只在检查时由探测发现，不会在每次工作区启动时再次确认。仍让网关可达的机器不满足 `host-gateway-block`，因此不在其上提供 S2。
- **磁盘限制。** 大多数存储驱动、所有 rootless 引擎与 Docker Desktop 都不强制执行容器的磁盘大小；在那里预设的磁盘值仅作建议。
- **辅助程序密钥。** 它不保护 S2 辅助程序免受其自身容器中命令的影响，这些命令以同一用户运行。
- **S3。** S3 不隔离各工作区之间。
- **完全访问下的根目录文件。** 在 `danger-full-access` 下运行的命令或工具可以修改 `supervisor/roots.json`。
- **Docker Desktop。** 容器运行在 Docker Desktop 的虚拟机内，该虚拟机对容器本身而言不是用户命名空间。

<a id="enforcement-per-platform-and-dialect"></a>

## 各平台与方言的强制执行情况

能力报告按在机器上检查到的情况给出每项限制；本表说明每种引擎能提供什么。

| 限制 | Linux 引擎，rootful | Linux 引擎，rootless | macOS 上的 Docker Desktop | Windows 上的 Docker Desktop |
| --- | --- | --- | --- | --- |
| S2 | 提供 | 提供 | 不提供 | 不提供 |
| S3 | 提供 | 提供 | 提供 | 提供 |
| `cap-drop`、`no-new-privileges`、`seccomp`、`read-only-root` | enforced | enforced | enforced，在 Docker Desktop 的虚拟机内 | enforced，在 Docker Desktop 的虚拟机内 |
| `cpu`、`memory`、`pids` | 在 cgroup v2 下 enforced | 只有 cgroup v2 控制器委派给本人用户时才 enforced | 在虚拟机内 enforced | 在虚拟机内 enforced |
| `disk` | 只在支持 `size` 的存储驱动上 enforced，例如带项目配额的 XFS 上的 overlay2 | not-enforced | not-enforced | not-enforced |
| `user-namespace` | 除非引擎使用 `userns-remap`，否则 not-enforced | enforced | 对容器本身 not-enforced；容器运行在 Docker Desktop 的虚拟机内 | 对容器本身 not-enforced；容器运行在 Docker Desktop 的虚拟机内 |
| `host-gateway-block`、`host-loopback-block` | 以探测结果为准 | 以探测结果为准 | 以探测结果为准 | 以探测结果为准 |
| 原生命令的套接字拒绝 | 见 [C1](c01-home-layout.zh.md) 的表格 | 见 [C1](c01-home-layout.zh.md) 的表格 | 见 [C1](c01-home-layout.zh.md) 的表格 | 见 [C1](c01-home-layout.zh.md) 的表格 |

- **等同 root。** 在 rootful 引擎上，任何能抵达 Docker 套接字的进程都能启动挂载机器文件的容器，因此 `docker` 组的成员身份等同于 root。rootless 引擎以本人自己的权限运行容器。
