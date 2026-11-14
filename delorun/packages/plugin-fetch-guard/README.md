---
description: "The optional pre-connection guard behind Delorun's `web_fetch` refusals, for maintainers changing which destinations the HTTP fetch provider refuses before it connects, and how a refusal reaches the model."
---

# @delorun/plugin-fetch-guard

English | [中文](README.zh.md)

## Summary

`@delorun/plugin-fetch-guard` provides the `fetchGuard` service, which the `http` fetch provider of [`@deepseek-ai/dsh-web-fetch-http`](../../../packages/web/web-fetch-http) consults before every hop of a fetch — the initial request and each redirect target. The provider resolves a hop's hostname first, so the guard classifies the addresses the connection would actually use, never just the name; a refusal throws a typed error that propagates as the fetch's failure and that the model reads verbatim, and no connection opens. The service is optional at its consumer: the provider reads it per hop with `ctx.get()`, so mounting or unmounting this plugin changes the next request without reloading the provider, and no mounted guard means no per-hop resolution. Stock's composition does not mount the plugin, and stock's `web_fetch` therefore fetches loopback and private-network destinations. `@delorun/bundle-local` mounts it on, so the CLI profile that `delorun` starts refuses them, and `@delorun/bundle-headless` mounts it on for `delorun headless`; both starts require the row, and a Host whose row did not start or whose `fetchGuard` service is absent is stopped after boot, so `web_fetch` never runs unguarded under them ([`compose.ts`](../../apps/cli/src/compose.ts)); the desktop app runs upstream's profiles, which do not mount it and fetch those destinations as stock does; the Config default stays the parity value, off, and the parity composition keeps the row disabled, so a recorded stock scenario replays unguarded. This is Delorun's C16 switch `fetch_guard`.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## Contract

- **Refusal matrix.** With the switch on, the guard refuses a hop when any address it resolved to is a loopback address (`127.0.0.0/8`, `::1`), a link-local address (`169.254.0.0/16`, `fe80::/10`), an RFC1918 private address (`10/8`, `172.16/12`, `192.168/16`) or a deprecated IPv6 site-local one (`fec0::/10`), an IPv6 unique-local address (`fc00::/7`), a shared address (`100.64.0.0/10`, the carrier-grade NAT range a tailnet and its API live in), a multicast address (`224.0.0.0/4`, `ff00::/8`), a reserved address (`240.0.0.0/4`, which holds the broadcast address `255.255.255.255`, and the IPv6 IPv4-translated `::ffff:0:0:0/96`), or the unspecified address (`0.0.0.0`, `::`). An IPv6 destination that reaches an IPv4 address is classified as that IPv4 address: an IPv4-mapped, IPv4-compatible or NAT64 one (`64:ff9b::/96`, and the local-use `64:ff9b:1::/48` deployed as a /96) by its low 32 bits, a 6to4 one (`2002::/16`) by the 32 bits after the prefix, and a Teredo one (`2001::/32`) by its client address, the inverted low 32 bits. An address the classifier cannot parse is refused too: a guard that cannot tell where a connection would go does not wave it through. Every other address is allowed ([`guard.ts`](src/guard.ts)). An IP-literal destination, IPv6 in URL brackets (`http://[::1]/`) included, is classified as that address without a lookup.
- **Refusal.** A refused hop raises `FetchGuardRefusedError` with a code, the host as the request spelled it, and a message naming both and nothing else — no resolved address, no interface — so the refusal can be quoted into a tool result without leaking more than was asked.
- **Every hop.** The guard sits outside the provider's redirect loop: the initial request and each same-origin redirect target are resolved and checked before their connection opens, so a hostname that rebinds to a private address between hops is refused at that hop.
- **Pinned connection.** The addresses the guard approved are the only ones that hop may connect to: the provider sends a direct hop on an agent whose resolver answers exactly those addresses, in the order the guard saw them, and fails the hop for a hostname it never approved. A resolver that answers the guard's lookup and the connection's own differently therefore cannot carry the fetch to an address the guard never saw. A hop the installed proxy routes keeps the proxy's dispatcher, because the proxy resolves the target itself.
- **Switch off.** `enabled: false` is the default and the parity value. The plugin then provides no service, so the provider reads its absence per hop and runs unguarded, with no per-hop hostname resolution: the fetch is byte-identical to stock's.
- **Consumers.** The service is read by name, not imported: any plugin that provides `fetchGuard` guards the provider's hops, and the provider needs no reload when the guard changes. The `web_fetch` tool refuses with the same typed error it reports for other fetch failures; the guard covers the `http` provider only — commands, and a proxy or remote fetch provider you configure, are outside it.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Refuse the destinations of the refusal matrix before each connection opens. Off — C16 switch `fetch_guard` — the plugin provides no service, and `web_fetch` behaves as stock's. |

## Known limitations

- The guard judges what `node:dns` resolved for the hop's hostname, and the pinned connection then connects to exactly those addresses, so a resolver that rebinds between the guard's lookup and the connection cannot redirect the hop. The pin covers a direct connection: a hop the installed proxy routes is resolved by the proxy, outside the pin.
- A refusal names the host and the reason, not the resolved address; a hop refused for one refused address among several reports neither which one nor the others.
- The guard covers only the `http` fetch provider. The `deepseek` provider's own API calls and the proxy policy are outside it.

## Tests

[`tests/guard.spec.ts`](tests/guard.spec.ts) covers the refusal matrix free of Cordis: every refused range and spelling, the public-looking addresses that pass, and the typed refusal's fields. [`tests/service.spec.ts`](tests/service.spec.ts) mounts the service and covers its switch, its refusals, and what unmounting does to the name. [`tests/provider-guard.spec.ts`](tests/provider-guard.spec.ts) mounts the real provider plugin and the guard plugin as siblings over mocked `node:dns` and `undici` — no network runs — and proves the whole chain: the hostname resolution before the connection, the typed refusal before any connect, a rebinding redirect hop refused, the approved hop sent on the agent that pins it, a stub guard plugin mounted as a sibling consulted by name, a guard mounted after the provider read from the next hop on, and the unguarded runs with no lookup at all. [`tests/pinned-connection.spec.ts`](tests/pinned-connection.spec.ts) proves the pin at the real transport: a loopback listener serves a body, a resolver answers the guard a documentation address and would answer the connection loopback, and the fetch reaches neither the listener nor the body.
