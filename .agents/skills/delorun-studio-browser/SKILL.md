---
name: delorun-studio-browser
description: Use when checking a change in the running studio by hand-driven browser steps, or recording one, with a script run against a studio on a loopback address in the person's own browser.
---

# Delorun studio browser

`delorun/apps/tools/src/studio-browser.ts` drives a browser against a studio on this computer: it opens a page at a chosen viewport and colour scheme, runs JSON steps or a Playwright-style script, takes screenshots and can record the run to WebM. It goes through the `StudioBrowser` adapter interface in `delorun/apps/tools/src/studio-browser/adapter.ts`. Two adapters exist:

- `playwright` (the default) runs the headless Chromium that the repository's Playwright install provides. It has no profile and no sign-ins, and it aborts every request that leaves the studio's origin.
- `browse` drives the person's own Chrome through the [`browse` CLI](https://github.com/anomalyco/browse). It needs a `browse` version that has the `doctor`, `session` and `execute` commands (0.0.16 had them; 0.1.1 does not), and `check --adapter browse` says so when it lacks them. It runs only `--file` and `--code` scripts and `--record`.

Use the tool to look at a change in the running studio, to take screenshots for a review, or to record a walk. It is not a test: the automated Playwright lanes (`pnpm run test:web:built` and the Web e2e specs) prove behavior in CI, and the [`record-browser-gif`](../record-browser-gif/SKILL.md) skill owns the GIF that a GUI pull request carries. This command can produce the WebM that skill encodes.

## Prerequisites

- Playwright's Chromium is installed (`pnpm exec playwright install chromium` once); `check` launches it and prints its version.
- The studio listens on a loopback address (`127.0.0.1`, `localhost` or `[::1]`).
- A studio started from source needs two builds first: `pnpm run build:artifacts`, then `pnpm --filter "./delorun/packages/*" run build`. Without the second, the Delorun plugins fail to import and the studio starts without its sidebar, settings and onboarding.
- A scratch home: set `DELORUN_HOME` to a new `/tmp` folder (mode 0700) and answer setup with a `--config` file whose `profile.port` is a free port; `delorun open --print` prints the one-time sign-in link, which is good for one minute and one use.

## Commands

Run from the repository root.

```sh
node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts check
node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts run --url <studio url> \
  [--file <script.js> | --code '<js>'] [--steps <steps.json>] [--viewport 1440x900] [--scheme light|dark] \
  [--screenshot <out.png>] [--record <out.webm>] [--timeout-ms 60000] [--adapter <id>]
```

`check` prints the adapter id and the tool's status, and exits 0 when it can run. `run` prints what the script returns and exits 0 when it ran, 1 when the script or browser failed, 2 for a usage error (bad flags, a non-loopback URL, an unknown adapter, `--record` not ending in `.webm`, `--screenshot` not ending in `.png`). It needs at least one of `--file`, `--code`, `--steps` and `--screenshot`.

With the `playwright` adapter a run goes in this order: open the studio origin (a sign-in link in `--url` is followed from inside the page), wait until the network is idle, run the steps, run the script, take the `--screenshot`. The viewport defaults to 1440x900 and the scheme to light.

A script is the body of an async function that receives Playwright's `page` and may `return` a JSON value:

```js
// check-title.js
await page.waitForSelector('main')
return await page.title()
```

A steps file is a JSON array; each step has one key:

```json
[
  { "click": "text=English" },
  { "type": { "selector": "input[name=key]", "text": "hello" } },
  { "press": "Enter" },
  { "waitFor": "main" },
  { "waitMs": 300 },
  { "goto": "/settings" },
  { "screenshot": "shots/step.png" }
]
```

A screenshot of one screen at both widths and both schemes:

```sh
for scheme in light dark; do for size in 1440x900 390x844; do
  node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts run \
    --url "$(node --import tsx/esm delorun/apps/cli/src/bin.ts open --print | grep -o 'http://[^ ]*')" \
    --viewport $size --scheme $scheme --screenshot "shots/welcome-${size%x*}-$scheme.png"
done; done
```

`--record` writes a WebM at the browser's own frame rate. Encode it to a GIF with the encoder that [`record-browser-gif`](../record-browser-gif/SKILL.md) describes.

### Sign-in links with the `browse` adapter

A `browse` script that navigates straight to a sign-in link gets a 401, because that navigation sends `Sec-Fetch-Site: cross-site`. Load the studio origin's root first, then navigate from inside the page: `await page.evaluate(link => { location.href = link }, link)`. The `playwright` adapter does this itself.

## Add another adapter

Implement `StudioBrowser` (`id`, `check()`, `run(spec)`), add it to `ADAPTERS` in `adapter.ts`, and select it with `--adapter <id>` or the `DELORUN_STUDIO_BROWSER` environment variable. The default is `playwright`.

## Rules

- Only loopback studio addresses are reachable, and that is not configurable: there is no flag or variable that widens it. Do not edit the check to allow another host.
- The `browse` adapter drives the person's real browser profile, with their signed-in sites. Each run uses its own session, limited to the studio's origin, and deletes it. Confirm with `browse session list` that no `delorun-studio-` session remains after a failure. Never adopt, read or close a tab the run did not open.
- A `browse` script does not write files: `browse` refuses `page.screenshot({ path })` outside its own file roots. Use the `playwright` adapter's `--screenshot`.
- A live model or provider is used only with a maintainer's approval.
