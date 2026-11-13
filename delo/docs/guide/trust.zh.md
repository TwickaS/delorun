---
description: "你使用 Delo 时信任什么：什么在你的电脑上运行，Delo Run 能看到和做到什么、不能做什么，每个远程访问选项向其提供方展示什么，默认离开你机器的内容与仅在你选择时才离开的内容，以及如何自行核查。"
---

# 你使用 Delo 时信任什么

[English](trust.md) | 中文

Delo 尚无正式发布；本页描述首个发布版本。

## 摘要

Delo 在你的电脑上、以你自己的用户账户运行。Delo 的约定要求 Delo Run（即背后的项目）不能自行访问你的 studio。Delo 也没有自身的遥测。Delo 的约定要求默认运行的完整性检查不发送个人数据，并要求其他所有网络功能只有在你选择后才会开启。本页说明每一方能看到什么、能做什么；[威胁模型](../security/threat-model.zh.md)给出每项防护、其约定与限制。

## 目录

- [什么在你的电脑上运行](#what-runs-on-your-computer)
- [Delo Run 能做什么、不能做什么](#what-delo-run-can-and-cannot-do)
- [每个远程访问选项向其提供方展示什么](#what-each-reach-option-shows-its-provider)
- [什么会离开你的机器](#what-leaves-your-machine)
- [自行核查](#checking-it-yourself)
- [报告问题](#reporting-a-problem)

<a id="what-runs-on-your-computer"></a>
## 什么在你的电脑上运行

- studio、harness 与其插件以你的操作系统用户身份运行，拥有该用户的访问权限。以同一用户运行的任何程序都能读取 `~/.delo` 下的全部内容，Delo 不防范此类程序。
- 原生工作区中模型运行的命令，以你自己的访问权限运行。Delo 的约定要求：在你的系统能够强制执行的范围内，这些命令不能写入 Delo 的 home，不能读取 Delo 的密钥和令牌，也不能连接其控制套接字与 Docker 套接字。`delorun verify` 会报告你的系统实际强制执行了哪些规则。其他 Unix 套接字对命令保持开放；除非你把工作区的网络设为 `allowlist` 或 `off`，网络也同样开放（[提示词注入与数据外泄](prompt-injection.zh.md)）。
- Docker 工作区运行在容器中。Delo 的约定提供两种形式：每个工作区一个容器，使每个工作区与你的电脑及其他工作区相互隔离；或所有工作区共用一个容器，使你的电脑与工作区相互隔离，但工作区之间不隔离。

<a id="what-delo-run-can-and-cannot-do"></a>
## Delo Run 能做什么、不能做什么

Delo Run 发布 Delo 的版本、插件索引及其撤销列表、文档网站和候补名单。

Delo Run 能够：

- 发布一个你可以安装的版本。在你确认更新前，没有客户端会安装它；也没有客户端会自行降级。
- 对每个版本签名并将其记入公开日志，对插件索引及其撤销列表签名。
- 通过撤销列表停用某个插件版本。Delo 的约定要求：被撤销的版本在下次加载时被停用，附带原因，并记入 profile 历史。已经在运行的插件会继续运行，直到 Delo 再次加载它。

根据 Delo 的约定，Delo Run 不能：

- 自行访问你的 studio。Tailscale 远程访问与自托管中继不经过 Delo 的基础设施，Delo 不持有 studio 的 TLS 密钥，也不持有设备密钥。
- 替你批准设备、指挥你的机器，或更改你电脑上固定的插件版本。
- 审计插件。插件索引条目所列的发现，是其作者或审阅者的主张，Delo 不予核实。

你仍然需要信任：

- Delo Run 的版本、插件索引与撤销列表，以及提供这些内容的 `delorun.com` 域名。
- 上游 DeepSeek Harness 的代码，Delo 在指定版本上运行它。
- 你的身份提供方（如果你通过它登录）。控制你在该提供方账户的一方可以通过身份检查，但设备批准仍然适用。

<a id="what-each-reach-option-shows-its-provider"></a>
## 每个远程访问选项向其提供方展示什么

Delo 的约定要求没有任何远程访问选项使用 Delo 的基础设施。远程访问在你开启前处于关闭状态，Delo 的约定要求每个选项在开启前显示其说明。

| 远程访问选项 | 提供方能看到或做到什么 |
| --- | --- |
| Tailscale 私有 | 只有你 tailnet 中的设备能打开该地址。Tailscale 的协调服务能看到你的 home 名称、你的 home 与每台设备的 IP 地址、连接时间与流量大小。除非开启 Tailnet Lock，Tailscale 可以向你的 tailnet 添加设备。Tailscale 控制 `ts.net` 并为该地址获取证书，因此任何应用都无法固定其 TLS 密钥。 |
| Tailscale Funnel | 互联网上任何人都能打开该地址。Tailscale 的 Funnel 服务器与协调服务能看到你的 home 名称、你的 home 与每台连接设备的 IP 地址、连接时间与流量大小。Funnel 把加密流量转交给你的 home，由 Tailscale 的软件在那里终止 TLS。除非开启 Tailnet Lock，Tailscale 可以向你的 tailnet 添加设备，并为该地址获取证书。 |
| 你自己域名上的自托管中继 | 你的中继能看到该地址的名称、你的 home 与每台连接设备的 IP 地址、连接时间与流量大小。它可以拒绝或断开连接，并强制重新绑定某个名称。它转交其无法读取的加密流量，TLS 在你的 home 上终止。只有当你域名的 CAA 记录仅允许你的 home 的 Let's Encrypt 账户获取证书、且你的 home 自行应答证书挑战时，流量才保持端到端加密。Let's Encrypt 与你的 DNS 提供方仍可能影响你域名的证书。你的 home 会查询公开证书日志，这些日志能看到你的 home 的 IP 地址与域名。 |

Delo 的约定要求每个选项还需要你的通行密钥或登录提供方，并且每台新设备都需要获得你已信任的设备的批准。

<a id="what-leaves-your-machine"></a>
## 什么会离开你的机器

### 默认情况

Delo 的约定要求以下完整性检查默认运行。它们不含个人数据，但每个请求都会向其所访问的主机透露你的 IP 地址、请求时间和 Delo 版本。

- 每次启动时进行的发布日志检查，访问 Sigstore 的公开发布日志及其检查点分发服务。
- 插件撤销列表，来自 `catalogue.delorun.com`，在 home 每次启动时以及运行期间每 6 小时获取一次。
- 更新检查，获取 Delo 的已签名发布元数据。

这些检查所获取的每个文件都经签名验证，因此提供被篡改文件的主机会导致检查失败。

Delo 的约定要求 `integrity.mode: off` 关闭发布日志检查与撤销列表。已安装版本的离线检查仍会在每次启动时运行，失败时仍会阻止启动。撤销列表关闭后，它会在 24 小时后过期：插件索引的安装暂停，已安装的插件继续加载。

Docker 工作区会拉取镜像，自有域名远程访问会查询公开证书日志。Delo 的约定要求这些仅在你选择该功能时发生。

### 仅在你选择时

Delo 的约定要求 Setup 的 `--yes` 与 `--config` 形式从不开启远程访问或上游的任一可选开关。

- **上游的桌面分析**在首个发布版本中默认关闭。开启后，桌面应用会把产品使用事件发送到上游配置所指定的收集端。
- **DeepSeek 的会话日志上传**在首个发布版本中默认关闭。开启后，每个发往 DeepSeek 官方 API 的请求都会在 `dsh_session_log` 字段中携带你会话日志的一段增量内容。
- **反馈**仅在你发送时离开你的机器。反馈对话框在你发送前会显示其内容（包括会话日志前缀）及其目的地。
- **模型请求**发往你配置的模型提供方，携带每个回合中模型所接收的内容。
- **远程访问**按上表所述，向你选择的提供方发送流量。

<a id="checking-it-yourself"></a>
## 自行核查

- Delo 的约定要求 `delorun verify` 检查 home 的发布版本、文件、隔离、暴露、登录、插件与数据共享，并报告你的系统无法强制执行的项目。每份报告都会说明，以你身份运行的程序可以更改这些检查。
- Delo 的约定要求 `delorun logs` 显示每个运行日志、其位置与记录。Delo 自身的记录不含密钥、聊天文本、提示、模型输出、工具参数或文件内容。命令的捕获输出仍可能包含聊天与文件文本，直到保留期限将其删除。Delo 运行期间，日志在写入 14 天后被删除。
- npm 在任何 Delo 检查运行之前就提供 `delorun` 启动器，因此请通过带外方式核查它。`delorun verify` 会打印一行 `Launcher`，给出已安装发布版本的签名清单为你所运行的启动器记录的完整性值；请将其与 `npm view delorun@<version> dist.integrity` 的输出比较。Delo Run 在 README、本页、每个发布版本的说明以及 `delo/release/production-keys.json` 中公布每个发布根文件的 SHA-256 及其密钥 id；请将它们与启动器包 `roots/` 目录下的根文件比较。目前尚未公布任何发布根。Setup 按你所运行的版本安装 `delorun` 命令，从不安装 npm 提供的最新版本。
- [威胁模型](../security/threat-model.zh.md)列出每个边界、其防护，以及 Delo 不防范的内容。

<a id="reporting-a-problem"></a>
## 报告问题

请按 [SECURITY.md](../../../SECURITY.md) 所述私下报告疑似漏洞，不要公开提交 issue。其他问题请发送至 support@delorun.com。
