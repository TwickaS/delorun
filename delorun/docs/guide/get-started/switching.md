---
description: "Switching from DeepSeek Harness to Delorun: what stays the same and what is different, what delorun import-home and setup copy from ~/.dsh, what you choose one by one, what stays behind and why, the summary and the dry run, your key, plugins to install afterwards, and going back."
---

# Switching from DeepSeek Harness

English | [中文](switching.zh.md)

## Summary

This page helps you move from DeepSeek Harness to Delorun without losing your chats. DeepSeek Harness is the program Delorun is built on, as its own maintainers release it. Delorun runs DeepSeek Harness's code, so your [chats](../../reference/glossary.md#chat), [workspaces](../../reference/glossary.md#workspace) and [profiles](../../reference/glossary.md#profile) can be copied across, and your plugins work once you install them. DeepSeek Harness keeps these in a folder called `~/.dsh`. Delorun keeps its own [home](../../reference/glossary.md#home), `~/.delorun`, and copies what you choose from `~/.dsh` into it. The copy only reads `~/.dsh`. Nothing in it changes, so DeepSeek Harness keeps working exactly as before.

You need Delorun installed ([Install and first run](install.md)) and, to copy a key or install plugins, a terminal.

## Contents

- [What stays the same and what is different](#what-stays-the-same-and-what-is-different)
- [Before you import](#before-you-import)
- [Import your home](#import-your-home)
- [What carries over](#what-carries-over)
- [What stays behind](#what-stays-behind)
- [Chats from the DeepSeek website](#chats-from-the-deepseek-website)
- [Plugins after the import](#plugins-after-the-import)
- [A home that already has chats](#a-home-that-already-has-chats)
- [Ask less (like DeepSeek Harness)](#ask-less-like-deepseek-harness)
- [Going back](#going-back)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## What stays the same and what is different

The same: the harness itself (`delorun --version` prints Delorun's version and the DeepSeek Harness version it runs on), the model providers it supports, set up the same way ([Model providers](providers.md)), and the MIT licence. Your plugins work as they did in DeepSeek Harness once you install them.

Different, in the studio and around it:

- **Where Delorun runs.** `delorun` runs Delorun in the background and opens the studio; `delorun stop` stops it ([Daily use](../everyday-use/daily-use.md)).
- **Your home.** Delorun keeps its own home, `~/.delorun`, and never writes `~/.dsh` ([Your Delorun home](../customising/home.md)).
- **What commands can reach.** Commands the model runs cannot write, or read, Delorun's home, and every new workspace starts on Workspace Write ([What Delorun protects](../safety-and-updates/safety.md)).
- **Consents.** With setup's default Ask me first, Delorun asks before the model writes instruction files or schedules work, holds a new MCP server that runs a command until you allow it, and asks once before a workspace gets full access ([Consents](../safety-and-updates/safety.md#consents)).
- **`web_fetch`.** It does not fetch addresses on your own computer or network ([The web_fetch guard](../safety-and-updates/safety.md#the-web_fetch-guard)).
- **Data sharing.** DeepSeek's session-log upload is off until you turn it on in Settings → Safety → Privacy.
- **Updates.** Delorun checks for a newer release once a day, shows what an update would change before you confirm, and can go back ([Updates](../safety-and-updates/updates.md)).
- **The look.** Delorun's theme, sidebar, chat states and settings layout.
- **Removed.** DeepSeek's account and Platform integration: there is no Platform sign-in, Usage or Top-up page. DeepSeek's API works with your own key, like any other provider.
- **Left out.** Delorun has no desktop app and does not run on macOS or native Windows ([Known issues](../help/known-issues.md#where-delorun-runs), [Roadmap](../roadmap.md)).

The exact list of differences, each changed default with its evidence, is in the developer reference: the [parity checklist](../../reference/parity-with-deepseek-harness/parity.md).

## Before you import

Stop DeepSeek Harness and Delorun first. If a file in `~/.dsh` changes while the import copies it, the import stops and your Delorun home is left as it was. If your computer stops during an import, the next start of Delorun removes the part it had copied.

## Import your home

The first `delorun setup` asks "Copy your DeepSeek Harness chats, attachments and workspace list? Your DeepSeek Harness folder is only read. You can also do this later with delorun import-home." when `~/.dsh` is a folder, not a link, and your Delorun home has no chats yet. It shows a summary of what it would copy first, the answer starts on no, and it copies nothing until you answer yes. Setup copies only your chats, attachments and workspace list.

Run the import yourself to copy the rest:

```text
delorun import-home --dry-run      # show the summary of what would be copied, write nothing
delorun import-home                # show it, ask, then copy
delorun import-home --from /path/to/another/dsh-home
delorun import-home --profile work  # import into the CLI profile work
```

The import asks before it copies anything, so it needs a terminal; without one, nothing is imported.

`delorun import-home` first asks about your chats, attachments and workspace list. Then it asks about each of these on its own, and copies one only if you answer yes: your profiles, your settings, your `AGENTS.md` instructions, your skills and your DeepSeek key. Each of them can change what Delorun runs or what the agent is told, so the import shows it before it asks: the exact settings that would land, and the first lines of your instructions.

## What carries over

- **Chats.** Every chat, with every saved version of it, copied exactly. Delorun opens them as DeepSeek Harness does. Chats an older DeepSeek Harness stored without compression stay behind.
- **Workspaces.** Your workspace list, so your chats appear under the same folders.
- **Attachments.** The images and files your chats refer to.
- **Profiles, when you say so.** Each profile keeps its name, its plugin list and its plain settings. Delorun adds its own bundle, `@delorun/bundle-local`, to each profile so Delorun's privacy defaults apply, and the profile's first start also adds `@delorun/bundle-studio`, Delorun's studio additions. Start one with `delorun --profile <name>`. A profile with the same name as one your Delorun home already has, such as `default`, stays behind, because the import never replaces one.
- **Settings, when you say so.** Your home patch `cordis.patch.yml` and older `settings.yaml` settings, when your Delorun home has none of its own.
- **Instructions and skills, when you say so.** Your `AGENTS.md` and your skills. Every chat reads the instructions, and a skill can tell the agent what to do, so read them before you say yes.
- **Your DeepSeek key, when you say so.** The import lists your stored keys by name, never showing a value, and offers only the DeepSeek key, which it copies into Delorun's credentials file, which only you can read. Add other keys again in Delorun.

A chat that ran with full access in DeepSeek Harness opens in Delorun on Workspace Write, the safer preset, until you turn on full access for its workspace in Delorun: pick Full access in the chat, choose "Allow for this chat" on an approval card that asks for it, or use Settings → Safety → Permissions, or `delorun workspace full-access <folder> on`.

The import never runs anything from `~/.dsh`.

## What stays behind

The summary lists each item that is not copied, with the reason.

**Settings.** Only settings that change how Delorun looks and which model it uses by default carry over: your theme and fonts, how chats and the composer show things, your language, and your default model by name. Everything else in your settings and profile patches is held back, even when you say yes to settings or profiles, because a setting can run code, send your requests or your key to another address, or switch off a protection. The import writes them to a file under `~/.delorun/archive/stock-import/` that nothing reads. Copy what you trust from there into your own settings yourself.

**Plugins.** A profile's plugin installed from a path, a link, a git address or a URL is not carried; add it again yourself if you trust it. The import also leaves the profile's lockfile, its version exemptions and the install scripts it approved behind.

**Workspaces and chats.** A workspace in a folder that holds your settings and keys stays behind with its chats: the root of your disk, your home folder itself, a hidden folder in it such as `.ssh` or `.config`, and the DeepSeek Harness or Delorun home. A chat stays behind when it works outside its workspace's folder, or when it stopped in the middle of a turn, because continuing it would offer its unfinished tool calls for retry; finish or close it in DeepSeek Harness, then import again.

**Everything else:**

- logs, caches, installed runtimes and installed plugin packages, which are created again;
- the desktop app's own profile, `desktop`;
- the profile's change history, which starts fresh in Delorun, and live-share links;
- tool output a chat set aside, which stays in `~/.dsh`, and the installation's anonymous identifier;
- `.env`, which may hold keys: copy what you need by hand;
- permissions you granted to tools, and scheduled follow-ups, which Delorun asks for again;
- symbolic links, pipes, other mounted drives, files with more than one hard link, and names DeepSeek Harness does not write, which are never followed or copied;
- attachments whose content does not match the name they are stored under;
- chats written by a newer DeepSeek Harness than your Delorun reads, chats stored without compression, and documents too large or that this version cannot read;
- anything the import does not recognise.

Before you say yes to profiles, settings or instructions, the import shows the whole text that would land, a page at a time. For skills it lists every file, and shows a skill's instructions when you ask.

## Chats from the DeepSeek website

The import above copies chats from `~/.dsh`. Chats you had on chat.deepseek.com are a separate source: export them from the website and load the file with the optional chat import plugin, as described in [Import your DeepSeek website chats](import-deepseek-chats.md).

## Plugins after the import

Installed plugin packages are not copied. The summary lists every plugin and bundle of each profile as carried, to install, added or not carried. For each profile with something to install, run the command the import prints, for example:

```text
delorun plugin --profile web install
```

The install runs pnpm, as DeepSeek Harness does. A plugin's install script runs only after you approve it, because the approvals you gave in DeepSeek Harness are not carried. A plugin that DeepSeek Harness retired is listed as not carried.

## A home that already has chats

The import refuses a Delorun home that already holds chats, so you never mix two histories by accident. Run it again with `--merge` to add your DeepSeek Harness chats beside them. A chat or file that is already in your Delorun home with the same content is skipped; one with the same name and different content stops the import, which never overwrites anything.

The import copies at most 4 GiB unless you give a larger limit in bytes, such as `--max-size 8589934592` for 8 GiB.

## Ask less (like DeepSeek Harness)

Each of these returns one difference to DeepSeek Harness's behaviour, and you can change it back at any time:

| Switch | Where | What it changes |
| --- | --- | --- |
| Prompts: **Ask less (like DeepSeek Harness)** | `delorun setup prompts` | Turns off the full-access consent, the instruction-file consent, the MCP server consent and the scheduled-task consent. The `web_fetch` guard stays on. |
| Look: **Delorun look** off | Settings → General → Look, or onboarding's studio look | The original look, without Delorun's theme, sidebar, chat states, settings layout and onboarding. Turning **Delorun look** on again in Settings → General switches back. Onboarding's Look step records the choice and applies it when the guide finishes. |
| **Check for new releases** off | Settings → General → Updates, or `delorun setup privacy` | No release check request; `delorun update` still works when you run it. |
| **DeepSeek session-log upload** on | Settings → Safety → Privacy | Each request to DeepSeek's API carries part of your session log, as in DeepSeek Harness. |

Some differences have no switch: commands the model runs never write into Delorun's home, `web_fetch` always refuses local addresses, and Delorun checks every release it runs.

## Going back

`~/.dsh` is untouched, so DeepSeek Harness works as it did before the import. Chats you start in Delorun stay in your Delorun home and do not return to DeepSeek Harness: `delorun export` writes chats and workspaces as files that another Delorun home imports with `delorun import`, and DeepSeek Harness cannot read them.

<details>
<summary>Edge cases</summary>

- If `~/.dsh` does not exist or cannot be read, then `delorun import-home` refuses with `DSH_IMPORT_SOURCE_UNUSABLE` and imports nothing. Use `--from <dir>` to name another DeepSeek Harness home.
- If `~/.dsh` is a link rather than a folder, then setup does not offer the import.

</details>

<details>
<summary>Go further</summary>

- Held-back settings are saved under `~/.delorun/archive/stock-import/`. Copy what you trust from there.
- Move chats between Delorun homes with `delorun export` and `delorun import` ([Daily use](../everyday-use/daily-use.md#trash-export-and-import)).

</details>

## Next

- Start Delorun: [Daily use](../everyday-use/daily-use.md).
- See the model providers: [Model providers](providers.md).
- Bring chats from the DeepSeek website too: [Import your DeepSeek website chats](import-deepseek-chats.md).
- If something went wrong: [Archives, imports and the trash](../help/troubleshooting.md#archives-imports-and-the-trash).

## For the technically curious

The [archive and trash contract](../../contracts/c08-archive-and-trash.md#the-stock-home-import) defines exactly what the import copies, holds back and refuses, and the [parity checklist](../../reference/parity-with-deepseek-harness/parity.md) lists each default Delorun changes, with its evidence.
