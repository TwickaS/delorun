# Agent Note: web_fetch refuses loopback, link-local and private-network targets

Status: implemented

English | [中文](2026-11-06-delo-web-fetch-private-targets.zh.md)

## Problem

The stock fetch provider does not restrict destination addresses, so `web_fetch` reaches loopback addresses, private-network hosts and cloud metadata addresses as readily as public hosts. The provider's README states this. Text from a page can ask a model to fetch a URL, so a fetch can reach a service on the person's own network or a metadata address and return that service's response to the model, without the person having decided that it would.

## Decision

Delo's fetch guard refuses a `web_fetch` target in the loopback, link-local and private-network ranges, including cloud metadata addresses. The guard is on by default, and the person can turn it off in configuration. A refusal fails the tool call with the web tool's structured error. The `web_fetch` tool stays in the model's tool list, as the [web capability decision](../architecture/2026-06-24-web-capability-seam.md) requires when a provider cannot run.

The guard checks the target before a request is sent. A person who needs a local target, such as a development server on loopback, turns the guard off in configuration. The guard is off in the parity composition, so the stock scenarios replay unchanged.

## Verification

A denial test uses local stand-ins: a loopback listener, a link-local address and a private-network address that the test controls. The test fails before the guard exists and passes after it. A second test shows that the same target is reachable when the guard is off. This note's tests never contact a real service.

## Related

The [web capability decision](../architecture/2026-06-24-web-capability-seam.md) resolves a web provider at execution time, which is why the refusal is a tool error and not a removed tool.

The [per-step readiness decision](../architecture/2026-09-27-web-search-offered-by-provider-readiness.md) withholds a web tool from a model step only when that step cannot authenticate. The guard does not change that admission rule.

The [outbound proxy decision](../architecture/2026-08-27-outbound-proxy-policy.md) chooses the route each request takes. A request sent through a proxy resolves its target at the proxy, so the guard cannot check the address that the proxy resolves.

The [DeepSeek Search and Fetch API decision](../feature/2026-10-15-deepseek-search-fetch-api.md) adds a fetch provider whose service receives the URL. The guard checks the URL before a provider receives it, and it cannot check the addresses that the provider's service resolves.

The stock contract that this decision changes is the [web-fetch-http README](../../../../packages/web/web-fetch-http/README.md), which states that the provider reaches loopback and private-network hosts.

## Alternatives considered

**Stock behaviour.** The stock provider reaches private destinations without asking, and the person cannot see which destinations a page has caused a fetch to reach.

**A per-request prompt.** A prompt on each private target turns the decision into a routine approval that a person may give without reading the target. A refusal with an explicit switch is the stronger default.

## Consequences

A person who needs a local or private target turns the guard off.

The guard protects the targets it can check. A remote fetch provider or a proxy resolves the target on its own side, so the claim covers the addresses that Delo's denial tests cover and not every address a fetch might reach.

Delo calls the refusal enforced only for the targets that a test proves it refuses.
