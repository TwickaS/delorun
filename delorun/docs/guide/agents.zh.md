---
description: "把任务交给 Claude Code 或 Codex：对话如何把任务交给智能体、第一次的同意、智能体能接触什么、结果显示在哪里、“高级选项”中的模型和时间限制，以及使用风险自负的警告。"
---

# 把任务交给 Claude Code 或 Codex

[English](agents.md) | 中文

## 摘要

本页说明对话如何把任务交给 Claude Code 或 Codex、该智能体能接触什么，以及如何选择它的模型和时间限制。你需要已运行并完成设置的 Delorun（[安装与首次运行](install.zh.md)），以及该智能体提供方的账户。

Claude Code 和 Codex 是可选的[外部智能体](../reference/glossary.zh.md#external-agent)。添加其中一个会下载其程序的固定版本副本，智能体使用你自己的账户登录，而不是 Delorun 的。使用风险自负：它们在你自己的账户和该提供方的条款下运行，不受 Delorun 沙箱和提示的约束。

## 目录

- [对话如何使用智能体](#how-a-chat-uses-an-agent)
- [添加智能体](#add-an-agent)
- [下载大小与登录](#download-size-and-sign-in)
- [Sign-in and plan limits](#sign-in-and-plan-limits)
- [第一次](#the-first-time)
- [智能体能接触什么](#what-the-agent-can-touch)
- [结果显示在哪里](#where-the-result-shows)
- [高级选项](#advanced-options)
- [使用风险自负](#use-at-your-own-risk)
- [下一步](#next)

<a id="how-a-chat-uses-an-agent"></a>

## 对话如何使用智能体

当你提出要求时，对话会在该对话的工作区把一个任务交给智能体。智能体自行工作，使用自己的登录，答案会回到同一个对话中。它工作时没有人回答它的提问，所以凡是它尚未被允许的操作都会被拒绝。

<a id="add-an-agent"></a>

## 添加智能体

1. 打开设置向导的“智能体”步骤，或打开“插件”。
2. 阅读卡片：它说明智能体如何使用、要下载多少内容，以及尚未登录时该怎么做。
3. 按**添加**。添加使用默认设置，不再询问其他内容。

<a id="download-size-and-sign-in"></a>

## 下载大小与登录

添加智能体会为你的平台下载其程序的固定版本副本：Claude Code 约 206 MB，Codex 约 320 MB。Delorun 在使用前会检查下载内容，副本保存在你的 Delorun 主目录中。它不是你自己的 `claude` 或 `codex` 命令。

智能体使用你自己的账户登录，登录信息保存在提供方保存它的地方（Claude Code 为 `~/.claude`，Codex 为 `~/.codex`）。卡片会说明 Delorun 是否能看到登录信息。如果缺少登录，卡片会显示 `delorun agents login claude-code` 或 `delorun agents login codex`，并附有“复制”按钮。请在终端中运行它：它会运行 Delorun 所下载副本中智能体自己的登录，因此你不需要另外安装命令。请先添加智能体。

<a id="the-first-time"></a>

## Sign-in and plan limits

Once an agent is added, its card says whether it is signed in and on which plan, such as "Signed in · Max plan". Before Delorun has checked, the card shows what a saved sign-in file suggests. If the agent is not signed in, the card names `delorun agents login claude-code` or `delorun agents login codex`.

Below that, two bars show how much of the agent's plan limits you have used, for example the 5-hour limit and the weekly limit, each with the time it resets on your own clock. A bar turns amber from 80% and red at the limit, and it also says "Near the limit" or "Limit reached" in words. The same bars are in Settings, Safety, External agents, under Plans and limits, and in the Plans pill beside the cost pill, which shows the highest share among your agents and opens the bars for each. The pill appears only while an agent is added.

Delorun reads these figures from the agent's own program. It does not read them just because a card or the pill is on screen. It checks when you add an agent, when you finish signing in, and when you press Check now. Figures are labelled "As of" the time they were read, and "Last seen" once they are old. If a window's reset time has passed, the bar says "Reset at …, not checked since" until you check again. Press Check now to refresh them.

Checking starts the agent's program on your computer, so a phone or another computer asks for Face ID or your PIN each time you press **Check now**. If you cancel, it says "Not confirmed" and nothing is checked.

To see the same figures at a terminal, run `delorun agents status`. It reads what Delorun has stored and starts nothing. Add `--refresh` to check now, at the computer that runs Delorun.

<details>
<summary>Edge cases</summary>

- If the agent is not added, there is nothing to check: the card shows only the Add button.
- If a check cannot be read, the old figures stay and the card says the check did not answer.
- If two checks come close together, the second says the last check was a moment ago and when the next can run.
- If a plan reports no figure for a window, the bar says "No figure" instead of a percentage.

</details>

## 第一次

第一次由对话在某个工作区把任务交给智能体时，Delorun 会在运行它的电脑上询问你。**允许一次**只启动这一次运行。**为此工作区允许**则让该智能体在那里无需再询问即可启动，直到你在“设置”“安全”“外部智能体”中撤销。手机无法回答。

<details>
<summary>边界情况</summary>

- 如果对话处于“只读”，则不会启动任何智能体——请先更改该对话的权限。
- 如果对话处于“完全访问”，则智能体不询问就会启动，因为你已选择在没有提示的情况下运行，对话会显示“已启动，未经询问 · 完全访问”。要让完全访问的对话重新询问，请在“设置”“安全”“外部智能体”中关闭**完全访问的对话无需询问即可启动智能体**；此后智能体只有在你已允许的工作区才会启动。
- 如果你运行 `delorun headless`，则没有人可以询问，因此只有在你已允许的工作区才会启动智能体，或者在该次运行具有完全访问权限时启动，即通过工作区的完全访问授权，或 setup 的**从不询问（危险）**答案。具有完全访问权限的运行与完全访问的对话一样，不询问也不需要授权就会启动智能体。
- 如果你停止某个对话，则它在该轮交出的任务也会停止。更早轮次的任务会继续运行，直到完成、达到时间限制，或你归档该对话（归档会停止该对话启动的每个任务）。
- 如果任务所需时间超过时间限制，则任务会停止。除非你在[高级选项](#advanced-options)中更改，限制为 30 分钟。

</details>

<a id="what-the-agent-can-touch"></a>

## 智能体能接触什么

智能体在该对话的工作区内工作。它可以读取那里的文件，并在其级别允许时修改文件。它在 Delorun 的沙箱和权限提示之外运行，因此你在“设置”“安全”“外部智能体”中为它选择的级别，决定它可以自行做什么：

“谨慎”只在任务文件夹中写入，其命令无法访问互联网。“标准”是默认级别，在任务文件夹和临时文件夹中写入并开启互联网，其余由智能体自己的审查器决定。“你自己的设置”表示 Delorun 不设置任何内容，由你自己的 Claude Code 或 Codex 设置决定。“不受限制”没有沙箱，也从不询问，且只能在运行 Delorun 的电脑上选择。

批准卡片上的标签显示该级别，点击一次即可打开选项。级别从下一个任务起生效。已批准的设备可以收紧级别；放宽则需要你在电脑前操作。处于“完全访问”的对话从不更改级别。这些级别不涵盖你自己在 Claude Code 或 Codex 中设置的 MCP 工具。

在 Linux 上，Claude Code 的命令沙箱需要 `bubblewrap` 和 `socat`（`sudo apt install bubblewrap socat`）。没有它们时，“标准”仍会运行，但没有沙箱，标签显示“标准 · 无沙箱”。“谨慎”会拒绝启动，因为它承诺了隔离。

<a id="where-the-result-shows"></a>

## 结果显示在哪里

结果会作为智能体的答案回到交出任务的那个对话中。任务失败时，原因也显示在同一处。

Codex 的三种失败有专门的措辞：

- **你配置的模型不在你的套餐中。**Codex 在任务开始前停止，并指出该模型以及你的套餐提供的模型，例如“Codex's configured model gpt-5.5 is not offered on your plan. Choose one of: gpt-5.6-luna, gpt-5.5, in your Codex settings.”请在**高级选项**下或在你的 Codex 设置中选择模型。Delorun 从不替你选择。
- **已达到套餐的限额。**结果会这样说明，并在 Codex 报告时给出限额重置的时间。
- **Codex 未登录。**结果会给出 `delorun agents login codex` 命令。

Delorun 的 Codex 运行从不修改你自己的 Codex 设置文件，因此你交给 Codex 的文件夹不会成为你终端 Codex 中的受信任文件夹。

<a id="advanced-options"></a>

## 高级选项

每张智能体卡片都有**高级选项**，默认关闭。默认路径不需要它。它包含两项设置。

- **模型。**第一个选项是**智能体自己的默认模型（推荐）**，把模型交给智能体决定。智能体添加后，Delorun 会询问它提供哪些模型并按名称列出；选择其中一个会让每个任务都使用该模型。智能体添加之前，或它无法回答时，只显示默认选项，并有一行说明智能体添加后才会出现列表。
- **每个任务的时间限制**，以分钟计（1 到 1440，默认 30）。任务超过这个时间就会停止。它适用于所有智能体，从下一次运行起生效，与“设置”“安全”“外部智能体”中是同一项设置。

<details>
<summary>进一步了解</summary>

- 模型写入配置文件中该智能体的条目，与“插件”编辑的位置相同。
- “设置”“安全”“外部智能体”也包含 Delorun 在每次运行前询问的问题。

</details>

<a id="use-at-your-own-risk"></a>

## 使用风险自负

智能体在你自己的账户和该提供方的条款下运行，而不是 Delorun 的，Delorun 无法保证它会如何使用其访问权限。对 Claude Code，建议使用家庭网络连接运行，而不是 VPN、代理或云服务器。

<a id="next"></a>

## 下一步

- 想了解 Delorun 还保护了什么，请阅读[Delorun 保护什么](safety.zh.md#external-agents)。
- 想编写自己的插件，请阅读[为 Delorun 编写插件](plugins.zh.md)。
