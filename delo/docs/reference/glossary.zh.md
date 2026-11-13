# Delo 术语表

[English](glossary.md) | 中文

Delo 尚无正式发布；本页描述首个发布版本。

Delo 的文档、skill（技能）、界面文案与拉取请求所用的词，每个概念只用一个规范术语。本页扩展了上游的[术语表](../../../docs/glossary.zh.md)；上游术语表定义 harness 自身的术语（agent、session、turn、step、tool、preset、plugin、bundle、profile），本页只定义 Delo 新增的概念。

每个条目给出术语、它在平实语言中的含义，以及代码所用的名称（如果二者不同）。界面文本使用该术语；代码与维护者文档可以用反引号加上代码名称。引入新概念的拉取请求须在同一次提交中新增该概念的条目。

## 目录

- [产品](#the-product)
- [运行位置](#where-things-run)
- [远程访问 studio](#reaching-a-studio)
- [登录](#signing-in)
- [修改 harness](#changing-the-harness)
- [保障工作安全](#keeping-work-safe)
- [社区](#community)
- [构建 Delo](#building-delo)
- [编写 Delo 的文档](#writing-delos-documentation)
- [应避免的用词](#words-to-avoid)

<a id="the-product"></a>

## 产品

- **Delo**：开源项目与应用，附带 `delorun` 命令：DeepSeek Harness 的社区分支。<a id="delo"></a>
- **Delo Run**：位于 delorun.com 的托管服务：社区页面与候补名单；配合 Delo 中继（路线图第 2 阶段），它还提供账户（邮件验证码、GitHub、可选的通行密钥）、登录，以及经由 Delo 的设备批准。公开文本只标注联系邮箱 support@delorun.com。<a id="delo-run"></a>
- **stock DSH**：上游按原样发布的 DeepSeek Harness。**stock look**：关闭 studio 附加功能后的 Delo。<a id="stock"></a>
- **studio**：harness 的网页界面，在浏览器与桌面应用中相同。代码对应：上游的 Web 客户端。<a id="studio"></a>
- **studio 附加功能**：Delo 的主题、侧边栏、chat 状态、设置布局与新手引导；首个发布版本默认开启它们，“设置”中的一个开关可以关闭它们。代码对应：`@delo/bundle-studio`。<a id="studio-additions"></a>
- **主对话**（main chat）：位于所有工作区之外的一个 chat，本人从这里询问并引导其他 chat，并在某个工作区中开始工作；凡超出单个轮次的变更，它都会先询问本人。代码对应：`@delo/plugin-main-chat`。<a id="main-chat"></a>
- **增强功能**（augmentation）：超出 stock 工作流、需由本人选择开启的附加功能，例如远程访问、Docker 隔离或额外机器。<a id="augmentation"></a>
- **本人**（the person）：一个 home 的唯一所有者。维护者文档用「the person」，界面文本用「你」。不用 user 一词，上游把它用于模型对话中的用户角色。<a id="the-person"></a>

<a id="where-things-run"></a>

## 运行位置

- **home**：唯一保存本人的 studio、harness 配置、机器列表与 chat 历史的位置：本人自己的电脑或服务器。代码对应：Delo 的 home 目录 `~/.delo`。<a id="home"></a>
- **机器**（machine）：运行 chat 的计算机；home 所在的电脑是第一台。额外机器运行由 home 配置的无界面 Delo agent（智能体）。<a id="machine"></a>
- **工作区**：一个项目；它可以在多台机器上各有一份副本。<a id="workspace"></a>
- **chat**：绑定到单台机器的对话，其 agent loop（智能体循环）在该机器上运行。代码对应：上游的 session（会话）。<a id="chat"></a>
- **目标设备**（target）：不运行 Delo 的设备，由 agent 通过工具访问，例如经 adb 连接的手机。<a id="target"></a>
- **运行时**（runtime）：机器运行命令的方式。**原生**（native）：以本人自己的访问权限运行，并在可用时使用上游的操作系统沙箱，它限制文件写入；Delo 的约定要求其 profile 还会在方言可强制执行时，阻止受限命令读取 Delo 的密钥与令牌，或连接其控制套接字与 Docker socket；其他 Unix socket 与网络仍可访问。**Docker**：在容器中运行，采用以下 Docker 形态之一：**S2**，harness 位于机器上，每个 Docker 工作区各自位于一个容器中；**S3**，所有内容位于一个容器中，它隔离的是计算机而不是各工作区之间，且不提供远程访问；**S1**，harness 与每个工作区都容器化，此形态需要托管 home。<a id="runtime"></a>
- **Docker 监管器**（Docker supervisor）：唯一调用 Docker 的 Delo 组件，通过 `~/.delo` 下一个套接字上的固定结构 API 提供服务。该套接字只接受持有令牌的调用方，而令牌在每次 home 进程启动时写入该处；因此在方言强制执行原生规则时，受限命令无法访问它。无法强制执行时，`delorun verify` 会报告，setup 会标注 Docker 模式。Delo 的约定要求它运行按摘要固定的工作区镜像，并报告该机器上 Docker 强制执行了哪些限制。代码对应：`@delo/supervisor`。<a id="supervisor"></a>
- **home 进程**（home process）：在 `~/.delo` 下持有 CLI profile 锁并运行其 Host 的后台进程。`delorun start` 与 `delorun stop` 启动和停止它；更新通过更新握手抵达它，该握手从不在运行中的 chat 之下切换运行时。**更新通道**（update channel）：`delorun update` 与 studio 的「Update now」所用的 `~/.delo` 下的套接字，与 Docker 监管器一样，由每次启动的令牌与原生规则保护。锁按 profile 划分：桌面 Host 既不获取该锁，也不加入其排空流程，各入口独立更新。<a id="home-process"></a>
- **运行时发行包**（runtime closure）：`delorun` 命令所运行全部内容的一次已签名发布，安装在 `~/.delo/runtimes/<version>` 下。**运行时仓库**（runtime store）：这些安装，附带指向当前活动安装的指针，并保留上一个安装以便回滚。桌面应用在其已签名资源中携带自己的副本。<a id="runtime-closure"></a>
- **启动令牌**（start token）：每次 home 进程启动时写入 `run/<profile>/start-token` 的 32 字节随机令牌；Docker 监管器与更新通道只在该次启动运行期间，接受携带它的请求。<a id="start-token"></a>
- **能力报告**（capability report）：说明机器运行什么、强制执行什么的陈述，其中每项限制标为 `enforced`、`not-enforced` 或 `unknown` 并附证据；setup 在本人选择 Docker 形态之前显示它。代码对应：运行时提供方的 `report()`。<a id="capability-report"></a>
- **读取豁免**（read exemption）：受限命令可以读取并执行的目录，即 `runtimes/`、`skills/` 与 `dsh-runtimes/`；任何密钥都不写入其中。<a id="read-exemption"></a>
- **启动协议**（launch protocol）：运行时已签名 manifest 中的编号，它规定入口文件、启动器传入的参数与所设置的环境变量；启动器只在支持该编号时运行此运行时。<a id="launch-protocol"></a>
- **工作区网络**（workspace network）：原生工作区为模型在其沙箱中运行的命令以及 `web_fetch` 设定的网络：`open`，即原版给出的主机网络，为默认值；`allowlist`，只允许列出的主机，经出站代理访问；或 `off`，没有网络。它只能在 home 所在电脑上的 studio 中更改。代码对应：`@delo/plugin-permission-defaults` 中的 `deloCommandNetwork`。<a id="workspace-network"></a>
- **出站代理**（egress proxy）：作为工作区唯一对外路由、拒绝非公共地址的 HTTP 代理。网络为 `allowlist` 的原生工作区使用每个列表一个的代理，由 Host 在 `~/.delo` 下的套接字上运行，并由沙箱绑定进每个命令，它在解析名称之前先与列表比对；每个 Docker 工作区则在其自有网络上运行自己的代理。<a id="egress-proxy"></a>
- **出站允许列表**（egress allowlist）：Docker 工作区的默认出站模式，允许其 profile 中的模型提供商、默认列表中的包仓库与 Git 主机，以及该工作区自行添加的主机。<a id="egress-allowlist"></a>
- **容器拒绝标记**（container denial marker）：Docker 工作区只读根目录拒绝文件访问时所带的那一行，它说明环境拒绝了该访问、任何沙箱模式都不允许它，因此不提供提权提示。<a id="container-denial-marker"></a>
- **S2 辅助通道**（S2 helper channel）：每个 S2 工作区容器内的 SSH 辅助程序，承载该工作区的文件、进程、终端、LSP 与 PTC 调用。<a id="s2-helper-channel"></a>
- **监管器根目录**（supervisor roots）：至多列出 16 个父目录的文件，Docker 监管器只在这些父目录之下创建工作区根目录；只有 `delorun setup` 写入它。<a id="supervisor-roots"></a>

<a id="reaching-a-studio"></a>

## 远程访问 studio

- **远程访问**（reach）：从另一台设备或网络打开 studio。**远程访问方式**（reach option）：其中一种方式：Tailscale 私有网络、Tailscale Funnel、自托管中继或 Delo 中继。<a id="reach"></a>
- **Tailscale 远程访问**（Tailscale reach）：通过本人的 tailnet 远程访问：`tailscale serve` 仅供 tailnet 设备访问，Funnel 面向公共互联网。Delo 的约定要求它不使用 Delo 的基础设施；Tailscale 的协调服务与证书则为受信任的对象；除非开启 Tailnet Lock，否则 Tailscale 可以把设备加入 tailnet。<a id="tailscale-reach"></a>
- **Delo 中继**（Delo relay）：Delo Run 的中继，位于 `delo.run` 名称下。**中继控制面**（relay control）：其 Cloudflare Workers 部分，负责名称、密钥绑定、隧道授权、限额与滥用处理。**中继数据面**（relay data plane）：无状态的直通服务器，转发它们无法读取的加密字节。<a id="delo-relay"></a>
- **自托管中继**（self-hosted relay）：由本人在自己的服务器与域名上运行的同一中继数据面。端到端加密在以下条件下保持成立：该域名的 CAA 记录把证书签发绑定到 home 的 ACME 账户（`accounturi`），且 home 不通过中继响应任何证书质询。其运营者即其所有者，因此 Delo 中继的每账户限额不适用于它。<a id="self-hosted-relay"></a>
- **studio 地址**（studio address）：能够访问 home 的 studio 的地址，例如 `k7x2p9.delo.run`、本人自己的域名或 `ts.net` 名称。<a id="studio-address"></a>
- **远程访问监听器**（reach listener）：为一种远程访问方式提供服务的 Host 监听器。它绑定到 `127.0.0.1` 或一个 Unix 套接字，不允许覆盖主机地址；它在任何路由之前对每个请求与升级请求进行认证，并在登录之前只提供其登录前允许列表中的路由。回环监听器是上游自己的监听器。代码中为 `@delo/contract-admission` 中的监听器 id。<a id="reach-listener"></a>
- **host id**：studio 与 home 的 Host 进程之间一个连接的标识符。它由浏览器生成，从不发送给 home。代码中为 `@delo/contract-host-qualified-keys` 中的 `hostId`。<a id="host-id"></a>
- **host 限定键**（host-qualified key）：携带 host id 的已持久化浏览器键或客户端状态键；对于会话或工作区，还带有原样的上游 id。代码中的键形式见 `@delo/contract-host-qualified-keys`。<a id="host-qualified-key"></a>
- **端到端加密远程访问**（end-to-end encrypted reach）：TLS 在本人的 home 上终止，因此中继或提供方无法读取 studio 流量的远程访问。界面文本会准确说明每个选项仍能看到什么。对 Delo 中继从不使用「零信任」一词；它只可描述不涉及 Delo 的选项（Tailscale、自托管中继），且优先直接陈述提供方能看到什么。<a id="end-to-end"></a>
- **隧道令牌**（tunnel token）：中继协议中的短时令牌，授权针对某一名称与某一 home 密钥的一次隧道尝试。<a id="tunnel-token"></a>
- **证书告警**（certificate alert）：当公开证书日志显示一张覆盖 home 名称（包括通配符）的证书、而 home 并未申请它时，正在运行的 home 会在自己的屏幕上、桌面应用中以及其他受信任设备上显示的阻断性警告。<a id="certificate-alert"></a>

<a id="signing-in"></a>

## 登录

- **所有者验证码**（owner code）：home 在其终端中打印的一次性代码，供第一台设备认领；仅在 home 所在计算机（回环地址，包括 SSH 端口转发）上接受，只有在远程访问约定信任 Tailscale 身份请求头的情况下，才也在 tailnet 私有路径上接受。<a id="owner-code"></a>
- **home 密钥**（home key）：home 自己的签名密钥，它向 home 的设备与中继标识该 home，为其告警签名，并在设备重置后保留。**匹配码**（match code）：设备批准期间新设备与受信任设备都显示的 8 位数字，由两台设备各自看到的密钥推导而来；本人在受信任设备上输入新设备显示的匹配码。<a id="home-key"></a>
- **受信任设备**（trusted device）：home 已为某个 studio 地址批准的浏览器或桌面应用。它持有绑定到该地址来源的设备密钥，因此新地址会再次批准它。**设备批准**（device approval）：在一个实时会话中，由受信任设备批准新设备，方法是输入新设备显示的代码。<a id="trusted-device"></a>
- **身份因子**（identity factor）：为远程访问证明本人身份的登录方式：通行密钥、本人自己的 OpenID Connect 提供方，或在使用 Delo 中继时的 Delo Run 账户；开启远程访问时，须为每个 studio 地址注册。仅本地的 home 不需要它；公开远程访问必须具备它，tailnet 私有远程访问则可改用 tailnet 身份。它从不替代设备批准。<a id="identity-factor"></a>
- **恢复套件**（recovery kit）：所有受信任设备丢失时，用于恢复批准权限的已保存密钥。使用它需要身份因子，并会换成一个新套件。home 自己的终端（`delorun devices reset`）是另一条恢复途径；在没有身份因子的情况下，它是唯一途径。<a id="recovery-kit"></a>
- **所有者认领**（owner claim）：尚无所有者的 home 的首台设备认领，须凭所有者验证码完成，且只在 home 的回环监听器上接受；home 有所有者之前，远程访问保持关闭。<a id="owner-claim"></a>

<a id="changing-the-harness"></a>

## 修改 harness

- **profile**：上游的 profile。`delorun` 命令与桌面应用各自保留一个，与上游一致，并共享 chat 与工作区。**层**（layer）：一个组合包、profile patch、home patch 或 overlay。<a id="profile"></a>
- **本地组合包**（local bundle）：Delo 的 CLI profile 在上游 web profile 模板之后加入的组合包，承载 Delo 的本地集成行；profile 的 `--dump-config` 会在它写入的每一行旁标注该组合包。代码对应：`@delo/bundle-local`。<a id="local-bundle"></a>
- **profile 历史**（profile history）：profile 的每个已保存版本，记录改动了什么以及由谁改动。**撤销**（undo）：恢复到最近一次之前的版本。**安全模式**（safe mode）：启动时保留本人的附加内容，但不加载它们。<a id="profile-history"></a>
- **eject**：将插件源码复制到 profile 中，作为原插件的可编辑替代品。<a id="eject"></a>
- **源码模式**（source mode）：从本人自己分叉的 git 检出版本运行 Delo，并通过合并已签名的发布标签进行更新。目前未提供此模式，界面文本不使用该术语。<a id="source-mode"></a>
- **更新报告**（update report）：新版本会改变或破坏什么，在更新应用之前显示。<a id="update-report"></a>
- **更新检查**（update check）：运行中的安装向发布渠道请求其最新版本，像更新一样验证它，且不发送任何关于本人的信息；“设置”→“通用”→“更新”可以关闭它。**更新提示**（update notice）：终端中的一行，以及 studio 侧边栏中不打扰的提示，说明有更新的版本；它不应用任何内容。<a id="update-check"></a>
- **更新日志**（update journal）：文件 `run/<profile>/update.json`，home 进程从 `snapshot` 阶段起在每个更新阶段开始时写入它，下次启动读取它以完成被中断的更新。<a id="update-journal"></a>

<a id="keeping-work-safe"></a>

## 保障工作安全

- **回收站**（trash）：已删除的 chat 与工作区在此等待，可以恢复，直至被清除。<a id="trash"></a>
- **未受信任的 chat**（untrusted chat）：导入的 chat。Delo 的约定要求它显示写明其来源的横幅，并在本人将其标记为受信任之前，让其历史保持在模型上下文之外。<a id="untrusted-chat"></a>
- **导出文件**（export file）：工作区及其 chat 与定制内容的导出文件，不含密钥。导入时不覆盖任何内容，且只在显示其差异后才应用定制内容。代码与维护者文档中为 archive（`@delo/archive`）；界面文本使用「export file」，因为上游界面把 Archive 用作会话操作。<a id="archive"></a>
- **验证状态**（verification status）：Delo 对 home 所做检查（发布版本、文件、隔离、暴露、登录、插件、数据共享）的结果，附带其模式：默认为 `warn`，另有 `enforce` 与 `off`。代码对应：`@delo/integrity`、`delorun verify`。<a id="verification"></a>
- **发布 manifest**（release manifest）：描述一次 Delo 发布的已签名文件，列出其运行时归档、安装程序、镜像摘要、SBOM、npm 包与安装脚本，每项附长度与 SHA-256 摘要。代码对应：`delorun-<version>.manifest.json`。<a id="release-manifest"></a>
- **根元数据**（root metadata）：已签名的文件，列出每个发布角色的密钥与阈值、发布日志的密钥、见证者密钥以及每次轮换。<a id="root-metadata"></a>
- **密钥角色**（key roles）：一次发布的四个签名角色：`root`（离线，由所有者持有）、`targets`（离线，签署每份发布 manifest）、`timestamp`（在线，证明新鲜度）与 `catalogue`（在线，签署插件索引与撤销列表）。<a id="key-roles"></a>
- **发布日志**（release log）：Sigstore 的公开 Rekor 日志，为每份已签名发布 manifest 保存一个条目；客户端依据经见证的检查点核对该条目。<a id="release-log"></a>
- **见证者**（witness）：根元数据中的一个密钥，为发布日志的检查点共同签名；至少一个所列见证者联署后，该检查点即为经见证。<a id="witness"></a>
- **安全公告接受记录**（advisory acceptance）：`delo/release/advisory-acceptances.yaml` 中经过评审的条目，使依赖安全公告检查对某一公告与某个锁定版本范围通过，直至其 `lapsesAfter` 所指的发布。<a id="advisory-acceptance"></a>
- **快照**（snapshot）：在更新、迁移或恢复之前自动创建的 profile 历史版本。<a id="snapshot"></a>
- **抓取防护**（fetch guard）：Delo 插件，使 `web_fetch` 与 HTTP 抓取提供方拒绝回环、链路本地（包括云元数据地址）与私有网络目标，并返回带类型的原因；Delo 的约定要求它默认开启，在对等组合中关闭，且可以切换。<a id="fetch-guard"></a>
- **安装检查**（install check）：在插件代码加载之前，对插件及其带来的每个包检查完整性、已知安全公告、很新的版本和相近的名称；它发出警告，只拒绝本人未允许的已知严重公告。**安装记录**（install record）：已安装插件每个文件的 SHA-256，每次启动和 `delorun verify` 用它比对已安装的文件。**信任状态**（trust status）：每个插件上一次比对的结果：未改动、已改动或无记录。代码：`@delo/plugin-install-check`。<a id="install-check"></a>
- **指令层文件**（instruction-layer file）：skill、预设（preset）或 `AGENTS.md`：作为指令加载到其作用域内每个后续 chat 中的文本，因此 Delo 的约定要求模型对它的写入先征询本人并显示差异。<a id="instruction-layer"></a>
- **运行日志**（operational log）：Delo 各进程（CLI home 进程、桌面 Host、Docker 监管器、自托管中继）记录其运行情况的文件。Delo 的约定要求它轮转、从不保存密钥，并可通过 `delorun logs` 查看。它不同于记录 chat 且永久保留的会话日志。代码与维护者文档中为运行日志约定。<a id="operational-log"></a>
- **会话与轮次键**（session and turn keys）：上游的会话与轮次 id。属于某个会话与轮次的运行日志记录携带它们，使一个 chat 的轮次能追溯到背后的进程故障；会话日志事件不携带额外的 id。<a id="log-keys"></a>
- **活动历史**（activity history）：一个只读视图，基于会话日志展示每个 chat 做过的事，通过 `delorun history` 查看。未提供此功能，界面文本不使用该术语。**系统状态面板**（system-stats panel）：每台机器上的实时 CPU、内存与进程占用，位于活动历史旁边。未提供此功能。<a id="activity-history"></a>
- **遥测**（telemetry）：Delo 会发送到 Delo Run、不含内容的使用数据。Delo 不发送自有遥测；Delo 新增的任何遥测都需经本人选择开启，默认为「否」，并显示其确切负载。上游的产品分析与 DeepSeek 会话日志上传是独立的；Delo 的约定要求它们保持可用，除非本人选择开启，否则保持关闭。<a id="telemetry"></a>

<a id="community"></a>

## 社区

- **插件索引**（catalogue）：Discover 首先列出的公开插件索引。**兼容徽章**（compatibility badge）：「tested with Delo X」，表示该插件在该发布版本上通过了兼容性语料库测试，并不构成背书。**撤销列表**（revocation list）：已签名的插件版本列表，Delo 会在其下次加载时将其停用，并显示可见的原因。**列出的发现**（listed findings）：插件索引条目为某插件列出的发现，显示为作者或评审者的主张，Delo 不予核实；Delo 不执行插件审计。**插件安全审查**（plugin security review）：本人在安装插件之前可以运行的一个可选 agent 预设；它可以把发现贡献给共享数据库，且并不完全可靠。未提供此功能，界面文本不使用该术语。<a id="catalogue"></a>
- **候补名单**（waitlist）：在 delorun.com 上为托管 home、托管机器与备份报名，受隐私政策约束。<a id="waitlist"></a>
- **文档网站**（documentation website）：`docs.delorun.com`，提供英文与中文的用户指南与参考资料。每个页面都注明其描述的 Delo 版本，并同时以 Markdown 形式发布；另提供 `llms.txt` 索引，供本人的编码 agent 使用。代码对应：`delo/apps/docs`。<a id="documentation-website"></a>

<a id="building-delo"></a>

## 构建 Delo

- **上游**（upstream）：DeepSeek Harness 由其维护者发布的版本。**差异台账**（divergence ledger）：`delo/upstream-patches.json`，记录每个被修改的上游文件及其原因与类别。**[差异记录](divergence/README.zh.md)**（divergence record）：说明对某个上游插件的重大修改，以及如何合并下一个上游版本的页面。<a id="upstream"></a>
- **对等基线**（parity baseline，[`parity-baseline.zh.md`](parity-baseline.zh.md)）：在 `dsh-v0.2.2-rc.1` 上对等运行所记录的结果，附带该页所述的环境与失败分类。<a id="parity-baseline"></a>
- **对等清单**（parity checklist，[`parity.zh.md`](parity.zh.md)）：上游记录版本中每项 stock 功能及其证据，以及每项刻意的差异。**对等组合**（parity composition）：关闭了 studio 组合包与每项对模型可见的 Delo 修改的 Delo 运行时。**对等回放**（parity replay）：上游记录的场景原样运行于对等组合之上。<a id="parity"></a>
- **对等开关**（parity switch）：对等组合中一个已注册的开关，即一项对模型可见的 Delo 变更，带有其默认取值与对等取值。代码中为 `@delo/contract-parity-composition` 中的注册表 `PARITY_SWITCHES`。<a id="parity-switch"></a>
- **开关扫描**（switch sweep）：分别开启每个开关、用其自身的 Delo 场景回放的检查，以及在 `delo/` 之下找出没有注册开关的对模型可见输入的静态扫描。<a id="switch-sweep"></a>
- **扩展点优先规则**（extension-point-first rule）：Delo 的行为位于 `delo/` 之下，并运行在上游的扩展点上；对上游的修改只增加扩展点，不增加行为。**差异预算**（divergence budget）：每个类别中，一次发布在 1.0 基线之外可新增的非生成台账条目与差异块，上限为 max(20 条目, 10%) 与 max(150 差异块, 10%)；上游已吸收的条目计入抵扣。**预演合并**（rehearsal merge）：每次 Delo 发布前，对上游最新标签进行的一次试验性合并。当存在冲突的差异块超过 15%，或在没有负责人决定的情况下出现冲突的 `security` 文件时，它失败。<a id="extension-point-first"></a>
- **约定**（contract）：位于 [`delo/docs/contracts/`](../contracts/README.zh.md) 下的规格页面，工作包按其原样使用。**工作包**（work package）：一个并行工作单元，具有其拥有的路径与验收证据。<a id="contract"></a>
- **拒绝测试**（denial test）：证明被禁止的操作会失败的测试。<a id="denial-test"></a>
- **替身**（stand-in）：在 `127.0.0.1` 上运行的本地服务，它像外部提供方那样应答，例如登录提供方、证书授权机构或证书日志，使测试不接触任何在线提供方。**替身栈**（stand-in stack）：一起启动的若干替身，连同拒绝每个离开回环的连接的网络守卫。代码对应：`delo/apps/tools/src/stack/`。<a id="stand-in"></a>
- **检查运行器**（check runner）：Delo 的命令，运行改动所涉及的检查（`pnpm check`），带有以每项检查已声明输入为键的本地通过缓存，并提供计划视图（`--plan`）。未缓存的完整运行（`pnpm check:full`）是正确性证据。<a id="check-runner"></a>
- **changelog fragment**：`delo/changelog/unreleased/` 下的一个文件，描述一项人们能够察觉的改动；发布说明由这些片段汇总而成。<a id="changelog-fragment"></a>
- **brief**：由维护者创建、加上 `brief` 标签并锁定的 GitHub issue，是交给 agent 的工作简报。其他 issue 文本只是数据，绝不是指令。<a id="brief"></a>
- **SBOM**（软件物料清单）：发布中组件的机器可读清单。<a id="sbom"></a>

<a id="writing-delos-documentation"></a>

## 编写 Delo 的文档

- **上游标准**（upstream standard）：上游根目录 `AGENTS.md`、`docs/AGENTS.md`、双语约定、skill、防御性模式、升级指南、持久化确认与快照策略所确立的规则。Delo 的仓库会把这些文件就地改写为自己的标准，该标准同样适用于 Delo 的代码与文档。上游对这些文件的后续修改由人工合并。<a id="upstream-standard"></a>
- **层级**（tier）：具有单一职责的一类文档，例如用户指南、实操手册（Cookbook）、参考资料、防御性模式或架构说明。每个事实只有一个归属，即承担其职责的层级，其他页面链接到那里。Delo 的层级位于 `delo/docs/` 下，与上游位于 `docs/` 下的层级并列。<a id="tier"></a>
- **架构说明**（architecture notes）：`delo/docs/architecture/`，即 Delo 各包的有序地图，并为每个子系统提供一页现行状态说明。<a id="architecture-notes"></a>
- **Agent Note**：位于 `.agents/notes/` 下的决策记录，上游与 Delo 通用。它记录问题、决定、被其胜过的备选方案及其后果，并按状态（proposed、implemented、rejected）与类别归档，已归档的副本位于 `archived/` 之下。新记录首先检查它取代了哪些旧记录。<a id="agent-note"></a>
- **一致性记录**（consistency record）：页面英文与中文文件旁边的 `<page>.i18n.yaml` 文件，为两侧每个小节保存一个哈希。重新记录它即确认两侧表达一致；若任一侧改动而未重新记录，配对门禁即失败。<a id="consistency-record"></a>

<a id="words-to-avoid"></a>

## 应避免的用词

| 避免使用 | 改用 |
| --- | --- |
| zero-trust（指 Delo 中继） | 端到端加密远程访问，并说明 Delo 仍能看到什么；对于 Tailscale 与自托管中继，陈述提供方能看到什么 |
| cell、instance、VM、sandbox（指 home） | home、机器 |
| user（指本人） | 本人、你 |
| hub | home |
| tunnel（界面文本中） | 远程访问、Delo 中继 |
| sync（指工作区） | 复制、移动、导出 |
| archive（界面文本中） | 导出文件 |
| reviewed（指徽章） | 由 Delo X 测试通过 |
| audited、audit findings（指插件） | 列出的发现、作者或评审者的主张 |
| end-to-end through any relay（指桌面应用） | 桌面应用在 home 保留 TLS 密钥的情况下，固定该 home 的 TLS 密钥，该密钥在证书续期时保持不变 |
