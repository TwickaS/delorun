---
description: "你在 Delorun 预览版中可能遇到的毛边，每条都写明会发生什么以及该怎么做：平台、撤销的范围、WSL2 内的手机访问、密钥检查、手机宽度下的间距、安装插件，以及文档语言。"
---

# 已知问题

[English](known-issues.md) | 中文

## 摘要

本页列出你在预览版中可能遇到的毛边。每一条都写明会发生什么以及该怎么做。任何影响安装、第一次聊天、更新、你的数据或安全的问题，都会在发布前修复，所以这份清单里是较小的问题，以及属于设计一部分的限制。你不需要任何前置知识。如果你遇到这里没有的问题，请告诉项目（[故障排查](troubleshooting.md#when-nothing-here-fits)说明了方法）。

## 目录

- [Delorun 在哪里运行](#where-delorun-runs)
- [撤销涵盖什么](#what-undo-covers)
- [WSL2 内的手机访问](#phone-access-from-inside-wsl2)
- [密钥检查](#the-key-check)
- [手机宽度下的间距](#phone-width-spacing)
- [触摸屏上的右侧边栏按钮](#the-right-sidebar-button-on-a-touch-screen)
- [开放网络下命令被拒绝](#commands-refused-with-an-open-network)
- [安装插件](#installing-a-plugin)
- [文档语言](#documentation-languages)

<a id="where-delorun-runs"></a>
## Delorun 在哪里运行

**会发生什么。** Delorun 在 Linux（x64 和 arm64）上运行，也可通过 WSL2 在 Windows 上运行。它不能在 macOS 或原生 Windows 上运行。

**该怎么做。** 在 Windows 上，请安装 WSL2 并在其中运行 Delorun（[安装与首次运行](install.md#windows-through-wsl2)）。在 macOS 上，没有受支持的方式运行 Delorun；[路线图](roadmap.zh.md#next)把桌面应用列为下一阶段。

<a id="what-undo-covers"></a>
## 撤销涵盖什么

**会发生什么。** “撤销一切”涵盖 harness 和你的聊天：你的配置、插件和设置。它不涵盖 agent 对工作区文件所做的事，因为工作区检查点尚未构建。

**该怎么做。** 请用 git 管理你的工作区，并在让 agent 修改许多文件之前先提交，这样 git 就能撤销 agent 所做的改动。

<a id="phone-access-from-inside-wsl2"></a>
## WSL2 内的手机访问

**会发生什么。** 通过 Tailscale 的远程访问可以工作，但 WSL2 无法解析你 tailnet 的 `*.ts.net` 名称。在 WSL2 内的浏览器中打开 studio 的 tailnet 地址可能失败，而同一个地址在你的手机上可以打开。

**该怎么做。** 从手机或 Windows 上的浏览器打开该地址（[用手机访问 studio](reach.md)）。

<a id="the-key-check"></a>
## 密钥检查

**会发生什么。** 首次设置和设置 → 模型中的检查会告诉你，某个提供方是否接受你的密钥。它向提供方请求模型列表，不发送任何聊天，所以不花费任何费用。通过检查的密钥，仍可能是一个你没有权限使用的模型的密钥。

**该怎么做。** 如果密钥检查通过后第一次聊天仍然失败，请打开设置 → 模型，检查你选择的模型。

**部分提供方的情况。** 少数提供方（例如 OpenRouter、Hugging Face 和 NVIDIA）向所有人公开其模型列表，所以请求该列表并不能证明你的密钥有效。对这些提供方，Delorun 会如实说明，并把密钥保存为“Key saved, not tested”（密钥已保存，未测试）。

**对这些提供方该怎么做。** 开始一次聊天。第一次聊天就是测试。

<a id="phone-width-spacing"></a>
## 手机宽度下的间距

**会发生什么。** 在较窄的手机屏幕上，少数标题（例如设备中的“Asking to connect”和品牌标题）会比其他标题向右偏几个像素。没有任何内容被隐藏，也没有任何功能失效。

**该怎么做。** 什么都不用做，这只是外观上的小问题。

<a id="the-right-sidebar-button-on-a-touch-screen"></a>
## 触摸屏上的右侧边栏按钮

**会发生什么。** 在触摸屏上，打开右侧边栏的按钮点击区域很小，所以点在其边缘附近可能点不中。

**该怎么做。** 点按该按钮的中心。

<a id="commands-refused-with-an-open-network"></a>
## 开放网络下命令被拒绝

**会发生什么。** 在 Linux 桌面上，网络为开放的命令会被拒绝；请把工作区的网络设为白名单或关闭，或在设置中接受风险。拒绝信息会指出命令可能借以在沙箱之外执行操作的套接字（显示服务器、会话总线）。检查在命令启动时进行。

**该怎么做。** 在“设置”→“安全”→“网络”中，为该工作区选择白名单或关闭。若仍要运行命令，请打开“开放”旁的“即使桌面套接字可被访问也运行命令”（[安全](safety.md#the-network-setting)）。

<a id="installing-a-plugin"></a>
## 安装插件

**会发生什么。** `delorun plugin` 在你的 Delorun home 内运行 DeepSeek Harness 的插件安装器，不带 Delorun 的保护。插件拥有与 Delorun 相同的完全访问权限，而且在你安装之后，Delorun 不会再次检查插件的文件。

**该怎么做。** 只安装你信任的插件，且来自你信任的来源。如果某个插件行为异常，请用 `delorun recover safe-mode` 以安全模式启动（[更新](updates.md#going-back)）。

<a id="documentation-languages"></a>
## 文档语言

**会发生什么。** 部分指南页面只有英文版，部分中文页面落后于其英文原文。从中文页面指向没有译文的页面的链接，会打开英文页面。

**该怎么做。** 在中文页面缺失或过时的地方，请阅读英文页面。
