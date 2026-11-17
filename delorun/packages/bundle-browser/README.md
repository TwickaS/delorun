---
description: "Lets the agent open pages, click and read in a Chromium browser on this computer, through Playwright."
---

# @delorun/bundle-browser

English | [中文](README.zh.md)

## Summary

Switch on **Browser** in Plugins to let the agent browse in a real Chromium browser on this computer. It uses the Playwright provider with a headless browser it launches itself.

Only one browser provider can be on at a time. To use Chrome DevTools instead, turn off the `browser-use-playwright-mcp` row and the `browser-use-chrome-devtools-mcp` row on in your profile's `cordis.patch.yml`. Stagehand needs a model of its own (`model.modelName` and `model.apiKey`), so its row stays off until you configure it.

Needs a Chromium browser the provider can start. It is experimental.

## Needs setup

- Stagehand stays off until you give it a model; the Playwright provider needs a Chromium browser on this computer.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
