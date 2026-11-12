---
description: "The @delo/reach package, for maintainers of reach: contract C7's reach service with its provider registry, the fixed listener port it holds for a C4 reach listener, and the Tailscale private provider that connects that port to tailscale serve, removes serve rules it does not own, refuses Funnel and declares the tailnet-membership identity factor."
---

# @delo/reach

## Summary

This package is the Service Definition and the first Service Provider of [contract C7](../../docs/contracts/c07-reach-providers.md). The `reach` service holds one provider per reach option and starts each option whose configuration row is on: it asks `@delo/home-auth` to serve the option's reach listener with the identity factor the provider declares, binds the option's fixed listener port on `127.0.0.1`, opens the listener through upstream's `ctx.connection.openReachListener` on a port the operating system assigns, relays the fixed port to it, and starts the provider. The `reach-tailscale-private` provider declares `tailnet-membership` ([C14](../../docs/contracts/c14-oidc-passkeys.md#tailnet-membership)) and configures `tailscale serve` to the fixed port. The service mounts behind the C16 switch `reach` (`Config.enabled`), which `@delo/bundle-local`'s row `delo-reach` turns on; every option stays off until the person runs `delorun reach on tailscale` or answers yes in setup's Full mode.

## Contents

- [The reach service](#the-reach-service)
- [The Tailscale private provider](#the-tailscale-private-provider)
- [The fixed listener port](#the-fixed-listener-port)
- [What is not built](#what-is-not-built)
- [Tests](#tests)

## The reach service

`GET /delo/reach/status` answers the studio, on the loopback listener and to an admitted reach session, with `{ "available": true, "options": [...] }`: each option's id, state, address and, when blocked or failed, its code and sentence (`REACH_STATUS_PATH`, `ReachSummary`). A profile without the service answers 404. The studio's Devices section and its onboarding read it.

`src/service.ts` registers the Tailscale private provider inside `ctx.effect()` and reads the `tailscalePrivate` row: `enabled` (default `false`), `address` (this machine's `https://<machine>.<tailnet>.ts.net` address), `servePort` (default 443), `listenerPort` (the fixed port on `127.0.0.1`, default `0` until `delorun reach on tailscale` chooses one), `serveCheckIntervalMs` (default 60000, at least 1000) and `elevationMinutes` (default 15, 1 to 60), which it passes to `homeAuth.serve` as the length of an elevation approved for a device on the listener. An enabled row that is not an `https` `ts.net` address fails at load with `TAILSCALE_ADDRESS_MISMATCH`, one without a listener port with `PORT_CONFLICT`, and one whose `elevationMinutes` is out of range with `ELEVATION_MINUTES_INVALID`. Starting an option moves it to `starting`, then to `ready`, or to `blocked` with C7's code when the fixed port does not bind or a check fails, or to `failed` for any other error. A `blocked` or `failed` option has stopped its provider first, so a serve rule never outlives the port it names while the home runs, then closed its listeners and stopped serving it; a stop that failed is added to the state's sentence. While an option is ready, an unreferenced timer runs the provider's `check` every `serveCheckIntervalMs`, one at a time: an unknown answer makes it `degraded` until a later one is `ok`, and a blocking one stops it as a failed start does. Disposing the plugin stops the provider, closes the listeners and stops serving it, in that order, and logs a stop that failed. Every change emits `reach/state`.

## The Tailscale private provider

`src/provider.ts` and `src/tailscale.ts` run every `tailscale` command through an injected runner. The runner starts the binary with an argument list, never a shell, and nothing runs through `sudo`.

| Check | Command | Refusal |
| --- | --- | --- |
| Installed | `tailscale version` | `TAILSCALE_NOT_INSTALLED` |
| Running and signed in | `tailscale status --json`, `BackendState` is `Running` | `TAILSCALE_NOT_LOGGED_IN` |
| HTTPS certificates on | `CertDomains` names this machine | `TAILSCALE_HTTPS_DISABLED` |
| The configured address is this machine's | `Self.DNSName` | `TAILSCALE_ADDRESS_MISMATCH` |
| Funnel is off for the address | `tailscale serve status --json`, `AllowFunnel["<name>:<servePort>"]` | `TAILSCALE_FUNNEL_ON`, naming `tailscale funnel --https=<servePort> off` |
| No other rule holds the serve port | `tailscale serve status --json`, then `tailscale serve --https=<servePort> off` (`--http`, `--tcp` for those kinds) and the status again | `TAILSCALE_SERVE_CONFLICT` when the removal fails or the port is still served |
| The person's user may configure serve | `tailscale serve --bg --https=<servePort> http://127.0.0.1:<listenerPort>` | `TAILSCALE_SERVE_NOT_PERMITTED`, with the one command the person runs: `sudo tailscale set --operator=$USER` |

`readServeRules` reads `tailscale serve status --json` as the JSON of Tailscale's `ipn.ServeConfig` (tailscale/tailscale `ipn/serve.go`; `cmd/tailscale/cli/serve_legacy.go` marshals it): `TCP` keyed by port with `HTTPS`, `HTTP` or `TCPForward`, `Web` keyed by `<name>:<port>` with `Handlers` by mount point, `AllowFunnel` keyed by `<name>:<port>`, and the same fields of each foreground session under `Foreground`. This home's own rule is HTTPS on the serve port in the background configuration with the one mount point `/` proxying to `http://127.0.0.1:<listenerPort>`. `stop` and `removeServe` run nothing when the port is not served, otherwise its `off` command, and read the status again to confirm the port is free. `check` rereads the status for Funnel and answers `unknown` when it cannot. Under C7's fallback every request on the serve target has the source `127.0.0.1`, and the listener's `Host` rule is what refuses a foreign `Host` that `tailscaled` passes through.

## The fixed listener port

`src/front.ts` binds `127.0.0.1:<listenerPort>` exclusively and relays each connection to the reach listener's assigned port once the service names it; a connection that arrives earlier is closed. A port another program holds fails with `PORT_CONFLICT`, and the service then removes any rule on the serve port, since it would forward to that program. `chooseListenerPort` picks a free port at random from C7's range, 20000 to 32767, which `delorun reach on tailscale` and setup record in the profile's row once.

## What is not built

The Funnel and self-hosted relay providers. No real tailnet or phone has exercised this package: the specs fake `tailscale` with `tests/fake-tailscale.ts`, which keeps a serve configuration in the JSON form above. A home process that dies without stopping leaves its rule in `tailscaled` until the next start or `delorun reach on|off` removes it ([C7](../../docs/contracts/c07-reach-providers.md#what-this-does-not-prove)).

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/reach` runs the specs. The end-to-end spec boots the composed studio, so it lives with the CLI, in `delo/apps/cli/tests/denial/reach/end-to-end.spec.ts`: it boots Delo's web composition in the test process with `@delo/home-auth` and this package loaded and `tailscale` faked, and drives the fixed listener port over loopback as a phone would: a refused request outside a window, the window opened on loopback, the match code the sign-in page's module computes, the local approval, the signature that creates a `tailnet-membership` session, the refusals of every action of the home's own computer, changing reach through the status route or the plugin manager included, and the removal that ends the session. It needs a current `build:artifacts`.
