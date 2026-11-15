---
description: "在每条命令和每个平台上的原生约束的设计：Delorun 在 Host 的每种启动方式下的保护，每次启动时的探测以及 delorun verify 的约束和 home 模式检查，完全访问提示的措辞，Docker Desktop 的控制套接字，Windows，以及模型通过命令对指令文件的写入。"
---

# 在每条命令和每个平台上的原生约束

[English](native-confinement.md) | 中文

## 摘要

[约定 C1](../contracts/c01-home-layout.zh.md) 陈述了 Delorun 在上游沙箱之上增加的约束规则，以及每种方言今天强制执行什么。本页给出 Delorun 为尚未构建的约束所采纳的规则：在每条启动 Host 的命令下的同样保护、每次启动时检查每条规则在这台机器上是否成立、指出完全访问触及什么的完全访问提示、Docker Desktop 的控制套接字、Windows，以及针对命令所做写入的指令同意。[威胁模型](../security/threat-model.zh.md)陈述了今天什么成立。

## 目录

- [今天已有的内容](#what-exists-today)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [实现状态](#implementation-status)

## 今天已有的内容

- 只有由 `delorun setup` 创建、由 `delorun` 或 `delorun start` 启动的 CLI profile，具备 Delorun 的保护：上游沙箱行上受保护的 home、`delorun start` 写入 `run/<profile>/sandbox.patch.yml` 的被拒绝的套接字、各项同意、获取防护以及隐私默认值（见 [bundle-local](../../packages/bundle-local/README.zh.md)）。
- `delorun plugin` 运行上游自己的 pnpm 操作。`delorun headless` 在沙箱覆盖层之下，带着 `@delorun/bundle-headless` 启动 home 的 `headless` profile，所以它的受限命令获得 CLI profile 的规则，获取防护、指令写入、MCP 和计划同意、完全访问同意以及隐私默认值都适用，并且组合会拒绝没有该 bundle 的 `headless` profile。
- bwrap、Landlock 和 Seatbelt 禁止受限命令在 home 之下写入，也禁止在其之下读取（`runtimes/`、`skills/` 和 `dsh-runtimes/` 除外）。bwrap 和 Seatbelt 禁止连接到更新渠道的套接字，以及 Docker 上下文的套接字（按其路径和真实路径）；Landlock 无法表达套接字规则。
- windows-acl 只约束写入。它不约束读取，不增加套接字或管道规则，并且 home 的模式检查在 Windows 上被跳过。更新渠道在每个平台上都是文件系统套接字；不存在命名管道。
- `delorun start` 不运行任何约束探测。`delorun verify` 把 `confinement-rule` 和 `home-modes` 检查报告为未运行。
- 完全访问的提示是上游的逐次调用批准提示，它指出所请求的模式和操作，而不指出 Delorun 的 home。[`@delorun/plugin-permission-defaults`](../../packages/plugin-permission-defaults/README.zh.md) 的按工作区的完全访问同意，是在 home 所在的电脑上询问的：当此人选择完全访问时由 studio 询问，从请求完全访问的批准卡片中询问，或在“设置”→“权限”中询问，以及由 `delorun workspace full-access` 询问；它的措辞说明完全访问会触及带有密钥和令牌的 Delorun home、Docker 监管器和更新渠道。
- 指令同意审阅文件工具所做的写入。`workspace-write` 下的 shell 命令或 PTC 代码，会在可写根之内写入 `AGENTS.md`、skill 或预设，而没有这种审阅。
- `delorun start` 在 WSL 下和 Linux 上，把 Docker Desktop 的控制套接字目录作为逃逸套接字目录隐藏起来（[C1](../contracts/c01-home-layout.zh.md#confinement-rules)），并且不把它的 macOS 控制目录传给提供方。

## 规则

### Host 的每种启动方式

1. 每条启动 Host 的 `delorun` 命令（包括 `delorun headless`），都组合与 CLI profile 相同的 Delorun 层，或者拒绝启动并指出缺少什么。在没有受保护的 home、被拒绝的套接字、各项同意、获取防护和隐私默认值的情况下启动的 Host，是一次失败的启动，而不是一条警告。

### 每次启动时的检查

2. 每次启动时，home 进程对每条规则（`home-write`、`home-read`、`token-read`、`home-connect`、`docker-connect`）运行一次受限探测，探测对象是 `run/<profile>/probe/` 中的 fixture、它在那里打开的套接字以及 Docker 套接字路径。在 Linux 上，读取和连接探测还会通过 home 的文件系统和 Docker 套接字的每一个其他挂载点运行，只有当每一次探测都被拒绝时，规则才是 `enforced`。
3. `delorun verify` 通过 [C15](../contracts/c15-verification-checks.zh.md) 的 `confinement-rule` 检查报告每条规则：只有当方言能表达该规则且它的探测在这次启动时被拒绝，才是 `enforced`（`pass`）；当方言无法表达它、端点是网络端点或平台没有证明它的测试时，是 `not-enforced`；当没有沙箱在运行或模式是 `danger-full-access` 时，是 `unconfined`（`fail`）；当探测没有运行或别名覆盖情况未知时，是 `unknown`。
4. `delorun verify` 运行 `home-modes` 检查：home 的模式、每个 Delorun 目录的模式和每个受保护文件的模式，并为每条更宽松的路径给出 `chmod` 修复办法，在 Windows 上则给出 `icacls` 修复办法。
5. 当 `docker-connect` 不是 `enforced` 时，`delorun verify` 会连同套接字的路径一起这样说明，setup 的 Docker 选项也会说明原生工作区中的命令可以连接到 Docker，而 Docker 可以挂载这台电脑的文件来启动容器。在使用 Landlock 和 rootful 引擎时，setup 提供 Docker 的 rootless 引擎。

### 完全访问

6. 对 `danger-full-access` 升级的批准提示，无论是命令请求它还是此人设置模式，都会在此人回答之前说明：“Full access lets this command read Delorun's home, including its keys and tokens, and reach the Docker supervisor and the update channel.”该提示显示给此人，对模型不可见。
7. 按工作区的完全访问同意有一个询问它的界面，所以一个人可以为一个工作区授予完全访问并撤回它。

### Docker Desktop 的控制套接字

8. `delorun start` 把 Docker Desktop 的 macOS 控制套接字目录 `~/Library/Containers/com.docker.docker/Data/` 和 `~/.docker/run/` 作为被拒绝的套接字目录传入。

### Windows

9. 受保护的文件或目录，如果其 DACL 允许此人、`SYSTEM` 或 `BUILTIN\Administrators` 之外的任何 SID，就会以 `SECRET_FILE_MODE` 或 `HOME_MODE` 被拒绝，并附上 `icacls` 修复办法。
10. 通道是命名管道 `\\.\pipe\delorun-<homeId>-<profile>-update` 和 `\\.\pipe\delorun-<homeId>-<profile>-supervisor`，各自创建时带有只授予此人 SID 并拒绝远程客户端的 DACL，并且受限令牌无法以写入方式打开它们。
11. home 上的禁止向上读取的完整性标签禁止受限命令在其之下读取，并且只有在该禁止得到证明的机器上，`delorun verify` 才把 `home-read` 和 `token-read` 报告为 `enforced`。

### 指令文件

12. 每一次模型编写的对指令层文件（`AGENTS.md`、skill 或预设）的写入，无论是由文件工具、shell 命令还是 PTC 代码所做，都需要指令同意的批准，该批准指出效果并显示差异。

## 本设计不防护什么

- **Landlock 与套接字。**Landlock 无法拒绝对路径名套接字的连接；在有 rootful Docker 套接字的情况下，受限命令可以访问引擎，这等同于 root。在这样的系统上，报告和 rootless 的提议是仅有的补救办法。
- **网络和其他套接字。**受限命令在每种方言上都可以访问网络、[C1](../contracts/c01-home-layout.zh.md#confinement-rules) 所隐藏的目录之外的路径名套接字，以及抽象套接字。
- **完全访问。**`danger-full-access` 下的命令不受约束地运行；提示说明它触及什么，没有任何规则适用。
- **同一用户的进程。**以此人身份在沙箱之外运行的程序，可以读取和更改 home、探测和检查。

## 拒绝测试

| 测试 | 证明什么 |
| --- | --- |
| `headless boots with Delorun's layer or not at all` | 缺少 `@delorun/bundle-headless` 的 `delorun headless` 拒绝启动；有它时，受限命令无法读取 home 之下的 fixture 密钥，stdio MCP 服务器被拒绝。 |
| `landlock-token-unreadable` | 在 Landlock 下，受限命令连接到更新渠道，读取启动令牌失败，收到 `UNAUTHENTICATED`，并且 `delorun verify` 把 `home-connect` 报告为 `not-enforced`，把 `token-read` 报告为 `enforced`。 |
| `not-enforced-reported` | 在无法表达 `docker-connect` 的 fixture 方言上，`delorun verify` 把该规则报告为 `not-enforced`，并且 setup 的 Docker 选项带有该标签。 |
| `home-mode-reported` | 当受保护文件的模式为 0640 时，`delorun verify` 让 `home-modes` 失败，并给出修复办法 `chmod 600 <path>`。 |
| `windows-dacl-refused` | 在 Windows 上，DACL 允许 `Everyone` 的受保护文件以 `SECRET_FILE_MODE` 被拒绝，并且 `delorun verify` 打印 `icacls` 修复办法。 |
| `windows-pipe-connect-denied` | 在 Windows 的 windows-acl 下，受限命令无法以写入方式打开任一通道的管道或 Docker Desktop 的引擎管道。 |
| `windows-home-read-label` | 在 Windows 的 windows-acl 下，home 上带有禁止向上读取的标签时，受限命令读取 fixture 密钥和启动令牌失败，而读取 `runtimes/` 下的文件成功。 |
| `escalation-prompt-names-home` | 对 fixture `danger-full-access` 升级的批准提示包含规则 6 的声明；被拒绝的提示让命令保持受限，并且它读取启动令牌失败。 |
| `landlock-rootful-docker-reported` | 在带有 rootful Docker 套接字的 Landlock fixture 上，`delorun verify` 把 `docker-connect` 报告为 `not-enforced` 并附上套接字的路径，setup 指出该路径并提供 rootless 引擎。 |
| `docker-desktop-control-sockets-denied` | 在 Seatbelt 下，受限命令无法连接到被拒绝的 Docker Desktop 控制目录中的 fixture 套接字，包括命令启动之后创建的套接字。 |
| `a shell write to AGENTS.md asks` | 受限 shell 命令在 `workspace-write` 下对工作区 `AGENTS.md` 的写入会等待指令同意，被拒绝的询问让该文件保持不变。 |

## 实现状态

bwrap、Landlock 和 Seatbelt 上的写入和读取规则、bwrap 和 Seatbelt 上的套接字规则、对等于、位于其内或包含 home 的可写根的拒绝、对过松的 home、`secrets/` 或 `run/<profile>/` 目录的拒绝以及对 Linux 和 macOS 上过松的受保护文件的拒绝、提供方对被拒绝套接字目录的支持，以及在 WSL 下和 Linux 上对 Docker Desktop 控制目录的隐藏，均已构建，并由 [C1](../contracts/c01-home-layout.zh.md) 描述。规则 1 已构建：`delorun headless` 在沙箱覆盖层之下组合 `@delorun/bundle-headless` 或拒绝启动，与 `delorun` 和 `delorun start` 组合 CLI profile 的层相同，并且 `delorun plugin` 不启动 Host。规则 2 到 12 尚未构建。
