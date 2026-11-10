---
description: "The @delo/reach package, for maintainers of reach: contract C7's reach service with its provider registry, and the Tailscale private provider that connects a C4 reach listener to tailscale serve and declares the tailnet-membership identity factor."
---

# @delo/reach

## Summary

This package is the Service Definition and the first Service Provider of [contract C7](../../docs/contracts/c07-reach-providers.md). The `reach` service holds one provider per reach option and starts each option whose configuration row is on: it asks `@delo/home-auth` to serve the option's reach listener with the identity factor the provider declares, opens the listener through upstream's `ctx.connection.openReachListener` on a port the operating system assigns, and starts the provider on that port. The `reach-tailscale-private` provider declares `tailnet-membership` ([C14](../../docs/contracts/c14-oidc-passkeys.md#tailnet-membership)) and configures `tailscale serve` to the listener. The service mounts behind the C16 switch `reach` (`Config.enabled`), which `@delo/bundle-local`'s row `delo-reach` turns on; every option stays off until the person runs `delorun reach on tailscale` or answers yes in setup's Full mode.

## Contents

- [The reach service](#the-reach-service)
- [The Tailscale private provider](#the-tailscale-private-provider)
- [What is not built](#what-is-not-built)
- [Tests](#tests)

## The reach service

`GET /delo/reach/status` answers the studio, on the loopback listener and to an admitted reach session, with `{ "available": true, "options": [...] }`: each option's id, state, address and, when blocked or failed, its code and sentence (`REACH_STATUS_PATH`, `ReachSummary`). A profile without the service answers 404. The studio's Devices section and its onboarding read it.

`src/service.ts` registers the Tailscale private provider inside `ctx.effect()` and reads the `tailscalePrivate` row: `enabled` (default `false`), `address` (this machine's `https://<machine>.<tailnet>.ts.net` address) and `servePort` (default 443). An enabled row that is not an `https` `ts.net` address fails at load with `TAILSCALE_ADDRESS_MISMATCH`. Starting an option moves it to `starting`, then to `ready`, or to `blocked` with C7's code when a check fails, or to `failed` for any other error; a `blocked` or `failed` option has closed its listener and stopped serving it. Disposing the plugin stops the provider, closes the listener and stops serving it, in that order, even when the provider's stop fails. Every change emits `reach/state`.

## The Tailscale private provider

`src/provider.ts` and `src/tailscale.ts` run every `tailscale` command through an injected runner. The runner starts the binary with an argument list, never a shell, and nothing runs through `sudo`.

| Check | Command | Refusal |
| --- | --- | --- |
| Installed | `tailscale version` | `TAILSCALE_NOT_INSTALLED` |
| Running and signed in | `tailscale status --json`, `BackendState` is `Running` | `TAILSCALE_NOT_LOGGED_IN` |
| HTTPS certificates on | `CertDomains` names this machine | `TAILSCALE_HTTPS_DISABLED` |
| The configured address is this machine's | `Self.DNSName` | `TAILSCALE_ADDRESS_MISMATCH` |
| The person's user may configure serve | `tailscale serve --bg --https=<servePort> http://127.0.0.1:<port>` | `TAILSCALE_SERVE_NOT_PERMITTED`, with the one command the person runs: `sudo tailscale set --operator=$USER` |

`stop` runs `tailscale serve --https=<servePort> off`. Under C7's fallback every request on the serve target has the source `127.0.0.1`, and the listener's `Host` rule is what refuses a foreign `Host` that `tailscaled` passes through.

## What is not built

The Funnel and self-hosted relay providers. No real tailnet or phone has exercised this package: the specs fake `tailscale`.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/reach` runs the specs. `tests/end-to-end.spec.ts` boots Delo's web composition in the test process with `@delo/home-auth` and this package loaded and `tailscale` faked, and drives the reach listener over loopback as a phone would: a refused request outside a window, the window opened on loopback, the match code the sign-in page's module computes, the local approval, the signature that creates a `tailnet-membership` session, the refusals of every action of the home's own computer, and the removal that ends the session. It needs a current `build:artifacts`.
