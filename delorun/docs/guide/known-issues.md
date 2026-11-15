---
description: "The rough edges you may meet in the Delorun preview, each written as what happens and what to do: platforms, undo limits, phone access from WSL2, the key check, phone-width spacing, the plugin installer and documentation languages."
---

# Known issues

English | [中文](known-issues.zh.md)

## Summary

This page lists the rough edges you may meet in the preview. Each one says what happens and what to do. Anything that breaks install, the first chat, updates, your data or safety is fixed before a release, so this list holds the smaller problems and the limits that are part of the design. You need nothing first. If you meet something that is not here, tell the project ([Troubleshooting](troubleshooting.md#when-nothing-here-fits) says how).

## Contents

- [Where Delorun runs](#where-delorun-runs)
- [What undo covers](#what-undo-covers)
- [Phone access from inside WSL2](#phone-access-from-inside-wsl2)
- [The key check](#the-key-check)
- [Phone-width spacing](#phone-width-spacing)
- [The right sidebar button on a touch screen](#the-right-sidebar-button-on-a-touch-screen)
- [Installing a plugin](#installing-a-plugin)
- [Documentation languages](#documentation-languages)

## Where Delorun runs

**What happens.** Delorun runs on Linux (x64 and arm64) and on Windows through WSL2. It does not run on macOS or on native Windows.

**What to do.** On Windows, install WSL2 and run Delorun inside it ([Install and first run](install.md#windows-through-wsl2)). On macOS, there is no supported way to run Delorun; the [roadmap](roadmap.md#next) lists the desktop app as the next stage.

## What undo covers

**What happens.** "Undo everything" covers the harness and your chats: your setup, plugins and settings. It does not cover what an agent did to the files in a workspace, because workspace checkpoints are not built.

**What to do.** Keep your workspaces in git, and commit before you let an agent change many files, so that git can undo what the agent did.

## Phone access from inside WSL2

**What happens.** Reach over Tailscale works, but WSL2 does not resolve your tailnet's `*.ts.net` names. Opening the studio's tailnet address from a browser inside WSL2 can fail, while the same address opens from your phone.

**What to do.** Open the address from your phone or from a browser on Windows ([Reach the studio from your phone](reach.md)).

## The key check

**What happens.** The check in onboarding and in Settings, Models says whether a provider accepts your key. It asks the provider for its list of models and sends no chat, so it spends nothing. A key that passes can still be a key for a model you have no access to.

**What to do.** If the first chat fails after the key check passed, open Settings, Models and check the model you picked.

**What happens for some providers.** A few providers, such as OpenRouter, Hugging Face and NVIDIA, publish their model list to everyone, so asking for it proves nothing about your key. For these, Delorun says so and saves the key as "Key saved, not tested".

**What to do for those.** Start a chat. The first chat is the test.

## Phone-width spacing

**What happens.** On a narrow phone screen, a few headings, such as "Asking to connect" in Devices and the Branding heading, sit a few pixels to the right of the other headings. Nothing is hidden and nothing stops working.

**What to do.** Nothing. It is cosmetic.

## The right sidebar button on a touch screen

**What happens.** On a touch screen, the button that opens the right sidebar has a small tap area, so a tap near its edge can miss.

**What to do.** Tap the centre of the button.

## Installing a plugin

**What happens.** `delorun plugin` runs DeepSeek Harness's plugin installer inside your Delorun home, without Delorun's protections. A plugin runs with the same full access as Delorun, and Delorun does not check a plugin's files again after you install it.

**What to do.** Install only plugins you trust, from sources you trust. If one misbehaves, start in safe mode with `delorun recover safe-mode` ([Updates](updates.md#going-back)).

## Documentation languages

**What happens.** Some guide pages exist in English only, and some Chinese pages lag behind their English originals. A link from a Chinese page to a page with no translation opens the English page.

**What to do.** Read the English page where the Chinese one is missing or out of date.
