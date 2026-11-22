---
description: "Hand work to Claude Code or Codex: how a chat gives an agent a task, the consent the first time, what the agent can touch, where its result shows, the model and time limit under Advanced options, and the use-at-your-own-risk warning."
---

# Hand work to Claude Code or Codex

English | [中文](agents.zh.md)

## Summary

This page shows how a chat hands a task to Claude Code or Codex, what that agent can touch, and how to choose its model and time limit. You need Delorun running and set up ([Install and first run](../get-started/install.md)), and an account with the agent's provider.

Claude Code and Codex are optional [external agents](../../reference/glossary.md#external-agent). Adding one downloads a pinned copy of its program, and the agent signs in with your own account, not Delorun's. Use them at your own risk: they run under your own account and that provider's terms, outside Delorun's sandbox and prompts.

## Contents

- [How a chat uses an agent](#how-a-chat-uses-an-agent)
- [Add an agent](#add-an-agent)
- [Download size and sign-in](#download-size-and-sign-in)
- [Sign-in and plan limits](#sign-in-and-plan-limits)
- [The first time](#the-first-time)
- [What the agent can touch](#what-the-agent-can-touch)
- [Where the result shows](#where-the-result-shows)
- [Watch several agents at once](#watch-several-agents-at-once)
- [Advanced options](#advanced-options)
- [Use at your own risk](#use-at-your-own-risk)
- [Next](#next)

## How a chat uses an agent

When you ask, a chat hands the agent one task in the chat's workspace. The agent works on its own, with its own sign-in, and its answer comes back into the same chat. Nobody is there to answer its questions while it works, so anything it is not already allowed to do is refused.

## Add an agent

1. Open the Agents step of setup, or Plugins.
2. Read the card: it says how the agent is used, how much it downloads and what to do if it is not signed in yet.
3. Press **Add**. Add takes the defaults and asks nothing more.

## Download size and sign-in

Adding an agent downloads a pinned copy of its program for your platform: about 206 MB for Claude Code and about 320 MB for Codex. Delorun checks the download before it uses it, and the copy stays in your Delorun home. It is not your own `claude` or `codex` command.

The agent signs in with your own account, kept where the provider keeps it (`~/.claude` for Claude Code, `~/.codex` for Codex). The card says whether Delorun can see a sign-in. If it is missing, the card shows `delorun agents login claude-code` or `delorun agents login codex` with a Copy button. Run it at a terminal: it runs the agent's own sign-in from the copy Delorun downloaded, so you need no separately installed command. Add the agent first.

## Sign-in and plan limits

Once an agent is added, its card says whether it is signed in and on which plan, such as "Signed in · Max plan". Before Delorun has checked, the card shows what a saved sign-in file suggests. If the agent is not signed in, the card names `delorun agents login claude-code` or `delorun agents login codex`.

Below that, two bars show how much of the agent's plan limits you have used, for example the 5-hour limit and the weekly limit, each with the time it resets on your own clock. A bar turns amber from 80% and red at the limit, and it also says "Near the limit" or "Limit reached" in words. The same bars are in Settings, Safety, External agents, under Plans and limits, and in the Plans pill beside the cost pill, which shows the highest share among your agents and opens the bars for each. The pill appears only while an agent is added.

Delorun reads these figures from the agent's own program. It does not read them just because a card or the pill is on screen. It checks when you add an agent, when you finish signing in, and when you press Check now. Figures are labelled "As of" the time they were read, and "Last seen" once they are old. If a window's reset time has passed, the bar says "Reset at …, not checked since" until you check again. Press Check now to refresh them.

Checking starts the agent's program on your computer, so a phone or another computer asks for Face ID or your PIN each time you press **Check now**, unless a Face ID pass is open. If you cancel, it says "Not confirmed" and nothing is checked.

To see the same figures at a terminal, run `delorun agents status`. It reads what Delorun has stored and starts nothing. Add `--refresh` to check now, at the computer that runs Delorun.

<details>
<summary>Edge cases</summary>

- If the agent is not added, there is nothing to check: the card shows only the Add button.
- If a check cannot be read, the old figures stay and the card says the check did not answer.
- If two checks come close together, the second says the last check was a moment ago and when the next can run.
- If a plan reports no figure for a window, the bar says "No figure" instead of a percentage.

</details>

## The first time

The first time a chat hands an agent a task in a workspace, Delorun asks at the computer that runs it. **Allow once** starts that run only. **Allow for this workspace** lets that agent start there without asking again until you revoke it in Settings, Safety, External agents. A phone cannot answer.

<details>
<summary>Edge cases</summary>

- If the chat is on Read Only, then no agent starts — change the chat's permission first.
- If the chat is on Full access, then the agent starts without asking, because you already chose to run without prompts, and the chat shows "Started without asking · Full access". To make a Full access chat ask again, turn off **Full access chats start agents without asking** in Settings, Safety, External agents; the agent then starts only in a workspace where you allowed it.
- If you run `delorun headless`, then no one can be asked, so an agent starts only where you allowed it, or when the run has full access, through a workspace's full-access grant or setup's **Never ask (dangerous)** answer. A run with full access starts agents without asking and without a grant, as a Full access chat does.
- If you stop a chat, then the tasks it handed off during that turn stop too. A task from an earlier turn keeps running until it finishes, reaches its time limit, or you archive the chat, which stops every task the chat started.
- If a task needs longer than the time limit, then it stops. The limit is 30 minutes unless you change it under [Advanced options](#advanced-options).

</details>

## What the agent can touch

An agent works in the chat's workspace. It can read and, where its level allows, change files there. It runs outside Delorun's sandbox and permission prompts, so the level you choose for it in Settings, Safety, External agents decides what it may do on its own:

Careful writes only in the task folder, and its commands get no internet. Standard, the default, writes in the task folder and temporary folders with the internet on, and the agent's own reviewer decides the rest. Your own settings means Delorun sets nothing and your own Claude Code or Codex settings decide. Unrestricted has no sandbox and never asks, and you can choose it only at the computer that runs Delorun.

The chip on the approval card shows the level, and one click opens the choice. A level applies from the next task. An approved device can tighten a level; loosening it needs you at the computer. A chat on Full access never changes a level. The levels do not cover MCP tools you set up yourself in Claude Code or Codex.

On Linux, Claude Code's command sandbox needs `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`). Without them Standard still runs, without the sandbox, and the seat's banner reads "No sandbox". Careful refuses to start, because it promises the confinement.

## Where the result shows

The result comes back into the chat that handed over the task, as the agent's answer. A task that fails shows why in the same place.

Three Codex failures have their own wording:

- **Your configured model is not offered on your plan.** Codex stops before the task starts and names the model and the models your plan offers, for example "Codex's configured model gpt-5.5 is not offered on your plan. Choose one of: gpt-5.6-luna, gpt-5.5, in your Codex settings." Choose a model under **Advanced options**, or in your Codex settings. Delorun never picks one for you.
- **Your plan's limit is reached.** The result says so and, when Codex reports it, when the limit resets.
- **Codex is not signed in.** The result gives the `delorun agents login codex` command.

Delorun's Codex runs never change your own Codex settings file, so a folder you hand to Codex does not become a trusted folder in your terminal Codex.

## Watch several agents at once

Multiview puts the agents a chat works with beside the chat, so you can follow them together instead of opening each one. It needs no setup: it does nothing until an agent is pinned or a chat hands work to one.

1. Open the agents list in the chat header (the "N subagents" button) and press the pin beside an agent. A chat opens Multiview by itself when it hands work to a new agent, and pins that agent.
2. Press **Multiview** in the header. The main chat stays on the left and the pinned agents stack on the right. Press it again to go back to the normal chat.
3. Each pane shows the agent's name, whether it is working, waiting for you or done, and, for Claude Code and Codex, the plan and how much of its limits it has used. You can approve or reject what an agent asks, reply to it or stop it right there. **Open full chat** moves it into the main view and **Close** removes the pane.
4. To arrange the panes, drag one by its handle onto the edge of another to split it, or onto the middle to share its tabs. The **Layout** menu offers Main and column, Side by side, Grid and Main on top, and **Reset to default**. Nothing here closes a pane.

Each chat remembers its panes and layout, and shows them again when you come back to it. On a phone, or in a window narrower than 768 pixels, the panes become pages you swipe sideways, with a strip of names at the top and an amber dot on an agent that is waiting for you.

<details>
<summary>Edge cases</summary>

- If the window has no room for another pane, the pin is greyed out and says why; a saved layout that no longer fits shows the panes that do and says how many are left out. They stay pinned.
- If an agent that is waiting for you has its pane closed, the first press on **Close** asks again, because the agent keeps waiting.
- Stop in a pane stops that agent only. A phone that is not allowed to stop an agent does not show the button.
- The Multiview settings are under the Multiview plugin in Plugins: opening on every hand-off, the pane limit (six, the main chat included), the short or full reply box in each pane, and reopening when you return to a chat.

</details>

## Advanced options

Each agent card has **Advanced options**, closed by default. The default path needs nothing from it. It holds two settings.

- **Model.** The first choice, **The agent's own default (recommended)**, leaves the model to the agent. Once the agent is added, Delorun asks it which models it offers and lists them by name; choosing one sets that model for every task. Before the agent is added, or if it cannot answer, only the default shows, with a line saying the list appears once the agent is added.
- **Time limit per task**, in minutes (1 to 1440, 30 by default). A task stops after this long. It applies to every agent from the next run, and it is the same setting as Settings, Safety, External agents.

<details>
<summary>Go further</summary>

- The model is written to the agent's row in the profile, the same place Plugins edits.
- Settings, Safety, External agents also holds the question that Delorun asks before each run.

</details>

## Use at your own risk

An agent runs under your own account and that provider's terms, not Delorun's, and nothing Delorun does can promise what it will do with its access. For Claude Code, running it from your home internet connection, not a VPN, proxy or cloud server, is recommended.

## Next

- To see what else Delorun protects, read [What Delorun protects](../safety-and-updates/safety.md#external-agents).
- To write your own plugin, read [Write a plugin for Delorun](../plugin-guides/plugins.md).
