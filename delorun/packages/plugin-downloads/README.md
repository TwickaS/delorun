---
description: "The studio's downloads panel: every plugin the install queue is working on, with progress and place in the line, and buttons to cancel, retry or remove."
---

# @delorun/plugin-downloads

English | [中文](README.zh.md)

The studio's downloads panel. It lists every plugin the install queue is working on, with its icon, name, progress and place in the line, and lets the person cancel a queued or running install, or retry or remove one that failed.

## What it shows

| Where | What |
| --- | --- |
| A computer | A floating card at the bottom right, above the page and the setup guide's window. The header reads "Installing 2 of 5" and folds the card down to one line. Only the running bar takes the accent. When the last install finishes, "5 plugins added" shows for a few seconds and the card hides. A failure keeps the card open until it is dismissed. |
| A phone, in the setup guide | `OnboardingDownloadsRow`: one muted line above Back and Continue with a thin grey progress line. No accent, no motion beyond the progress. A failure shows as a small neutral marker. Tapping the line lists the plugins in place. |
| A phone, elsewhere | A header download icon with a count badge. It opens a bottom sheet with the same list. |

A running download's status gives its percentage (the bytes received while the queue holds no size), then its speed and, with a known size, the time left, such as `25% · 4.0 MB/s · ~3.8s left`. The page measures them from the received bytes over the last five seconds, with the formats of the terminal's install display (`@delorun/install/transfer`, reached through `@delorun/plugin-packs/transfer`); the speed shows once two readings a second apart exist and goes when no byte has arrived for three seconds. The progress bar's text keeps to the percentage. The card appears only while something is queued or has just finished. Reduced motion turns the fades and the fold off. A polite live region speaks a completion or a new failure once; it never speaks a percentage.

## The data seat

The panel reads a `DownloadsSource` and does not know the install queue's routes:

```ts
interface DownloadsSource {
  snapshot(): readonly DownloadItem[]   // stable until an item changes
  subscribe(listener: () => void): () => void
  cancel(key: string): void
  retry(key: string): void
  remove(key: string): void
}
```

A `DownloadItem` has `key` (the package name), `title`, `iconUrl`, `state`, `receivedBytes`, `totalBytes`, `position`, `failure` and, for a download the page runs itself, `local`. The states are `queued`, `waiting-for-unlock`, `downloading`, `verifying`, `installing`, `ready`, `needs-reload`, `failed` and `cancelled`.

`createFakeDownloadsSource(items)` holds the items in memory; its `set` and `update` drive tests and the harness page. `createRemoteDownloadsSource(ctx)` is the adapter for `@delorun/plugin-packs`' routes (`createPacksClient()`): it reads the install list while a surface subscribes (on the Host's install announcements, after a connection reset, and every 1.5 seconds while something is queued or working), and sends cancel, retry, remove and dismiss. A refusal that asks for an unlock keeps the row on "Waiting for unlock". A Host without plugin packs shows an empty list.

`startPageDownload(key, { title, retry })` (exported from `@delorun/plugin-downloads/row`) adds an install that does not go through the Host's install queue, such as the plugin manager's own install of a package that is not a plugin pack, or the browser download Browser needs, to every surface of this tab. Its item carries `local` and follows the Host's items; a Host item of the same key wins. Its starter reports `bytes(received, total)`, `installing()`, `done(reload)` or `failed(message)`; without a size the bar moves without a measure and the status says Downloading. It cannot be cancelled, a failure offers Try again only when the starter passed `retry`, and Remove takes it off. It lives only in this tab: nothing persists it and other devices do not see it.

## In the setup guide

`plugin-onboarding` renders `<OnboardingDownloadsRow />` above Back and Continue at phone width. The row reads the source this plugin provides, and while it shows, the header icon stays out of the way.

## Look

Surfaces use studio design tokens only. Copy is in `src/client/locales.ts` (English and Chinese, sentence case).

## Tests

`pnpm exec vitest run --config delorun/vitest.config.ts delorun/packages/plugin-downloads` runs the component tests: each state, the summary and its hide, a failure that stays, collapse and expand, the quiet row, the badge and the keyboard.

## Harness page

`harness/` is a static page over the fake source: `pnpm exec vite --config delorun/packages/plugin-downloads/harness/vite.config.ts` serves it on port 18571. `?scene=mixed|done|failure|unlock` picks the items, `?mode=card|row|sheet` picks the presentation and `?dark=1` the dark scheme.
