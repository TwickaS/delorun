---
description: "让智能体通过 Cua Driver SDK，在 Linux 和 Windows 上查看并操作桌面窗口。macOS 上请用“Computer use”。"
---

# @delorun/bundle-computer-use-driver

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **Computer use (Cua Driver)**，即可让智能体通过 Cua Driver SDK 检查并操作桌面窗口。截图会发送给接受图像的模型。

它在 Linux 和 Windows 上运行。在 macOS 上，“插件”会显示它不可用并指出所在平台；请在那里使用 **Computer use**。两者使用同一个提供方槽位，所以不要同时开启。请把桌面权限授予启动 Delorun 的程序；此 bundle 不会更改任何权限。它是实验性的。

## 需要设置

- 需要启动 Delorun 的程序拥有桌面权限。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
