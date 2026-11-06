# Agent Note: web_fetch refuses loopback, link-local and private-network targets

Status: proposed

English | [中文](2026-11-06-delo-web-fetch-private-targets.zh.md)

## Problem

The stock fetch provider does not restrict destination addresses, so `web_fetch` reaches loopback addresses, private-network hosts and cloud metadata addresses as readily as public hosts. The provider's README states this. Text from a page can ask a model to fetch a URL, so a fetch can reach a service on the person's own network or a metadata address and return that service's response to the model, without the person having decided that it would.

## Proposal

Delo's fetch guard would refuse a `web_fetch` target in the loopback, link-local and private-network ranges, including cloud metadata addresses. The guard would be on by default, and the person could turn it off in configuration. A refusal would fail the tool call with the web tool's structured error. The `web_fetch` tool would stay in the model's tool list, as the [web capability decision](../../implemented/architecture/2026-06-24-web-capability-seam.md) requires when a provider cannot run.

The guard would check the target before a request is sent. A person who needs a local target, such as a development server on loopback, would turn the guard off in configuration. In the parity composition the guard would be off, so the stock scenarios would replay unchanged.

## Related

The [per-step readiness decision](../../implemented/architecture/2026-09-27-web-search-offered-by-provider-readiness.md) withholds a web tool from a model step only when that step cannot authenticate. The guard would not change that admission rule.

The [outbound proxy decision](../../implemented/architecture/2026-08-27-outbound-proxy-policy.md) chooses the route each request takes. A request sent through a proxy resolves its target at the proxy, so the guard could not check the address that the proxy resolves.

The [DeepSeek Search and Fetch API decision](../../implemented/feature/2026-10-15-deepseek-search-fetch-api.md) adds a fetch provider whose service receives the URL. The guard would check the URL before a provider receives it, and it could not check the addresses that the provider's service resolves.

The stock contract that this proposal changes is the [web-fetch-http README](../../../../packages/web/web-fetch-http/README.md), which states that the provider reaches loopback and private-network hosts.

## Alternatives considered

**Stock behaviour.** The stock provider reaches private destinations without asking, and the person cannot see which destinations a page has caused a fetch to reach.

**A per-request prompt.** A prompt on each private target turns the decision into a routine approval that a person may give without reading the target. A refusal with an explicit switch is the stronger default.

## Acceptance criteria

- A denial test against local stand-ins (a loopback listener, a link-local address and a private-network address that the test controls) shows each target refused with the structured error. The test fails before the guard exists and passes after it.
- With the guard turned off, the same test reaches the same targets.
- In the parity composition the guard is off, and the stock fetch scenarios replay with no difference.
- A refused `web_fetch` call leaves the tool in the model's tool list for the following request.

## Risks

A person who needs a local or private target has to turn the guard off, because a legitimate private-network target is refused while the guard stays on.

The guard covers only the targets it can check. Remote fetch providers and proxies resolve the target on their own side, so the claim would cover the addresses that the denial tests cover and not every address a fetch might reach.

A refusal is enforced only for the targets that a test proves it refuses, so each new class of target needs its own denial test before the claim extends to it.
