---
description: "Delorun 各种运行方式下的平台信任：哪些命令带有 Delorun 的保护、原生沙箱在各平台上强制什么、尚未构建的 Docker 工作区与 reach、自托管 home，以及每一项与 stock DSH 的对比。"
---

# 每种执行向量的信任

[English](execution-vectors.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

Delorun 尚未发布；本页描述本仓库中的代码。它说明 Delorun 的每种运行方式强制了什么、不能强制什么，以及与同版本 stock DSH 的对比。

[威胁模型](threat-model.zh.md) 给出各方、资产与每道防线及其契约；本页是执行侧的视图。[信任指南](../guide/safety-and-updates/trust.zh.md) 说明每一方能看到或做什么。

## 向量

姿态由三件事决定：**哪个命令启动 Host**、**模型命令在哪里运行**（执行向量）和 **谁能访问 studio**（reach 向量）。

Delorun 的保护位于 CLI profile 中，该 profile 由 `delorun setup` 创建、由 `delorun` 或 `delorun start` 启动：上游的 web 模板加上 `@delorun/bundle-local` 与 `@delorun/bundle-studio`。`delorun headless` 启动 home 的 `headless` profile，即上游的 `headless` 模板加上 `@delorun/bundle-headless`：沙箱 overlay、fetch 守卫、指令写入同意、MCP 与定时任务同意、完全访问同意以及回合闸门，均免受插件管理的修改，且会话日志上传关闭。在那里，需要询问本人的守卫会拒绝；对于没有授权的工作目录，完全访问会被拒绝——授权须在 home 的电脑上记录，在 studio 中或使用 `delorun workspace full-access`。`delorun plugin` 运行上游自己的 pnpm 操作，不含 Delorun 的任何行。桌面应用是上游的，未作改动。

| 执行向量 | 在那里运行什么 | 由什么强制 | 已构建 |
| --- | --- | --- | --- |
| 原生工作区 | 命令直接在你的账户中运行，由操作系统限制 | Linux 上的 bwrap 或 Landlock、macOS 上的 Seatbelt：由内核拒绝，而不是工具。在 Windows 上，ACL runner 只限制写入 | 是 |
| Docker 工作区（S2） | 命令在每工作区一个容器中运行 | [C9](../contracts/c09-runtime-supervisor.zh.md) 的监管器 | 否：监管器已构建，但没有命令启动它 |
| reach 监听器，你自己的 tailnet | 设备会话在你的 Tailscale 地址上可使用的路由 | 已批准设备的密钥，加上 [C4](../contracts/c04-admission.zh.md) 的准入与 [reach 设计](../design/reach.zh.md) | 是，在你开启之前关闭 |
| reach 监听器，自托管中继 | 同一组路由，位于你自己的域名上 | [C6](../contracts/c06-relay-protocol.zh.md) 的中继与 C4 的准入 | 否：中继的服务端已构建，但没有 home 连接它 |

**自托管 home** 不是独立向量：它是你自己机器上的同一个 home 目录。

## 各项保证，按命令

各行是一个人对原生工作区合理期待的保证。“Stock”指同版本的 stock DSH；CLI profile 一列适用于 `delorun` 与 `delorun start`。

| 保证 | Stock | Delorun，CLI profile | `delorun headless` |
| --- | --- | --- | --- |
| 受限命令不能写到其可写根之外 | 是 | 是 | 是 |
| 受限命令不能写入 Delorun 的 home 之下 | 否 | 是 | 是 |
| 受限命令不能读取 Delorun 的 home（密钥、令牌、凭据） | 否 | 在 Linux 与 macOS 上是；在 Windows 上否 | 与 CLI profile 相同 |
| 受限命令不能读取你账户的其余部分（`~/.ssh`、`~/.aws`、`/etc`） | 否 | 否，与 stock 一致 | 否 |
| 受限命令不能访问网络 | 否 | 否，与 stock 一致 | 否 |
| 受限命令不能连接 Docker socket | 否 | 在 bwrap 与 Seatbelt 上对当前上下文的 socket 是；在 Landlock 与 Windows 上否 | 与 CLI profile 相同 |
| 受限命令不能通过 WSL 的互操作套接字启动 Windows 程序 | 否 | 在 WSL 下的 bwrap 上是；在 Landlock 上，只要互操作存在，每个受限命令都会被拒绝 | 与 CLI profile 相同 |
| 受限命令不能通过你会话的服务（`systemd-run --user`、会话总线或系统总线、tmux 或 screen 服务器、X 服务器）在沙箱之外启动程序 | 否 | 在 bwrap 与 Seatbelt 上，对其默认套接字是；在 Landlock 上，只要其中一个目录存在，每个受限命令都会被拒绝；X 服务器的抽象套接字以及位于抽象地址的会话总线仍可访问 | 与 CLI profile 相同 |
| 受限命令不能使用你的 ssh-agent | 否 | 在 bwrap 与 Seatbelt 上，对启动时 `SSH_AUTH_SOCK` 所指的代理，以及 `/tmp` 与运行时目录下的代理是；在 Landlock 上否 | 与 CLI profile 相同 |
| harness 汇总回合的变更文件时，受限命令在仓库的 git 设置、属性或钩子中指定的程序绝不会在沙箱之外运行 | 否 | 是 | 不适用：未挂载变更汇总 |
| `web_fetch` 拒绝回环、链路本地与私有网络目标 | 否 | 是 | 是 |
| 模型对指令文件的写入需要一次说明效果的批准 | 否 | 仅限经由文件工具；shell 命令或 PTC 代码的写入不需要它 | 仅限经由文件工具，且该写入会被拒绝，因为无人能答复 |
| 对话不能通过 `plugin_manager` 关闭、重新配置或移除 Delorun 的守卫 | 否 | 是，依据 profile 组合后的行判断；完全访问命令仍可编辑 profile 的文件 | 否 |
| 新的 stdio MCP 服务器需要本人同意 | 否 | 新的 stdio 服务器会被暂停并写明其命令，直到本人在主机的电脑上通过工作室的「设置 > 权限」或 `delorun mcp accept` 接受它，之后它无需重启即可启动；在同一处或用 `delorun mcp revoke` 撤销该接受会让它再次停止 | 否 |
| 目标对话的权限预设已改变时，定时投递会被拒绝 | 否 | 是 | 否 |
| 把工作区切换到完全访问需要本人同意 | 否 | 在本人于 home 的电脑上为该工作区授权之前，切换会被拒绝，授权在 studio 的同意中或使用 `delorun workspace full-access`；按调用的升级仍经过上游的审批 | 对于没有已记录授权的工作目录，通过选项或变量请求的完全访问会在启动之前被拒绝 |
| 发布在运行前完成签名校验 | 否 | 是，当 npm 启动器启动它时：每次启动都校验每个已安装文件 | 是，与 CLI profile 相同 |
| 更新会报告、快照并可回滚 | 否：静默禁用不兼容插件 | 是，对 CLI home 通过 `delorun update` | 不适用 |
| 归档是封闭数据格式，从不求值代码 | 否：用 `new Function` 求值 `!!js` | 是 | 是：`delorun import` 是同一个命令 |
| 默认安装不发送关于你的任何数据 | 否：默认开启会话日志上传与产品分析 | 是 | 是：会话日志上传关闭 |
| 插件由 Delorun 固定版本、校验完整性并可撤销 | 否 | 否：目录与撤销列表尚未构建 | 否 |

## 组合

- **原生，CLI profile。** 操作系统沙箱就是边界。在 Linux 与 macOS 上 home 对命令隐藏；账户其余部分与网络不隐藏，与 stock 完全相同。在 Windows 上命令可以读取 home。
- **原生，`delorun headless`。** CLI profile 的沙箱 overlay、fetch 守卫、指令写入同意、完全访问同意与隐私默认值适用；MCP 与定时任务同意没有可守卫的对象，因为该 profile 不挂载 MCP 客户端，也不挂载定时任务运行时。
- **Docker 工作区与 reach。** Docker 工作区尚未构建，reach 只构建了 Tailscale 私有路由。它们的规则见 [C9](../contracts/c09-runtime-supervisor.zh.md)、[reach 设计](../design/reach.zh.md) 及其列出的约定，每份都带有说明已存在内容的状态。
- **自托管 home，仅本地。** 除回环 studio 之外不打开任何监听器，除你主动要求的以外没有任何东西离开机器：模型请求、你启用的工具以及发布检查。

## 自托管

自托管 home 是你在自己拥有并运维的机器上的 home 目录（`~/.delorun`）。这对信任意味着：

- **密钥在你手里。** 模型凭据在你的机器上；Delo Run 无法访问。发布与发布日志主机会获知你的 IP 地址与你请求的版本，仅此而已。
- **操作系统由你负责。** 文件权限、全盘加密、备份以及谁能登录都归你。Delorun 的保护是 Linux 与 macOS 上 home 的 0700 与 0600 布局，加上 CLI profile 中沙箱的受保护 home 规则；它不是磁盘加密，也不防御你以同一用户运行的程序。
- **更新决定由你做。** `delorun update` 报告更新将改变什么，在你确认之前不应用任何内容；它对 profile 做快照，并在新发布未通过健康检查时回滚。签名校验不依赖提供文件的主机。
- **你可以自己核查。** `delorun verify` 报告已安装发布的签名、其发布日志状态及其文件。它把其他检查（包括限制规则）报告为未运行。

## 与 stock DSH 对比

Delorun 是加了 Delorun 层的 stock DSH。在限制方面两者是同一机制，Delorun 的沙箱就是上游的，因此差异就是 Delorun 层新增的那些：

| | Stock | Delorun | 位置 |
| --- | --- | --- | --- |
| home 保护 | 没有任何机制向受限命令隐藏 home | 在 CLI profile 中，home 对进程内工具是受保护读取，在 Linux 与 macOS 上对受限命令也是 | [C1](../contracts/c01-home-layout.zh.md) |
| Reach | 无 | 仅 Tailscale 私有，在本人开启之前关闭；没有 Funnel、中继或通行密钥 | [reach 设计](../design/reach.zh.md) |
| 权限同意 | 无 | 在 CLI profile 中：按工作区的完全访问同意、文件工具写入的指令层同意、新的 stdio MCP 服务器同意、定时任务同意以及 fetch 守卫；在 parity 组合中关闭 | [C16](../contracts/c16-parity-composition.zh.md) |
| 发布 | 无校验 | 运行前校验签名、新鲜度、发布日志与文件列表 | [C2](../contracts/c02-release-manifest.zh.md)、[C18](../contracts/c18-release-log.zh.md) |
| 更新 | 静默禁用与重写 | 对 CLI home 报告、快照、恢复与回滚 | [C3](../contracts/c03-update-report.zh.md) |
| 归档 | 加载时求值 `!!js` | 封闭数据格式，不求值 | [C8](../contracts/c08-archive-and-trash.zh.md) |
| 隐私默认 | 会话日志上传与产品分析默认开启 | 在 CLI profile 中两者都关；在 `delorun headless` 下会话日志上传关闭 | [C11](../contracts/c11-setup-answers.zh.md) |
| 插件 | 不固定版本、无沙箱 | 相同：除上游的锁文件外 Delorun 不固定任何内容，撤销列表尚未构建 | [C13](../contracts/c13-catalogue-revocation.zh.md) |

## 任何向量都不能防护的情况

以下限制在所有向量中都成立，在此明示而非隐含：

- **以你的用户运行的程序。** 它能读取 `~/.delorun`、凭据文件、会话日志与其余一切。这就是操作系统账户的含义。
- **被攻陷的操作系统，或持有你账户的实时攻击者。** 同类。
- **没有任何静态加密。** Delorun 的存储在 0700 与 0600 下是明文；全盘加密由你控制。
- **获得批准的模型动作。** 批准说明会发生什么；一旦批准，动作就会发生。同意约束的是能请求什么，而不是已批准的动作是否明智。
- **插件。** 插件以你的权限作为受信任代码运行。安装它即授予该权限。
- **通过命令的网络出口。** fetch 守卫管的是 `web_fetch`；shell 命令可以访问网络。
- **远端主机获知的信息。** 模型提供方看到你的请求；发布与发布日志主机看到你的 IP 地址与版本。
