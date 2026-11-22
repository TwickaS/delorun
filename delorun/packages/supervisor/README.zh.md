---
description: "@delorun/supervisor 包，供 home 进程与 Docker 运行时的维护者使用：Delorun 的 Docker 监管器，其固定模式的 API 位于 ~/.delorun 下的套接字上，包括启动令牌检查、监管器根目录、依据已验证发布 manifest 的镜像检查、通过检视构建的能力报告、加固的工作区容器及其运行日志。"
---

# @delorun/supervisor

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包是 [约定 C9](../../docs/contracts/c09-runtime-supervisor.zh.md) 中的 Docker 监管器，是 Delorun 中唯一调用 Docker 的组件。它作为本人用户的独立进程运行，由 home 进程（home process）启动。它在 Delorun home 下的 `run/<profile>/supervisor.sock` 上提供固定模式的 API，并且只接受携带当前这次 home 进程启动的令牌（[C1](../../docs/contracts/c01-home-layout.zh.md)）的请求。它通过检查探测容器构建能力报告（capability report），依据只由 `delorun setup` 写入的根目录文件解析每个工作区根目录，只运行摘要（digest）被已验证发布 manifest（release manifest）所列出的镜像，它将日志写入 [C20](../../docs/contracts/c20-operational-logs.zh.md) 的 `supervisor-<profile>` 入口，写入时经由 [`@delorun/logs`](../logs/README.zh.md)。约定的取值与类型来自 [`@delorun/contract-runtime-supervisor`](../contract-runtime-supervisor/README.zh.md)。

## 目录

