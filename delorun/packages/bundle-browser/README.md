---
description: "Lets the agent open pages, click and read in a Chromium browser on this computer, through Playwright."
---

# @delorun/bundle-browser

English | [中文](README.zh.md)

## Summary

Switch on **Browser** in Plugins to let the agent browse in a real browser on this computer. It uses the Playwright provider with a headless browser it launches itself: Google Chrome when you have it installed, in a fresh profile of its own and never your Chrome profile, and otherwise Playwright's Chromium build.

Only one browser provider can be on at a time. To use Chrome DevTools instead, turn off the `browser-use-playwright-mcp` row and the `browser-use-chrome-devtools-mcp` row on in your profile's `cordis.patch.yml`. Stagehand needs a model of its own (`model.modelName` and `model.apiKey`), so its row stays off until you configure it.

With Chrome installed it needs nothing else. Without Chrome it needs the Chromium build its Playwright expects, which Playwright downloads into its own cache. It is experimental.

## Needs setup

- Stagehand stays off until you give it a model; the Playwright provider launches Chrome when it is installed, and then needs no setup. Without Chrome, or with `browser: chromium` set on the `browser-use-playwright-mcp` row, it needs the Chromium build its Playwright expects, and only then can a Delorun update need a new download. Browser picks Chrome or Chromium when Delorun starts, so after you install or remove Chrome, restart Delorun (`delorun stop`, then `delorun start`). Until it is downloaded, Plugins shows "Needs setup · Chromium download" with the command that runs Playwright's own installer for that exact build, and a browser step tells the agent to stop and ask you to finish setup.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
