---
description: "收到已签名的 GitHub webhook 时开始一次对话。需要在 DELORUN_GITHUB_WEBHOOK_SECRET 中设置密钥，并需要你自己的规则。"
---

# @delorun/bundle-webhooks

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

在“插件”中开启 **Webhook**，即可让已签名的 GitHub webhook 开始一次对话。端点 `POST /github` 只监听 `127.0.0.1:3081`；要接收 GitHub 的调用，你需要自己在它前面放一个 TLS 反向代理或隧道。

有两样东西需要你自己提供。启动 Delorun 之前先设置 `DELORUN_GITHUB_WEBHOOK_SECRET`（一个高熵密钥，与 GitHub webhook 设置中的相同）。GitHub 端点行起初是关闭的；设置好密钥后再开启它（在此之前“插件”会显示“Needs setup”）。另外要在你的 profile 中添加一条规则，说明哪种投递创建哪个对话；此 bundle 不附带任何规则，所以仅有一次通过验证的投递不会产生任何效果。设置 `DELORUN_GITHUB_WEBHOOK_PORT` 可更改端口。它是实验性的，并且会打开一个网络监听端口，请先阅读 GitHub 审查指南。

## 需要设置

- 需要在环境中设置 DELORUN_GITHUB_WEBHOOK_SECRET，并需要你自己的规则；没有密钥时端点不会启动。

此 bundle 在新 profile 中是关闭的。[`@delorun/bundle-local`](../bundle-local/README.zh.md) 没有列出它；用户在“插件”中开启它，发行版把它作为可选包提供，而不是放进默认安装。
