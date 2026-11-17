---
description: "让智能体通过 Playwright，在这台电脑上的 Chromium 浏览器中打开页面、点击和阅读。"
---

# @delorun/bundle-browser

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **浏览器**，即可让智能体在这台电脑上的真实浏览器中浏览。它使用 Playwright 提供方，并启动由它自己管理的无头浏览器：你装有 Google Chrome 时使用 Chrome，并使用它自己的全新配置文件，从不使用你的 Chrome 配置文件；否则使用 Playwright 的 Chromium 版本。

同一时间只能开启一个浏览器提供方。若要改用 Chrome DevTools，请关闭 `browser-use-playwright-mcp` 行，并在你 profile 的 `cordis.patch.yml` 中开启 `browser-use-chrome-devtools-mcp` 行。Stagehand 需要它自己的模型（`model.modelName` 和 `model.apiKey`），所以在你配置之前它的行保持关闭。

装有 Chrome 时不需要别的东西。没有 Chrome 时，需要它的 Playwright 所需的 Chromium 版本，由 Playwright 下载到它自己的缓存中。它是实验性的。

## 需要设置

- Stagehand 在你给它一个模型之前保持关闭；Playwright 提供方在装有 Chrome 时启动 Chrome，此时无需设置。没有 Chrome，或在 `browser-use-playwright-mcp` 行上设置了 `browser: chromium` 时，它需要它的 Playwright 所需的 Chromium 版本，也只有这时 Delorun 更新后才可能需要重新下载。下载之前，“插件”会显示“需要设置 · 需要下载 Chromium”，并附上为该版本运行 Playwright 自带安装程序的命令；浏览器步骤会让智能体停下，请你完成设置。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
