# @delorun/plugin-thinking-rsvp

English | [中文](README.zh.md)

The Thinking tab: read the model's reasoning and its reply word by word, in the studio's right sidebar, as the model writes them. Off by default: a person turns it on under Components on the Delorun studio page of the sidebar's Plugins. The user guide is [Read the model's thinking word by word](../../docs/guide/everyday-use/thinking-tab.md).

## Using the tab

Open the right Sidebar and pick **Thinking**. The tab follows the latest turn of the chat you are in.

- **The band** shows one word at a time, at a fixed place, with the letter your eye fixes on marked, so you read without moving your eyes. A word ending a sentence or clause holds the band a little longer.
- **The page** keeps every word legible: what you have read sits above the band and what is still ahead sits below it, each part labelled Reasoning or Reply. Scroll either side to look back or ahead; the band keeps its place.
- **Read** chooses the reasoning, the reply, or both in the order the model wrote them.
- **Pace** chooses how the band moves:
  - **Live** shows each word as the model writes it.
  - **Set rate** plays at the words a minute you choose, from 100 to 1,000.
  - **Model's rate** plays at the rate the model writes, measured over its newest words, and at your set rate until it is known.
- **Delay**, at a set rate or the model's, holds each word back until it has been written for the seconds you choose, up to 30, so you read a steady stream behind the model.
- **Playback**: play and pause, step one word back or forward, start again, and skip to the newest word. With reduced motion turned on in your system, the tab starts paused.

Your choices stay in this browser. The copy is in English and Chinese, and Chinese and Japanese text, written without spaces, is read word by word too.

## Contract

- **Browser-only, optional.** [`@delorun/bundle-studio`](../bundle-studio/README.md) inserts the row `delorun-thinking-rsvp` with `disabled: true`. The studio serves a package's `./client` half for the row that names the package, so the Host half ([`src/index.ts`](src/index.ts)) mounts nothing. The browser half registers inside an injection of `delorunStudio`, so the stock look unloads it. Its title and description in the plugin manager are [`locale/en.json`](locale/en.json) and [`locale/zh.json`](locale/zh.json). The icon ([`icon.svg`](icon.svg), [`ThinkingArtwork.tsx`](src/client/ThinkingArtwork.tsx)) is drawn for Delorun's plugin list; changes to it need the owner's approval.
- **The tab** ([`src/client/index.ts`](src/client/index.ts)) registers the `thinking-rsvp` tab type, kept mounted while hidden so the reader keeps its place, an entry on the Sidebar's start page, and its body in the `sidebar.right.pane.tab` seat. It needs the studio's `slots`, `locale`, `sessions` and `sidebarRightTabs` services, and `delorunStudio`.
- **One feed per Session** ([`src/client/feed.ts`](src/client/feed.ts)) folds the Session's event window into the latest turn's page: each reasoning and reply block of each step is a part, keyed `<turn>:<step>:<block>`, with its complete words.
  - A live chunk appends to its block and reads only the words it completed, so earlier words keep their objects; a word is complete once whitespace follows it or its block ends. Each word carries when the page received it, on the browser's clock; a word that arrived settled carries 0.
  - The settled message keeps a block whose text confirms or extends what streamed and replaces one it contradicts, in place. An attempt that settles with nothing drops its parts. A replaced or prepended window, or a missed revision, rebuilds the page. Word keys do not depend on the attempt, so the reader keeps its place across all of these.
  - A newer turn starts a new page; an older one is not read. The page publishes at most once an animation frame.
  - The feed reads the window only while the tab observes it. It is released when its Session's scope ends or the plugin unloads.
- **The controller** ([`src/client/controller.ts`](src/client/controller.ts)) decides which word the band shows from the clock alone, one word at most per call: the interval is a minute over the words a minute, times the word's dwell, and a word waits until it has been written for the delay. The model's rate is measured over its newest 30 written words, needs at least 5, and is kept between 60 and 1,500 words a minute.
- **The words** ([`src/client/words.ts`](src/client/words.ts)) are the text's runs between whitespace, shown without Markdown markup: emphasis marks, code backticks, link syntax (the link text stays), and at a line's start heading hashes, list bullets, quote marks, rules and code fences (the code lines stay). Each word is judged alone, so a marker split across chunks never changes an earlier word or its key. A run of Han, Hiragana or Katakana is split by `Intl.Segmenter`, with punctuation kept on the word before it. The page's text around the band is cleaned the same way.
- **Preferences** are a browser-persisted store ([`src/client/store.ts`](src/client/store.ts)), key `delorun.thinking-rsvp.reader.v2`. The pane reads them through `readerSettings`, so a field it cannot use falls back to its default and a number is kept inside its range.

## Development

`pnpm run build` writes `lib/index.js` and `lib/client.js` with upstream's client preset (`pnpm --filter @delorun/plugin-thinking-rsvp run build`). The browser half inlines the session and model types' small helpers and imports only the page's own modules.

[`tests/words.client.spec.tsx`](tests/words.client.spec.tsx), [`tests/feed.client.spec.tsx`](tests/feed.client.spec.tsx) and [`tests/controller.client.spec.tsx`](tests/controller.client.spec.tsx) cover the words, the feed and the controller without React, the feed against upstream's `MutableSessionEventSource`. [`tests/pane.client.spec.tsx`](tests/pane.client.spec.tsx) renders the tab in jsdom, and [`tests/plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) covers its registrations, the stock look and each feed's release. The row's presence and `disabled: true` are asserted in `@delorun/bundle-local`'s composition specs.