- [启动监管器](#launching-the-supervisor)
- [套接字与令牌](#the-socket-and-the-token)
- [API](#the-api)
- [监管器根目录](#supervisor-roots)
- [镜像与已验证的 manifest](#images-and-the-verified-manifest)
- [能力报告](#the-capability-report)
- [工作区容器](#workspace-containers)
- [运行日志](#the-operational-log)
- [尚未实现的部分](#not-implemented)
- [测试](#tests)

<a id="launching-the-supervisor"></a>
## 启动监管器

home 进程（[C19](../../docs/contracts/c19-home-process.zh.md)，[`@delorun/home-process`](../home-process/README.zh.md)）持有启动令牌。每次启动时，它使用 `@delorun/home` 的 `writeNewStartToken` 将令牌写入 `run/<profile>/start-token`，然后以文件描述符 3（`LAUNCH_FD`）上的管道启动 `src/main.ts`，并用 `encodeLaunch` 向其写入一行启动信息：

| 字段 | 取值 |
| --- | --- |
| `v` | 1 |
| `home`、`profile` | 解析后的 Delorun home 与 CLI profile |
| `startId` | 本次启动在 C1 中的启动 id |
| `token` | 本次启动的令牌 |
| `manifest` | home 进程为所运行的运行时验证过的发布 manifest 中的 `images` 条目 |
| `imagePull` | `registry` 表示按摘要拉取引擎缺少的已列出镜像；`none` 表示只使用引擎已持有的镜像 |
| `seccompDirectory` | 存放 manifest 所列 seccomp 配置文件的绝对目录 |
| `logLevel` | 监管器所记录日志的最详细级别 |
| `timing` | `engineCallMs`（1 到 600 秒）与 `pullMs`（10 秒到 1 小时），分别是一次 Engine API 调用与一次拉取的截止时间；`firstByteMs`（0.1 到 5 秒），从连接到请求第一个字节的时间；`refusalLogIntervalMs`（1 秒到 1 小时），两条认证拒绝记录之间的最短间隔 |

令牌只通过该管道到达监管器，从不经由命令行或环境变量。管道在本次启动运行期间保持打开；home 进程关闭它或退出时，监管器关闭其套接字并退出，下一次启动会以新令牌启动新的监管器。监管器在读取启动行之前就开始监视该管道，因此监管器启动期间管道关闭时，它同样会停止。该次重启期间，容器继续运行。`Supervisor.start` 在一个已持有这些值的进程中运行同一个监管器。

<a id="the-socket-and-the-token"></a>
## 套接字与令牌

- 套接字是 `@delorun/home` 的令牌通道（[令牌通道](../home/README.zh.md#the-token-channels)），采用 C9 的限制：路径名套接字 `run/<profile>/supervisor.sock`，位于必须通过 C1 的 0700 检查的运行目录中。超过 103 字节的路径会以 `SOCKET_PATH_TOO_LONG` 被拒绝。套接字先以临时名称在运行目录中绑定，设为模式 0600，再重命名到位，替换该 profile 先前监管器遗留的套接字；路径上的任何其他文件都会被拒绝。停止时，只有该路径仍是本监管器的套接字（按设备号与 inode 判断）才会删除它，因此较晚停止的旧监管器会保留新监管器的套接字。绑定之后启动失败时，会关闭并删除其临时套接字，每次启动也会删除先前监管器遗留的临时套接字。监管器在启动时解析一次 home，并以规范路径推导运行目录与辅助程序目录、标签中的 home id 以及挂载来源。
- 每个连接携带一行至多 65,536 字节的请求；其第一个字节必须在 `firstByteMs` 内到达，整行必须在 5 秒内到达（`REQUEST_TIMEOUT`），第 33 个打开中的连接会收到 `BUSY` 应答。应答行一经写出，该连接所占的名额即被释放；调用方在此后 `firstByteMs` 内仍未关闭的连接会被关闭。
- `@delorun/home` 的 `StartTokenCheck` 通过定长摘要，以恒定时间比较请求的 `token` 与当前启动的令牌。缺失、错误或属于上一次启动的令牌，以及不是 JSON 对象的行，都只会收到 `UNAUTHENTICATED`，别无其他回应。认证拒绝至多每 `refusalLogIntervalMs` 记录一次日志，并附上未记录的次数。
- 令牌在读取模式之前检查，因此没有令牌的调用方无法了解 API 的任何信息。
- `@delorun/home` 的 `readStartTokenFile` 通过 C1 的受保护文件检查读取令牌文件，供 `delorun` 客户端命令使用。

<a id="the-api"></a>
## API

`decodeRequest` 依据 C9 的 `SupervisorRequest` 封闭模式检查已通过认证的请求：未知的 `op`、任意深度的未知字段，或超出其类型或界限的取值，都会以 `SCHEMA_VIOLATION` 被拒绝，其详情只写出字段名，从不写出取值。没有任何字段可以指定镜像、Docker 标志、挂载、环境变量、命令、设备、能力或网络。对同一工作区的操作按到达顺序执行。每个应答行都带有 `ok`；失败时带有 C9 的 `error` 代码和一个 `detail`。监管器未预料到的失败会关闭连接，不返回应答行，并会被记录日志。

| `op` | 提供的服务 |
| --- | --- |
| `capabilities` | 报告中的 Docker 部分及每种形态的可用性；`refresh: true` 会重新检视 |
| `workspace.create`、`.start`、`.stop`、`.remove`、`.inspect`、`.list`、`.egress` | S2 工作区容器、其网络及其出站代理 |
| `helper.start`、`s3.create`、`s3.start`、`s3.stop`、`s3.inspect` | 以 `SHAPE_UNAVAILABLE` 拒绝：S2 辅助程序与 S3 容器将随其形态一同到达 |

<a id="supervisor-roots"></a>
## 监管器根目录

`loadRootRules` 在监管器启动时通过 C1 的受保护文件检查读取 `supervisor/roots.json`；文件缺失表示没有父目录，因此每个根目录都会被拒绝。记录若不是 `{"v":1,"parents":[...]}`（父目录至多 16 个），或其父目录未以已存在的规范路径保存，或是 setup 所拒绝的父目录，则会中止本次启动。本包中没有任何代码写入该文件。

`resolveWorkspaceRoot` 使用 `realpath` 解析请求的根目录，并按文件身份（根目录及其每个祖先目录的设备号与 inode）比较，因此绑定挂载之类的别名视同它所展示的目录。它以 `ROOT_REFUSED` 拒绝以下情形：文件系统根目录、操作系统的主目录或包含它的路径、Delorun home 或包含它或位于其内的路径、位于引擎上任何其他带有 Delorun 标签的工作区容器（无论其 home 与 profile）的根目录之内或包含该根目录的路径、无法解析的路径，以及任何不是本人所拥有目录的对象。未严格位于某个父目录之内的根目录会以 `ROOT_NOT_UNDER_PARENT` 被拒绝。`recheckMountedRoot` 在每次启动之前运行：已记录的根目录必须仍解析为其自身，并通过同样的规则。

<a id="images-and-the-verified-manifest"></a>
## 镜像与已验证的 manifest

监管器只依赖 [C2](../../docs/contracts/c02-release-manifest.zh.md) 的类型：它以 `VerifiedManifest` 输入接收已验证的 manifest，其 `images` 由 home 进程在发布校验器检查 manifest 之后、于启动时发送。验证签名、时间戳或日志条目不是本包的职责，也没有任何请求会指定镜像。

- `listedImage` 按引擎平台的摘要取 C9 的仓库，并以 `IMAGE_NOT_IN_MANIFEST` 拒绝指定其他仓库的条目，或指定的平台没有摘要的条目。
- `ensureListedImage` 以 `<repository>@<digest>` 查找镜像；镜像不存在且 `imagePull` 为 `registry` 时，精确拉取该引用。拉取失败以 `IMAGE_PULL_FAILED` 拒绝；以下情形以 `IMAGE_NOT_IN_MANIFEST` 拒绝：拉取关闭时镜像不存在，以及镜像记录的摘要中不包含 manifest 所列任何摘要的情形。容器只从该引用创建，从不使用标签。
- manifest 为镜像列出 `seccomp` 文件时，`loadSeccompProfile` 从 `seccompDirectory` 读取它；名称不是单个路径段、文件不存在，或其长度或 SHA-256 不符时，以 `IMAGE_NOT_IN_MANIFEST` 拒绝。该镜像的每个容器（包括探测容器）都在该配置文件下运行；没有列出时，在引擎的默认配置文件下运行，从不使用 `unconfined`。

<a id="the-capability-report"></a>
## 能力报告

`inspectDocker` 与 `docker` 命令一样解析当前生效的 Docker 上下文（`DOCKER_HOST`、`DOCKER_CONTEXT`、配置中的 `currentContext`），读取引擎的 `info` 与 `version`，并以 S2 镜像的已列出摘要，在其自有的内部网络上使用 Small 预设创建探测容器。它读取该容器的 inspect 记录，并在其中以 exec 方式运行固定的探测命令，仅读取其退出码。只有两者都显示某项限制时，该限制才为 `enforced`：

| 限制 | inspect 记录 | 在容器内确认 |
| --- | --- | --- |
| `cpu`、`memory`、`pids` | `NanoCpus`、`Memory` 与 `MemorySwap`，`PidsLimit` | cgroup 的配额与限制 |
| `disk` | `StorageOpt.size`；拒绝该设置的引擎会给出 `not-enforced` 及其消息 | 根文件系统的大小在限制之内 |
| `cap-drop`、`no-new-privileges`、`seccomp` | `CapDrop`、`SecurityOpt`，以及引擎的 seccomp 选项 | `/proc/self/status` 中为空的 `CapBnd`、`CapPrm`、`CapEff` 与 `CapAmb`，以及 `NoNewPrivs` 与 `Seccomp` |
| `read-only-root`、`user-namespace` | `ReadonlyRootfs`，引擎的 `userns` 或 `rootless` 选项 | `/` 以只读方式挂载；`uid_map` 不是恒等映射 |
| `network-isolation` | 探测网络为内部网络，且是容器唯一的网络 | 除 `lo` 外的接口上没有默认路由 |
| `host-gateway-block`、`host-loopback-block` | 探测网络的 `Options` 请求桥接驱动的 `isolated` 网关模式，因此它没有网关地址 | 连接监管器在网关地址上打开的监听器，以及经由 `host.docker.internal`、`10.0.2.2` 和网关连接回环监听器，均失败；完全没有网关地址的网络（`isolated` 模式所致）本身就是该阻断 |
| `egress-allowlist` | | `unknown`：探测需要 S2 镜像的出站代理 |

缺失或未能结束的探测工具会得到 `unknown`；监管器无法在其上监听的网关地址同样得到 `unknown`，引擎运行在虚拟机中时即为此情形。无论发生什么，返回报告之前都会删除探测容器及其网络。只有当 C9 要求的限制（其中包括 `host-gateway-block`）均为 `enforced` 且其镜像已列出时，`shapesOf` 才会提供某个形态；在 Docker Desktop 上、任何宿主系统上，都不会提供 S2，因为其辅助程序套接字无法穿过 Desktop 的虚拟机文件共享；文件监视仅在 Linux 引擎上被报告为 `supported`。

<a id="workspace-containers"></a>
## 工作区容器

`workspace.create` 要求 S2 已被提供，拒绝凭据转发，解析根目录，依据引擎所在机器检查预设（`PRESET_OUT_OF_RANGE`），确保 S2 镜像存在，并在 home 与 profile 的标签下创建：

- 内部网络 `delorun-ws-<12 hex>`，由 `networkBody` 以桥接驱动的 `isolated` 网关模式创建，因此其网桥不携带主机地址，容器没有机器上的网关可连接；
- 同名容器，由 `createBody` 构建：丢弃所有能力，设置 `no-new-privileges`，使用所列的 seccomp 配置文件或引擎的默认配置文件，根文件系统只读并带有大小为预设值的 tmpfs `/tmp`，CPU、内存与 PID 限制取自预设，交换空间等于内存，磁盘大小仅在报告确认其已强制执行时设置，使用 init 进程，无重启策略，无设备，不加入宿主的任何命名空间，使用 C9 辅助通道的工作区用户，并且只绑定挂载解析后的根目录（路径相同，可写）以及辅助程序的目录 `run/<profile>/s2/<12 hex>/` 到 `/run/delorun-helper`（只读），其 `channel/` 子目录以可写方式挂载到 `/run/delorun-helper/channel`；
- 除非出站为 `none`，否则还会创建出站代理 `delorun-ws-<12 hex>-proxy`，它使用同一摘要的镜像，接入 `delorun-ws-<12 hex>-out` 与内部网络，以 C9 的入口 `/usr/local/bin/delorun-egress-proxy`（`EGRESS_PROXY_ENTRY`）启动，其模式与主机列表分别在 `DELORUN_EGRESS_MODE` 与 `DELORUN_EGRESS_HOSTS` 中给出，并使用工作区的资源限制。

每创建一个容器后，监管器都会将其 inspect 记录与其请求体比较（`hardeningDifferences`）：挂载与解析后的路径不一致时，删除本次创建的全部内容，并以 `ROOT_REFUSED` 拒绝；引擎未应用某项设置时，以 `LIMITS_MISSING` 拒绝。工作区容器的代理变量始终指向该代理，因此在 `none` 下，任何名称都无法解析，也没有任何流量能够发出。容器已存在的工作区以 `WORKSPACE_EXISTS` 拒绝，启动一个容器已在运行的工作区也是如此，引擎拒绝的调用以 `ENGINE_REFUSED` 并附引擎的消息拒绝，引擎未应答时以 `DOCKER_UNAVAILABLE` 拒绝。对不带有本 home 与本 profile 标签的容器执行的操作，会以 `NOT_FOUND` 失败。`workspace.remove` 会删除这些容器、两个网络与辅助程序目录，并保持工作区根目录不变。

每次 `workspace.start` 之前，监管器都会再次检查这些容器：所有者标签、经 `recheckMountedRoot` 检查的根目录挂载、辅助程序目录及其通道目录、C9 所允许的挂载与网络，以及每条 inspect 记录与 `workspace.create` 所构建请求体的比较，包括镜像、用户与每项设置，还包括容器在 `delorun.limits` 标签中记录的限额，因此创建之后被机器提高的限额会以 `LIMITS_MISSING` 拒绝。未通过检查的容器不会启动。通道目录是工作区唯一可写的宿主路径，因此每次启动时都会清空上一次会话遗留的辅助程序套接字，并在其中含有任何其他条目时以 `ROOT_REFUSED` 拒绝；容器中的命令会写入该目录，因此使用它的主机端代码（例如 S2 辅助程序的客户端）绝不能跟随其中的路径。

随后，`workspace.start` 会从容器内部对刚刚启动的容器进行闸门检查（[`confine.ts`](src/confine.ts)，C9 的容器、网络与根目录各节），并要求两部分都成立，因为任何一部分单独都可能被蒙骗。在探测运行之后重新读取的 inspect 记录只能带有 C9 允许的绑定挂载——解析后的根目录挂载在其自身路径上、辅助程序目录（只读）及其下方可写的通道目录，以及引擎自身的 `/etc/hosts`、`/etc/hostname` 与 `/etc/resolv.conf`——其挂载源不得位于 OS home、Delorun home 或 Docker 套接字之中，并且容器只能属于它自己的内部网络，不加入宿主的任何命名空间。随后每个属性各有一条固定的探测命令，仅凭退出码读取容器自身的视图：能力集合为空、`no-new-privileges`、seccomp、根文件系统只读、工作区根目录可写、辅助程序目录只读而其通道目录可写，且除根目录、通道目录、`/tmp` 与引擎自身的文件系统及文件之外没有其他可写挂载、Delorun home 与本机 Docker 套接字不存在、`/tmp` 为预设大小的 tmpfs、预设的 cgroup 限制、工作区用户，以及除 `lo` 之外没有接口带有默认路由。若某个挂载、某项设置、网络或某条探测不通过，或探测无法运行、无法结束，容器会连同其网络与辅助程序目录一起被停止并删除；挂载问题以 `ROOT_REFUSED` 拒绝，其余以 `LIMITS_MISSING` 拒绝，未保持运行的容器以 `ENGINE_REFUSED` 拒绝，探测或其他引擎调用被引擎拒绝时同样如此。此后该工作区在 `reason` 中报告该代码并处于 `failed` 状态，直到 `workspace.create` 重新创建它；被收回的工作区绝不会被启动：即使清理失败、其容器仍然存在，`workspace.inspect` 也会以该代码报告 `failed`，而下一次启动会以同一代码被拒绝。探测不读取任何输出，因此探测命令从不携带机密，容器所显示的内容也不会离开容器。

每次 Engine API 调用都有截止时间 `engineCallMs`，每次拉取都有 `pullMs`；超过截止时间的调用为 `DOCKER_UNAVAILABLE`，拉取为 `IMAGE_PULL_FAILED`。拉取的进度流按行读取，因此其长度不受限制。

<a id="the-operational-log"></a>
## 运行日志

`openSupervisorLog` 以启动 id 打开 `logs/supervisor-<profile>/supervisor.log`，且进程在记录任何内容之前，就已将其令牌登记到日志的脱敏器中。每个请求写入一条记录，包含操作、工作区 id 与结果；认证被拒绝时，记录不包含所提交的值；任何记录都不携带请求体、凭据或环境变量的值。`captureSupervisorOutput` 将进程自身的标准输出与标准错误导入同一日志。C20 的跨入口拒绝测试套件通过 `tests/log-driver.ts` 中的驱动在此入口上运行。

<a id="not-implemented"></a>
## 尚未实现的部分

- 由发布命令启动：`delorun start` 不传递任何监管器设置，也没有 setup 步骤写入根文件。
- S2 辅助程序（`helper.start`）、S3 容器（`s3.*`）与凭据转发，在对应形态加入它们之前，均以 `SHAPE_UNAVAILABLE` 拒绝。
- 出站代理程序由 S2 镜像提供；在镜像随附该程序之前，代理容器不会启动，`egress-allowlist` 被报告为 `unknown`。
- 采用 C1 DACL 的 Windows 命名管道：监管器只在 Unix 套接字上监听。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/supervisor` 运行不需要 Docker 引擎的规范：套接字、分帧与令牌检查、封闭模式、根目录拒绝、启动的进程、纯函数部分，以及隔离规范。`node_modules/.bin/vitest run --config delorun/vitest.docker.config.ts delorun/packages/supervisor` 针对当前上下文的引擎运行 Docker 规范（`*.docker.spec.ts`），使用由 `tests/fixtures/s2-image` 构建、并在本次运行中以 C9 的仓库名打上标签的替代 S2 镜像；它们创建的每个容器、网络与标签，之后都会被删除。

隔离规范会运行宿主提供的每种沙箱方言，经由上游的沙箱提供方。若某方言的配置文件尚未表达 C1 的 `home-read` 规则（由读取 home 下夹具文件的探测发现），则以该原因报告为跳过；启动器不可用时，Landlock 同样如此。一个规范依约定所述应用 C1 的 bwrap 机制，以证明套接字与令牌文件位于该机制所隐藏的位置之内。
