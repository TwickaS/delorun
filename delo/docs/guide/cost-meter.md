# See what a chat costs

Delorun can show an estimate of what a chat has spent, under the message box. It is off until you turn it on.

## Turn it on

Open Plugins in the sidebar, find **Cost meter** and turn it on. The reading appears under the composer in every chat, after the token count.

## What it shows

The box shows what this chat cost, such as `$0.42`. When a chat has started subagents or teammates, it shows two figures, `$0.42 · $0.61 with agents`: this chat alone, then this chat with the chats it started.

Select it to see the breakdown: one row for each model, with its requests, tokens and cost, and each row opens into input, cache write, cache read and output tokens. With agents, a row for this chat comes first, then one for each agent it started, costliest first.

The figure is an estimate. A request with no price in the table is listed as such rather than guessed.

## Prices

Prices come with Delorun and are checked against each provider's published prices when a release is prepared. Long prompts and DeepSeek's peak hours are priced as the providers do. Nothing leaves your computer to work them out.

If a price changes before a release, an entry in the plugin's settings under `prices` replaces the one for that model.

## What it does not count

Batch prices, fast mode, one-hour cache writes, discounts and Chinese holidays are not modelled. A chat that runs a model the table does not know says so.
