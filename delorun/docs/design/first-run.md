---
description: "Design of Delorun's first run: one command from install to a first chat, the launcher's progress, setup by use case with sections, the background start, onboarding in the studio, and the rule that no question is asked twice."
---

# The first run

English | [中文](first-run.zh.md)

## Summary

One command, `npx delorun`, takes a person from nothing to a first chat. The launcher says what it does while it downloads and verifies a release. Setup asks how the person will use Delorun, then the few questions a working chat needs; More settings on the review screen asks every other question that changes the computer. Setup then starts Delorun, in the background unless the person chose otherwise, and opens the studio, where onboarding covers what setup did not, and no question is asked twice across the terminal and the studio. The terminal is for setup and operations only: chatting happens in the studio. Setup's answers are [contract C11](../contracts/c11-setup-answers.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Implementation status](#implementation-status)

## What exists today

- **The launcher.** The npm launcher refuses a Node older than 24.9 with the version it needs before it does anything else. While it installs, it prints one line for each step: the release the channel names, the signature check with the release root, the release-log check with its outcome, the download with its size, and the install. When the release-log check did not run, it prints the reason and one warning that names the release.
- **The bare command.** `delorun` with no command runs setup when the home has no CLI profile. With a profile, it starts Delorun in the background when setup's `background` answer says so, and otherwise in the terminal, and opens the studio either way; `--foreground` keeps a start in the terminal.
- **Setup by use case.** Setup opens with "How will you use Delorun?": just me on this computer, also from my phone or another device, or scripts and automation. The answer sets the defaults and decides which sections the main flow asks (`privacy` shows a note, then `import`, `key` and `prompts`, and `reach` for the phone use case); the review screen's More settings asks `background`, `profile` and the rest. Setup ends by printing next steps and starts nothing. Every question after the first offers a way back, and a review screen lists the answers before anything is written. `delorun setup <section>` runs one section again on a profile that is set up, and `delorun setup --list` lists the sections. `--yes` and `--config` give the answers without a terminal.
- **The key.** A key typed at the prompt is checked with one live request to the provider before it is stored; a failed check lets the person enter it again or continue.
- **The ending.** A terminal run offers to install the `delorun` command with `npm install -g delorun@<version>`, at the version of the launcher that started it (`DELORUN_LAUNCHER_VERSION`), yes preselected, and prints that line when the person declines or the install fails; a run the launcher did not start offers no install and says how to install a pinned version. It then starts Delorun in the background or in the terminal, as the `background` answer says, and opens the studio after either start. It prints whether Delorun keeps running after the terminal closes, the studio's address, and `delorun status`, `delorun logs --follow` and `delorun stop`. With no browser to open, it prints the address and the SSH port-forward line. `--yes` and `--config` start nothing and print the command to run.
- **The record.** Setup writes which sections the person saw, answered or skipped into `setup-answers.json` in the profile.
- **The address afterwards.** `delorun status` prints the studio's address, without a token, and `Run delorun open to open the studio in your browser.` `delorun doctor` checks the port the profile's studio uses and reports it as in use by Delorun, not as a failure, while this home's own Delorun holds it.
- **The default workspace.** `delorun start` resolves the studio's default workspace before the Host boots: `Delorun/default-workspace` in the platform's documents folder when the platform reports one that is not the home directory, otherwise in the home directory. The folder is created when the studio first needs it, and never inside the Delorun home or anywhere the sandbox refuses as a writable root. A profile that sets `defaultWorkspaceDirectory` on its `workspace-controller` row keeps its own folder.
- **The studio.** Delorun's profile replaces upstream's preview notice with Delorun's own notice. `@delorun/bundle-studio` mounts `@delorun/plugin-onboarding`, whose dialog opens on the preview notice, asks for the language and look, offers the Claude Code and Codex delegation bundles and the recommended plugins, and ends by opening a chat with starter prompts: in the default workspace, or in the workspace used last when the person already has one. Where neither exists, the last step offers Delorun's own folder chooser, which adds only a folder the person selects or creates and refuses the home directory itself, a filesystem root, the Delorun home, the stock home and any folder that contains one of them, saying why and what to choose instead. Settings → General → Getting started shows the guide again, and a reload keeps it open until it is finished or skipped. Its reach step never shows, because no reach exists.

