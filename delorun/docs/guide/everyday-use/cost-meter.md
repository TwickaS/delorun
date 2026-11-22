---
description: "See what a chat costs: turning on the cost meter, reading the figure under the message box and its breakdown, how prices are set and overridden, and what the estimate leaves out."
---

# See what a chat costs

English | [中文](cost-meter.zh.md)

## Summary

This page shows how to see an estimate of what a [chat](../../reference/glossary.md#chat) has spent, under the message box. It helps when you pay a provider by use and want to know which chats are expensive. You need Delorun running with a model provider ([Model providers](../get-started/providers.md)). The glossary describes the [cost meter](../../reference/glossary.md#cost-meter). The meter is off until you turn it on, and it makes no request of its own: it adds up the usage the provider already reported.

## Contents

- [Turn it on](#turn-it-on)
- [What it shows](#what-it-shows)
- [Prices](#prices)
- [What it does not count](#what-it-does-not-count)
- [Next](#next)

## Turn it on

Open Plugins in the sidebar and open **Delorun studio**. Under Components, find **Cost meter** and turn it on; it starts at once, with no restart. You should see a figure under the message box in every chat, after the token count.

The first-run guide's Recommended plugins step offers the same switch.

## What it shows

The box shows what this chat cost, such as `$0.42`. When a chat has started subagents or teammates, it shows two figures, `$0.42 · $0.61 with agents`: this chat alone, then this chat with the chats it started.

Select it to see the breakdown: one row for each model, with its requests, tokens and cost. Each row opens into input, cache write, cache read and output tokens. With agents, a row for this chat comes first, then one for each agent it started, costliest first.

The figure is an estimate. A request with no price in the table is listed as such rather than guessed.

## Prices

Prices come with Delorun and are checked against each provider's published prices when a release is prepared. Long prompts and DeepSeek's peak hours are priced as the providers do. Nothing leaves your computer to work them out.

<details>
<summary>Edge cases</summary>

- If a chat runs a model the price table does not know, then the breakdown lists its requests as unpriced and says so.
- If the figure differs from your invoice, then check [What it does not count](#what-it-does-not-count). The invoice is the authority.
- If a price changed after your release, then override it as described under Go further.
- If you reload, resume or fork a chat, then the total is the same, because it is worked out from the chat's saved history.
- If you turn the meter off, then the figure disappears. Your chats keep their history.
- If the settings you give the plugin are malformed, then the plugin stops at load. Fix them or remove them.

</details>

<details>
<summary>Go further</summary>

An entry under `prices` in the plugin's settings replaces the price table's entry for that model, or adds a model. Each entry names a `model` (a prefix of the model id; the longest matching prefix wins) and four rates in US dollars per million tokens: `input`, `output`, `cacheRead` and `cacheWrite`. Add `provider` to limit the entry to one provider, `longContext` for a higher rate above a prompt size, or `peak` for rates in the provider's busy hours. [Changing your harness](../customising/changing-your-harness.md) explains where plugin settings live and how to undo a change.

</details>

## What it does not count

The meter adds up the chats it can see in this studio. It does not count:

- **External agents.** Claude Code, Codex and other external agents run as their own programs outside the studio, so their usage is not counted. A chat that uses them shows a note, such as "2 external agents run outside this studio and are not counted."
- **Batch prices.** Some providers charge less for requests sent in a slower batch.
- **Fast mode.** Some providers charge more for a faster mode of a model.
- **One-hour cache writes.** Some providers charge more to keep a cached prompt for an hour instead of the default shorter time.
- **Discounts** that a provider gives your account.
- **Chinese public holidays.** DeepSeek's busy-hour prices follow a weekday schedule in UTC, and the meter does not adjust that schedule for Chinese public holidays.

## Next

- Start chatting: [Daily use](daily-use.md).
- Choose cheaper or other models: [Model providers](../get-started/providers.md).
