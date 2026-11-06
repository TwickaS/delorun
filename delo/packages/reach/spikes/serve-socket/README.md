---
description: "Spike report for WP1.18: whether tailscale serve forwards to a mode-0600 Unix socket and which local processes reach that socket, measured with Tailscale 1.104.5 on Linux, with the fallback path's commands, identity header removal and forwarded Host values."
---

# Spike: `tailscale serve` to a mode-0600 Unix socket

English | [中文](README.zh.md)

## Summary

This report records work package WP1.18 for [contract C7](../../../../docs/contracts/c07-reach-providers.md#tailscale-serve-target). On Linux with Tailscale 1.104.5, `tailscale serve` refused to configure a Unix socket target for a caller that is not root and cannot run `sudo tailscale` without a password, so forwarding to the socket was not observed. A mode-0600 socket was reachable by every unconfined process of the person's user, by a `bwrap`-confined process that could see the socket's path, and by a root process in a Docker container with the socket's directory mounted; only a process of another user was refused. Both conditions in C7 select the fallback, which is already the current contract: the TCP target on `127.0.0.1`, identity headers trusted on no listener, and an identity factor for tailnet-private reach. The fallback's commands worked, and `tailscaled` removed forged `Tailscale-*` headers from requests it forwarded.

## Answers

| Question | Answer |
| --- | --- |
| Does `tailscale serve` forward to a mode-0600 Unix socket? | Not observed. `tailscaled` refused the configuration with `401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket`, and the command exited 1. |
| Can a local process other than `tailscaled` reach the listener? | Yes. Every process of the person's user that can see the socket's path received a response, and so did root. |
| Which fallback applies? | C7's named fallback: the Tailscale private target is a TCP port on `127.0.0.1`, identity headers are trusted on no listener, tailnet-private reach needs a passkey or OpenID Connect identity factor, and owner claim is loopback-only. |
| Does the result contradict a contract? | No. C7 already states the fallback as the current contract on every platform and adopts the socket variant only on a passing spike. |

## Environment

- **Operating system.** Ubuntu 24.04.1 LTS under WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`.
- **Tailscale.** `tailscale version` reported `1.104.5`, tailscale commit `78838476328d1a97dc05400ad23086a9dbe616da`, go `go1.27.3`.
- **Test node.** A `tailscaled` started with `--tun=userspace-networking --statedir=$HOME/.delo-test/tailscale --socket=$HOME/.delo-test/tailscale/tailscaled.sock --port=0`, running as the person's user (uid 1000, from `ps`), tagged `tag:delo-test`, with MagicDNS and the `https` and `funnel` capabilities. Its name is written `<node>.<tailnet>.ts.net` here. The operator preference was empty (`tailscale get operator`).
- **Run.** 2026-11-06, between 14:50 and 15:05 UTC.

## Why the socket target was refused

The refusal comes from `authorizeServeConfigForGOOSAndUserContext` in `ipn/localapi/serve.go` and `connIsLocalAdmin` in `ipn/ipnserver/actor.go` at tag `v1.104.5` of the Tailscale repository. A serve configuration that serves a Unix socket or a path is accepted only from an admin caller of the local API:

- **Linux, illumos, Solaris and standalone macOS.** The caller is admin when its uid is 0, or when the operator preference is empty or equals the caller's uid and `tailscaled` runs `sudo --other-user=<caller> --list tailscale` successfully within 3 seconds.
- **Windows.** Unix socket targets are not supported (`unix socket serve target is not supported on Windows`).
- **Sandboxed macOS (App Store and standalone system extension builds).** The check is skipped, and the source states that `tailscaled` cannot serve files outside its sandbox there.

On the test node `tailscaled` runs as the person's user, so its `sudo --list` call needs the person's password and fails. Where `tailscaled` runs as root, the same call succeeds for a person whom sudoers allows to run `tailscale`, so the home could configure the target without typing a password; that case was not run.

## Who reaches a mode-0600 socket

`socket-server.py` created `serve.sock` with umask 0177 in a fresh mode-0700 directory under `/tmp` and set mode 0600 after `bind`. `stat -c '%A %a %U:%G'` showed `drwx------ 700` for the directory and `srw------- 600` for the socket, both owned by the person's user. Each request below sent a forged `Tailscale-User-Login` header, and the server logged the peer's `SO_PEERCRED` with every `Tailscale-*` header.

| Client | Result | Peer credentials logged |
| --- | --- | --- |
| `curl --unix-socket` as the person's user, unconfined | 200; the forged header reached the handler | uid 1000, `curl` |
| `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all` running the same `curl` | 200; the forged header reached the handler | uid 1000, `curl` |
| The same `bwrap` with `--tmpfs` over the socket's directory | `curl` exit 7: the path did not exist inside the sandbox | none |
| Docker container (`delo-cell:test`) as uid 65534 with the directory bind-mounted | `PermissionError [Errno 13]` | none |
| Docker container as uid 0 with the directory bind-mounted | 200; the forged header reached the handler | uid 0, pid 0 (the peer's PID namespace is not visible) |

A container on the default Docker network without a mount has no path to a Unix socket on the host, so that case needs no request. A network namespace does not separate path-named Unix sockets: the `--unshare-all` case reached the socket. Only a mount rule that hides the socket's directory, as C1's `home-connect` rule requires, kept the confined process out.

For the variant's peer-credential check, these logs show:

- When `tailscaled` runs as the person's user, its connections and the person's own processes present the same uid, so a uid check cannot tell them apart. C7 already selects the fallback for that case.
- When `tailscaled` runs as root, a check that admits only uid 0 also admits every root process, including a root container that has the socket's directory mounted. Membership of the `docker` group is therefore enough to pass it.

## The fallback path through `tailscaled`

`socket-server.py tcp` listened on `127.0.0.1` with a port the operating system assigned. Because a userspace-networking node does not route its own processes through the tailnet, `tailnet-connect-proxy.ts` carried `curl`'s HTTPS connection to the node's own `ts.net` name through `tailscale nc`. The request therefore came from the test node itself, a tagged node, and not from another tailnet device.

| Request | Logged by the target |
| --- | --- |
| Port 443, with forged `Tailscale-User-Login`, `Tailscale-User-Name` and `Tailscale-Headers-Info` | No `Tailscale-*` header at all; `Host: <node>.<tailnet>.ts.net`; `X-Forwarded-Host` the same; `X-Forwarded-Proto: https`; `X-Forwarded-For` the node's tailnet address |
| Port 8443, with forged `Tailscale-User-Login` and `X-Forwarded-For` | No `Tailscale-*` header; `Host: <node>.<tailnet>.ts.net:8443`; the forged `X-Forwarded-For` replaced by the node's tailnet address |
| Port 8443, with `Host: other.example` | `Host: other.example` and `X-Forwarded-Host: other.example`: `tailscaled` forwarded the client's `Host` unchanged |
| A local process to the TCP port directly, with forged `Tailscale-User-Login` | The forged header reached the handler |

The forwarded `Host` matches C4's rule for Tailscale listeners, the configured address with its port when it is not 443. `tailscaled` does not restrict `Host` to the certificate's name, so the listener's `Host` check is the only check on it. `tailscaled` added no identity headers because the source was a tagged node; identity headers for a user-owned device were not measured. The first request on port 443 took about 35 seconds while `tailscaled` obtained the certificate.

C7's fallback commands worked as written: `tailscale serve --bg --https=443 http://127.0.0.1:<port>` and `tailscale serve --https=443 off`, and on port 8443 the same pair. The Funnel pair `tailscale funnel --bg --https=8443 http://127.0.0.1:<port>` and `tailscale funnel --https=8443 off` worked in the [WP1.19 spike](../../../home-auth/spikes/ts-net-rp-id/README.md).

## Not covered

- **`tailscaled` as root.** The forwarding itself, and the `sudo --list` path, need a node whose `tailscaled` runs as root; this run had none.
- **Other platforms.** macOS was not tested; Windows has no Unix socket target.
- **Another tailnet device.** Requests came from the node itself through `tailscale nc`, not from a browser on another device.
- **Another local user.** A container with uid 65534 stood in for another user; no second host account was used.
- **Delo's sandbox profiles.** They are not built yet; `bwrap` invocations stood in for them.

## Commands

Every `tailscale` command ran as `tailscale --socket=$HOME/.delo-test/tailscale/tailscaled.sock <command>`, shortened below to `tailscale <command>`. `<dir>` is the mode-0700 directory from `mktemp -d /tmp/delo-serve-spike.XXXXXX`.

```sh
tailscale version
python3 -I socket-server.py <dir>/serve.sock
node tailnet-connect-proxy.ts $HOME/.delo-test/tailscale/tailscaled.sock
stat -c '%A %a %U:%G %n' <dir> <dir>/serve.sock
tailscale serve --bg --https=443 unix:<dir>/serve.sock    # 401, exit 1
tailscale serve --bg unix:<dir>/serve.sock                # 401, exit 1
tailscale get operator                                    # empty
sudo -n --other-user=<user> --list tailscale              # a password is required
curl -s --unix-socket <dir>/serve.sock -H 'Tailscale-User-Login: forged@example.com' http://localhost/a
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent curl -s --unix-socket <dir>/serve.sock -H 'Tailscale-User-Login: forged@example.com' http://localhost/b
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --tmpfs <dir> --die-with-parent curl -s --unix-socket <dir>/serve.sock http://localhost/c
docker run --rm -u 65534 -v <dir>:/s --entrypoint python3 delo-cell:test -I -c '<connect to /s/serve.sock and send GET /d>'
docker run --rm -u 0 -v <dir>:/s --entrypoint python3 delo-cell:test -I -c '<connect to /s/serve.sock and send GET /e>'
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

## Files

- `socket-server.py`: the test HTTP server on a mode-0600 Unix socket, or with `tcp` on `127.0.0.1`, logging peer credentials and `Tailscale-*` headers; Linux only.
- `tailnet-connect-proxy.ts`: an HTTP CONNECT proxy on `127.0.0.1` that carries tunnels to the node's own `ts.net` name through `tailscale nc` and refuses every other target.

## Reset

After the last request, `tailscale serve reset` and `tailscale funnel reset` ran and `tailscale serve status` printed `No serve config`. The test servers and the proxy were stopped and the socket's directory was deleted.
