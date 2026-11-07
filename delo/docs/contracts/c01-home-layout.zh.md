---
description: "约定 C1：~/.delo home 目录树、其权限模式与拒绝规则、密钥与套接字的存放位置、每次启动的令牌、CLI profile、带 current 与 previous 指针的运行时仓库、npm 启动器的下载与校验，以及每种沙箱方言能强制执行的内容。"
---

# C1 Home 布局与运行时仓库

[English](c01-home-layout.md) | 中文

## 摘要

本约定规定 Delo 把本人的 home 存放在磁盘上的位置，以及 `delorun` 命令如何找到并切换它所运行的运行时。它定义 `~/.delo` 目录树及每个条目的所有者，home 及其受保护文件的权限模式（组件拒绝权限更宽的文件），密钥与两个拒绝受限命令的套接字的存放位置，每次 home 进程启动时写入的令牌，与桌面应用自身 profile 并列的 CLI profile，带 `current` 与 `previous` 指针文件的运行时仓库，覆盖变量，以及 npm 启动器的下载与校验。它说明每种操作系统与沙箱方言能强制执行哪些限制规则，使 `delorun verify` 按每条规则在该机器上的实际情况报告。类型包 [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.zh.md) 以常量形式提供名称、代码与限额。

## 目录

- [home 目录](#the-home-directory)
- [home 目录树](#the-home-tree)
- [权限模式与拒绝规则](#modes-and-the-refusal-rule)
- [密钥](#secrets)
- [套接字与启动令牌](#sockets-and-the-start-token)
- [home 锁](#the-home-lock)
- [Profile](#profiles)
- [运行时仓库](#the-runtime-store)
- [启动器与仓库的兼容性](#launcher-and-store-compatibility)
- [npm 启动器与安装脚本](#the-npm-launcher-and-the-install-script)
- [限制规则](#confinement-rules)
- [限额](#limits)
- [错误](#errors)
- [使用方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [各平台与方言的强制执行情况](#enforcement-per-platform-and-dialect)

<a id="the-home-directory"></a>

## home 目录

Delo home 是每人每台机器一个的目录。上游 harness 把它用作自己的 home（`DSH_HOME`），因此上游数据与 Delo 数据共用同一棵目录树。

- **解析。** `DELO_HOME` 已设置且非空时，`delorun` 用它解析 home；否则使用操作系统 home 目录拼接 `.delo`（`~/.delo`，Windows 上为 `%USERPROFILE%\.delo`）。开头的 `~` 按上游 `expandHomePath` 的方式展开，结果规范化为绝对路径。
- **拒绝。** 解析出的 home 若不是绝对路径、等于文件系统根目录或操作系统 home 目录（`HOME_INVALID`），或等于或位于上游默认 home `~/.dsh` 之内（`HOME_IS_DSH_HOME`），`delorun` 拒绝它。
- **上游变量。** `delorun` 在它启动的每个运行时进程的环境中把 `DSH_HOME` 设为解析出的 home。继承来的 `DSH_HOME` 被忽略；若其值不同，`delorun status` 会指出。
- **上游的 home。** Delo 从不读取、写入或迁移 `~/.dsh`。本人只能通过显式导入把上游数据移入 Delo。
- **覆盖变量。** `DELO_HOME` 选择 home。`DELO_PROFILE` 选择 CLI profile（[Profile](#profiles)）。没有其他变量改变布局；运行时仓库没有覆盖变量，`current` 以外的运行时只能按下文的切换规则运行。

<a id="the-home-tree"></a>

## home 目录树

Delo 在 home 顶层添加标为 Delo 的条目。其他每个条目都属于上游，保留上游的布局与权限模式，并由上游文档说明。

```text
~/.delo/                         0700  the home; upstream's DSH_HOME
  .credentials.yaml              0600  upstream credentials provider: model keys, the browser session secret
  .env                           0600  upstream credentials fallback, never written by Delo
  cordis.patch.yml                     upstream home patch
  AGENTS.md, skills/                   upstream user instructions and skills
  profiles/default/                    the CLI profile, in upstream's profile layout
  profiles/desktop/                    the desktop app's upstream profile and its lock
  sessions/, attachments/, cache/, storages/, dsh-runtimes/, ...   upstream data
  logs/                                upstream startup reports and the operational logs of C20
  runtimes/                      0700  Delo: the runtime store
  staging/                       0700  Delo: runtime installs in progress
  trust/                         0700  Delo: the verified release root, timestamp and log checkpoint (C2, C18)
  status/                        0700  Delo: each installation's update status record (C3)
  catalogue/                     0700  Delo: the verified catalogue index and revocation list (C13)
  secrets/                       0700  Delo: secret files, 0600 each
  run/<profile>/                 0700  Delo: home lock, start token, sockets, update journal
  supervisor/                    0700  Delo: the Docker supervisor's roots file (C9)
  bin/                           0700  Delo: the launcher copy used by the install script and login items
  alerts/                        0700  Delo: signed certificate-alert files (C5)
```

[C20](c20-operational-logs.zh.md) 定义的运行日志位于上游 `logs/` 下的各入口子目录中，与上游的 `startup-*.log` 报告并列。

- **`trust/`。** `root.json` 是最新通过校验的根，`timestamp.json` 是最新通过校验的时间戳，其 `version` 即所保存的最高版本（[C2](c02-release-manifest.zh.md)），`checkpoint.json` 是最新通过校验的日志检查点（[C18](c18-release-log.zh.md)）。每个文件都以原子方式替换，且从不替换为更旧的版本；CLI 启动器与桌面更新器共用它们。
- **`status/`。** `cli-home.json` 与 `desktop-host.json` 是 [C3](c03-update-report.zh.md) 的状态记录；每个安装只写自己的记录，并读取另一个的记录。
- **`catalogue/`。** `index.json` 与 `revocations.json` 是最新通过校验的插件索引与撤销列表，`state.json` 保存二者各自的 `sequence` 与获取时间（[C13](c13-catalogue-revocation.zh.md)）。

<a id="modes-and-the-refusal-rule"></a>

## 权限模式与拒绝规则

在 Linux 与 macOS 上，home 及 Delo 在其下创建的每个目录的权限模式为 0700，每个受保护文件为 0600。Delo 以独占创建方式按这些模式创建它们，因此进程 umask 只能使其更严。

- **受保护文件。** `secrets/`、`trust/`、`status/` 与 `catalogue/` 下的每个文件、`run/<profile>/start-token`、`supervisor/roots.json` 以及 [C20](c20-operational-logs.zh.md) 的日志文件。上游的 `.credentials.yaml` 与 `.env` 遵循上游自己的检查：其他用户可读的文件会被拒绝。
- **拒绝规则。** 组件读取受保护文件前先用 `lstat` 检查它。路径是符号链接或不是普通文件、所有者不是本进程的用户，或设置了任一组或其他用户权限位（`0o077`）时，组件以 `SECRET_FILE_MODE` 拒绝该文件。错误给出路径与修复命令 `chmod 600 <path>`。
- **目录。** home、`secrets/` 或 `run/<profile>/` 设置了组或其他用户权限位、是符号链接或属于其他用户时，home 进程以 `HOME_MODE` 拒绝启动。错误给出路径与修复命令 `chmod 700 <path>`。
- **Windows。** Windows 没有权限位。等价的检查读取路径的 DACL：每个允许项都必须指向本人自己的 SID、`SYSTEM` 或 `BUILTIN\Administrators`。DACL 允许其他任何 SID 的受保护文件或目录以相同代码被拒绝，修复命令是移除继承并只授权这三者的 `icacls` 命令。
- **验证。** `delorun verify` 检查 home、上述每个目录以及每个受保护文件的权限模式，并为每个权限过宽的路径打印修复命令。

<a id="secrets"></a>

## 密钥

Delo 的密钥是 C4 至 C7 定义的 home-auth 密钥、中继与 TLS 密钥以及会话密钥。每个密钥存放在 `secrets/<owner>/` 下的一个文件中，由所属约定命名该文件并规定其格式。上游的模型密钥与浏览器会话密钥留在上游的 `.credentials.yaml` 中，它同样位于 home 之下。

- 密钥从不出现在 profile、`cordis.yml`、patch 文件、命令的环境、命令行或日志中。
- home 的限制规则拒绝受限命令读取 `secrets/` 与上游的凭据文件（[限制规则](#confinement-rules)）。
- Delo 不把这些密钥存入操作系统密钥库。在 Linux 上，Secret Service 通过 D-Bus 访问，而 D-Bus 对受限命令仍可访问；在 macOS 上，钥匙串条目的访问列表信任运行时的 `node` 可执行文件，而受限命令同样运行它。只要方言强制执行读取规则，放在每种方言都拒绝的目录中的文件就能使受限命令无法读取这些密钥。

<a id="sockets-and-the-start-token"></a>

## 套接字与启动令牌

Docker 监管器（[C9](c09-runtime-supervisor.zh.md)）与更新通道（[C19](c19-home-process.zh.md)）是拒绝受限命令的两个通道。二者都在 home 下监听，且只接受携带当前启动令牌的请求。

- **套接字路径。** 在 Linux 与 macOS 上，更新通道是 Unix 套接字 `run/<profile>/update.sock`，监管器是 `run/<profile>/supervisor.sock`。二者都是路径名套接字；Delo 从不在抽象命名空间套接字上监听。套接字在启动令牌写入之后创建，绑定后设为 0600。
- **路径长度。** 套接字路径最多 103 字节。路径更长时，启动以 `SOCKET_PATH_TOO_LONG` 停止，错误给出该路径并要求使用更短的 `DELO_HOME`。
- **Windows。** 通道是命名管道 `\\.\pipe\delo-<homeId>-<profile>-update` 与 `\\.\pipe\delo-<homeId>-<profile>-supervisor`，其中 `<homeId>` 是解析出的 home 路径的 SHA-256 摘要的前 16 位小写十六进制数字。每个管道创建时带有只授权本人 SID 的 DACL，并拒绝远程客户端。
- **启动令牌。** 每次 home 进程启动都在任一通道监听之前，把一个新令牌写入 `run/<profile>/start-token`：来自操作系统加密随机源的 32 字节，以不带填充的 base64url 编码（43 个字符），后跟一个换行符。该文件以 0600 原子替换，home 进程正常停止时删除。
- **令牌有效期。** 令牌只在写入它的那次 home 进程启动运行期间有效。崩溃进程遗留的令牌文件在下次启动时被替换，任何监听方都不接受其值。
- **令牌处理。** 令牌只存在于 home 进程的内存、监管器的内存与令牌文件中。它从不出现在命令行、环境变量、URL、响应或日志中。`delorun` 客户端命令在发送请求时读取该文件。

<a id="the-home-lock"></a>

## home 锁

每个 profile 只有一个 home 进程，它在整个生命周期内持有 `run/<profile>/home.lock`（[C19](c19-home-process.zh.md)）。没有 home 进程运行时，`delorun update` 与 `delorun recover` 在修改仓库期间持有该锁。

- **创建。** 锁以独占创建方式、权限 0600 创建。它包含一个 JSON 对象：`{"v":1,"pid":<integer>,"startId":"<32 lowercase hexadecimal digits>","runtime":"<version>","startedAt":"<RFC 3339 UTC time>"}`。`startId` 是随机值，在 [C19](c19-home-process.zh.md) 的协议与 [C20](c20-operational-logs.zh.md) 的记录中标识一次启动；它不是密钥。
- **失效的锁。** 只有记录的进程已不存在（`ESRCH`）时，竞争者才替换该锁。
- **无响应的持有者。** 记录的进程存在、但其更新通道在 2 秒内没有回答 `status` 时，竞争者以 `HOME_UNRESPONSIVE` 停止并给出进程 id。它从不接管该锁。
- **范围。** 锁按 profile 划分。桌面应用的上游锁 `profiles/desktop/lock` 是另一个文件，Delo 从不获取、写入或等待它。

<a id="profiles"></a>

## Profile

- **CLI profile** 是 `default`，位于 `profiles/default/`，采用上游的 profile 布局（`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`、`node_modules/`）。`DELO_PROFILE` 按上游的 profile 命名规则选择另一个 CLI profile 名称。每个 CLI profile 都有自己的 `run/<profile>/` 目录、锁、令牌与通道。
- **桌面 profile** 是上游位于 `profiles/desktop/` 的 `desktop` profile，只由桌面应用管理。`delorun` 拒绝把 `desktop` 用于自己的运行和 `delorun plugin`，与上游 CLI 的拒绝方式相同。
- **共享数据。** 会话、工作区、附件、凭据与 home patch 留在 home 下上游规定的位置，因此 CLI 与桌面应用按上游各入口的方式共享它们。

<a id="the-runtime-store"></a>

## 运行时仓库

运行时仓库保存已安装的运行时发行包，并指明当前活动的那一个。每次命令行启动只运行一个运行时，即 `current` 所指的那个。

```text
runtimes/
  store.json              {"layout":1}
  current                 the active version and one newline
  previous                the version kept for rollback and one newline; absent before the first switch
  store.lock              taken by install, switch and removal
  <version>/              one complete, verified runtime closure
  delorun-<version>.manifest.json            the verified release manifest, beside its installation
  delorun-<version>-<platform>.files.json    the verified runtime file list
  delorun-<version>.manifest.log.json        the release-log bundle
```

- **版本名。** 目录名是 Delo 的发布版本：不带构建元数据的 SemVer 2.0，匹配 `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`，最多 64 个字符。
- **指针文件。** `current` 与 `previous` 保存 UTF-8 文本：恰好一个版本和一个换行符，最多 65 字节。替换指针的方法是：以独占创建方式、权限 0600 写入同级文件 `<pointer>.tmp-<16 hex>`，将其刷入磁盘，重命名覆盖指针，并在 Linux 与 macOS 上刷新 `runtimes/` 目录。从不使用符号链接，因为在 Windows 上创建符号链接需要特权，而运行中的 `node.exe` 会锁定其目录。
- **Windows 重命名。** 重命名报告 `EPERM`、`EBUSY` 或 `EACCES` 时，以退避方式重试，总计最多 2,000 毫秒。仍然失败的重命名以 `POINTER_REPLACE_FAILED` 停止，旧指针保持不变。
- **读取指针。** 读取方读取整个文件。缺失、为空、超长或格式错误的指针，或所指版本没有已安装目录的指针，都是 `NO_ACTIVE_RUNTIME`；此时启动器提供重新安装或回滚，从不自行挑选目录。
- **切换顺序。** 切换先把旧版本写入 `previous`，再把新版本写入 `current`，因此在两次写入之间被杀死的进程会让 `current` 仍指向完整的旧版本。
- **谁切换 `current`。** 只有四种事件切换它：不存在 `current` 时的首次安装；经由 [C19](c19-home-process.zh.md) 握手的更新；本人通过 [C19](c19-home-process.zh.md) 或 `delorun recover` 请求的回滚；以及 [C19](c19-home-process.zh.md) 在健康检查失败后的自动回滚。启动器从不自行切换 `current`，无论它比活动运行时新还是旧。
- **安装。** 安装获取 `store.lock`，最多等待 30 秒，之后以 `STORE_BUSY` 停止。它下载到 `~/.delo/staging/<16 hex>/`，该目录位于 `runtimes/` 之外、同一文件系统上，并执行 [C2](c02-release-manifest.zh.md) 的客户端校验：根与时间戳的遍历、manifest 的签名与新鲜度、发布日志 bundle 与在线检查（[C18](c18-release-log.zh.md)），以及归档与文件列表的摘要。它带路径检查地解压（不允许绝对路径、`..` 段、链接、设备文件以及文件列表之外的条目），按文件列表检查每个文件，然后把暂存目录重命名为 `runtimes/<version>/`，并把 manifest、文件列表与 bundle 放在其旁边。在全部检查通过之前，`runtimes/` 下不出现任何内容；失败的安装删除其暂存目录，不改动其他任何内容。
- **已安装文件。** 重命名之后，`<version>/` 下的目录权限为 0555，文件为 0444，可执行文件为 0555；在 Windows 上它们带只读属性。每次启动时启动器的哈希检查（[C2](c02-release-manifest.zh.md)）才是完整性控制；这些权限模式只防止意外写入。
- **保留。** 切换提交之后，仓库保留 `current` 与 `previous` 所指的版本及其发布文件，删除其他每个 `<version>/` 及其发布文件，以及 `staging/` 下没有安装占用的每个目录。失败的删除（例如 Windows 上仍在使用的目录）在下次启动时重试。同一时间最多存在两个版本和一个暂存目录。
- **回滚范围。** 运行时回滚不改动 `runtimes/` 之外的任何文件。从 profile 历史恢复 profile 是 [C3](c03-update-report.zh.md) 的步骤。

<a id="launcher-and-store-compatibility"></a>

## 启动器与仓库的兼容性

只有当启动器既理解仓库、又理解运行时的启动接口时，它才运行活动运行时。

- `store.json` 记录仓库布局编号，当前为 1。只有仓库的某个条目移动或改变含义时，布局编号才改变。
- 每个运行时的已签名 manifest（[C2](c02-release-manifest.zh.md)）记录其启动协议编号，当前为 1。启动协议规定运行时的入口文件、启动器传入的参数以及它设置的环境变量（`DSH_HOME`、`DELO_HOME`、`DELO_PROFILE`）。
- 启动器支持仓库的布局编号和运行时的启动协议编号时，才运行 `current`。否则它以 `RUNTIME_INCOMPATIBLE` 停止，给出两个编号；运行时较旧时提供更新流程，启动器较旧时提供启动器更新。它既不改动 `current`，也不改动仓库的任何其他文件。

<a id="the-npm-launcher-and-the-install-script"></a>

## npm 启动器与安装脚本

- **包中不含运行时。** npm 包 `delorun` 只是启动器。它没有运行时依赖，也不携带运行时发行包。
- **下载。** 安装某个版本时，启动器只通过 HTTPS 下载 [C2](c02-release-manifest.zh.md) 指定的发布文件：从 `releases.delorun.com` 下载根与时间戳，从 Delo 公开仓库的 GitHub Releases 下载 manifest、其 bundle、文件列表与对应平台的归档（`.tar.gz`，Windows 上为 `.zip`）。它只跟随指向 `github.com`、`objects.githubusercontent.com` 与 `release-assets.githubusercontent.com` 的重定向，对其他任何主机以 `DOWNLOAD_REFUSED` 拒绝。发布日志检查访问 [C18](c18-release-log.zh.md) 指定的主机。
- **下载限额。** 归档最多 1,073,741,824 字节（1 GiB），manifest 最多 4,194,304 字节（4 MiB）。30 秒内未建立的连接，或 60 秒内未传送任何字节的连接，会使下载失败。
- **安装前校验。** 启动器按已签名 manifest（[C2](c02-release-manifest.zh.md)）与该 manifest 在发布日志中的条目（[C18](c18-release-log.zh.md)）校验归档，且在 `runtimes/<version>/` 下出现任何文件之前完成，如[运行时仓库](#the-runtime-store)所述。
- **无网络时。** 启动器在离线哈希检查后运行已安装的 `current`。安装始终需要网络和日志收录证明。
- **信任锚。** `npx delorun` 在任何 Delo 检查能够运行之前，就运行 npm 提供的启动器，因此该启动器通过 npm 为其发布的构建证明获得信任，该证明把包与公开仓库的发布工作流关联起来（[C2](c02-release-manifest.zh.md)）。安装脚本通过其公布的哈希获得信任。
- **启动器副本。** 安装脚本把启动器写入 `bin/delorun`（Windows 上另有 `bin/delorun.cmd`），并把 `bin/` 加入本人的命令路径。`delorun start --at-login` 在安装登录项（[C19](c19-home-process.zh.md)）之前把正在运行的启动器复制到 `bin/`，因此登录项从不依赖 npm。

<a id="confinement-rules"></a>

## 限制规则

上游的沙箱方言只限制文件写入。Delo 的沙箱 profile 为在 `read-only` 或 `workspace-write` 下运行的每条命令添加下列规则。在 `danger-full-access` 下运行的命令（无论由本人设置还是作为提权获得批准）不受限制，本节的任何规则都不适用于它。

| 规则 | 受限命令不能 |
| --- | --- |
| `home-write` | 在 home 下创建、修改或删除任何内容 |
| `home-read` | 读取 home 下读取豁免之外的任何内容 |
| `token-read` | 读取启动令牌 |
| `home-connect` | 连接 home 各通道的套接字或管道 |
| `docker-connect` | 连接位于其真实路径的 Docker 套接字 |

- **读取豁免。** 受限命令可以读取并执行 `runtimes/`、`skills/` 与 `dsh-runtimes/`。PTC worker 与其他受限进程运行 `runtimes/` 中运行时自带的 `node`，命令运行 `skills/` 中本人的 skill 脚本，桌面应用的工作区依赖从 `dsh-runtimes/` 运行。豁免路径下不写入任何密钥；保存密钥的组件使用 `secrets/`。
- **可写根目录。** home 从不位于可写根目录之内。工作区根目录或附加可写根目录在解析符号链接后等于 home、位于其内或包含它时，`workspace-write` 以 `HOME_IN_WRITABLE_ROOT` 被拒绝。根目录包含 home 的工作区（例如 `~`）仍可运行 `read-only` 命令。
- **Docker 套接字。** 该套接字位于 home 之外。Delo 从当前 Docker context 解析其路径：rootful 引擎为 `/var/run/docker.sock`，rootless 引擎为 `$XDG_RUNTIME_DIR/docker.sock`，或 Docker Desktop 的 context 所指的路径。该规则同时覆盖 context 的路径及其解析后的真实路径、到达同一套接字的其他每个挂载（例如 WSL 下 Docker Desktop 的 `/mnt/wsl/docker-desktop-bind-mounts/<distro>/docker.sock`），以及 Docker Desktop 控制套接字目录中的每个套接字，Delo 把这些目录列为被拒绝的套接字目录：WSL 下为 `/mnt/wsl/docker-desktop/shared-sockets/host-services/`（其中 `backend.sock` 对所有用户可写，控制引擎的设置与重启）和 `/mnt/wsl/docker-desktop/shared-sockets/guest-services/`，Linux 上为 `~/.docker/desktop/`，macOS 上为 `~/Library/Containers/com.docker.docker/Data/` 与 `~/.docker/run/`。bwrap 隐藏每个这样的目录，因此之后在其中创建的套接字也被隐藏；Seatbelt 拒绝包装命令时其中存在的每个套接字。端点为 TCP 或 SSH 的 context 使用网络，而没有方言限制网络，因此对它不强制执行 `docker-connect`。
- **其他套接字。** 其他 `AF_UNIX` 套接字（例如 ssh-agent 套接字、D-Bus 与显示服务器）以及网络，对受限命令仍可访问。
- **探测。** 每次启动时，home 进程针对 `run/<profile>/probe/` 中的固定样例、它在那里打开的一个套接字以及 Docker 套接字路径，为每条规则运行一个受限探测命令，并记录结果。在 Linux 上，读取与连接探测还会通过本次启动时发现的 home 所在文件系统与 Docker 套接字的其他每个挂载运行（例如 WSLg 下根文件系统在 `/mnt/wslg/distro` 的第二个挂载），只有当其中每一个都被拒绝时，规则才是 `enforced`。当沙箱提供方把别名覆盖报告为 `unknown`（因为 home 或 Docker 套接字位于无法从挂载表找到其他挂载的文件系统上：btrfs、bcachefs 或 overlayfs）时，`delorun verify` 把 `home-read`、`token-read`、`home-connect` 与 `docker-connect` 报告为 `unknown`，原因为 `aliases-unknown`，setup 为 Docker 模式加上标注。`delorun verify` 通过 [C15](c15-verification-checks.zh.md) 的 `confinement-rule` 检查报告每条规则；只有当方言能表达某条规则、且本次启动时其探测被拒绝，才把该规则报告为 `enforced`。其他状态是 `not-enforced`（方言无法表达该规则、端点是网络端点，或该平台没有证明它的测试）、`unconfined`（没有沙箱运行，或模式为 `danger-full-access`）和 `unknown`（探测未运行，或因其他原因失败）。 每条沙箱规则的状态都映射为一个验证检查结果：`enforced` 为 `pass`，`not-enforced` 为 `not-enforced`，`unconfined` 为 `fail`，`unknown` 为 `unknown`。
- **标注 Docker 模式。** `docker-connect` 不是 `enforced` 时，`delorun verify` 会报告它，setup 的 Docker 模式选项附带这一说明：在此系统上，原生工作区中的命令可以连接 Docker，而 Docker 可以启动挂载此计算机文件的容器。
- **Landlock 与 rootful 引擎。** 方言为 Landlock、且当前 context 的端点是 rootful 引擎的套接字时，`delorun verify` 把 `docker-connect` 报告为 `not-enforced`，原因为 `dialect-cannot-express`，并给出该套接字的路径。setup（[C11](c11-setup-answers.zh.md)）给出同一路径，说明受限命令可以连接它、这在本机上等同于 root，并提供设置 Docker 的 rootless 引擎并把当前 context 切换到它的选项。
- **提权提示。** `danger-full-access` 提权的批准提示（无论是命令请求它，还是本人设置该模式）在本人批准之前说明：「完全访问让该命令可以读取 Delo 的 home（包括其中的密钥与令牌），并访问 Docker 监管器与更新通道。」该提示展示给本人，对模型不可见。

<a id="limits"></a>

## 限额

| 限额 | 值 |
| --- | --- |
| home 及 Delo 目录的权限模式 | 0700 |
| 受保护文件的权限模式 | 0600 |
| 套接字路径长度 | 最多 103 字节 |
| 启动令牌 | 32 个随机字节，43 个 base64url 字符 |
| Windows 管道名中的 `homeId` | 16 位十六进制数字 |
| 锁被视为无响应之前等待 `status` 回答的时间 | 2 秒 |
| 运行时版本名 | 最多 64 个字符 |
| 指针文件 | 最多 65 字节 |
| 等待 `store.lock` | 30 秒 |
| Windows 指针重命名重试 | 总计最多 2,000 毫秒 |
| 已安装运行时版本 | 最多 2 个，外加 1 个暂存目录 |
| 归档下载 | 最多 1 GiB |
| manifest 下载 | 最多 4 MiB |
| 下载连接 | 30 秒内建立，60 秒无字节即失败 |
| 仓库布局编号 | 1 |
| 启动协议编号 | 1 |

<a id="errors"></a>

## 错误

| 代码 | 含义 |
| --- | --- |
| `HOME_INVALID` | 解析出的 home 不是绝对路径，或是文件系统根目录或操作系统 home 目录 |
| `HOME_IS_DSH_HOME` | 解析出的 home 是上游的 `~/.dsh` 或位于其内 |
| `HOME_MODE` | home、`secrets/` 或 `run/<profile>/` 的权限宽于 0700、是符号链接或属于其他用户 |
| `SECRET_FILE_MODE` | 受保护文件的权限宽于 0600、是符号链接、不是普通文件或属于其他用户 |
| `SOCKET_PATH_TOO_LONG` | 某个通道的套接字路径超过 103 字节 |
| `HOME_IN_WRITABLE_ROOT` | 某个可写根目录等于 home、位于其内或包含它 |
| `HOME_RUNNING` | 该 profile 有一个存活的 home 进程持有锁 |
| `HOME_UNRESPONSIVE` | 锁记录的进程存在，但其更新通道未在 2 秒内回答 |
| `STORE_BUSY` | `store.lock` 在 30 秒内未释放 |
| `NO_ACTIVE_RUNTIME` | `current` 缺失、格式错误或所指版本未安装 |
| `POINTER_REPLACE_FAILED` | 指针重命名在重试后仍失败；旧指针保持不变 |
| `RUNTIME_INCOMPATIBLE` | 启动器不支持仓库的布局编号或运行时的启动协议编号 |
| `INSTALL_VERIFY_FAILED` | 安装期间摘要、签名、新鲜度、日志收录、路径或文件哈希检查失败 |
| `DOWNLOAD_REFUSED` | 下载重定向到列表之外的主机、超过大小限额或超时 |

<a id="consumers"></a>

## 使用方

- `delo/apps/cli`：`delorun` 命令与 CLI profile，经由 `delo/packages/home`。
- `delo/packages/home`：home 解析、home 目录树及其权限模式、按拒绝规则读写受保护文件，以及 home 锁。
- `delo/packages/integrity`：`delorun verify` 对权限模式与每条限制规则的检查。
- 上游的 `packages/sandbox/sandbox-local` 与 `packages/sandbox/sandbox`：各方言的 profile 与对可写根目录的拒绝。
- `delo/apps/install` 与 `delo/apps/npm-launcher`：下载、校验与启动器副本。
- `delo/packages/runtime-store`：仓库、指针文件、安装、切换与保留。
- `delo/packages/home-process`：经由 `delo/packages/home` 持有锁，以及启动令牌、更新通道的套接字与探测（[C19](c19-home-process.zh.md)）。
- `delo/packages/supervisor`：监管器的套接字及其令牌检查（[C9](c09-runtime-supervisor.zh.md)）。
- `delo/packages/home-auth`：`secrets/home-auth/` 下的密钥文件，经由 `delo/packages/home` 读写。

<a id="compatibility"></a>

## 兼容性

- 目录树只通过添加条目改变。移动、重命名条目或改变其含义，要么提高仓库布局编号，要么属于破坏性变更并在 `delo/docs/upgrade-guide/` 下附升级指南；做出该变更的运行时能读取两种形式。
- `DELO_HOME`、`DELO_PROFILE`、CLI profile 名称与通道路径是外部接口；改变其中任一项都是破坏性变更，需附升级指南。
- 上游的条目保留上游的布局与兼容性规则，包括其会话格式。
- 只有启动器传入的入口文件、参数或环境发生变化时，启动协议编号才提高。启动器支持它能安装的所有运行时的启动协议编号。
- 类型包跟随 Delo 的版本，并与本页在同一个拉取请求中修改。

<a id="security"></a>

## 安全

### 要求

1. home 的权限为 0700，其受保护文件为 0600。组件拒绝权限更宽、是符号链接或属于其他用户的受保护文件；home、`secrets/` 或 `run/<profile>/` 权限更宽时，home 进程拒绝启动。`delorun verify` 检查其中每一项，并打印 `chmod` 修复命令，Windows 上为 `icacls` 修复命令。
2. Delo 的密钥存放在 `secrets/` 下的文件中，在强制执行 `home-read` 的方言上，每种方言都拒绝读取该目录。上游的凭据文件位于 home 之下，适用同一规则。读取豁免路径、profile、patch 文件、命令的环境或命令行以及日志中都不写入任何密钥。
3. 在任何方言上，受限命令都不能写入 home 下的任何内容；在强制执行 `home-read` 的方言上，除读取豁免外，它也不能读取 home 下的任何内容。
4. 在强制执行 `home-connect` 与 `docker-connect` 的方言上，受限命令不能连接 home 的通道，也不能连接位于真实路径的 Docker 套接字。bwrap 在 home 上挂载一个空 tmpfs，并把 `/dev/null` 绑定到 Docker 套接字的真实路径上，从不绑定到其父目录，因为 `/run/user/<uid>/` 还存放着 ssh-agent 套接字。Seatbelt 拒绝对 home 的 `file-read*`，并拒绝对每个通道套接字与两个 Docker 套接字路径的 `remote unix-socket` 路径字面量的 `network-outbound`。Landlock 无法拒绝对路径名套接字的连接，因此在 Landlock 上 `home-connect` 与 `docker-connect` 报告为 `not-enforced`。
5. 在 Landlock 下，对 home 的读取拒绝使启动令牌不可读，因此受限命令可以连接任一通道，但其请求认证失败，`delorun verify` 会报告这一状态。
6. 两个通道只接受携带当前 home 进程启动令牌的请求；缺失的令牌、错误的令牌与之前某次启动的令牌一律被拒绝。令牌是来自操作系统随机源的 256 位值，从不记录到日志，也不通过命令行或环境传递，并以恒定时间比较。
7. 该保护依赖于对 agent 命令的限制。在沙箱外运行的本人用户进程可以读取令牌，也本来就可以自行运行 `delorun` 与 `docker`，本约定不声称能防范它。不存在 root 所有的辅助程序。
8. `danger-full-access` 下的命令不受限制；上述规则都不适用于它，`delorun verify` 对处于该模式的工作区报告 `unconfined`。该模式的批准提示说明，完全访问可以触及 Delo 的 home、其令牌、Docker 监管器与更新通道。
9. home 从不位于可写根目录之内；根目录等于 home、位于其内或包含它时，`workspace-write` 被拒绝。
10. 启动器从不自行切换 `current`。安装在 `runtimes/<version>/` 下出现任何文件之前，校验归档、manifest 的签名与新鲜度、其日志收录以及每个文件的哈希；指针只通过原子重命名替换。
11. Delo 从不读取或写入上游的 `~/.dsh`。
12. 在只有 Landlock、且 Docker 套接字为 rootful 的系统上，`delorun verify` 把该套接字报告为未强制执行，setup 给出它并提供 rootless 引擎。

### 拒绝测试

每个测试在其方言存在的每个 CI 平台上运行，只针对本地固定样例。

| 测试 | 证明 |
| --- | --- |
| `home-read-denied` | 在每种强制执行 `home-read` 的方言上，位于 `~` 工作区中的受限命令无法读取 `secrets/` 下的 home-auth 密钥样例与启动令牌，但能读取 `runtimes/` 下的文件 |
| `home-write-denied` | 在每种方言上，受限命令无法在 home 下创建、修改或删除文件 |
| `home-socket-connect-denied` | 在 bwrap 与 Seatbelt 上，受限命令连接 home 下的套接字失败，而连接 home 之外的 ssh-agent 套接字样例成功 |
| `docker-socket-connect-denied` | 在 bwrap 与 Seatbelt 上，受限命令连接位于 rootful 真实路径和 rootless 路径的 Docker 套接字失败，而与 rootless Docker 套接字同一目录中的 ssh-agent 套接字仍可访问 |
| `landlock-token-unreadable` | 在 Landlock 下，受限命令能连接两个通道，但无法读取启动令牌，两个通道都返回 `UNAUTHENTICATED`，`delorun verify` 把 `home-connect` 报告为 `not-enforced`、把 `token-read` 报告为 `enforced` |
| `not-enforced-reported` | 在无法表达 `docker-connect` 的方言样例上，`delorun verify` 把该规则报告为 `not-enforced`，setup 的 Docker 模式选项附带标注 |
| `secret-mode-refused` | 在设备密钥文件权限为 0640 的 home 样例中，读取组件以 `SECRET_FILE_MODE` 拒绝该文件，`delorun verify` 失败并给出修复命令 `chmod 600 <path>` |
| `home-mode-refused` | home 权限为 0755 时，home 进程以 `HOME_MODE` 拒绝启动，`delorun verify` 打印修复命令 `chmod 700 <path>` |
| `writable-root-refused` | 工作区根目录为 `~` 时，以及根目录位于 home 内时，`workspace-write` 以 `HOME_IN_WRITABLE_ROOT` 被拒绝，不运行任何命令 |
| `launcher-leaves-current` | 较新的启动器与较旧的启动器都使 `current` 与 `previous` 保持逐字节不变 |
| `pointer-switch-interrupted` | 在两次指针写入之前、之间与之后杀死执行切换的进程，`current` 都指向一个完整的已安装版本 |
| `install-verify-first` | 错误的签名、错误的文件哈希、缺失的日志条目以及含 `..` 的归档条目，都不会在 `runtimes/<version>/` 下留下任何内容，也不留下暂存目录 |
| `dsh-home-untouched` | 在继承了 `DSH_HOME` 的首次运行之后，`~/.dsh` 样例逐字节不变，且运行时以设为 Delo home 的 `DSH_HOME` 运行 |
| `windows-dacl-refused` | 在 Windows 上，DACL 允许 `Everyone` 的受保护文件以 `SECRET_FILE_MODE` 被拒绝，`delorun verify` 打印 `icacls` 修复命令 |
| `windows-pipe-connect-denied` | 在 Windows 的 windows-acl 下，受限命令无法以写方式打开任一通道的管道，也无法打开 Docker Desktop 的引擎管道 |
| `windows-home-read-label` | 在 Windows 的 windows-acl 下，home 带有 no-read-up 标签时，受限命令无法读取密钥样例与启动令牌，但能读取 `runtimes/` 下的文件；只有在这一拒绝成立的机器上，`delorun verify` 才把 `home-read` 报告为 `enforced` |
| `escalation-prompt-names-home` | 为一个 `danger-full-access` 提权样例渲染的批准提示包含如下说明：完全访问可以触及 Delo 的 home、其密钥与令牌、Docker 监管器与更新通道；提示被拒绝时命令仍受限制，其读取启动令牌的操作失败 |
| `landlock-rootful-docker-reported` | 在带 rootful Docker 套接字的 Landlock 样例上，`delorun verify` 把 `docker-connect` 报告为 `not-enforced` 并给出该套接字的路径，setup 的 Docker 步骤给出该路径并提供 rootless 引擎 |

### 本约定不能证明的内容

- **Landlock 与套接字。** Landlock 无法拒绝对路径名套接字的连接。在只有 Landlock 的系统上，受限命令能访问 rootful Docker 套接字，这等同于 root；`delorun verify` 会报告它，但在那里没有 Delo 机制能阻止它。home 的通道之所以仍然关闭，只是因为启动令牌不可读。
- **命令启动后重新创建的套接字。** bwrap 在包装命令时把 `/dev/null` 绑定到被拒绝套接字的路径上；之后在该路径上被删除并重新创建的套接字（例如 Docker 引擎重启之后）是一个新文件，绑定不覆盖它，因此之前已启动的命令不会被拒绝访问它。让受限命令长时间运行的组件（例如终端或后台任务）在被拒绝的套接字重新创建时重新包装或停止这些命令；该组件的契约承担这一要求。
- **隐藏其别名的文件系统。** 别名通过把路径在 `stat` 中的设备号与挂载表匹配来查找。btrfs 与 bcachefs 子卷以及 overlayfs 层报告的设备号，挂载表不会把它们与其他挂载对应起来，因此在这些文件系统上可能找不到别名；提供方在那里把别名覆盖报告为 `unknown`，依赖它的规则都不会显示为 `enforced`。以另一个设备号在别处暴露 home 的文件系统（例如 FUSE 镜像）在任何文件系统上都检测不到。
- **之后新增的挂载与链接。** profile 覆盖包装命令时已存在的、home 所在文件系统与每个被拒绝套接字的其他挂载。命令运行期间新增的挂载，以及在沙箱外为 home 下文件创建的硬链接，不在覆盖范围内。
- **Landlock 与 home 的上级目录。** Landlock 按目录树授予读取权限，因此 profile 授予从 `/` 到 home 路径旁的每个条目，而不是这些目录本身：受限命令不能列出 `/`、操作系统主目录或这条路径上的任何其他目录，命令启动后在其中新建的条目对它不可读。这些条目在包装命令时列出，因此在启动器应用规则集之前被删除的条目会让启动器拒绝运行；该命令不会运行，无论是否受限。
- **Windows 上的读取。** windows-acl 不限制读取。home 上的 no-read-up 标签只在 `windows-home-read-label` 通过时才报告为 `enforced`；该标签不成立时，Windows 上的 `home-read` 与 `token-read` 不被强制执行，通道只依靠 `windows-pipe-connect-denied` 所证明的命名管道写拒绝。
- **Windows 上的通道。** 在 Windows 上，通道是位于 home 文件系统目录树之外的命名管道；保护它们的只有其 DACL 与令牌。
- **经网络的 Docker。** 端点为 TCP 或 SSH 的 Docker context，在每种方言上都可被任何有网络访问的命令访问。
- **完全访问。** `danger-full-access` 下的命令可以读取 home 下的每个密钥与启动令牌，并能访问两个通道；提权提示会说明这一点，任何规则都不适用。
- **本人自己的进程。** 沙箱之外的本人用户进程可以读取和修改 home 下的一切；权限模式防范的是其他用户，而不是它。

<a id="enforcement-per-platform-and-dialect"></a>

## 各平台与方言的强制执行情况

`delorun verify` 按本表报告每条规则。标为强制执行的规则，只有在该机器上其启动探测被拒绝时才报告为 `enforced`；否则报告会说明原因。

| 规则 | bwrap（Linux） | Landlock（Linux） | Seatbelt（macOS） | windows-acl（Windows） | 无沙箱或 `danger-full-access` |
| --- | --- | --- | --- | --- | --- |
| `home-write` | enforced：home 未以可写方式绑定 | enforced：home 下没有写授权 | enforced：可写根目录之外 `deny file-write*` | enforced：低完整性令牌无法写入带标签的根目录之外 | unconfined |
| `home-read` | enforced：home 上覆盖空 tmpfs，豁免路径以只读方式绑定 | enforced：一个叠加的规则集，授权读取 home 之外和豁免路径 | enforced：对 home `deny file-read*`，允许豁免路径 | not-enforced：该方言不限制读取；机制是 home 上的 no-read-up 完整性标签，只在其拒绝测试通过时报告为 enforced | unconfined |
| `token-read` | enforced，同 `home-read` | enforced，同 `home-read` | enforced，同 `home-read` | not-enforced，同 `home-read` | unconfined |
| `home-connect` | enforced：套接字被 tmpfs 遮蔽 | not-enforced：Landlock 没有连接路径名套接字的权限项；令牌检查拒绝该请求 | enforced：`remote unix-socket` 路径字面量 | 在 `windows-pipe-connect-denied` 通过时 enforced：写受限的低完整性令牌无法以写方式打开管道 | unconfined |
| `docker-connect` | enforced：把 `/dev/null` 绑定到套接字真实路径上 | not-enforced | enforced：context 路径与真实路径的路径字面量 | 在 `windows-pipe-connect-denied` 通过时 enforced，针对 Docker Desktop 的引擎管道 | unconfined |
| 经 TCP 或 SSH 的 Docker | not-enforced | not-enforced | not-enforced | not-enforced | unconfined |
| 其他 `AF_UNIX` 套接字与网络 | 可访问 | 可访问 | 可访问 | 可访问 | 可访问 |

- **没有 bwrap 的 Linux。** 无法使用非特权用户命名空间时，bwrap 的探测失败，上游的提供方选择 Landlock。二者都不可用时，上游的提供方拒绝运行受限命令；对本人以 `danger-full-access` 运行的工作区，每条规则都显示为 `unconfined`。
- **Landlock 授权。** 叠加的规则集为从 `/` 到 home 路径上的每个同级条目授权，因此在受限命令运行期间直接在 home 某个祖先目录中创建的文件，对该命令不可读。
- **macOS 路径。** Seatbelt 匹配解析后的路径，因此 profile 用 `/private/var/...` 表示 `/var/...`，并同时列出 Docker Desktop 的 context 路径及其真实路径。
- **WSL2。** WSL2 中的 Delo 就是 Linux，适用 Linux 各列。Windows 主机上的进程位于沙箱之外。
