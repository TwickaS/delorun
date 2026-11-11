---
description: "Switching from stock DeepSeek Harness to Delo: what delorun import-home and setup copy from ~/.dsh, what you choose one by one, what is held back or stays behind and why, the preview and the dry run, your key, plugins to install afterwards, and going back."
---

# Switching from DeepSeek Harness

English

## Summary

If you used stock DeepSeek Harness, your chats, workspaces, profiles and settings live in `~/.dsh`. Delo keeps its own home, `~/.delo`, and copies what you choose from `~/.dsh` into it. The copy only reads `~/.dsh`: nothing in it changes, so stock DeepSeek Harness keeps working exactly as before, and you can go back at any time.

## Contents

- [Import your home](#import-your-home)
- [What carries over](#what-carries-over)
- [What is held back](#what-is-held-back)
- [Workspaces and chats that stay behind](#workspaces-and-chats-that-stay-behind)
- [What stays behind](#what-stays-behind)
- [Plugins after the import](#plugins-after-the-import)
- [A home that already has chats](#a-home-that-already-has-chats)
- [What changes when you switch](#what-changes-when-you-switch)
- [Same as stock](#same-as-stock)
- [Going back](#going-back)

## Import your home

The first `delorun setup` asks "Copy your DeepSeek Harness chats, attachments and workspace list? They are only read, and nothing in them changes." when `~/.dsh` is a folder, not a link, and your Delo home has no chats yet. It shows what it would copy first, the answer starts on no, and it copies nothing until you answer yes. Setup copies only your chats, attachments and workspace list.

Run the import yourself to copy the rest:

```text
delorun import-home --dry-run      # show what would be copied, write nothing
delorun import-home                # show it, ask, then copy
delorun import-home --from /path/to/another/dsh-home
delorun import-home --profile work  # import into the CLI profile work
```

The import asks before it copies anything, so it needs a terminal; without one, nothing is imported.

`delorun import-home` first asks about your chats, attachments and workspace list. Then it asks about each of these on its own, and copies one only if you answer yes: your profiles, your settings, your `AGENTS.md` instructions, your skills and your DeepSeek key. Each of them can change what Delo runs or what the agent is told, so the import shows it before it asks: the exact settings that would land, and the first lines of your instructions.

Stop DeepSeek Harness and Delo before you import. If a file in `~/.dsh` changes while the import copies it, the import stops, and your Delo home is left as it was. If your computer stops during an import, the next start of Delo removes the part it had copied.

## What carries over

- **Chats.** Every chat, with every saved version of it, copied exactly. Delo opens them as DeepSeek Harness does. Chats an older DeepSeek Harness stored without compression stay behind.
- **Workspaces.** Your workspace list, so your chats appear under the same folders.
- **Attachments.** The images and files your chats refer to.
- **Profiles, when you say so.** Each profile keeps its name, its plugin list and its plain settings. Delo adds its own bundle, `@delo/bundle-local`, to each profile so Delo's privacy defaults apply, and the profile's first start also adds `@delo/bundle-studio`, Delo's studio additions. Start one with `delorun --profile <name>`. A stock profile with the same name as a profile your Delo home already has, such as `default`, stays behind, because the import never replaces one.
- **Settings, when you say so.** Your home patch `cordis.patch.yml` and older `settings.yaml` settings, when your Delo home has none of its own.
- **Instructions and skills, when you say so.** Your `AGENTS.md` and your skills. Every chat reads the instructions, and a skill can tell the agent what to do, so read them before you say yes.
- **Your DeepSeek key, when you say so.** The import lists your stored keys by name, never showing a value, and offers only the DeepSeek key, which it copies into Delo's credentials file, which only you can read. Add other keys again in Delo.

A chat that ran with full access in DeepSeek Harness opens in Delo on the safer preset, until you allow full access for its workspace in Delo.

The import never runs anything from `~/.dsh`.

## What is held back

Only settings that change how Delo looks and which model it uses by default carry over: your theme and fonts, how chats and the composer show things, your language, and your default model by name. Everything else in your settings and profile patches is held back, even when you say yes to settings or profiles, because a setting can run code, send your requests or your key to another address, or switch off a protection. The preview lists each held-back setting with the reason, and the import writes them to a file under `~/.delo/archive/stock-import/` that nothing reads. Copy what you trust from there into your own settings yourself.

A profile's plugin installed from a path, a link, a git address or a URL is not carried; add it again yourself if you trust it. The import also leaves the profile's lockfile, its version exemptions and the install scripts it approved behind.

## Workspaces and chats that stay behind

The preview lists every workspace with its folder. A workspace in a folder that holds your settings and keys stays behind with its chats: the root of your disk, your home folder itself, a hidden folder in it such as `.ssh` or `.config`, and the DeepSeek Harness or Delo home. A chat stays behind when it works outside its workspace's folder, or when it stopped in the middle of a turn, because continuing it would offer its unfinished tool calls for retry; finish or close it in DeepSeek Harness, then import again.

Before you say yes to profiles, settings or instructions, the import shows the whole text that would land, a page at a time. For skills it lists every file, and shows a skill's instructions when you ask.

## What stays behind

The preview lists each item that is not copied, with the reason:

- logs, caches, installed runtimes and installed plugin packages, which are created again;
- the desktop app's own profile, `desktop`;
- the profile's change history, which starts fresh in Delo, and live-share links;
- tool output a chat set aside, which stays in `~/.dsh`, and the installation's anonymous identifier;
- `.env`, which may hold keys: copy what you need by hand;
- permissions you granted to tools, and scheduled follow-ups, which Delo asks for again;
- symbolic links, pipes, other mounted drives, files with more than one hard link, and names DeepSeek Harness does not write, which are never followed or copied;
- attachments whose content does not match the name they are stored under;
- chats written by a newer DeepSeek Harness than your Delo reads, chats stored without compression, and documents too large or that this version cannot read;
- anything the import does not recognise.

## Plugins after the import

Installed plugin packages are not copied. The preview lists every plugin and bundle of each profile as carried, to install, added or not carried. For each profile with something to install, run the command the import prints, for example:

```text
delorun plugin --profile web install
```

The install runs pnpm, as DeepSeek Harness does. A plugin's install script runs only after you approve it, because the approvals you gave in DeepSeek Harness are not carried. A plugin that DeepSeek Harness retired is listed as not carried.

## A home that already has chats

The import refuses a Delo home that already holds chats, so you never mix two histories by accident. Run it again with `--merge` to add your stock chats beside them. A chat or file that is already in your Delo home with the same content is skipped; one with the same name and different content stops the import, which never overwrites anything.

The import copies at most 4 GiB unless you give a larger limit in bytes, such as `--max-size 8589934592` for 8 GiB.

## What changes when you switch

Your chats and workspaces look as they did, and your plugins work as they did in DeepSeek Harness once you install them. A few things behave differently in Delo's studio:

- **Where Delo runs.** `delorun` runs Delo in the background and opens the studio; `delorun stop` stops it ([Daily use](daily-use.md)).
- **Your home.** Delo keeps its own home, `~/.delo`, and never writes `~/.dsh` ([Your Delo home](home.md)).
- **What commands can reach.** Commands the model runs cannot write, or read, Delo's home, and every new workspace starts on Workspace Write ([What Delorun protects](safety.md)).
- **Consents.** With setup's default Safer prompts, Delo asks before the model writes instruction files or schedules work, refuses a new MCP server that runs a command, and refuses to switch a workspace to full access ([Consents](safety.md#consents)).
- **`web_fetch`.** It does not fetch addresses on your own computer or network ([The web_fetch guard](safety.md#the-web_fetch-guard)).
- **Data sharing.** DeepSeek's session-log upload is off until you turn it on in Settings, under Privacy.
- **Updates.** Delo checks for a newer release once a day, shows what an update would change before you confirm, and can go back ([Updates](updates.md)).
- **The look.** Delo's theme, sidebar, chat states and settings layout.

[Delorun and stock DeepSeek Harness](delo-vs-stock.md) lists every difference and what is not available yet, and the [parity checklist](../reference/parity.md) lists each changed default with its evidence.

## Same as stock

Each of these returns one difference to DeepSeek Harness's behaviour, and you can change it back at any time:

| Switch | Where | What it changes |
| --- | --- | --- |
| Prompts: **Same as stock** | `delorun setup prompts`, or the prompts question in setup | Turns off the full-access consent, the instruction-file consent, the MCP server consent and the scheduled-task consent. The `web_fetch` guard stays on. |
| Look: **Stock** | Settings, under Appearance, or onboarding's studio look | The original look, without Delo's theme, sidebar, chat states, settings layout and onboarding. **Delo look** under General switches back. |
| **Check for new releases** off | Settings, under Privacy, or `delorun setup privacy` | No release check request; `delorun update` still works when you run it. |
| **DeepSeek session-log upload** on | Settings, under Privacy | Each request to DeepSeek's API carries part of your session log, as in DeepSeek Harness. |

Some differences have no switch: commands never reach Delo's home, `web_fetch` always refuses local addresses, and Delo checks every release it runs.

## Going back

`~/.dsh` is untouched, so stock DeepSeek Harness works as it did before the import. Chats you start in Delo stay in your Delo home; Delo's export files ([`delorun export`](../contracts/c08-archive-and-trash.md#import-and-export)) carry chats and workspaces between homes.
