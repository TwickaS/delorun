---
description: "Hand work to Claude Code or Codex: how a chat gives an agent a task, the consent the first time, what the agent can touch, where its result shows, the model and time limit under Advanced options, and the use-at-your-own-risk warning."
---

# Hand work to Claude Code or Codex

English | [中文](agents.zh.md)

## Summary

This page shows how a chat hands a task to Claude Code or Codex, what that agent can touch, and how to choose its model and time limit. You need Delorun running and set up ([Install and first run](install.md)), and an account with the agent's provider.

Claude Code and Codex are optional [external agents](../reference/glossary.md#external-agent). Adding one downloads a pinned copy of its program, and the agent signs in with your own account, not Delorun's. Use them at your own risk: they run under your own account and that provider's terms, outside Delorun's sandbox and prompts.

## Contents

- [How a chat uses an agent](#how-a-chat-uses-an-agent)
- [Add an agent](#add-an-agent)
- [Download size and sign-in](#download-size-and-sign-in)
- [Sign-in and plan limits](#sign-in-and-plan-limits)
- [The first time](#the-first-time)
- [What the agent can touch](#what-the-agent-can-touch)
- [Where the result shows](#where-the-result-shows)
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

Checking starts the agent's program on your computer, so a phone or another computer must be unlocked first. A locked device sees "Unlock to check" on the button.

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
- If the chat is on Full access, then every approval is refused without asking, so an agent starts only in a workspace where you allowed it.
- If you run `delorun headless`, then no one can be asked, so an agent starts only where you allowed it.
- If a task needs longer than the time limit, then it stops. The limit is 30 minutes unless you change it under [Advanced options](#advanced-options).

</details>

## What the agent can touch

An agent works in the chat's workspace. It can read and, where its own settings allow, change files there, and it can reach anywhere else its own settings allow, your Delorun home included. It runs outside Delorun's sandbox and permission prompts. What it may do inside the workspace follows its own settings. When Delorun adds Claude Code it sets Claude Code to accept file edits, so a task can change files in the chat's workspace, and run simple file and read-only commands there, without asking. Anything else, including anything outside the workspace, is refused, because the agent cannot stop to ask you during a task. Codex keeps its own defaults. If you change Claude Code's permission mode afterwards, Delorun keeps your value.

## Where the result shows

The result comes back into the chat that handed over the task, as the agent's answer. A task that fails shows why in the same place.

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

- To see what else Delorun protects, read [What Delorun protects](safety.md#external-agents).
- To write your own plugin, read [Write a plugin for Delorun](plugins.md).
