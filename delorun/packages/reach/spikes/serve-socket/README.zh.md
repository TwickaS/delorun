---
description: "spike 报告：tailscale serve 是否转发到模式为 0600 的 Unix socket，以及哪些本地进程能够访问该 socket；测量基于 Linux 上的 Tailscale 1.104.5，并记录回退路径的命令、身份请求头的移除以及转发的 Host 值。"
---

# Spike：`tailscale serve` 转发到模式为 0600 的 Unix socket

[English](README.md) | 中文

## 摘要

本报告支持[约定 C7](../../../../docs/contracts/c07-reach-providers.zh.md#tailscale-serve-target)。在 Linux 与 Tailscale 1.104.5 上，`tailscale serve` 拒绝为非 root 且无法免密运行 `sudo tailscale` 的调用者配置 Unix socket 目标，因此未观察到向该 socket 的转发。模式为 0600 的 socket 可被本人用户的所有未受限进程访问，可被能看到 socket 路径的 `bwrap` 受限进程访问，也可被挂载了 socket 所在目录的 Docker 容器中的 root 进程访问；只有其他用户的进程被拒绝。约定 C7 中的两个条件都会选择回退方案，该方案已是现行约定：在 `127.0.0.1` 上的 TCP 目标，任何监听器都不信任身份请求头，以及用于 tailnet 私有远程访问的身份因子。回退方案的命令按原样运行正常，`tailscaled` 也移除了它所转发请求中伪造的 `Tailscale-*` 请求头。

## 答案

| 问题 | 答案 |
| --- | --- |
| `tailscale serve` 是否转发到模式为 0600 的 Unix socket？ | 未观察到。`tailscaled` 以 `401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket` 拒绝了该配置，命令以退出码 1 结束。 |
| 除 `tailscaled` 之外，是否有本地进程能访问该监听器？ | 有。本人用户中能看到该 socket 路径的每个进程都收到了响应，root 也收到了响应。 |
| 适用哪一种回退方案？ | 约定 C7 所命名的回退方案：Tailscale 私有目标为 `127.0.0.1` 上的 TCP 端口，任何监听器都不信任身份请求头，tailnet 私有远程访问需要通行密钥或 OpenID Connect 身份因子，所有者认领仅限回环地址。 |
| 结果是否与约定相矛盾？ | 否。约定 C7 已在所有平台上将该回退方案定为现行约定，且仅在 spike 通过时才采纳套接字变体。 |

## 环境

- **操作系统。** WSL2 下的 Ubuntu 24.04.1 LTS，内核为 `6.6.87.2-microsoft-standard-WSL2`。
- **Tailscale。** `tailscale version` 报告版本为 `1.104.5`，提交为 `78838476328d1a97dc05400ad23086a9dbe616da`，go 为 `go1.27.3`。
- **测试节点。** 以 `--tun=userspace-networking --statedir=$HOME/.delorun-test/tailscale --socket=$HOME/.delorun-test/tailscale/tailscaled.sock --port=0` 启动的 `tailscaled`，以本人用户身份运行（uid 1000，来自 `ps`），带有标签 `tag:delorun-test`，并启用了 MagicDNS 以及 `https` 与 `funnel` 能力。本文中其名称写作 `<node>.<tailnet>.ts.net`。operator 偏好设置为空（`tailscale get operator`）。
- **运行时间。** 2026-11-06，UTC 14:50 至 15:05 之间。

## 为什么套接字目标被拒绝

拒绝来自 Tailscale 仓库在 `v1.104.5` 标签处的 `ipn/localapi/serve.go` 中的 `authorizeServeConfigForGOOSAndUserContext`，以及 `ipn/ipnserver/actor.go` 中的 `connIsLocalAdmin`。只有本地 API 的管理员调用者才能提交提供 Unix socket 或路径的 serve 配置：

- **Linux、illumos、Solaris 与独立分发的 macOS。** 当调用者的 uid 为 0，或 operator 偏好为空或等于调用者的 uid，且 `tailscaled` 能在 3 秒内成功运行 `sudo --other-user=<caller> --list tailscale` 时，该调用者为管理员。
- **Windows。** 不支持 Unix socket 目标（`unix socket serve target is not supported on Windows`）。
- **沙箱化的 macOS（App Store 与独立系统扩展构建）。** 跳过该检查，源码注明此处 `tailscaled` 无法提供其沙箱之外的文件。

在测试节点上，`tailscaled` 以本人用户身份运行，因此其 `sudo --list` 调用需要本人的密码，并且失败。若 `tailscaled` 以 root 身份运行，则对于 sudoers 允许运行 `tailscale` 的某位用户，同一调用会成功，因此 home 无需输入密码即可配置该目标；该情形未经运行。

## 哪些进程能访问模式为 0600 的 socket

`socket-server.py` 在 `/tmp` 下新建的模式为 0700 的目录中，以 umask 0177 创建 `serve.sock`，并在 `bind` 之后将模式设为 0600。`stat -c '%A %a %U:%G'` 显示目录为 `drwx------ 700`，socket 为 `srw------- 600`，二者均属于本人的用户。下列每个请求都发送了伪造的 `Tailscale-User-Login` 请求头，服务器则随每个 `Tailscale-*` 请求头记录对端的 `SO_PEERCRED`。

| 客户端 | 结果 | 记录的对端凭证 |
| --- | --- | --- |
| 以本人用户身份、未受限运行的 `curl --unix-socket` | 200；伪造的请求头到达处理程序 | uid 1000，`curl` |
| 以 `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all` 运行的同一 `curl` | 200；伪造的请求头到达处理程序 | uid 1000，`curl` |
| 同一 `bwrap`，并在 socket 所在目录上加 `--tmpfs` | `curl` 退出码 7：沙箱内不存在该路径 | 无 |
| 以 uid 65534 运行、挂载了该目录的 Docker 容器（`delorun-cell:test`） | `PermissionError [Errno 13]` | 无 |
| 以 uid 0 运行、挂载了该目录的 Docker 容器 | 200；伪造的请求头到达处理程序 | uid 0，pid 0（对端的 PID 命名空间不可见） |

默认 Docker 网络中未挂载该路径的容器无法访问宿主机上的 Unix socket，因此该情形无需发送请求。网络命名空间并不隔离具名路径的 Unix socket：`--unshare-all` 的情形仍然访问到了 socket。只有像约定 C1 的 `home-connect` 规则所要求的那样，隐藏 socket 所在目录的挂载规则，才能把受限进程挡在外面。

就该变体的对端凭证检查，这些日志显示：

- 当 `tailscaled` 以本人用户身份运行时，其连接与本人的进程呈现相同的 uid，因此 uid 检查无法区分二者。约定 C7 已为该情形选择回退方案。
- 当 `tailscaled` 以 root 身份运行时，仅放行 uid 0 的检查也会放行所有 root 进程，包括挂载了该 socket 所在目录的 root 容器。因此，只要属于 `docker` 组，就足以通过该检查。

## 经由 `tailscaled` 的回退路径

`socket-server.py tcp` 监听 `127.0.0.1` 上由操作系统分配的端口。由于用户态网络节点不会将其自身的进程经由 tailnet 路由，`tailnet-connect-proxy.ts` 通过 `tailscale nc` 转发 `curl` 向节点自身 `ts.net` 名称发起的 HTTPS 连接。因此，请求来自测试节点本身（一个带标签的节点），而非 tailnet 上的其他设备。

| 请求 | 目标记录的内容 |
| --- | --- |
| 端口 443，携带伪造的 `Tailscale-User-Login`、`Tailscale-User-Name` 与 `Tailscale-Headers-Info` | 完全没有 `Tailscale-*` 请求头；`Host: <node>.<tailnet>.ts.net`；`X-Forwarded-Host` 与之相同；`X-Forwarded-Proto: https`；`X-Forwarded-For` 为该节点的 tailnet 地址 |
| 端口 8443，携带伪造的 `Tailscale-User-Login` 与 `X-Forwarded-For` | 没有 `Tailscale-*` 请求头；`Host: <node>.<tailnet>.ts.net:8443`；伪造的 `X-Forwarded-For` 被替换为该节点的 tailnet 地址 |
| 端口 8443，携带 `Host: other.example` | `Host: other.example` 与 `X-Forwarded-Host: other.example`：`tailscaled` 原样转发了客户端的 `Host` |
| 本地进程直接访问 TCP 端口，携带伪造的 `Tailscale-User-Login` | 伪造的请求头到达处理程序 |

转发的 `Host` 与约定 C4 对 Tailscale 监听器的规则一致，即配置的地址，端口不是 443 时还附带端口。`tailscaled` 并不把 `Host` 限制为证书中的名称，因此对它进行检查的只有监听器自身的 `Host` 检查。由于来源是带标签的节点，`tailscaled` 未添加身份请求头；对于用户拥有的设备，身份请求头未经测量。端口 443 上的第一个请求耗时约 35 秒，期间 `tailscaled` 在获取证书。

约定 C7 的回退命令按写法运行正常：`tailscale serve --bg --https=443 http://127.0.0.1:<port>` 与 `tailscale serve --https=443 off`，端口 8443 上使用相同的一对命令。Funnel 的一对命令 `tailscale funnel --bg --https=8443 http://127.0.0.1:<port>` 与 `tailscale funnel --https=8443 off` 在 [ts-net-rp-id spike 报告](../../../home-auth/spikes/ts-net-rp-id/README.zh.md)中运行正常。

## 未覆盖的范围

- **以 root 运行的 `tailscaled`。** 转发本身以及 `sudo --list` 路径，都需要 `tailscaled` 以 root 身份运行的节点；本次运行没有此类节点。
- **其他平台。** 未测试 macOS；Windows 没有 Unix socket 目标。
- **tailnet 上的其他设备。** 请求经由 `tailscale nc` 来自节点自身，而非来自其他设备上的浏览器。
- **其他本地用户。** 以 uid 65534 运行的容器代替了其他用户；未使用第二个宿主机账户。
- **Delorun 的沙箱 profile。** 它们尚未构建，由 `bwrap` 调用代替。

## 命令

每条 `tailscale` 命令均以 `tailscale --socket=$HOME/.delorun-test/tailscale/tailscaled.sock <command>` 的形式运行，下文简写为 `tailscale <command>`。`<dir>` 为由 `mktemp -d /tmp/delorun-serve-spike.XXXXXX` 创建的模式为 0700 的目录。

```sh
tailscale version
python3 -I socket-server.py <dir>/serve.sock
node tailnet-connect-proxy.ts $HOME/.delorun-test/tailscale/tailscaled.sock
stat -c '%A %a %U:%G %n' <dir> <dir>/serve.sock
tailscale serve --bg --https=443 unix:<dir>/serve.sock    # 401, exit 1
tailscale serve --bg unix:<dir>/serve.sock                # 401, exit 1
tailscale get operator                                    # empty
sudo -n --other-user=<user> --list tailscale              # a password is required
curl -s --unix-socket <dir>/serve.sock -H 'Tailscale-User-Login: forged@example.com' http://localhost/a
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent curl -s --unix-socket <dir>/serve.sock -H 'Tailscale-User-Login: forged@example.com' http://localhost/b
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --tmpfs <dir> --die-with-parent curl -s --unix-socket <dir>/serve.sock http://localhost/c
docker run --rm -u 65534 -v <dir>:/s --entrypoint python3 delorun-cell:test -I -c '<connect to /s/serve.sock and send GET /d>'
docker run --rm -u 0 -v <dir>:/s --entrypoint python3 delorun-cell:test -I -c '<connect to /s/serve.sock and send GET /e>'
python3 -I socket-server.py tcp
tailscale serve --bg --https=443 http://127.0.0.1:<port>
curl -s -x http://<proxy> -H 'Tailscale-User-Login: forged@example.com' -H 'Tailscale-User-Name: Forged' -H 'tailscale-headers-info: forged' https://<node>.<tailnet>.ts.net/fallback
curl -s -H 'Tailscale-User-Login: forged@example.com' http://127.0.0.1:<port>/local
tailscale serve --https=443 off
tailscale serve --bg --https=8443 http://127.0.0.1:<port>
curl -s -x http://<proxy> -H 'Tailscale-User-Login: forged@example.com' -H 'X-Forwarded-For: 203.0.113.9' https://<node>.<tailnet>.ts.net:8443/port8443
curl -s -x http://<proxy> -H 'Host: other.example' https://<node>.<tailnet>.ts.net:8443/hostoverride
tailscale serve --https=8443 off
tailscale serve reset
tailscale funnel reset
tailscale serve status                                    # No serve config
```

## 文件

- `socket-server.py`：测试用 HTTP 服务器，监听模式为 0600 的 Unix socket，或在使用 `tcp` 参数时监听 `127.0.0.1`，并记录对端凭证与 `Tailscale-*` 请求头；仅限 Linux。
- `tailnet-connect-proxy.ts`：监听 `127.0.0.1` 的 HTTP CONNECT 代理，通过 `tailscale nc` 转发到节点自身 `ts.net` 名称的隧道，并拒绝其他所有目标。

## 清理

最后一次请求之后，运行了 `tailscale serve reset` 与 `tailscale funnel reset`，`tailscale serve status` 输出 `No serve config`。测试服务器与代理已停止，socket 所在目录已删除。
