---
description: "Design of Delorun's first run: one command from install to a first chat, the launcher's progress, a short setup with sections, the start in the terminal, onboarding in the studio, and the rule that no question is asked twice."
---

# The first run

English | [中文](first-run.zh.md)

## Summary

One command, `npx delorun`, takes a person from nothing to a first chat. The launcher says what it does while it downloads and verifies a release. Setup shows one privacy line and asks only whether to use Delorun from your other devices too, whether to copy DeepSeek Harness chats (when there are some) and, when 3080 is busy, which port to use. It then starts Delorun in the terminal and opens the studio, where the welcome screen takes the model key and onboarding covers what setup did not, and no question is asked twice across the terminal and the studio. Every other answer has a safe default that Settings → General → How Delorun runs and `delorun setup <section>` change. The terminal is for setup and operations only: chatting happens in the studio. Setup's answers are [contract C11](../contracts/c11-setup-answers.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Implementation status](#implementation-status)

## What exists today

- **The launcher.** The npm launcher refuses a Node older than 24.9 with the version it needs before it does anything else. While it installs, it prints one line for each step: the release the channel names, the signature check with the release root, the release-log check with its outcome, the download with its size, and the install. When the release-log check did not run, it prints the reason and one warning that names the release.
- **The bare command.** `delorun` with no command runs setup when the home has no CLI profile. With a profile, it starts Delorun in the background when setup's `background` answer says so, and otherwise in the terminal, and opens the studio either way; `--foreground` keeps a start in the terminal.
- **A short setup.** In a terminal on a new home, setup shows one privacy line with a link and asks "Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale)" (No, or Yes over Tailscale, after the checks of `delorun reach on tailscale`); then, only when `~/.dsh` is a directory and the home has no chats, whether to copy the DeepSeek Harness chats, with a summary of what is copied and what stays behind; then, only when port 3080 is busy, whether to use the next free port. It does not ask how the person will use Delorun and shows no review screen. `--yes`, no terminal and `--config` ask nothing and take the defaults and the flags `--phone` (or `--devices`), `--import-dsh` and `--port`. `delorun setup <section>` runs one section again on a profile that is set up, and `delorun setup --list` lists the sections.
- **The key.** Setup does not ask for the model key: the studio's Models step takes it on the first open, from the environment or pasted and tested with a free request. `delorun setup key` and `--provider` stay for the terminal and for scripts; a key typed there is checked with one live request to the provider before it is stored.
- **The ending.** A terminal run starts Delorun in this terminal and opens the studio. With a phone Yes it then asks for the PIN, which the running home stores, and it asks whether to keep the `delorun` command with `npm install -g delorun@<version>`, at the version of the launcher that started it (`DELORUN_LAUNCHER_VERSION`), yes preselected; it prints that line when the person declines or the install fails, and a run the launcher did not start offers no install. It ends by saying that Ctrl+C stops Delorun, that `delorun start --background` keeps it running after the terminal closes, and how to change an answer. With no browser to open, it prints the address and the SSH port-forward line. `--yes`, no terminal and `--config` start nothing and print the studio's address and the command to run.
- **The record.** Setup writes which sections the person saw, answered or skipped into `setup-answers.json` in the profile.
- **The address afterwards.** `delorun status` prints the studio's address, without a token, and `Run delorun open to open the studio in your browser.` `delorun doctor` checks the port the profile's studio uses and reports it as in use by Delorun, not as a failure, while this home's own Delorun holds it.
- **The default workspace.** `delorun start` resolves the studio's default workspace before the Host boots: `Delorun/default-workspace` in the platform's documents folder when the platform reports one that is not the home directory, otherwise in the home directory. The folder is created when the studio first needs it, and never inside the Delorun home or anywhere the sandbox refuses as a writable root. A profile that sets `defaultWorkspaceDirectory` on its `workspace-controller` row keeps its own folder.
- **The studio.** Delorun's profile replaces upstream's preview notice with Delorun's own notice. `@delorun/bundle-studio` mounts `@delorun/plugin-onboarding`, whose dialog on a first open has three steps: Welcome (the language and the preview notice), Models (the key) and Ready, which opens a chat with starter prompts. Settings → General → Getting started opens the full guide, which adds the look, the Claude Code and Codex delegation bundles, the recommended plugins, the browser, phone access, the PIN and the workspace. The dialog ends by opening a chat with starter prompts: in the default workspace, or in the workspace used last when the person already has one. Where neither exists, the last step offers Delorun's own folder chooser, which adds only a folder the person selects or creates and refuses the home directory itself, a filesystem root, the Delorun home, the stock home and any folder that contains one of them, saying why and what to choose instead. A reload keeps the guide open until it is finished or skipped.

