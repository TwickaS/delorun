---
description: "在你允许的 chat 中，让智能体通过 browse 在你自己的 Chrome 里操作，使用你的登录状态。"
---

# @delorun/bundle-real-browser

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中添加 **你自己的浏览器**，即可让智能体在你已登录的 Chrome 中，完成你在 chat 里允许的任务。智能体会先询问；你没有允许的 chat 永远碰不到你的浏览器，[`@delorun/bundle-browser`](../bundle-browser/README.zh.md) 的隔离浏览器保持不变。指南见[使用你自己的浏览器](../../docs/guide/everyday-use/use-your-own-browser.zh.md)。

此 bundle 带有 Delorun 固定版本的 [browse](https://github.com/anomalyco/browse)（MIT，Anomaly 出品）：每个平台的变体都带有该系统的 browse 程序，构建发行版时逐字节对照锁文件中的固定值检查；linux-x64 变体还带有 Windows 程序，供在 WSL 中使用、而 Chrome 在 Windows 上时使用（在驱动行上设置 `variant: windows-x64`）。这份副本从不自行更新。它的行是 browse 驱动 `browser-use-browse`（在你开启前保持关闭），以及技能 [`@delorun/skill-real-browser`](../skill-real-browser/package.json)，智能体只在驱动开启时加载它。驱动在 home 的同一个文件夹中运行 browse 的程序，所以一次 MCP 同意即可覆盖所有 chat。browse 没有 Windows on Arm 版本的程序。它是实验性的。

## 需要设置

- 驱动需要 browse 扩展与这台电脑配对一次。在已配对的浏览器连接之前，“插件”会显示“需要设置 · 需要连接 Chrome”，并附上步骤：从 Chrome 应用店添加扩展，选择 **获取配对码**，然后在扩展的选项中输入配对码。配对码只能在电脑上获取；已配对的手机不能发起配对。检查只读取 browse 的 `browsers.json`，从不读取它的令牌文件。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中添加它，发行版把它作为可选包提供，而不是放进默认安装。
