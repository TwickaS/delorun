---
description: "Delo 的威胁模型：绝不比 stock DSH 更不安全的目标及每项变更的默认值、资产、各方能看到和能做的事、每个信任边界上的防护及规定它的约定、Delo 不防范的内容，以及变更如何保持该模型成立。"
---

# Delo 威胁模型

[English](threat-model.md) | 中文

## 摘要

本页说明 Delo 保护什么、防范谁、如何防范，以及在哪些地方无法防范。它在上游的[安全声明](../../../SAFETY.zh.md)与[进程沙箱参考](../../../docs/subsystems/sandbox.zh.md)之上扩展出 Delo 的资产、各方、信任边界与局限，上游这两份文档原样适用于 Delo。每个边界都链接到规定其防护的约定及其拒绝测试；实现某项防护的包尚未发布时，本页陈述的是该约定的要求。`delorun verify` 报告哪些防护在某台机器上成立。疑似漏洞请通过 [SECURITY.md](../../../SECURITY.md) 报告。

## 目录

- [目标](#goal)
- [资产](#assets)
- [各方与信任](#parties-and-trust)
- [边界及其防护](#boundaries-and-their-defences)
- [Delo 不防范的内容](#what-delo-does-not-protect-against)
- [变更如何保持本页成立](#how-changes-keep-this-true)

<a id="goal"></a>

## 目标

Delo 在任何路径上都不比 stock DSH 更不安全，并且在它改变默认值的地方更安全。Delo 运行指定 DSH 版本的上游代码，保留上游的批准、权限与沙箱决策，包括没有应答者的批准请求会被拒绝这一规则（[批准](../../../docs/subsystems/approval.zh.md)）。Delo 在这些决策之外增加保护，每项改变批准、拒绝或提权的 Delo 变更都遵循[下文的规则](#how-changes-keep-this-true)。[对等组合](../contracts/c16-parity-composition.zh.md)关闭所有模型可见的 Delo 变更并回放上游录制的场景，因此 stock 行为始终可以达到并受到检查。

上游的安全声明原样适用于 Delo：沙箱、批准与权限控制能降低风险，但不保证隔离。在原生（native）工作区中，命令以本人（the person）自己的权限运行。

Delo 改变了以下默认值。[对等清单](../reference/parity.md)列出每一项及其证据。

| 默认值 | stock DSH | Delo | 对安全的影响 |
| --- | --- | --- | --- |
| 原生命令的限制 | 沙箱限制文件写入；读取、Unix 套接字与网络保持开放 | 沙箱还拒绝受限命令在 Delo 的 home 下写入、在其下读取（三个豁免除外），以及连接 home 的控制通道与 Docker 套接字，前提是方言能强制执行相应规则（[C1](../contracts/c01-home-layout.zh.md)） | 更安全；`delorun verify` 按机器报告每条规则 |
| 完全访问 | 所有工作区共用一个权限默认值 | 新工作区以 `workspace-write` 开始，完全访问需要每个工作区一次同意；提权提示说明完全访问能触及 Delo 的 home、其密钥与令牌、Docker 监管器（Docker supervisor）与更新通道 | 更安全 |
| `web_fetch` 的目标 | 在所有模式下无需确认即抓取回环、链路本地与私有网络主机（[web-fetch-http](../../../packages/web/web-fetch-http/README.zh.md)） | 抓取防护拒绝这些目标（包括云元数据地址），并给出模型可读的类型化原因 | 更安全；本人可以关闭它 |
| 计划任务 | 一次获批的调用就能创建无人值守、反复运行的轮次 | 创建或编辑任务时会写明重复规则、目标会话及其权限预设；向完全访问的工作区投递需要每个工作区的同意 | 更安全 |
| 指令层文件 | 模型对 skill、预设或 `AGENTS.md` 的写入，即使需要批准，也只作为文件写入批准 | 批准会写明其效果，即该文本会作为指令加载到其范围内今后的每个 chat，并显示差异 | 更安全 |
| MCP 服务器 | 每个服务器命令都作为可信代码在 agent（智能体）沙箱之外运行 | 添加服务器时会在写明命令及其参数的界面上请求同意 | 更安全 |
| 数据共享 | 桌面分析与 DeepSeek 会话日志上传默认开启 | 两者在本人开启之前都关闭；Delo 没有自己的遥测 | 更安全 |
| 容器拒绝 | 没有 Docker 工作区 | 被容器只读根文件系统拒绝的文件操作带有标记，且没有提权提示 | 只适用于 Docker 工作区 |
| studio 附加功能 | stock 外观，没有主 chat | 开启，包括主 chat；其中写入另一个工作区的指令、导入工作区或恢复工作区的工具每次都会询问 | 新增工具，每个持久效果都会询问 |
| `plugin_manager` 的读取操作 | 每个操作都需要 `danger-full-access` 提权 | `list_plugins`、`list_bundles`、`list_version_exemptions`、`history` 与 `read_config` 无需提权即可运行；`read_config` 遮盖密钥字段，并扣留非原生 schema 的 Config 的值；每个写入操作仍需提权 | 唯一一个去掉提权的默认值：范围窄、可关闭，并在对等组合中关闭 |
| 入门模式与模型可见工具 | Standard 模式；没有 `preset_inspect` 或 doctor | 预选 PTC；增加 `preset_inspect` 与 doctor，每个都可关闭 | 不改变批准或限制 |
| home 目录 | `~/.dsh` | `~/.delo`，权限模式 0700；从不读取或写入 `~/.dsh` | 分开两个 home |

<a id="assets"></a>

## 资产

- **本人的文件与工作区**：机器上的工作区根目录，以及 Docker 工作区挂载的根目录。
- **模型提供方密钥与其他密钥**：home 下上游的 `.credentials.yaml` 与 `.env`；`~/.delo/secrets/` 下 Delo 的密钥，包括 home 认证密钥、中继与 TLS 密钥、会话密钥，以及工作区转发的部署密钥与令牌。
- **会话**：chat 历史（其中常含密钥），以及附件、全文索引、溢出文件与浏览器中的草稿。
- **Delo 的 home**：`~/.delo`，包括其密钥、每次启动的令牌、Docker 监管器与更新通道的套接字、已验证的发布根与检查点、插件索引缓存，以及运行时仓库（runtime store）。
- **发布完整性**：已签名的发布清单、运行时文件、工作区镜像、桌面安装程序与 npm 启动器，以及为它们签名的离线 root 与 targets 密钥。
- **插件供应**：已安装的插件及其固定版本与完整性哈希、插件索引、撤销列表以及插件索引密钥。
- **来自其他设备的 studio 访问**：studio 地址、受信任设备（trusted device）的密钥、身份因子（identity factor）、恢复套件（recovery kit），以及 home 的 TLS 证书与密钥。

<a id="parties-and-trust"></a>

## 各方与信任

### 本人

本人拥有 home 与机器。凡是其操作系统用户能看到和能做的事，本人都能看到和做到：home 下的每个文件、每个 chat 与密钥，以及在其账户能运行时的 `delorun` 与 Docker。Delo 的检查不会限制本人：`delorun verify` 只做报告，在 `enforce` 模式下，失败的检查也只阻止它所指明的启动或远程访问（reach）。本人批准提权、同意、设备与更新，每个提示都在本人作答之前说明其效果。

### 模型及其工具调用

模型能看到系统提示、chat 的历史、工具描述与工具结果。这些文本中的任何一段都可能带有通过网页、文件、仓库、issue、其他 chat 或工具输出注入的指令；导入的 chat 的历史在本人将其标记为可信之前不进入模型上下文。模型可以调用其预设提供的工具，每次都经过上游的批准与工作区的沙箱模式，也可以请求只有本人才能批准的提权；它看不到提权提示。它的命令以本人自己的权限运行，按 [C1](../contracts/c01-home-layout.zh.md) 的规定受到限制，它的 `web_fetch` 调用只能到达抓取防护允许的目标。具有持久效果的 Delo 工具，例如写入另一个工作区的指令、导入工作区或恢复工作区，每次都会询问本人。

### 插件

插件是本人安装的代码，其可信程度以本人的安装为限。Host 插件在 harness 进程中以 harness 的权限运行：它能读取 Host 读取的内容，包括 Host 加载的凭据以及 home 进程（home process）在内存中持有的启动令牌，并能向更新通道与 Docker 监管器发送其固定请求集合中的任何请求。客户端插件在 studio 页面中以已登录会话的权限运行。Delo 不对插件做沙箱隔离，也不审计插件；它用完整性哈希固定版本、检查版本要求，并在被撤销版本下次加载时停用它。每个 MCP 服务器命令都按上游所述，作为可信代码在 agent 沙箱之外运行；添加服务器时，Delo 会请求写明该命令的同意。

### 同一用户下的其他本地进程

在沙箱之外运行的本人用户进程，可以读取和修改 home 下的一切、读取启动令牌，并在本人能运行 `delorun` 与 `docker` 时运行它们。Delo 不声称防范这样的进程。home 的权限模式防范的是其他用户，而不是它，也不存在 root 所有的辅助程序。只有当这样的进程的篡改没有同时改动启动器、已存储的 root 或检查本身时，验证才能发现它。

### 机器上的其他用户

其他非管理员用户无法读取 home：其目录权限模式为 0700、受保护文件为 0600，在 Windows 上则由只允许本人、`SYSTEM` 与 Administrators 的 DACL 保护。他们无法连接 home 的套接字（位于 0700 目录内、权限模式为 0600），也无法连接其命名管道（其 DACL 只授权本人并拒绝远程客户端）。他们可以与 studio 的回环监听器建立 TCP 连接，该监听器只接受上游的启动令牌或会话 cookie。管理员或 root 能做本人能做的一切。在 rootful Docker 引擎上，`docker` 组成员身份等同于 root。

### 网络

网络上的一方能看到机器的连接。默认情况下，Delo 会发出以下请求来获取公开的已签名文件：每次启动时的发布日志检查、每次 Host 启动时及每 6 小时一次的撤销列表获取、更新检查，以及 Docker 工作区的镜像拉取。这些请求会向其主机暴露机器的 IP 地址、请求时间与 Delo 版本。这些文件都通过签名验证，因此其主机不受信任：被改动的文件无法通过验证，被扣留的文件会在其签名元数据过期时被发现。在本人开启远程访问之前，studio 只监听回环地址，远程访问的 TLS 在 home 上终止。Docker 工作区只能通过其出口代理与允许列表访问网络。

### Tailscale、本人自己的中继与 OIDC 提供方

- **Tailscale** 承载 Tailscale 远程访问，不经过任何 Delo 基础设施。受信任的是 Tailscale 的协调服务与证书：除非开启 Tailnet Lock，Tailscale 可以向 tailnet 添加设备，并持有 `ts.net` 名称的 TLS 密钥。Funnel 的服务器还能看到连接方的 IP 地址与流量大小。
- **自托管中继**由本人在自己的服务器与域名上运行。其运营者能看到 studio 的名称、home 与每台连接设备的 IP 地址、连接时间与流量大小，并在[下文](#reach-providers)的自有域名条件成立时转发它无法读取的加密字节。它声称的客户端地址会被标记为未验证。
- **本人的 OIDC 提供方**可以声明谁登录了，也可以拒绝登录。它签发的令牌本身不能完成登录：home 还要求一个已批准的设备密钥。

### Delo Run 项目

Delo Run 持有离线的 root 与 targets 密钥、在线的 timestamp 密钥与在线的插件索引密钥。它发布版本、发布元数据、插件索引、撤销列表、文档网站与候补名单。它可以发布本人可能安装的版本，该版本已签名并记录在公开日志中；在本人确认更新之前，没有客户端会安装它，也没有客户端会自行降级。它可以通过撤销列表在某个插件版本下次加载时停用它，studio 会显示原因，并记录到 profile 历史（profile history）。它无法自行进入 home：Tailscale 远程访问或自托管中继的路径上没有 Delo 基础设施，Delo 不持有任何 studio 的 TLS 密钥或设备密钥，它无法伪造设备批准（device approval）或指挥机器，也无法改变已安装插件的固定版本。本人对 Delo Run 的剩余信任包括其发布、插件索引与撤销列表，以及提供这些内容的 `delorun.com` 名称。

### 上游与依赖作者

上游的代码就是 harness，因此其作者如同 harness 一样受到信任。Delo 合并上游的每次发布，为每个改动的文件记录结论，并重新运行对等回放与插件语料。依赖由锁文件固定，发布会根据公告源检查锁文件。带标签源码或固定依赖中的恶意改动会被重建复现并签名；签名与日志条目表明发布来自何处，而不表明它没有缺陷。

### 持有被盗设备的一方

受信任设备持有绑定到某个 studio 地址的不可导出设备密钥。在远程访问中，新的登录还需要身份因子。持有带实时会话设备的窃贼，或者还能使用身份因子（例如已解锁设备上的通行密钥）的窃贼，可以在该 studio 地址上以本人身份行事，直到另一台受信任设备或 home 的终端撤销该设备。在远程访问地址上批准另一台设备，需要一个经过用户验证的 WebAuthn 断言以及新设备显示的代码。运行 home 的计算机被盗时，持有者获得本人用户持有的一切；在这种情况下，Delo 依靠操作系统的登录与磁盘加密。

<a id="boundaries-and-their-defences"></a>

## 边界及其防护

每一节写明边界、其约定要求的防护，以及报告它的检查。

- [原生命令的限制](#confinement-of-native-commands)
- [home 的控制通道](#the-homes-control-channels)
- [容器隔离](#container-isolation)
- [准入与监听器](#admission-and-listeners)
- [设备批准](#device-approval)
- [远程访问方式](#reach-providers)
- [登录](#sign-in)
- [发布、日志与重建](#releases-the-log-and-the-rebuild)
- [插件索引与撤销](#the-catalogue-and-revocation)
- [更新与回滚](#updates-and-rollback)
- [导出文件与不受信任的 chat](#archives-and-untrusted-chats)
- [日志与遮盖](#logs-and-redaction)
- [验证](#verification)
- [对等](#parity)
- [web_fetch 抓取防护](#the-web_fetch-guard)
- [数据共享](#data-sharing)

<a id="confinement-of-native-commands"></a>

### 原生命令的限制

[C1](../contracts/c01-home-layout.zh.md) 为每个在 `read-only` 或 `workspace-write` 下运行的命令，在上游的沙箱配置之上增加五条规则：不得在 home 下写入（`home-write`），不得在其下读取，`runtimes/`、`skills/` 与 `dsh-runtimes/` 除外（`home-read`），不得读取启动令牌（`token-read`），不得连接 home 的通道（`home-connect`），也不得连接位于真实路径的 Docker 套接字（`docker-connect`）。

- Delo 的密钥保存在 `secrets/` 下的文件中，文件权限模式为 0600、所在目录为 0700，从不放在读取豁免、profile、命令行、命令的环境变量或日志中。上游的凭据文件位于 home 下，受 `home-read` 约束。Delo 不使用操作系统的密钥存储，因为受限命令可以通过 D-Bus 访问 Linux Secret Service，也能运行 macOS 钥匙串项目所信任的 `node` 可执行文件。
- 当某个可写根目录等于 home、位于 home 内或包含 home 时，`workspace-write` 会被拒绝。
- `danger-full-access` 的批准提示会在本人批准之前说明：完全访问允许该命令读取 Delo 的 home（包括其密钥与令牌），并访问 Docker 监管器与更新通道。
- 其他 Unix 套接字（例如 ssh-agent 套接字、D-Bus 与显示服务器）以及网络，对受限命令仍然可达。
- home 进程在每次启动时探测每条规则，`confinement-rule` 检查只在方言能表达某条规则且其探测在本次启动时被拒绝时，才把该规则报告为已强制执行。C1 的各方言表格说明了 bwrap、Landlock、Seatbelt 与 windows-acl 各自强制执行什么。

<a id="the-homes-control-channels"></a>

### home 的控制通道

Docker 监管器（[C9](../contracts/c09-runtime-supervisor.zh.md)）与更新通道（[C19](../contracts/c19-home-process.zh.md)）监听 `run/<profile>/` 下的套接字，在 Windows 上则是命名管道。两者都只接受携带本次 home 进程启动令牌的请求：该令牌为来自操作系统随机源的 256 位数据，以恒定时间比较，从不出现在命令行、环境变量、响应或日志中。两个通道都不转发请求：监管器的 API 采用固定 schema，没有任何字段能指定镜像、参数、挂载、环境变量、命令、设备、能力或网络；更新请求不携带路径、归档、URL 或命令，因此持有令牌的调用方只能选择一个由 home 进程自己获取并验证的版本。这种保护依赖于对 agent 命令的限制，如 C1 所述。

<a id="container-isolation"></a>

### 容器隔离

[C9](../contracts/c09-runtime-supervisor.zh.md) 以两种 Docker 形态定义 Docker 工作区。在 S2 下，harness 在机器上运行，每个 Docker 工作区有自己的容器，将其与计算机以及其他每个工作区隔离。受限的 S3 在一个容器中运行 harness 与所有工作区，它把计算机与工作区隔离开，但不把工作区彼此隔离；其 harness 以单独的用户在只读目录树上运行，远程访问拒绝开启。

- 每个容器都丢弃所有能力、设置 `no-new-privileges`、使用发布附带的 seccomp 配置与只读根文件系统，并且不会获得 Docker 套接字、设备或宿主机的任何命名空间。
- 每个工作区都有自己的内部网络，没有通往机器的路由，只能通过其出口代理访问外部；该代理拒绝回环、链路本地、私有以及机器自身的地址，并在本人没有为该工作区另作选择时只允许默认允许列表。
- 监管器只挂载位于设置时所选父目录下的工作区根目录，并拒绝 `/`、`$HOME` 与 `~/.delo`。
- 它只运行已验证发布清单所列摘要的 S2 与 S3 镜像，并按摘要拉取。
- 凭据转发默认关闭，按工作区选择：单个仓库的部署密钥、每次使用都需确认的 ssh agent，或限定于单个仓库的令牌。studio 会说明该工作区的代码可以在该范围内以本人身份行事。
- 能力报告只在检查探测容器确实显示某项限制时，才把它报告为已强制执行；设置会在本人选择形态之前列出每项限制，并推荐 Docker 的 rootless 引擎。

<a id="admission-and-listeners"></a>

### 准入与监听器

studio 的回环监听器保留上游的登录方式。在本人开启远程访问之前，远程访问保持关闭，设置的 `--yes` 与 `--config` 形式从不开启它（[C11](../contracts/c11-setup-answers.zh.md)）。[C4](../contracts/c04-admission.md) 要求远程访问监听器在任何路由、升级或回退之前，在其分发器中验证每个请求；在登录前只提供登录前允许列表；拒绝上游的启动令牌、`/connect`、上游的会话 cookie 以及任何非绑定名称的 `Host`；远程访问会话保存在服务器端、经过哈希且可撤销；并发送一项内容安全策略，把图片与媒体限制在 studio 自身的源。`reach-binding` 检查报告该监听器的绑定与当前的远程访问方式（reach option）。

<a id="device-approval"></a>

### 设备批准

[C5](../contracts/c05-device-approval.md) 要求：在第一台设备于回环地址上，或在 C7 信任 tailnet 身份时于 tailnet 私有路径上，出示所有者验证码（owner code）之前，home 没有所有者，远程访问在此之前保持关闭。受信任设备只在实时会话中批准新设备，方式是输入新设备显示的代码，在远程访问地址上还需要一个经过用户验证的 WebAuthn 断言。设备密钥绑定到一个 studio 地址，因此新地址需要再次批准每台设备。批准提示会把根据中继声称的客户端地址得出的位置标记为未验证。`delorun devices reset` 需要先停止 home，它会关闭远程访问、轮换回环会话密钥，并通知每台受信任设备。在会跨证书续期保留同一 TLS 叶子密钥的 home 上，桌面应用固定该密钥；桌面应用打开另一个 home 时，与其他设备一样需要批准。`owner-and-devices` 检查报告每个地址的所有者、受信任设备与身份因子。

<a id="reach-providers"></a>

### 远程访问方式

[C7](../contracts/c07-reach-providers.md) 定义各远程访问方式，以及每种方式所显示的、关于其提供方能看到什么的说明；[C6](../contracts/c06-relay-protocol.md) 定义中继协议。

| 远程访问方式 | 路径上的 Delo 基础设施 | 提供方能看到或做到的事 | 端到端条件 |
| --- | --- | --- | --- |
| Tailscale 私有 | 无 | 受信任的是 Tailscale 的协调服务与证书；除非开启 Tailnet Lock，Tailscale 可以向 tailnet 添加设备，并持有 `ts.net` 的 TLS 密钥 | 只有 tailnet 设备能连接；桌面应用无法固定 `ts.net` 的密钥 |
| Tailscale Funnel | 无 | 与 Tailscale 私有相同；Funnel 的服务器还能看到连接方的 IP 地址与流量大小 | Funnel 把 TLS 转发到 home |
| 本人域名上的自托管中继 | 无 | 中继运营者能看到名称、home 与每台设备的 IP 地址、连接时间与流量大小；每个名称只存在一条活动隧道 | 当该域名的 CAA 记录把签发绑定到 home 的 ACME 账户（`accounturi`），且 home 不通过中继应答任何证书质询时，才是端到端的；只声称所指定 CA 强制执行的 RFC 8657 参数 |

`own-domain-caa` 检查按所指定 CA 强制执行的参数报告 CAA 记录。运行中的 home 会监视公开证书日志中覆盖其名称的证书（包括通配符证书），对于它没有申请的证书，会在自己的屏幕上、桌面应用中及其他受信任设备上发出证书告警。检测发生在某个日志收录该证书之后，延迟由各日志的收录策略决定；桌面应用的密钥固定不需要等待日志。`certificates` 检查报告证书状态与告警。Delo 中继（Delo relay）是路线图中的一个阶段，不是远程访问方式；宣布它的页面会说明 Delo 能看到什么。

<a id="sign-in"></a>

### 登录

[C14](../contracts/c14-oidc-passkeys.md) 定义身份因子：一个通行密钥或本人自己的 OIDC 提供方，在开启远程访问时为每个 studio 地址登记。公开远程访问需要身份因子；tailnet 私有远程访问可以改用 tailnet 身份。身份因子从不取代设备批准：对于没有已批准设备密钥的有效令牌，home 会拒绝。home 自己验证签发方、受众、nonce 与 PKCE，并拒绝来自启动该流程之外签发方的令牌。有身份因子时，恢复使用恢复套件与 home 的终端；没有身份因子时，只能使用终端。使用恢复套件需要身份因子，并会替换该套件。

<a id="releases-the-log-and-the-rebuild"></a>

### 发布、日志与重建

[C2](../contracts/c02-release-manifest.zh.md) 与 [C18](../contracts/c18-release-log.zh.md) 定义发布完整性。

- 离线的 targets 密钥为每个发布清单签名，离线的 root 密钥为每个角色的密钥及每次轮换签名。在线的 timestamp 密钥只为新鲜度签名，其文件在签发 3 天后过期；客户端拒绝过期或更旧的 timestamp，也从不自行降到更低的版本。
- 每个清单在 Sigstore 的公开 Rekor 日志中都有条目，并由 root 所列的见证者共同签名。安装或更新需要经过验证的包含证明，可验证的日志失败会在所有验证模式下阻止 CLI 启动。
- targets 密钥持有者只在自己控制的、CI 之外的机器上，使用公开的配方从带标签源码重建发布之后才签名；没有匹配的重建记录时，签名命令会拒绝。
- 发布会根据 GitHub Advisory Database 检查其锁文件，遇到没有已记录接受的公告时失败。
- 在签名、摘要与日志检查通过之前，任何文件都不会进入 `~/.delo/runtimes/`。在每次启动时，无论验证模式如何，启动器都会在完整性包之外，根据已签名的文件列表检查每个已安装的运行时文件。
- 桌面应用在每次更新应用之前验证清单、下载文件的摘要与日志条目，并拒绝自动降级。
- npm 启动器是安装前的信任锚：`npx delorun` 会在任何 Delo 检查之前运行 npm 提供的启动器，因此它通过 npm 为 Delo 发布工作流发布的构建证明获得信任，该工作流不持有 npm 令牌。安装脚本通过其公开的哈希获得信任。

<a id="the-catalogue-and-revocation"></a>

### 插件索引与撤销

[C13](../contracts/c13-catalogue-revocation.zh.md) 定义插件索引与撤销列表，两者都用插件索引密钥签名，并从不受信任的主机提供。安装会固定确切版本及其完整性哈希；对于被撤销的版本，或在撤销列表过期期间，安装会被拒绝。该列表带有防重放的序列号，在签发 48 小时后过期，最长缓存时间为 24 小时；超过后，studio 会说明这一点，新的插件索引安装暂停，已安装的插件继续加载，已被撤销的版本保持停用。被撤销的版本会在下次加载时停用，并附带原因与一个 profile 历史版本。徽章只显示「tested with Delo X」，由不运行插件代码的发布作业写入。Delo 不审计插件：条目列出的发现是作者或评审者的主张，Delo 不验证它们，studio 在显示它们的地方会说明这一点。[C17](../contracts/c17-plugin-versions.zh.md) 对 DSH 或 Delo 版本要求未满足或无法读取的插件，在安装时拒绝、在启动时停用，并且从不为此导入插件代码。`plugin-pins` 检查报告固定版本、徽章与撤销列表的状态。

<a id="updates-and-rollback"></a>

### 更新与回滚

[C3](../contracts/c03-update-report.zh.md) 与 [C19](../contracts/c19-home-process.zh.md) 定义更新如何应用。在更新之前，更新报告会显示目标版本将停用、移除或改变的每个插件、组合包与 profile 行，把 Delo 无法预测的内容标记为未验证且从不算作安全，并在本人确认之前不应用任何内容。只有通过签名、新鲜度与日志检查的目标才会生成报告。先写入快照；切换会等到旧运行时上没有 chat 运行；120 秒内的健康检查失败时会自动回滚，本人之后也可以随时回滚。profile 历史的撤销与恢复会运行安装时的插件检查，并在应用之前列出它们改变的插件、构建与豁免。CLI home 与桌面应用各自独立更新，更新其中一个从不切换另一个。

<a id="archives-and-untrusted-chats"></a>

### 导出文件与不受信任的 chat

[C8](../contracts/c08-archive-and-trash.zh.md) 定义导出文件与回收站。导入会先在暂存区验证整个归档，然后才写入任何内容，并且从不覆盖工作区或 chat。定制内容是封闭 schema 下的数据：不会求值任何 `!!js` 表达式，不接受任何 `insert` 行，也没有任何行能设置沙箱模式、凭据引用、远程访问方式或出口。如果归档没有导入方 home 能担保的签名，就只能以未验证状态导入，差异界面与导入报告都会显示这一状态。导入的插件声明只会列出，从不安装；导入的预设不能把权限提升到本人自己的预设之上；导入的 skill 初始为停用；导入的 chat 初始为不受信任，带有写明其来源的横幅，其历史在本人标记为可信之前不进入模型上下文。清除会从 C8 所列的每个存储中移除条目；[C10](../contracts/c10-host-qualified-keys.zh.md) 让每个连接的浏览器状态彼此分开，清除会在执行它的浏览器中移除某个 chat 在每个主机范围下的草稿。

<a id="logs-and-redaction"></a>

### 日志与遮盖

[C20](../contracts/c20-operational-logs.zh.md) 定义 Delo 的运行日志。每条记录在写入之前都经过遮盖器，它会替换已登记的密钥值、名称表明是密钥的字段以及所列的凭据形式，因此任何密钥、令牌、私钥、所有者验证码或 cookie 都不会进入日志。Delo 自己的记录不包含 chat 文本、提示、模型输出、工具参数或文件内容。日志文件位于 home 下，权限模式为 0600，受限命令不能写入它们，并且在 `home-read` 被强制执行的地方也不能读取它们。Delo 运行期间，日志在写入 14 天后被删除。

<a id="verification"></a>

### 验证

[C15](../contracts/c15-verification-checks.zh.md) 定义 `delorun verify` 与 studio 的验证面板。检查在 home 的进程中以本人的权限运行，每份报告都说明以该权限运行的程序可以改变这些检查。结果为 `pass`、`fail`、`not-enforced` 或 `unknown`；`not-enforced` 与 `unknown` 从不算作通过。模式默认为 `warn`，也可以是 `enforce` 或 `off`，每个显示结果的界面都会同时显示模式。只有在 `enforce` 模式下且每项检查都通过时，徽章才是绿色。任何详情都不包含密钥、令牌、所有者验证码、cookie、私钥或文件内容。

<a id="parity"></a>

### 对等

[C16](../contracts/c16-parity-composition.zh.md) 定义对等组合。其 overlay 只在回放流程设置 `DSH_SNAPSHOT_PATCH` 时加载；任何随产品发布的 profile、配置或命令行选项都不会选择它。在对等组合中，抓取防护、计划任务、指令层与 MCP 的同意，以及容器拒绝标记都处于关闭状态，它们提供的保护在那里不存在；Delo 的默认组合保持每一项开启。

<a id="the-web_fetch-guard"></a>

### web_fetch 抓取防护

抓取防护让 `web_fetch` 与 HTTP 抓取提供方拒绝回环、链路本地与私有网络目标（包括云元数据地址），并给出模型可读的类型化原因；该工具仍保留在模型的工具列表中（[决策](../../../.agents/notes/proposed/feature/2026-11-06-delo-web-fetch-private-targets.zh.md)）。它在请求发送之前检查目标。它限制的是 `web_fetch` 的目标，而不是命令能访问什么。

<a id="data-sharing"></a>

### 数据共享

任何关于本人、离开机器的内容都需要本人选择开启（[C11](../contracts/c11-setup-answers.zh.md)）。Delo 没有自己的遥测。上游的桌面分析与 DeepSeek 会话日志上传仍然可用，默认关闭；设置与同意界面可以分别开启或关闭它们，`--yes` 与 `--config` 不能开启其中任何一个。新增一个默认开启的、发往 Delo 主机的请求，需要负责人批准，并在网络测试的允许列表中登记。`data-sharing` 检查报告这两个选项。

<a id="what-delo-does-not-protect-against"></a>

## Delo 不防范的内容

下面每项局限都写在拥有它的约定中。当 `delorun verify` 能看到某项局限时，最后一列写明它报告什么。

| 局限 | 仍然可能发生的事 | `delorun verify` 报告什么 |
| --- | --- | --- |
| Landlock 无法拒绝对路径名套接字的连接 | 在只有 Landlock 的系统上，受限命令可以连接 home 的通道（通道会因其无法读取启动令牌而拒绝它），也可以连接 rootful Docker 套接字，这等同于 root | `confinement-rule`：`home-connect` 与 `docker-connect` 未被强制执行，并写明套接字路径；设置会提供 Docker 的 rootless 引擎 |
| Windows 不限制读取 | 在 no-read-up 标签的拒绝测试不通过的地方，受限命令可以读取 home 的密钥与启动令牌；通道只依靠命名管道的写入拒绝 | `confinement-rule`：在该机器上 `home-read` 与 `token-read` 未被强制执行 |
| 经 TCP 或 SSH 访问 Docker | 任何有网络访问的命令都能访问该引擎 | `confinement-rule`：`docker-connect` 未被强制执行；该 context 上不提供 Docker 形态 |
| 其他 Unix 套接字与网络 | 受限命令可以访问 ssh-agent 套接字、D-Bus、显示服务器以及任何网络主机 | 不报告；原生模式会说明命令以本人自己的权限运行 |
| 已提权的命令 | `danger-full-access` 下的命令不受限制：它可以读取 home 下的每个密钥与启动令牌、访问两个通道，并修改监管器的根目录文件 | `confinement-rule`：对处于该模式的工作区报告为不受限制 |
| 沙箱之外的同一用户进程 | 它们可以读取和修改 home 下的一切、运行 `delorun` 与 `docker`，并改动启动器、已存储的 root 与检查本身 | 每份报告都说明检查以本人的权限运行，并可被具有该权限的程序改变 |
| macOS 与 Windows 上的进程内存 | home 进程内存的保护依赖操作系统的规则，没有 Delo 测试检查它 | 不报告 |
| 插件 | 插件以 harness 的权限运行；撤销只在其下次加载时生效，即撤销后最多 6 小时，再加上直到重启的时间；列出的发现是未经验证的主张 | `plugin-pins`：固定版本、徽章与撤销列表的状态 |
| 插件索引密钥或发布作业被攻破 | 它可以为任何索引条目、徽章或撤销签名；已安装的版本保持其固定的完整性 | 客户端无法发现 |
| 对时钟的信任 | 被调慢的时钟会接受已超过实际过期时间的发布 timestamp、撤销列表或日志检查点；被调快的时钟会拒绝新的元数据 | 拒绝信息会写明过期时间与本地时间 |
| 从不联网的 home | 其发布相对于日志一直是 `unchecked`，展示给它的不同日志视图不会被发现，其撤销列表会过期，从而暂停插件索引安装 | `release-signature`：发布的日志状态；`plugin-pins`：过期状态 |
| 见证者的独立性 | 检查的是所列见证者的共同签名；它独立于日志与 Delo 与否，取决于 root 列出了哪些见证者 | 不报告 |
| 日志条目或重建能说明什么 | 已记录、已重建的发布来自带标签的源码；它仍可能含有缺陷或漏洞，重建也无法证实签名者的机器与工具链未被攻破 | `release-signature`：签名与日志条目 |
| 公告覆盖范围 | 公告检查不覆盖 Node 二进制、原生插件的工具链、镜像的系统软件包或桌面应用的 Python 与 Office 载荷，也不覆盖没有公开公告的漏洞 | 不报告 |
| 引擎未强制执行的容器限制 | 能否访问宿主网关取决于引擎；磁盘限制在大多数存储驱动、rootless 引擎与 Docker Desktop 上只是建议性的；Docker Desktop 的虚拟机不是容器的用户命名空间 | `workspace-isolation`：每项限制按探测结果报告 |
| S3 与 S2 辅助程序 | S3 不把工作区彼此隔离；S2 辅助程序的密钥不能保护它免受同一容器内命令的影响 | `workspace-isolation` |
| 转发的凭据 | 转发凭据的工作区，允许其代码在该凭据的范围内以本人身份行事 | `workspace-isolation` |
| 遮盖 | Delo 从未加载、也不匹配任何所列形式的密钥可能进入日志；捕获的输出可能包含 chat 与文件文本，直到保留期限或清除将其移除 | 不报告 |
| Delo 停止期间的日志保留 | 过期记录会一直保留，直到某个 Delo 进程启动或本人运行 `delorun logs --prune` | 不报告 |
| 清除后的残留 | 已清除 chat 的片段会留在进程日志中，直到其保留期限将其移除，除非本人在清除时清理它们；另一个浏览器 profile 中的草稿仍会保留 | 不报告；清除时会说明 |
| 抓取防护的作用范围 | 命令可以访问任何地址；通过已配置代理或远程抓取提供方发出的请求，会在防护之外解析其目标 | 不报告 |
| 证书检测延迟 | 在任何日志收录之前，覆盖 home 名称的证书就可能被使用 | `certificates`：在日志收录该证书后告警 |
| 对等组合 | 其开关关闭的保护在那里不存在 | 不适用；任何随产品发布的 profile 都不会选择它 |

<a id="how-changes-keep-this-true"></a>

## 变更如何保持本页成立

- 改变批准、拒绝或提权的变更，在[差异台账](../../upstream-patches.json)中是一条 `security` 类条目，附带负责人的结论，并包含一项在变更前失败、变更后通过的拒绝测试（[决策](../../../.agents/notes/implemented/process/2026-11-06-delo-never-less-safe-than-stock.zh.md)）。Delo 对 stock 检查的豁免范围很窄，写明它覆盖的检查与情形，并置于一个在对等组合中关闭的开关之后。
- 涉及信任边界的变更（登录、设备、中继、运行时、导出文件、更新或签名）在其 brief 中标记为 Lead，并接受逐行审查；安全路径由人类代码所有者批准（[规则](../../../AGENTS.md)）。
- 拒绝测试针对本地替身运行，从不联系真实服务。
- 本页与它所陈述的边界、某一方的权限或某项局限在同一次变更中修改。
- 安全报告通过 [SECURITY.md](../../../SECURITY.md) 提交，从不通过公开 issue。
