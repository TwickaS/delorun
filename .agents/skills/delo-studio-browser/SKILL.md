---
name: delo-studio-browser
description: Use when checking a change in the running studio by hand-driven browser steps, or recording one, with a script run against a studio on a loopback address in the person's own browser.
---

# Delo studio browser

`delo/apps/tools/src/studio-browser.ts` runs a Playwright-style script against a studio on this computer and can record the run to WebM. It goes through the `StudioBrowser` adapter interface in `delo/apps/tools/src/studio-browser/adapter.ts`; the first adapter, `browse`, drives the person's own Chrome through the [`browse` CLI](https://github.com/anomalyco/browse).

Use it to look at a change in the running studio by hand-driven steps, or to record one. It is not a test: the automated Playwright lanes (`pnpm run test:web:built` and the Web e2e specs) prove behavior in CI, and the [`record-browser-gif`](../record-browser-gif/SKILL.md) skill owns the GIF that a GUI pull request carries. This command can produce the WebM that skill encodes.

## Prerequisites

- `browse` is installed and its Chrome extension is paired. `check` reports both. Under WSL the Windows install is found by itself; `DELO_BROWSE_BIN` names another binary.
- The studio listens on a loopback address (`127.0.0.1`, `localhost` or `[::1]`). Start it as the root `AGENTS.md` says.

## Commands

Run from the repository root.

```sh
node_modules/.bin/tsx delo/apps/tools/src/studio-browser.ts check
node_modules/.bin/tsx delo/apps/tools/src/studio-browser.ts run --url <studio url> (--file <script.js> | --code '<js>') [--record <out.webm>] [--timeout-ms 60000] [--adapter <id>]
```

`check` prints the adapter id and the tool's status, and exits 0 when it can run. `run` prints what the script returns and exits 0 when it ran, 1 when the script or browser failed, 2 for a usage error (bad flags, a non-loopback URL, an unknown adapter, `--record` not ending in `.webm`).

The script is the body of an async function that receives Playwright's `page` and may `return` a JSON value. A worked example, with the studio listening on `http://127.0.0.1:5173`:

```js
// check-title.js
await page.goto('http://127.0.0.1:5173/')
await page.waitForSelector('main')
return await page.title()
```

```sh
node_modules/.bin/tsx delo/apps/tools/src/studio-browser.ts run --url http://127.0.0.1:5173/ --file check-title.js
```

Add `--record /tmp/studio/run.webm` to record the run as a WebM at 15 frames per second. Encode it to a GIF with the encoder that [`record-browser-gif`](../record-browser-gif/SKILL.md) describes.

## Add another adapter

Implement `StudioBrowser` (`id`, `check()`, `run(spec)`), add it to `ADAPTERS` in `adapter.ts`, and select it with `--adapter <id>` or the `DELO_STUDIO_BROWSER` environment variable. The default is `browse`.

## Rules

- The `browse` adapter drives the person's real browser profile, with their signed-in sites. Only loopback studio addresses are reachable, and that is not configurable: there is no flag or variable that widens it. Do not edit the check to allow another host.
- Each run uses its own session, limited to the studio's origin, and deletes it. Confirm with `browse session list` that no `delo-studio-` session remains after a failure.
- Never adopt, read or close a tab the run did not open.
- Scripts do not write files. `browse` refuses `page.screenshot({ path })` outside its own file roots; use `--record` or return values instead.
- A live model or provider is used only with the owner's approval.
