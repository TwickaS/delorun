---
description: "Design of Delo's first run: one command from install to a first chat, the launcher's progress, Quick and Full setup with sections, the background start, onboarding in the studio, and the rule that no question is asked twice."
---

# The first run

English

## Summary

One command, `npx delorun`, takes a person from nothing to a first chat. The launcher says what it does while it downloads and verifies a release. Setup asks the few questions a working chat needs, or every question that changes the computer when the person chooses Full. Setup then starts Delo in the background and opens the studio, where onboarding covers what setup did not, and no question is asked twice across the terminal and the studio. The terminal is for setup and operations only: chatting happens in the studio. Setup's answers are [contract C11](../contracts/c11-setup-answers.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- **The launcher.** The npm launcher refuses a Node older than 24.9 with the version it needs before it does anything else. While it installs, it prints one line for each step: the release the channel names, the signature check with the release root, the release-log check with its outcome, the download with its size, and the install. When the release-log check did not run, it prints the reason and one warning that names the release.
- **The bare command.** `delorun` with no command runs setup when the home has no CLI profile. With a profile, it starts Delo in the background when setup's `background` answer says so, and otherwise in the terminal, and opens the studio either way; `--foreground` keeps a start in the terminal.
- **Quick and Full setup.** Setup opens with Quick, preselected, or Full. Quick runs the sections `privacy` (a note that asks nothing), `key` and `prompts`; Full adds `background` and `profile`. Every question after the first offers a way back, and a review screen lists the answers before anything is written. `delorun setup <section>` runs one section again on a profile that is set up, and `delorun setup --list` lists the sections. `--yes` and `--config` give the answers without a terminal.
- **The key.** A key typed at the prompt is checked with one live request to the provider before it is stored; a failed check lets the person enter it again or continue.
- **The ending.** A terminal run offers to install the `delorun` command with `npm install -g delorun`, yes preselected, and prints that line when the person declines or the install fails. It then starts Delo in the background or in the terminal, as the `background` answer says, and opens the studio for a background start. It prints whether Delo keeps running after the terminal closes, the studio's address, and `delorun status`, `delorun logs --follow` and `delorun stop`. With no browser to open, it prints the address and the SSH port-forward line. `--yes` and `--config` start nothing and print the command to run.
- **The record.** Setup writes which sections the person saw, answered or skipped into `setup-answers.json` in the profile.
- **The studio.** Delo's profile replaces upstream's preview notice with Delo's own notice. `@delo/bundle-studio` mounts `@delo/plugin-onboarding`, whose dialog opens on the preview notice, asks for the language and look, offers the Claude Code and Codex delegation bundles and the recommended plugins, and ends by opening a chat in the default workspace with starter prompts. Its reach step never shows, because no reach exists.

## The rules

1. The terminal is for setup and operations: install, setup, start, update, recover, reach, devices, doctor and logs. All chatting is in the studio.
2. `npx delorun` is the first command and every later one: with no profile it runs setup, and with one it starts Delo in the background and opens the studio. Delo never edits shell start-up files.
3. Every start, not only the first, says that Delo keeps running after the terminal closes, prints the studio's address, and names `delorun status`, `delorun logs --follow` and `delorun stop`. `--foreground` keeps one start attached to the terminal.
4. Every question takes effect or is not asked. Upstream's two data-sharing opt-ins are not setup questions: they stay off, and the privacy note says that Settings → Privacy changes them.
5. Quick setup is the shortest path to a working chat: the privacy note; "Import your DeepSeek Harness home?" only when `~/.dsh` exists, with a preview before anything changes; the key, checked with one live request; and the prompts question. Every other answer takes its default.
6. Full setup is Quick plus the sections that change the computer: reach, with the checks and the one command of the [reach design](reach.md); where commands run, shown only while Docker workspaces are part of the release and only after Docker answers; whether Delo keeps running in the background; and the profile's name and port. Each section is also `delorun setup <section>`.
7. The studio's first minute is one flow that ends in a chat. Delo's preview notice is onboarding's first screen; the steps after it are language and look, the offer of the Claude Code and Codex delegation bundles with what each one may do explained, recommended plugins, and reach. The last screen opens a new chat in the default workspace with two or three starter prompts. Onboarding reopens from Settings.
8. No question is asked twice. Onboarding reads the sections record of `setup-answers.json` and leaves out what the terminal covered. The one exception is reach: onboarding shows its step whenever reach is not set up, including after the person skipped it in the terminal, as an explanation with the command to run at the computer. Upstream's key dialog stays hidden when setup stored a working key.

## What this does not protect against

- `npx delorun` runs the launcher npm serves before any Delo check, so the launcher is trusted through npm's build attestation, as the [threat model](../security/threat-model.md#releases-the-log-and-the-rebuild) states.
- `npm install -g delorun` installs into the person's global npm prefix with their own access.
- A background start keeps Delo running after the terminal closes; the person stops it with `delorun stop`.

## Denial tests

The rules above change what is asked and when; the protections they rely on keep their own denial tests, among them `yes run leaves reach and credential forwarding off` and `config file cannot enable reach` of C11. The first run adds:

- `no question is asked in the studio that setup answered`
- `setup asks no question whose answer it does not apply`
- `the import changes nothing before the person confirms the preview`

## What is built so far

The launcher's progress and its Node check, Quick and Full setup with its five sections, the way back, the review screen, the install offer, setup's ending and its record of sections are built. Onboarding in the studio, with its starter prompts and the reopening from Settings, is built. The bare command starts in the background only when setup's answer says so, and only setup's ending prints the message of rule 3. The stock-home import, the reach and Docker sections, and onboarding's reach step are not built.
