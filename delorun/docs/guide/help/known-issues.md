---
description: "The rough edges you may meet in the Delorun preview, each written as what happens and what to do: platforms, undo limits, phone access from WSL2, the key check, phone-width spacing, the plugin installer and documentation languages."
---

# Known issues

English | [中文](known-issues.zh.md)

## Summary

This page lists the rough edges you may meet in the preview. Each one says what happens and what to do. This list holds the rough edges and the limits that are part of the design. You need nothing first. If you meet something that is not here, tell the project ([Troubleshooting](troubleshooting.md#when-nothing-here-fits) says how).

## Contents

- [Where Delorun runs](#where-delorun-runs)
- [What undo covers](#what-undo-covers)
- [Phone access from inside WSL2](#phone-access-from-inside-wsl2)
- [The key check](#the-key-check)
- [Phone-width spacing](#phone-width-spacing)
- [The right sidebar button on a touch screen](#the-right-sidebar-button-on-a-touch-screen)
- [Commands refused with an open network](#commands-refused-with-an-open-network)
- [Commands refused without bubblewrap](#commands-refused-without-bubblewrap)
- [The Docker warning in doctor](#the-docker-warning-in-doctor)
- [Face ID on phones](#face-id-on-phones)
- [Several agents at once](#several-agents-at-once)
- [Installing a plugin](#installing-a-plugin)
- [Documentation languages](#documentation-languages)

## Where Delorun runs

**What happens.** Delorun runs on Linux (x64) and on Windows through WSL2. Delorun does not run on Linux on ARM (arm64). It does not run on macOS or on native Windows.

**What to do.** On Windows, install WSL2 and run Delorun inside it ([Install and first run](../get-started/install.md#windows-through-wsl2)). On macOS, there is no supported way to run Delorun. The [roadmap](../roadmap.md#next) lists the desktop app.

## What undo covers

**What happens.** "Undo everything" covers the harness and your chats: your setup, plugins and settings. It does not cover what an agent did to the files in a workspace, because Delorun has no workspace checkpoints.

**What to do.** Keep your workspaces in git, and commit before you let an agent change many files, so that git can undo what the agent did.

## Phone access from inside WSL2

**What happens.** Reach over Tailscale works, but WSL2 does not resolve your tailnet's `*.ts.net` names. Opening the studio's tailnet address from a browser inside WSL2 can fail, while the same address opens from your phone.

**What to do.** Open the address from your phone or from a browser on Windows ([Reach the studio from your phone](../everyday-use/reach.md)).

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

## Commands refused with an open network

**What happens.** On a Linux desktop, commands with open network are refused; set the workspace's network to an allowlist or off, or accept the risk in Settings. The refusal names the sockets (the display server, the session bus) that a command could use to act outside the sandbox. The check runs when a command starts.

**What to do.** The first time this happens in a workspace, the chat asks whether to let commands run anyway in that workspace; allowing it records the same choice as the switch below. Declining keeps the refusal, and the chat does not ask again in that workspace until Delorun restarts. Otherwise, in Settings, Safety, Network, choose Allowlist or Off for the workspace, or switch on **Run commands even when desktop sockets are reachable** beside Open ([Safety](../safety-and-updates/safety.md#the-network-setting)).

**What happens with Docker.** The refusal is not limited to a desktop. It applies while any program on the computer listens on an abstract socket, and a running `docker` command-line process, such as a foreground `docker compose up`, is one. While it runs, commands on a workspace with the Open network are refused with `the command would share this computer's network, where 1 abstract Unix socket is listening`, followed by the socket's name and the ways out.

**What to do for Docker.** Stop the `docker` process, or allow commands to run anyway when the chat asks, or accept the risk for the workspace in Settings, Safety, Network. The check runs when a command starts, so a command that was already running is not stopped.

## Commands refused without bubblewrap

**What happens.** On Linux without bubblewrap, a computer with a login session, or a program such as tmux that holds a socket in `/tmp`, makes Delorun refuse every sandboxed command, because the fallback sandbox cannot hide those sockets. The refusal says to install bubblewrap. On a computer with no such socket, commands run and `delorun doctor` shows `warn sandbox`.

**What to do.** Install the `bubblewrap` package and start Delorun again ([What Delorun protects](../safety-and-updates/safety.md#the-sandbox)). If bubblewrap is installed but cannot create a sandbox, see [Troubleshooting](troubleshooting.md#protections-and-plugins).

## The Docker warning in doctor

**What happens.** On a computer without Docker, `delorun doctor` prints `warn docker: Docker is not installed; the Docker shapes stay unavailable, and native workspaces are unaffected.` Delorun offers no Docker workspaces, so the warning describes nothing you need.

**What to do.** Nothing. Docker is optional.

## Face ID on phones

**What happens.** Face ID has three rough edges.

- A browser that cannot make a platform passkey, such as some versions of Firefox, says "This browser cannot use Face ID here" and gets no passkey.
- If you change your reach address, the passkeys made on the old address stop working. The phone says to set Face ID up again, and the old passkeys stay listed.
- While no PIN is set and no passkey is enrolled, an approved phone can still save or remove a model key with no extra check.

**What to do.** In a browser without a platform passkey, confirm actions with the PIN or at your computer. After a change of address, set Face ID up again on each phone. To make a phone confirm model-key changes, set a PIN or enrol a passkey ([Confirm with Face ID](../everyday-use/reach.md#confirm-with-face-id)).

## Several agents at once

**What happens.** Multiview has three rough edges.

- With six busy panes, the main chat's first words can take up to about twice as long to appear.
- A notice from an agent, such as a refused question, is recorded in the agent's log and is not shown in the chat.
- A Claude Code or Codex chat still shows upstream's own text for the hand-off, and a failure can appear as two red lines.

**What to do.** Pin fewer agents if the main chat feels slow. The extra text and the doubled line change nothing about the run ([Watch several agents at once](../everyday-use/agents.md#watch-several-agents-at-once)).

## Installing a plugin

**What happens.** `delorun plugin` runs DeepSeek Harness's plugin installer inside your Delorun home, without Delorun's protections. A plugin runs with the same full access as Delorun, and Delorun does not check a plugin's files again after you install it.

**What to do.** Install only plugins you trust, from sources you trust. If one misbehaves, start in safe mode with `delorun recover safe-mode` ([Updates](../safety-and-updates/updates.md#going-back)).

## Documentation languages

**What happens.** Some guide pages exist in English only, and some Chinese pages lag behind their English originals. A link from a Chinese page to a page with no translation opens the English page.

**What to do.** Read the English page where the Chinese one is missing or out of date.
