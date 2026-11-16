---
description: "Hand work to Claude Code or Codex: how a chat gives an agent a task, the consent the first time, what the agent can touch, where its result shows, the presets under Advanced options, and the use-at-your-own-risk warning."
---

# Hand work to Claude Code or Codex

English | [中文](agents.zh.md)

## Summary

This page shows how a chat hands a task to Claude Code or Codex, what that agent can touch, and how to make it stricter. You need Delorun running and set up ([Install and first run](install.md)), and an account with the agent's provider.

Claude Code and Codex are optional [external agents](../reference/glossary.md#external-agent). Adding one downloads a pinned copy of its program, and the agent signs in with your own account, not Delorun's. Use them at your own risk: they run under your own account and that provider's terms, outside Delorun's sandbox and prompts.

## Contents

- [How a chat uses an agent](#how-a-chat-uses-an-agent)
- [Add an agent](#add-an-agent)
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

An agent works in the chat's workspace. It can read and, where its own settings allow, change files there, and it can reach anywhere else its own settings allow, your Delorun home included. It runs outside Delorun's sandbox and permission prompts. The presets under [Advanced options](#advanced-options) make it stricter.

## Where the result shows

The result comes back into the chat that handed over the task, as the agent's answer. A task that fails shows why in the same place.

## Advanced options

Each agent card has **Advanced options**, closed by default. The default path needs nothing from it.

- **Recommended** is what Add leaves in place. For Claude Code, anything its own settings do not already allow is refused (permission mode `dontAsk`). For Codex, it works without asking you and its own sandbox settings apply (permission mode `never`).
- **Read only** makes the agent plan and review without changing files. For Claude Code it sets permission mode `plan`. For Codex it sets permission mode `read-only`, which pins its sandbox to read-only.

Selecting a preset shows what it sets. No preset is looser than Recommended. **Fine-tune** holds two more settings: the **Model** the agent runs (empty means the agent's own default) and the **Time limit per task** in minutes, which applies to every agent from the next run.

<details>
<summary>Go further</summary>

- The presets write the agent's row in the profile, the same place Plugins edits.
- A choice made before you add the agent is kept and written when the agent is added.
- Settings, Safety, External agents also holds the time limit and the question that Delorun asks before each run.

</details>

## Use at your own risk

An agent runs under your own account and that provider's terms, not Delorun's, and nothing Delorun does can promise what it will do with its access. For Claude Code, running it from your home internet connection, not a VPN, proxy or cloud server, is recommended.

## Next

- To see what else Delorun protects, read [What Delorun protects](safety.md#external-agents).
- To write your own plugin, read [Write a plugin for Delorun](plugins.md).
