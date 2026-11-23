---
description: "The Delorun user guide, as a map of what you want to do: installing and first run, switching from stock DeepSeek Harness, daily use, model providers, the cost meter, updates, reaching the studio from a phone, customising Delorun and its changes, safety and trust, and troubleshooting."
---

# Delorun user guide

English | [中文](README.zh.md)

## Summary

The user guide is for people who install and use Delorun, the agent harness you shape to your own work and that is built on DeepSeek Harness, whether new to both or switching from stock DeepSeek Harness. Delorun runs on your own computer. This page is a map: find what you want to do, and follow the link to the page and section. Technical terms link to the [glossary](../reference/glossary.md).

If you are new, these three pages are the whole path to a working Delorun:

1. [Install and first run](get-started/install.md): one command, a few questions and your first chat.
2. [Model providers](get-started/providers.md): the key for the model you want to use.
3. [Daily use](everyday-use/daily-use.md): start, open and stop Delorun, and choose what the model may change.

The rest of this page is for when you need it.

## Contents

- [I want to get started](#i-want-to-get-started)
- [I want to use it every day](#i-want-to-use-it-every-day)
- [I want to choose or change the model](#i-want-to-choose-or-change-the-model)
- [I want to reach it from my phone](#i-want-to-reach-it-from-my-phone)
- [I want to make it mine](#i-want-to-make-it-mine)
- [I want to know what is safe](#i-want-to-know-what-is-safe)
- [Something went wrong](#something-went-wrong)
- [For the technically curious](#for-the-technically-curious)

## I want to get started

- **Decide whether Delorun suits me, and how it compares with other tools:** [Why Delorun](why-delorun.md). It covers what you get, what Delorun changes from DeepSeek Harness and when another tool fits better.
- **Install Delorun and have a first chat:** [Install and first run](get-started/install.md). It covers what you need first, [setup in a few questions](get-started/install.md#setup-a-few-questions), [the studio and your first chat](get-started/install.md#the-studio-and-your-first-chat) and [a computer without a browser](get-started/install.md#a-computer-without-a-browser).
- **Bring my DeepSeek Harness chats:** [Switching from DeepSeek Harness](get-started/switching.md). It explains what stays the same and what is different, what is copied, what stays behind and [how to go back](get-started/switching.md#going-back).
- **Find out whether it is safe and what the catch is:** [Questions and answers](help/questions.md).

## I want to use it every day

- **Start, open, stop or check Delorun:** [Start, open and stop](everyday-use/daily-use.md#start-open-and-stop) and [Check the release and your setup](everyday-use/daily-use.md#check-the-release-and-your-setup).
- **Decide what the model may change in a folder:** [Workspaces and what the model may change](everyday-use/daily-use.md#workspaces-and-what-the-model-may-change).
- **Recover from a plugin that stops Delorun starting:** [Safe mode and recovery](everyday-use/daily-use.md#safe-mode-and-recovery).
- **Restore a deleted chat, or move chats between homes:** [Trash, export and import](everyday-use/daily-use.md#trash-export-and-import).
- **Move to a new release, or back:** [Updates](safety-and-updates/updates.md) and [Going back](safety-and-updates/updates.md#going-back).
- **Update when I run many third-party plugins:** [Update Delorun with many plugins](plugin-guides/updating-with-plugins.md). It covers what is saved first, reading the report's `disabled` lines, trying a plugin anyway with a version exemption, and going back.
- **Move my plugins, model choices and settings to another computer:** [Move your setup to another computer](customising/move-your-setup.md). It covers what the file holds and never holds, what the import replaces and how to undo it.
- **Find where my data lives, move it, or use two profiles:** [Your Delorun home](customising/home.md).
- **Find out why something failed:** [Where Delorun keeps its logs](help/logs.md).
- **Bring my chats from the DeepSeek website:** [Import your DeepSeek website chats](get-started/import-deepseek-chats.md).
- **See what a chat costs:** [See what a chat costs](everyday-use/cost-meter.md).
- **Let the agent work in my own Chrome, signed in as me:** [Use your own browser](everyday-use/use-your-own-browser.md).
- **Read the model's thinking word by word:** [Read the model's thinking word by word](everyday-use/thinking-tab.md).
- **Hand a task to Claude Code or Codex from a chat:** [Hand work to Claude Code or Codex](everyday-use/agents.md).

## I want to choose or change the model

- **Pick a provider and key, or run a model on my own computer:** [Model providers](get-started/providers.md). It lists every provider setup knows and how to [change the provider later](get-started/providers.md#change-the-provider-later).

## I want to reach it from my phone

- **Turn on remote access, approve a device, or remove one:** [Reach the studio from your phone](everyday-use/reach.md).

## I want to make it mine

- **Choose the right way to change Delorun:** [Where to customise what](customising/customise.md) compares settings, the profile patch, agent presets, your own plugin, a renamed fork of a shipped plugin and editing Delorun itself, with what each costs you at every update.
- **Make a first plugin and see it in the studio:** [Your first plugin](plugin-guides/first-plugin.md) builds one, shows it under Plugins, and removes it again.
- **Write a plugin:** [Write a plugin for Delorun](plugin-guides/plugins.md) goes from `delorun plugin new` to a plugin that loads in your studio.
- **See, protect or undo changes:** [Changing your harness](customising/changing-your-harness.md) explains what `delorun changes` records, protection, and undo.

## I want to know what is safe

- **Understand the sandbox, full access and the consents:** [What Delorun protects](safety-and-updates/safety.md).
- **Understand prompt injection and what leaves my computer:** [Prompt injection and data exfiltration](safety-and-updates/prompt-injection.md).
- **Know what I trust when I use Delorun:** [What you trust when you use Delorun](safety-and-updates/trust.md).

## Something went wrong

- **A message or code I do not understand:** [Troubleshooting](help/troubleshooting.md). It explains [how to read a refusal](help/troubleshooting.md#reading-a-refusal) and lists the common ones by code, with fixes.
- **Delorun does not start:** [Starting and stopping](help/troubleshooting.md#starting-and-stopping), then `delorun doctor` ([Daily use](everyday-use/daily-use.md#check-the-release-and-your-setup)).
- **An update failed:** [Updates and rollback](help/troubleshooting.md#updates-and-rollback).
- **Check whether it is a known problem:** [Known issues](help/known-issues.md) lists the rough edges of this preview, each with what to do.

## For the technically curious

These pages describe what you see and do. The [Delorun documentation index](../README.md), on GitHub, leads to the contracts, designs and threat model that define the exact rules; each guide page ends with links to the ones it relies on.

The [Roadmap](roadmap.md) says what is being built now, what comes next and what comes later, and the [changelog](https://docs.delorun.com/changelog) lists what changed in each version.
