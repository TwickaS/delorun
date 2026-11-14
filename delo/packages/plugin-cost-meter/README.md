# @delo/plugin-cost-meter

An estimate of what each chat has cost, shown under the composer, with the chats it started added up under it. Off by default: a person turns it on under Components on the Delo studio page of the sidebar's Plugins.

## What it shows

A pill under the message box reads this chat's cost, and reads two figures once a subagent or teammate has cost anything: this chat alone, then this chat with the agents it started. The dialog behind the pill lists each model's requests, tokens and cost, then input, cache write, cache read and output tokens. With agents, each chat the person opened or an agent started has its own row, costliest first, and the row of a chat that runs outside the studio is marked as not counted.

## Prices

`src/prices.ts` holds the table: USD per million tokens, with each source's URL and the date it was checked. A model id matches by its longest prefix, optionally restricted to one provider; a long-prompt rate and DeepSeek's weekday peak hours are part of an entry. `Config.prices` replaces an entry with the same model and adds any other, so a deployment prices a model without a release. The table is part of the projection's version, so editing a price recomputes every chat's figure.

A request whose model matches no entry is counted but priced as unknown, and the dialog says so. Nothing leaves the computer to work out a figure: the plugin reads the usage the provider reported and makes no request of its own.

## The projection

`costMeter` is a session projection (`src/projection.ts`): it folds each chat's saved history, taking the model from the latest request header and the usage each answer or failed attempt reported, so a reload, resume or fork shows the same total, and a retried attempt is counted as the built-in token count counts it. Nothing it computes reaches a model request.

The session list carries each chat's cost for the studio's agent roll-up; the client walks the chats a chat started through their parent links and asks for any it has not seen when the dialog opens.

## Configuration

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the plugin runs. Off by default. |
| `prices` | Entries that replace or add to the bundled table. Malformed settings stop the plugin at load. |

## What it does not model

Batch prices, US-only routing, fast mode, one-hour cache writes, discounts and DeepSeek's holiday calendar. Libraries a program loads are not relevant here. The icon is drawn for Delorun's plugin list; changes to it need the owner's approval.
