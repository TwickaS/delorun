# Review pass

English | [中文](README.zh.md)

The scripts that make the evidence for each review pass of the home page: the same pictures and one audit, from a production build. They measure and report; they never change the page.

## Run a pass

```sh
cd delorun/apps/website
node review/run-pass.ts --pass 1 --build
```

`--build` runs `vite build` under `nice -n 19` first, (never set it for a build that deploys); without it the existing `out/` is served. The command waits until 4 GB of memory and 5 GB of disk are free, serves `out/` on port 18680 (`--port` changes it), and writes `~/delorun-rc-release/site-pass-<n>/` (`--release-dir` changes the parent). It prints the summary counts. `--audit-only` writes `audit.md` and `report.json` without pictures, and `--suffix b` names the folder `site-pass-<n>b`. A second run of the same build writes the same file names; the folder's earlier pictures and reports are removed first.

## What the folder holds

- Pictures named `page__section__w<width>__<look>-<scheme>__<state>.png` (see `naming.ts`), listed in `index.md`.
  - Every section and the whole page at 390, 768, 1440 and 1920 px in Soft light and dark.
  - At 390 and 1440 px: the hero and the setup strip in each of the other six looks, light and dark; reduced motion; scripts off; one picture per keyboard focus stop (`k-NN`); up to three chapters of each replay (`chapter-NN`).
  - The 404, privacy and notices pages at 390 and 1440 px.
  - Worst cases (page `worst`): the longest plugin name and sentence, no headlines, a failed copy, a refused sign-up, an unknown look in the link, 320 and 1920 px.
- `audit.md` and `report.json`: the head tags of the home, privacy, notices, blog and 404 pages (the 404 page is noindex, so no canonical or og:url is expected; structured data is expected on the home page only) (title, description, canonical address, link-preview tags, structured data, present or missing); What's new recorded as absent when the build has no headlines; console errors and failed requests, sideways overflow at 320, 390, 768, 1440 and 1920 px, tap targets under 24 px, text hidden under reduced motion, accessibility violations with measured contrast ratios, tab order, skip link, focus stops with no visible style, focus on invisible elements, largest paint and layout shift on the phone profile, the weight table, and scroll smoothness at 1440 px and on the phone profile. The phone-profile paint and scroll are measured three times each and the median is judged, with the free memory noted (`review/phone-repeat.ts` repeats just those two).

Sections are found by landmark (the id, label or first heading), not by a fixed selector. A section the page lacks is listed under "Missing sections" and skipped. Replay chapters are the page's `[data-chapter]` or `[role="tab"]` controls inside the replays section.

## Files

- `run-pass.ts`: the command.
- `capture.ts`, `worst.ts`: the pictures. `audit.ts`: the measurements. `page-tools.ts`: opening pages and finding sections.
- `naming.ts`, `report.ts`: picture names and the report format, with their specs in `tests/review-format.spec.ts`.
- `serve.ts`, `browser.ts`, `resources.ts`: the static server (brotli, or gzip, for text types with `Content-Encoding` and `Vary`, as Cloudflare sends them; `report.json` records the encodings under `serverEncoding`), the browser (Playwright from `apps/tools`) and the wait for free memory and disk.
- `scroll-trace.ts`, `trace-summary.ts`: `node review/scroll-trace.ts` serves a built `out/` and traces two scrolls in headless Chromium, the hero's zoom and the wall with every picture shown, printing per run the frame intervals, dropped frames, long tasks, style, layout, paint, raster and decode time and the layer count. Options: `--out`, `--port` (18681 by default), `--runs`, `--scenario hero|wall|all`, `--width`, `--scheme`, `--cpu` (CPU slow-down) and `--trace-dir` (keeps each trace). It compares two builds on one machine; on the software renderer raster and decode cost more than on a real graphics card. The summary's spec is `tests/trace-summary.spec.ts`.

Every browser context refuses any request that is not to the local server and records it as "blocked, would have left the machine" (the sign-up field would otherwise load Turnstile from Cloudflare). The refused sign-up case runs without Turnstile.

The accessibility run needs `axe-core` in the website's dev dependencies; without it the audit records one warning and skips that run. Headless Chromium has no real GPU, so the frame rates are a floor.
