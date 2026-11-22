---
description: "你在 Delorun 预览版中可能遇到的毛边，每条都写明会发生什么以及该怎么做：平台、撤销的范围、WSL2 内的手机访问、密钥检查、手机宽度下的间距、安装插件，以及文档语言。"
---

# 已知问题

[English](known-issues.md) | 中文

> 本页是英文页面的模型翻译。如有出入，以英文页面为准。

## 摘要

本页列出你在预览版中可能遇到的毛边。每一条都写明会发生什么以及该怎么做。这份清单列出这些毛边，以及属于设计一部分的限制。你不需要任何前置知识。如果你遇到这里没有的问题，请告诉项目（[故障排查](troubleshooting.zh.md#when-nothing-here-fits)说明了方法）。

## 目录

- [Delorun 在哪里运行](#where-delorun-runs)
- [撤销涵盖什么](#what-undo-covers)
- [WSL2 内的手机访问](#phone-access-from-inside-wsl2)
- [密钥检查](#the-key-check)
- [手机宽度下的间距](#phone-width-spacing)
- [触摸屏上的右侧边栏按钮](#the-right-sidebar-button-on-a-touch-screen)
- [开放网络下命令被拒绝](#commands-refused-with-an-open-network)
- [没有 bubblewrap 时命令被拒绝](#commands-refused-without-bubblewrap)
- [doctor 中的 Docker 警告](#the-docker-warning-in-doctor)
- [Face ID on phones](#face-id-on-phones)
- [Several agents at once](#several-agents-at-once)
- [安装插件](#installing-a-plugin)
- [文档语言](#documentation-languages)

<a id="where-delorun-runs"></a>
## Delorun 在哪里运行

**会发生什么。** Delorun 在 Linux（x64）上运行，也可通过 WSL2 在 Windows 上运行。Delorun 不能在 ARM（arm64）上的 Linux 上运行。它不能在 macOS 或原生 Windows 上运行。

**该怎么做。** 在 Windows 上，请安装 WSL2 并在其中运行 Delorun（[安装与首次运行](../get-started/install.zh.md#windows-through-wsl2)）。在 macOS 上，没有受支持的方式运行 Delorun；[路线图](../roadmap.zh.md#next)把桌面应用列为下一阶段。

<a id="what-undo-covers"></a>
## 撤销涵盖什么

**会发生什么。** “撤销一切”涵盖 harness 和你的聊天：你的配置、插件和设置。它不涵盖 agent 对工作区文件所做的事，因为工作区检查点尚未构建。

**该怎么做。** 请用 git 管理你的工作区，并在让 agent 修改许多文件之前先提交，这样 git 就能撤销 agent 所做的改动。

<a id="phone-access-from-inside-wsl2"></a>
## WSL2 内的手机访问

**会发生什么。** 通过 Tailscale 的远程访问可以工作，但 WSL2 无法解析你 tailnet 的 `*.ts.net` 名称。在 WSL2 内的浏览器中打开 studio 的 tailnet 地址可能失败，而同一个地址在你的手机上可以打开。

**该怎么做。** 从手机或 Windows 上的浏览器打开该地址（[用手机访问 studio](../everyday-use/reach.zh.md)）。

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

**该怎么做。** 在某个工作区第一次遇到这种情况时，对话会询问是否让该工作区中的命令照常运行；允许会记录与下方开关相同的选择。拒绝则保持拒绝，在 Delorun 重启之前，对话不会在该工作区再次询问。否则，请在“设置”→“安全”→“网络”中为该工作区选择白名单或关闭，或打开“开放”旁的“即使桌面套接字可被访问也运行命令”（[安全](../safety-and-updates/safety.zh.md#the-network-setting)）。

**使用 Docker 时会发生什么。** 这种拒绝并不只限于桌面。只要电脑上有任何程序在抽象套接字上监听，它就会生效，而正在运行的 `docker` 命令行进程（例如前台运行的 `docker compose up`）就是其中之一。它运行期间，网络为开放的工作区中的命令会被拒绝，信息为 `the command would share this computer's network, where 1 abstract Unix socket is listening`，后面跟着套接字的名称和解决办法。

**使用 Docker 时该怎么做。** 停止该 `docker` 进程，在对话询问时允许命令照常运行，或在“设置”→“安全”→“网络”中为该工作区接受风险。检查在命令启动时进行，所以已经在运行的命令不会被停止。

<a id="commands-refused-without-bubblewrap"></a>
## 没有 bubblewrap 时命令被拒绝

**会发生什么。** 在没有 bubblewrap 的 Linux 上，如果电脑有登录会话，或有 tmux 这类程序在 `/tmp` 中持有套接字，Delorun 会拒绝每一条沙箱命令，因为后备沙箱无法隐藏这些套接字。拒绝信息会说明要安装 bubblewrap。在没有这类套接字的电脑上，命令会运行，`delorun doctor` 显示 `warn sandbox`。

**该怎么做。** 安装 `bubblewrap` 软件包，然后再次启动 Delorun（见 [Delorun 保护什么](../safety-and-updates/safety.zh.md#the-sandbox)）。如果 bubblewrap 已安装但无法创建沙箱，请见[故障排查](troubleshooting.zh.md#protections-and-plugins)。

<a id="the-docker-warning-in-doctor"></a>
## doctor 中的 Docker 警告

**会发生什么。** 在没有 Docker 的电脑上，`delorun doctor` 会打印 `warn docker: Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.` Delorun 不提供 Docker 工作区，所以这条警告所说的内容与你无关。

**该怎么做。** 什么都不用做。Docker 是可选的。

## Face ID on phones

**What happens.** Face ID has three rough edges.

- A browser that cannot make a platform passkey, such as some versions of Firefox, says "This browser cannot use Face ID here" and gets no passkey.
- If you change your reach address, the passkeys made on the old address stop working. The phone says to set Face ID up again, and the old passkeys stay listed.
- While no PIN is set and no passkey is enrolled, an approved phone can still save or remove a model key with no extra check.

**What to do.** In a browser without a platform passkey, confirm actions with the PIN or at your computer. After a change of address, set Face ID up again on each phone. To make a phone confirm model-key changes, set a PIN or enrol a passkey ([Confirm with Face ID](../everyday-use/reach.zh.md#confirm-with-face-id)).

## Several agents at once

**What happens.** Multiview has three rough edges.

- With six busy panes, the main chat's first words can take up to about twice as long to appear.
- A notice from an agent, such as a refused question, is recorded in the agent's log but not yet shown in the chat.
- A Claude Code or Codex chat still shows upstream's own text for the hand-off, and a failure can appear as two red lines.

**What to do.** Pin fewer agents if the main chat feels slow. The extra text and the doubled line change nothing about the run ([Watch several agents at once](../everyday-use/agents.zh.md#watch-several-agents-at-once)).

<a id="installing-a-plugin"></a>
## 安装插件

**会发生什么。** `delorun plugin` 在你的 Delorun home 内运行 DeepSeek Harness 的插件安装器，不带 Delorun 的保护。插件拥有与 Delorun 相同的完全访问权限，而且在你安装之后，Delorun 不会再次检查插件的文件。

**该怎么做。** 只安装你信任的插件，且来自你信任的来源。如果某个插件行为异常，请用 `delorun recover safe-mode` 以安全模式启动（[更新](../safety-and-updates/updates.zh.md#going-back)）。

<a id="documentation-languages"></a>
## 文档语言

**会发生什么。** 部分指南页面只有英文版，部分中文页面落后于其英文原文。从中文页面指向没有译文的页面的链接，会打开英文页面。

**该怎么做。** 在中文页面缺失或过时的地方，请阅读英文页面。
