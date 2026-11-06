---
description: "Spike report for WP1.19: ts.net on the Public Suffix List, the WebAuthn relying-party IDs a page on a tailscale serve address and on a Funnel address may use, and passkey registration and assertion there in Chromium, with Firefox's relying-party ID checks and the browsers not covered."
---

# Spike: passkey relying-party IDs on `ts.net`

English | [中文](README.zh.md)

## Summary

This report records work package WP1.19 for [contract C14](../../../../docs/contracts/c14-oidc-passkeys.md#relying-party-ids). `ts.net` is on the Public Suffix List, in its private section under Tailscale Inc., so `<tailnet>.ts.net` is a registrable domain. A page on the `tailscale serve` address `https://<node>.<tailnet>.ts.net` and a page on the Funnel address `https://<node>.<tailnet>.ts.net:8443` may each use `<node>.<tailnet>.ts.net` or `<tailnet>.ts.net` as the relying-party ID, and browsers refuse `ts.net` and `net`. In Chromium 149 a passkey with the relying-party ID `<node>.<tailnet>.ts.net` registered and asserted on both addresses, with a platform and a security-key virtual authenticator, and a passkey registered on the serve address asserted on the Funnel address. Firefox 151 accepted and refused the same relying-party IDs but had no authenticator to complete a ceremony, and WebKit and Safari were not run. C14's evidence for Firefox and Safari is therefore missing, and its current contract, no passkeys on `ts.net` addresses with OpenID Connect sign-in as their identity factor, stays.

## Answers

| Question | Answer |
| --- | --- |
| Is `ts.net` on the Public Suffix List? | Yes, in the private section, submitted by Tailscale Inc.: the rule `ts.net` and a wildcard rule for every name directly under the `c` label of `ts.net`, which Delo's addresses do not use. |
| Relying-party ID on the serve address `https://<node>.<tailnet>.ts.net` | `<node>.<tailnet>.ts.net` or `<tailnet>.ts.net`; `ts.net` and `net` are refused with `SecurityError`. |
| Relying-party ID on the Funnel address `https://<node>.<tailnet>.ts.net:8443` | The same: `<node>.<tailnet>.ts.net` or `<tailnet>.ts.net`. The port is not part of a relying-party ID, so both addresses share them. |
| Does a passkey register and assert there? | Chromium 149: yes on both addresses, with platform and security-key virtual authenticators. Firefox 151: not completed, because no authenticator was available. Safari: not tested. |
| Does a passkey registered on the serve address assert on the Funnel address? | Yes in Chromium 149; the assertion's `clientDataJSON.origin` was `https://<node>.<tailnet>.ts.net:8443`. |
| Does the result contradict a contract? | No. C14 keeps passkeys unavailable on `ts.net` until every browser it names passes, chooses the address's host and never a parent such as `<tailnet>.ts.net`, and already states that a private address and a Funnel address share a relying-party ID. |

## Public Suffix List

| Source | Version | Result |
| --- | --- | --- |
| Live list, `https://publicsuffix.org/list/public_suffix_list.dat`, fetched 2026-11-06 14:53 UTC | `VERSION: 2026-11-06_09-01-47_UTC`, `COMMIT: 94ec5df7273926560d91e77c002000ba1a53fec4` | `ts.net` and the wildcard rule under the `c` label, under `// Tailscale Inc. : https://www.tailscale.com` in the private section |
| `psl` 1.15.0 in `node_modules`, `data/rules.js` | the package's bundled list | Lists `ts.net` and the same wildcard rule; `psl.get('<node>.<tailnet>.ts.net')` is `<tailnet>.ts.net`, and `psl.get('ts.net')` is `null` |
| `tldts` 7.4.5 in `node_modules` | the package's bundled list | With `allowPrivateDomains: true`, the public suffix of `<node>.<tailnet>.ts.net` is `ts.net` and its domain `<tailnet>.ts.net`; with the default `false`, which reads only the ICANN section, the domain is `ts.net` |

Browsers read both sections: Chromium and Firefox refused `ts.net` as a relying-party ID and accepted `<tailnet>.ts.net`, as the private section requires.

## Browser results

The test page was served by `test-page-server.ts` on `127.0.0.1` and published with `tailscale serve --bg --https=443` and `tailscale funnel --bg --https=8443`. The node's own processes do not route through the tailnet in userspace networking, so browsers reached the serve address through `tailnet-connect-proxy.ts` from the [WP1.18 spike](../../../reach/spikes/serve-socket/README.md), which carries each connection through `tailscale nc`. They reached the Funnel address over the public internet with no proxy. Every page load reported `isSecureContext: true` and a defined `PublicKeyCredential`.

`rp-id-probe.ts` called `navigator.credentials.create` with C14's registration options (`residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`, algorithms -8, -7 and -257) once for each candidate relying-party ID, then `navigator.credentials.get` with the relying-party ID `<node>.<tailnet>.ts.net` and `userVerification: "required"`. It checked that the assertion's `rpIdHash` equals the SHA-256 hash of that ID and that the user-present and user-verified flags are set.

| Browser and authenticator | Address | `<node>.<tailnet>.ts.net` | `<tailnet>.ts.net` | `ts.net` | `net` | Assertion |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 149.0.7827.55, CTAP2 virtual authenticator, transport `internal` | serve | registered | registered | `SecurityError` | `SecurityError` | `rpIdHash` matched, UP and UV set |
| Chromium 149.0.7827.55, CTAP2 virtual authenticator, transport `usb` | serve | registered | registered | `SecurityError` | `SecurityError` | `rpIdHash` matched, UP and UV set |
| Chromium 149.0.7827.55, transport `internal` | Funnel | registered | registered | `SecurityError` | `SecurityError` | `rpIdHash` matched, UP and UV set |
| Chromium 149.0.7827.55, transport `usb` | Funnel | registered | registered | `SecurityError` | `SecurityError` | `rpIdHash` matched, UP and UV set |
| Firefox 151.0, no authenticator | serve and Funnel | accepted: `NotAllowedError` after about 15 s | accepted: `NotAllowedError` after about 15 s | `SecurityError` at once | `SecurityError` at once | not run |

Chromium's `SecurityError` message was `The relying party ID is not a registrable domain suffix of, nor equal to the current domain.`; Firefox's was `The operation is insecure.`. In Firefox, an accepted relying-party ID made the browser wait for an authenticator until its timeout, while a refused one failed before any wait. Setting `security.webauthn.enable_softtoken` in Firefox gave no authenticator either: `create` still ended with `NotAllowedError`.

**Cross-address assertion.** In one Chromium page with one `internal` virtual authenticator, a passkey registered at `https://<node>.<tailnet>.ts.net` with the relying-party ID `<node>.<tailnet>.ts.net`, and after navigation to `https://<node>.<tailnet>.ts.net:8443` the same page asserted it: `rpIdHash` matched, UP and UV were set, and `clientDataJSON.origin` was `https://<node>.<tailnet>.ts.net:8443`. The browser does not separate the two addresses; only the home's check of `clientDataJSON.origin` against the address the passkey was enrolled on does, as C14's assertion checks require.

**Funnel reachability.** While Funnel was on, some connections to the Funnel address closed or timed out during TLS setup: `curl` failed once with HTTP/1.1 and once with HTTP/2 in five requests, and Chromium's first navigation failed in some runs with `ERR_CONNECTION_CLOSED` or `ERR_TIMED_OUT`. The probe retries a failed navigation up to twice and records each failure; every recorded WebAuthn result comes from a page that loaded.

## Not covered

- **Safari and WebKit.** Safari needs a macOS or iOS host. Playwright's WebKit build did not start, because the host lacks system libraries whose installation needs `sudo`.
- **Firefox ceremonies.** Playwright gives Firefox no virtual authenticator, so registration and assertion in Firefox were not run.
- **Real authenticators.** Only Chromium's CDP virtual authenticators were used; no platform authenticator of an operating system and no physical security key.
- **Other operating systems.** Every browser ran headless on Ubuntu 24.04.1 under WSL2.

## Commands

Every `tailscale` command ran as `tailscale --socket=$HOME/.delo-test/tailscale/tailscaled.sock <command>`, shortened below to `tailscale <command>`. `<port>` is the test page's port and `<proxy>` the proxy's address.

```sh
curl -sfL -o psl.dat https://publicsuffix.org/list/public_suffix_list.dat
grep -n -B2 '^ts\.net' psl.dat
node -e '<tldts.getPublicSuffix and getDomain, with and without allowPrivateDomains; psl.parse and psl.get>'
node test-page-server.ts
node ../../../reach/spikes/serve-socket/tailnet-connect-proxy.ts $HOME/.delo-test/tailscale/tailscaled.sock
tailscale serve --bg --https=443 http://127.0.0.1:<port>
node rp-id-probe.ts $HOME/.delo-test/tailscale/tailscaled.sock serve <proxy>
tailscale funnel --bg --https=8443 http://127.0.0.1:<port>
curl -s --http1.1 https://<node>.<tailnet>.ts.net:8443/
curl -s --http2 https://<node>.<tailnet>.ts.net:8443/
node rp-id-probe.ts $HOME/.delo-test/tailscale/tailscaled.sock funnel
node rp-id-probe.ts $HOME/.delo-test/tailscale/tailscaled.sock cross <proxy>
tailscale funnel --https=8443 off
tailscale serve --https=443 off
tailscale funnel reset
tailscale serve reset
tailscale serve status                                    # No serve config
```

## Files

- `test-page-server.ts`: an HTTP server on `127.0.0.1` that answers `GET /` with one fixed page and everything else with 404; it reads no file.
- `rp-id-probe.ts`: the Playwright probe for the `serve`, `funnel` and `cross` scenarios; it prints its results with the node's name replaced by `<node>.<tailnet>.ts.net`.

## Reset

Funnel published only the test page, and only while a probe ran: on 2026-11-06 from 14:57:29 to 14:57:42, 14:58:10 to 14:58:18, about 14:59 to 14:59:40, 15:00:08 to 15:00:51 and 15:01:16 to 15:02:28 UTC. After each window `tailscale funnel --https=8443 off`, `tailscale funnel reset` and `tailscale serve reset` ran, and `tailscale serve status` printed `No serve config`. The test page server and the proxy were stopped.