## The rules

1. The terminal is for setup and operations: install, setup, start, update, recover, reach, devices, doctor and logs. All chatting is in the studio.
2. `npx delorun` is the first command and every later one: with no profile it runs setup, which then starts Delorun in the terminal, and with one it starts Delorun, in the background unless the person turned that off, and opens the studio. Delorun never edits shell start-up files.
3. Every start, not only the first, says that Delorun keeps running after the terminal closes, says how to open the studio, and names `delorun status`, `delorun logs --follow` and `delorun stop`. `--foreground` keeps one start attached to the terminal.
4. Every question takes effect or is not asked. Upstream's two data-sharing opt-ins are not setup questions: they stay off, and `delorun setup privacy` and the privacy page say that Settings → Safety → Privacy changes them.
5. The main flow is the shortest path to a running studio: one privacy line; the phone question; "Copy your N DeepSeek Harness chats?" only when `~/.dsh` is a directory and the Delorun home has no chats, with a preview before anything changes; the port question only when 3080 is busy; then the start, with the PIN question after a phone Yes and the keep-the-command question. Every other answer takes its default: safer prompts, the profile name `default`, no changes protection, the release check on, and the background answer yes for later starts.
6. The model key is the studio's question, asked on the first open. Prompts, background, the profile name, changes protection and the release check are not asked in setup; Settings → General → How Delorun runs shows the command for each, and each is `delorun setup <section>`. Phone access keeps its checks and its one command in the [reach design](reach.md).
7. The studio's first minute is one flow of three steps that ends in a chat: Welcome (language, with Delorun's preview notice and, when device access is on, the studio's Tailscale address for finishing setup from another device), Models, and Ready, which opens a new chat in the default workspace and offers three ideas, each with a Copy button, and never sends a first message. A Workspace step joins it only where no default workspace exists, and a PIN step only when phone access is on at the computer and PIN mode is off. The full guide, from Settings → General → Getting started, adds look, the delegation bundles with what each one may do explained, recommended plugins, the browser and phone access.
8. No question is asked twice. Onboarding reads the sections record of `setup-answers.json` and leaves out what the terminal covered. The one exception is reach: the full guide shows its step whenever reach is not set up, including after the person answered No in the terminal, as an explanation with the command to run at the computer. Upstream's key dialog stays hidden when setup stored a working key.

## What this does not protect against

- `npx delorun` runs the launcher npm serves before any Delorun check. No workflow publishes it, so it carries no npm build attestation; the person checks it out of band as the [Trust page](../guide/trust.md#checking-it-yourself) describes, and the [threat model](../security/threat-model.md#releases-the-log-and-the-rebuild) states the limit.
- `npm install -g delorun@<version>` installs into the person's global npm prefix with their own access.
- A background start keeps Delorun running after the terminal closes; the person stops it with `delorun stop`.

## Denial tests

The rules above change what is asked and when; the protections they rely on keep their own denial tests, among them `yes run leaves reach and credential forwarding off` and `config file cannot enable reach` of C11. The first run adds:

- `no question is asked in the studio that setup answered`
- `setup asks no question whose answer it does not apply`
- `the import changes nothing before the person confirms the preview`

## Implementation status

The launcher's progress and its Node check, the short setup with its sections (`privacy` as a line, `reach`, `import` and `profile` for a busy port in the main flow; `key`, `prompts`, `background` and `changes-protection` through `delorun setup <section>`), the way back, the start and open in the terminal with the PIN and keep-the-command questions, and setup's record of sections are built. Onboarding in the studio, with its three-step first open, starter prompts, folder chooser and the reopening from Settings, is built, and so is the default workspace that `delorun start` resolves. The bare command starts in the background when setup's answer says so, which is the default for later starts, and in the terminal otherwise; a start in the terminal ends with how to start in the background. The stock-home import is built, as setup's `import` section and `delorun import-home` ([C8](../contracts/c08-archive-and-trash.md#the-stock-home-import)). The reach section is built for Tailscale on the person's own tailnet, with the checks and the trust statement of `delorun reach on tailscale`; the Docker section is not built.
