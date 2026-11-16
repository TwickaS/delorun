# @delorun/plugin-downloads

The studio's downloads panel. It lists every plugin the install queue is working on, with its icon, name, progress and place in the line, and lets the person cancel a queued or running install, or retry or remove one that failed.

## What it shows

| Where | What |
| --- | --- |
| A computer | A floating card at the bottom right, above the page and the setup guide's window. The header reads "Installing 2 of 5" and folds the card down to one line. Only the running bar takes the accent. When the last install finishes, "5 plugins added" shows for a few seconds and the card hides. A failure keeps the card open until it is dismissed. |
| A phone, in the setup guide | `OnboardingDownloadsRow`: one muted line above Back and Continue with a thin grey progress line. No accent, no motion beyond the progress. A failure shows as a small neutral marker. Tapping the line lists the plugins in place. |
| A phone, elsewhere | A header download icon with a count badge. It opens a bottom sheet with the same list. |

The card appears only while something is queued or has just finished. Reduced motion turns the fades and the fold off. A polite live region speaks a completion or a new failure once; it never speaks a percentage.

## The data seat

The panel reads a `DownloadsSource` and does not know the install queue's remote:

```ts
interface DownloadsSource {
  snapshot(): readonly DownloadItem[]   // stable until an item changes
  subscribe(listener: () => void): () => void
  cancel(key: string): void
  retry(key: string): void
  remove(key: string): void
}
```

A `DownloadItem` has `key` (the package name), `title`, `iconUrl`, `state`, `receivedBytes`, `totalBytes`, `position` and `failure`. The states are `queued`, `waiting-for-unlock`, `downloading`, `verifying`, `installing`, `ready`, `needs-reload`, `failed` and `cancelled`.

`createFakeDownloadsSource(items)` holds the items in memory; its `set` and `update` drive tests and the harness page. `createRemoteDownloadsSource()` is the adapter for `@delorun/plugin-packs`' remote actions; until it is wired it reads an empty list.

## In the setup guide

`plugin-onboarding` renders `<OnboardingDownloadsRow />` above Back and Continue at phone width. The row reads the source this plugin provides, and while it shows, the header icon stays out of the way.

## Look

Surfaces use studio design tokens only. Copy is in `src/client/locales.ts` (English and Chinese, sentence case).

## Tests

`pnpm exec vitest run --config delorun/vitest.config.ts delorun/packages/plugin-downloads` runs the component tests: each state, the summary and its hide, a failure that stays, collapse and expand, the quiet row, the badge and the keyboard.
