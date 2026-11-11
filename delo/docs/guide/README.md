---
description: "The Delorun user guide index: installing and first run, switching from stock DeepSeek Harness, daily use, updates, reaching the studio from a phone, customising Delorun and its changes, safety and trust, and troubleshooting."
---

# Delorun user guide

English | [中文](README.zh.md)

## Summary

The user guide is for people who install and use Delorun, the community fork of DeepSeek Harness, whether new to both or switching from stock DeepSeek Harness. Delorun runs on your own computer, and you can reshape it to suit how you work: plugin settings, agent presets, skills, your own plugins and Delorun's own files. Updates carry your changes, and Delorun shows what an update would change before you confirm it. Read the pages in the order below, or go straight to the one you need.

## Contents

- [Get started](#get-started)
- [Every day](#every-day)
- [Make it yours](#make-it-yours)
- [Safety and trust](#safety-and-trust)
- [When something goes wrong](#when-something-goes-wrong)

## Get started

[Install and first run](install.md) installs Delorun with `npx delorun`, explains what the launcher verifies before it installs a release, walks through Quick and Full setup, and opens the studio, from a machine without a browser too.

[Switching from DeepSeek Harness](switching.md) explains what `delorun import-home` and setup copy from `~/.dsh`, what you choose one by one, what is held back or stays behind and why, what changes when you switch, the switches that return a difference to stock, and how to go back.

[Delo and stock DeepSeek Harness](delo-vs-stock.md) covers why Delorun exists, what stays the same as stock, the differences it plans, and the roadmap.

## Every day

[Daily use](daily-use.md) covers starting, opening, stopping and checking Delorun, workspaces and what the model may change in them, safe mode and recovery, the trash and archives, and the plugin and headless commands.

[Updates](updates.md) explains the update notice, `delorun update --check` and `--report`, what the update report shows, the health check and automatic rollback, the chat-data copy when a release changes the data format, and going back with `delorun recover`.

[Reach the studio from your phone](reach.md) explains remote access over your own tailnet: turning it on, approving a device at your computer, what an approved phone can and cannot do, and removing a device.

[Your Delo home](home.md) explains where `delorun` keeps your data, how to move it, how profiles work, and how to fix a home or secret file that other users can read.

[Where Delo keeps its logs](logs.md) lists every operational log's location, what a log holds and never holds, how long logs are kept and how `delorun logs` shows and clears them.

## Make it yours

[Where to customise what](https://docs.delorun.com/guide/customise) compares settings, the profile patch, agent presets, your own plugin, a renamed fork of a shipped plugin and editing Delorun itself, with what each costs you at every update.

[Write a plugin for Delo](https://docs.delorun.com/guide/plugins) goes from `delorun plugin new` to a plugin that loads in your studio.

[Changing your harness](https://docs.delorun.com/guide/changing-your-harness) explains what `delorun changes` records when a plugin or Delorun's own files change, protection, which is off by default so changes load without review and stay undoable, turning protection on, editing Delorun itself, and undo.

## Safety and trust

[What Delorun protects](safety.md) explains, in plain language, the sandbox and the protected home on each platform, full access, the consents, the `web_fetch` guard, release checks, and what Delorun does not protect against.

[What you trust when you use Delo](trust.md) states what runs on your computer, what Delo Run can and cannot do, what each reach option shows its provider and what leaves your machine.

## When something goes wrong

[Troubleshooting](troubleshooting.md) explains how to read a refusal and lists the common refusals by code, with their fixes.