## The rules

1. The terminal is for setup and operations: install, setup, start, update, recover, reach, devices, doctor and logs. All chatting is in the studio.
2. `npx delorun` is the first command and every later one: with no profile it runs setup, and with one it starts Delorun in the background and opens the studio. Delorun never edits shell start-up files.
3. Every start, not only the first, says that Delorun keeps running after the terminal closes, says how to open the studio, and names `delorun status`, `delorun logs --follow` and `delorun stop`. `--foreground` keeps one start attached to the terminal.
4. Every question takes effect or is not asked. Upstream's two data-sharing opt-ins are not setup questions: they stay off, and the privacy note says that Settings → Safety → Privacy changes them.
5. The main flow is the shortest path to a working chat: the privacy note; "Copy your DeepSeek Harness chats, attachments and workspace list? They are only read, and nothing in them changes." only when `~/.dsh` is a directory and the Delorun home has no chats, with a preview before anything changes; the key, checked with one live request; and the prompts question. Every other answer takes its default.
6. More settings and the phone use case add the sections that change the computer: reach, with the checks and the one command of the [reach design](reach.md); where commands run, shown only while Docker workspaces are part of the release and only after Docker answers; whether Delorun keeps running in the background; and the profile's name and port. Each section is also `delorun setup <section>`.
7. The studio's first minute is one flow that ends in a chat. Delorun's preview notice is onboarding's first screen; the steps after it are language and look, the offer of the Claude Code and Codex delegation bundles with what each one may do explained, recommended plugins, and reach. The last screen opens a new chat in the default workspace with two or three starter prompts; where no default workspace exists it opens the workspace used last, or lets the person choose a folder that may hold a workspace. Onboarding reopens from Settings.
8. No question is asked twice. Onboarding reads the sections record of `setup-answers.json` and leaves out what the terminal covered. The one exception is reach: onboarding shows its step whenever reach is not set up, including after the person skipped it in the terminal, as an explanation with the command to run at the computer. Upstream's key dialog stays hidden when setup stored a working key.

## What this does not protect against

- `npx delorun` runs the launcher npm serves before any Delorun check. No workflow publishes it, so it carries no npm build attestation; the person checks it out of band as the [Trust page](../guide/safety-and-updates/trust.md#checking-it-yourself) describes, and the [threat model](../security/threat-model.md#releases-the-log-and-the-rebuild) states the limit.
- `npm install -g delorun@<version>` installs into the person's global npm prefix with their own access.
- A background start keeps Delorun running after the terminal closes; the person stops it with `delorun stop`.

## Denial tests

The rules above change what is asked and when; the protections they rely on keep their own denial tests, among them `yes run leaves reach and credential forwarding off` and `config file cannot enable reach` of C11. The first run adds:

- `no question is asked in the studio that setup answered`
- `setup asks no question whose answer it does not apply`
- `the import changes nothing before the person confirms the preview`

## Implementation status

The launcher's progress and its Node check, Setup by use case with its seven sections (`privacy`, `import`, `key` and `prompts` in the main flow, `reach` for the phone use case, `background`, `reach` and `profile` under More settings), the way back, the review screen, setup's ending (next steps only) and its record of sections are built. Onboarding in the studio, with its starter prompts, its folder chooser and the reopening from Settings, is built, and so is the default workspace that `delorun start` resolves. The bare command starts in the background when setup's answer says so, which is the default, and in the terminal otherwise. Rule 3 is built for a start in the background, which prints the message; a start in the terminal does not print it. The stock-home import is built, as setup's `import` section and `delorun import-home` ([C8](../contracts/c08-archive-and-trash.md#the-stock-home-import)). The reach section is built for Tailscale on the person's own tailnet, with the checks and the trust statement of `delorun reach on tailscale`; the Docker section and onboarding's reach step are not built.
