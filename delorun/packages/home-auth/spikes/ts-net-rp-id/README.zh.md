---
description: "spike 报告：ts.net 是否在 Public Suffix List 中，tailscale serve 地址与 Funnel 地址上的页面可以使用的 WebAuthn 依赖方 ID，Chromium 中在这些地址上的通行密钥注册与断言，以及 Firefox 的依赖方 ID 检查；未覆盖的浏览器另行说明。"
---

# Spike：`ts.net` 上的通行密钥依赖方 ID

[English](README.md) | 中文

## 摘要

本报告支持[约定 C14](../../../../docs/contracts/c14-oidc-passkeys.zh.md#relying-party-ids)。`ts.net` 位于 Public Suffix List（公共后缀列表）的私有区段中，由 Tailscale Inc. 提交，因此 `<tailnet>.ts.net` 是可注册域名。`tailscale serve` 地址 `https://<node>.<tailnet>.ts.net` 与 Funnel 地址 `https://<node>.<tailnet>.ts.net:8443` 上的页面，均可使用 `<node>.<tailnet>.ts.net` 或 `<tailnet>.ts.net` 作为依赖方（relying party）ID，浏览器会拒绝 `ts.net` 与 `net`。在 Chromium 149 中，依赖方 ID 为 `<node>.<tailnet>.ts.net` 的通行密钥在两个地址上均完成了注册与断言，所用认证器分别为平台型与安全密钥型虚拟认证器；在 serve 地址上注册的通行密钥，也可以在 Funnel 地址上断言。Firefox 151 对相同的依赖方 ID 做出了接受与拒绝的判断，但没有可用于完成注册或断言流程的认证器；WebKit 与 Safari 未运行。因此约定 C14 缺少 Firefox 与 Safari 的证据，其现行约定保持不变：`ts.net` 地址上不提供通行密钥，OpenID Connect 登录作为这些地址的身份因子。

## 答案

| 问题 | 答案 |
| --- | --- |
| `ts.net` 是否在 Public Suffix List 中？ | 是，位于私有区段，由 Tailscale Inc. 提交：规则为 `ts.net` 本身，以及针对 `ts.net` 下 `c` 标签的每个直接子名称的通配规则，Delorun 的地址不使用后者。 |
| serve 地址 `https://<node>.<tailnet>.ts.net` 上的依赖方 ID | `<node>.<tailnet>.ts.net` 或 `<tailnet>.ts.net`；`ts.net` 与 `net` 会以 `SecurityError` 被拒绝。 |
| Funnel 地址 `https://<node>.<tailnet>.ts.net:8443` 上的依赖方 ID | 相同：`<node>.<tailnet>.ts.net` 或 `<tailnet>.ts.net`。端口不属于依赖方 ID，因此两个地址共用这些依赖方 ID。 |
| 通行密钥能否在这些地址上注册与断言？ | Chromium 149：能，两个地址上均可，所用认证器分别为平台型与安全密钥型虚拟认证器。Firefox 151：未完成，因为没有可用的认证器。Safari：未测试。 |
| 在 serve 地址上注册的通行密钥，能否在 Funnel 地址上断言？ | 能（Chromium 149）；断言的 `clientDataJSON.origin` 为 `https://<node>.<tailnet>.ts.net:8443`。 |
| 结果是否与约定相矛盾？ | 否。约定 C14 在 `ts.net` 上直到其所列的每个浏览器都通过之前，都不提供通行密钥；它选择地址的主机名，从不选择 `<tailnet>.ts.net` 这类父域；并且已经说明私有地址与 Funnel 地址共用依赖方 ID。 |

## 公共后缀列表

| 来源 | 版本 | 结果 |
| --- | --- | --- |
| 在线列表，`https://publicsuffix.org/list/public_suffix_list.dat`，获取于 2026-11-06 14:53 UTC | `VERSION: 2026-11-06_09-01-47_UTC`，`COMMIT: 94ec5df7273926560d91e77c002000ba1a53fec4` | 私有区段中，在 `// Tailscale Inc. : https://www.tailscale.com` 下有 `ts.net`，以及 `c` 标签下的通配规则 |
| `node_modules` 中的 `psl` 1.15.0，`data/rules.js` | 该包内置的列表 | 列出 `ts.net` 与同一通配规则；`psl.get('<node>.<tailnet>.ts.net')` 为 `<tailnet>.ts.net`，`psl.get('ts.net')` 为 `null` |
| `node_modules` 中的 `tldts` 7.4.5 | 该包内置的列表 | 设置 `allowPrivateDomains: true` 时，`<node>.<tailnet>.ts.net` 的公共后缀为 `ts.net`，其域名为 `<tailnet>.ts.net`；使用默认值 `false` 时只读取 ICANN 区段，域名为 `ts.net` |

浏览器会同时读取两个区段：Chromium 与 Firefox 拒绝 `ts.net` 作为依赖方 ID，并接受 `<tailnet>.ts.net`，这与私有区段的规定一致。

## 浏览器结果

测试页面由 `test-page-server.ts` 在 `127.0.0.1` 上提供，并通过 `tailscale serve --bg --https=443` 与 `tailscale funnel --bg --https=8443` 发布。在 userspace networking 模式下，节点自身的进程不经由 tailnet 路由，因此浏览器经由 [serve-socket spike 报告](../../../reach/spikes/serve-socket/README.zh.md)中的 `tailnet-connect-proxy.ts` 访问 serve 地址，该代理通过 `tailscale nc` 转发每个连接。浏览器通过公网访问 Funnel 地址，未使用代理。每次加载页面时，`isSecureContext: true` 且 `PublicKeyCredential` 已定义。

`rp-id-probe.ts` 对每个候选依赖方 ID 调用一次 `navigator.credentials.create`，所用注册选项为约定 C14 中的选项（`residentKey: "required"`、`userVerification: "required"`、`attestation: "none"`，算法 -8、-7 与 -257）；随后以依赖方 ID `<node>.<tailnet>.ts.net` 与 `userVerification: "required"` 调用 `navigator.credentials.get`。它检查断言的 `rpIdHash` 是否等于该 ID 的 SHA-256 哈希，以及用户在场（UP）与用户已验证（UV）标志是否均已设置。

| 浏览器与认证器 | 地址 | `<node>.<tailnet>.ts.net` | `<tailnet>.ts.net` | `ts.net` | `net` | 断言 |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 149.0.7827.55，CTAP2 虚拟认证器，传输方式 `internal` | serve 地址 | 已注册 | 已注册 | `SecurityError` | `SecurityError` | `rpIdHash` 匹配，UP 与 UV 均已设置 |
| Chromium 149.0.7827.55，CTAP2 虚拟认证器，传输方式 `usb` | serve 地址 | 已注册 | 已注册 | `SecurityError` | `SecurityError` | `rpIdHash` 匹配，UP 与 UV 均已设置 |
| Chromium 149.0.7827.55，传输方式 `internal` | Funnel 地址 | 已注册 | 已注册 | `SecurityError` | `SecurityError` | `rpIdHash` 匹配，UP 与 UV 均已设置 |
| Chromium 149.0.7827.55，传输方式 `usb` | Funnel 地址 | 已注册 | 已注册 | `SecurityError` | `SecurityError` | `rpIdHash` 匹配，UP 与 UV 均已设置 |
| Firefox 151.0，无认证器 | serve 地址与 Funnel 地址 | 已接受：约 15 秒后出现 `NotAllowedError` | 已接受：约 15 秒后出现 `NotAllowedError` | 立即出现 `SecurityError` | 立即出现 `SecurityError` | 未运行 |

Chromium 的 `SecurityError` 消息为 `The relying party ID is not a registrable domain suffix of, nor equal to the current domain.`；Firefox 的消息为 `The operation is insecure.`。在 Firefox 中，被接受的依赖方 ID 会使浏览器等待认证器直至超时，而被拒绝的依赖方 ID 则在任何等待之前即失败。在 Firefox 中设置 `security.webauthn.enable_softtoken` 也没有提供认证器：`create` 仍以 `NotAllowedError` 结束。

**跨地址断言。** 在一个使用单个 `internal` 虚拟认证器的 Chromium 页面中，依赖方 ID 为 `<node>.<tailnet>.ts.net` 的通行密钥在 `https://<node>.<tailnet>.ts.net` 上注册；随后导航至 `https://<node>.<tailnet>.ts.net:8443`，同一页面对该通行密钥完成了断言：`rpIdHash` 匹配，UP 与 UV 均已设置，且 `clientDataJSON.origin` 为 `https://<node>.<tailnet>.ts.net:8443`。浏览器不区分这两个地址；按约定 C14 的断言检查要求，只有 home 将 `clientDataJSON.origin` 与通行密钥注册时所在的地址相比较，这一检查才能区分它们。

**Funnel 可达性。** Funnel 开启期间，部分到 Funnel 地址的连接在 TLS 建立过程中关闭或超时：五次请求中，`curl` 分别以 HTTP/1.1 与 HTTP/2 各失败一次；Chromium 的首次导航在部分运行中以 `ERR_CONNECTION_CLOSED` 或 `ERR_TIMED_OUT` 失败。探测程序对失败的导航最多重试两次，并记录每次失败；所有记录的 WebAuthn 结果均来自成功加载的页面。

## 未覆盖的范围

- **Safari 与 WebKit。** Safari 需要 macOS 或 iOS 主机。Playwright 的 WebKit 构建未能启动，因为主机缺少系统库，而安装这些库需要 `sudo`。
- **Firefox 认证流程。** Playwright 不为 Firefox 提供虚拟认证器，因此未在 Firefox 中运行注册与断言。
- **真实认证器。** 仅使用了 Chromium 的 CDP 虚拟认证器；未使用操作系统的平台认证器，也未使用实体安全密钥。
- **其他操作系统。** 所有浏览器均在 WSL2 下的 Ubuntu 24.04.1 上以无头模式运行。

## 命令

每条 `tailscale` 命令均以 `tailscale --socket=$HOME/.delorun-test/tailscale/tailscaled.sock <command>` 的形式运行，下文简写为 `tailscale <command>`。`<port>` 为测试页面的端口，`<proxy>` 为代理的地址。

```sh
curl -sfL -o psl.dat https://publicsuffix.org/list/public_suffix_list.dat
grep -n -B2 '^ts\.net' psl.dat
node -e '<tldts.getPublicSuffix and getDomain, with and without allowPrivateDomains; psl.parse and psl.get>'
node test-page-server.ts
node ../../../reach/spikes/serve-socket/tailnet-connect-proxy.ts $HOME/.delorun-test/tailscale/tailscaled.sock
tailscale serve --bg --https=443 http://127.0.0.1:<port>
node rp-id-probe.ts $HOME/.delorun-test/tailscale/tailscaled.sock serve <proxy>
tailscale funnel --bg --https=8443 http://127.0.0.1:<port>
curl -s --http1.1 https://<node>.<tailnet>.ts.net:8443/
curl -s --http2 https://<node>.<tailnet>.ts.net:8443/
node rp-id-probe.ts $HOME/.delorun-test/tailscale/tailscaled.sock funnel
node rp-id-probe.ts $HOME/.delorun-test/tailscale/tailscaled.sock cross <proxy>
tailscale funnel --https=8443 off
tailscale serve --https=443 off
tailscale funnel reset
tailscale serve reset
tailscale serve status                                    # No serve config
```

## 文件

- `test-page-server.ts`：监听 `127.0.0.1` 的 HTTP 服务器，对 `GET /` 返回一个固定页面，对其他请求返回 404；它不读取任何文件。
- `rp-id-probe.ts`：针对 `serve`、`funnel` 与 `cross` 场景的 Playwright 探测程序；其输出结果中，节点名称已替换为 `<node>.<tailnet>.ts.net`。

## 清理

Funnel 仅发布了测试页面，且仅在探测程序运行期间发布：2026-11-06 的 UTC 时段为 14:57:29 至 14:57:42、14:58:10 至 14:58:18、约 14:59 至 14:59:40、15:00:08 至 15:00:51，以及 15:01:16 至 15:02:28。每个时段结束后，依次运行 `tailscale funnel --https=8443 off`、`tailscale funnel reset` 与 `tailscale serve reset`，`tailscale serve status` 输出 `No serve config`。测试页面服务器与代理已停止。
