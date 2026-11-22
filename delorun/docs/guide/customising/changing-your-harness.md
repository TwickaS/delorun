---
description: "Changing what Delorun runs: why a plugin you link from a folder runs a copy kept in your Delorun home, what loads without review while protection is off, the default, how delorun changes lists, shows, applies, discards and undoes changes, the second confirmation, working on a plugin with live reload, changing Delorun itself, turning one plugin off, what happens when a change stops Delorun from starting, the protection setting, and the studio's Changes section."
---

# Changing your harness

English | [中文](changing-your-harness.zh.md)

## Summary

You can change what your Delorun runs: plugins you link from a folder, and Delorun's own files. The [protection](../../reference/glossary.md#changes-protection) setting decides whether a change loads at once or waits for your review.

- With protection off, the default, a change loads without review and is recorded. `delorun changes` lists it, shows it with its files and a diff, and undoes it.
- With protection on, a change waits for your review. A plugin you link from a folder runs the copy you approved, so edits in the folder, yours or your agent's, break nothing that is running until you apply them. `delorun changes` lists what waits, shows each change with a summary of what it can do, and applies, discards or undoes it.
- While you work on a plugin with protection on, `delorun changes work` loads your edits live until you are done.
- Delorun's own files change in your own copy of the installed release. `delorun changes` also turns one plugin off or on, and turns protection on or off.
- A change that stops Delorun from starting is left out, and Delorun starts without it.

The studio's Changes section in Settings does the same at your computer.

## Contents

- [Plugins you link from a folder](#plugins-you-link-from-a-folder)
- [Seeing what waits for review](#seeing-what-waits-for-review)
- [Applying, discarding and undoing](#applying-discarding-and-undoing)
- [The second confirmation](#the-second-confirmation)
- [Plugin code from an imported setup](#plugin-code-from-an-imported-setup)
- [Working on a plugin](#working-on-a-plugin)
- [When your agent changes a plugin](#when-your-agent-changes-a-plugin)
- [Changing Delorun itself](#changing-delorun-itself)
- [Turning one plugin off](#turning-one-plugin-off)
- [When a change stops Delorun from starting](#when-a-change-stops-delorun-from-starting)
- [The protection setting](#the-protection-setting)
- [In the studio](#in-the-studio)

## Plugins you link from a folder

When you add a plugin with `delorun plugin --profile default add link:<folder>`, Delorun keeps a copy of the folder's content in your Delorun home and runs that copy, not the folder.

With protection off, the default, Delorun copies the folder again at each start, and while Delorun runs, each time you save a file in it: the new content loads at once and is recorded as a change. A start prints `<plugin> loaded changes without review, because protection is off: delorun changes show <id>`, and so does `delorun plugin --profile default add link:<folder>`. If what you saved fails to load, Delorun goes back to what ran before and does not try it again until you save something else; `delorun changes list` shows the error. `delorun changes undo <id>` takes a change back, and the content you undid does not load again until the folder holds something else.

With protection on, edits in the folder appear in `delorun changes list` as a change waiting for your review. Until you apply it, Delorun runs the copy you approved; a plugin you linked and never approved does not run at all. That holds while Delorun runs too: `delorun plugin --profile default add link:<folder>` prints `<plugin> is not loaded until you review it: delorun changes show <id>`, and neither that command nor a restore or undo of an earlier version of your plugins in the studio loads anything from the folder.

The copy includes the installed packages the plugin links to, such as those of a pnpm workspace, so a change to one of them is not what runs until it is part of a change you applied. A copy holds at most 50,000 files and 512 MiB with those packages. A plugin larger than that keeps running the copy you approved, or does not run, and every start says why; with protection off, a plugin that is larger only with its installed packages runs and loads those packages from where they are installed, and every start says so. A folder Delorun cannot read, such as one that keeps changing, never stops Delorun from starting: the plugin runs the copy you approved and the start names it.

Before Delorun reloads its plugins, while it runs, it checks that each plugin's copy is the one Changes keeps; when one is not, it does not reload, and what was running keeps running.

## Seeing what waits for review

| Command | Prints |
| --- | --- |
| `delorun changes` or `delorun changes list` | the changes waiting for your review first, then your recent changes, newest first, the protection setting, and the plugin Delorun is working on, if any |
| `delorun changes show <id>` | one change: the plugin, its folder, its files with the files of its dependencies grouped, and what the change can do |
| `delorun changes show <id> --diff` | the same with the diff; a very large diff is cut short, and the command names the files it left out |
| `--json` | for `list` and `show`, the same as JSON |
| `--profile <name>` | another CLI profile's changes |

A change's id, such as `c3f09a1b2c4`, names exactly the content that was shown. If the folder changes after you looked, the id no longer applies and `delorun changes list` shows the new one.

## Applying, discarding and undoing

| Command | What happens |
| --- | --- |
| `delorun changes apply <id>` | Shows the change's diff, a page at a time, then asks; the plugin runs exactly the content you reviewed. |
| `delorun changes discard <id>` | The change never runs, and it is no longer listed while the folder holds that content. Your folder stays as it is. |
| `delorun changes undo <id>` | An applied change is taken back: the plugin runs what it ran before, or nothing after undoing its install, which stops it without removing it: the undo prints `delorun plugin remove <name>` for that. |

Each of these runs only in a terminal, prints what it is about to do and asks you to confirm; any answer but `y` or `yes` changes nothing. `apply` prints the diff before it asks: press Enter for the next page, or `a` for the rest. Names, lines and messages that hold control characters are printed with those characters written as `\uXXXX`, so a file cannot change what your terminal shows. With input or output redirected, the command refuses with "This needs you at your computer: run it in a terminal."

When Delorun is running, the change takes effect at once. If the plugin then fails to load, Delorun goes back to what ran before, prints the error, and the change waits for your review again with that error. When Delorun is not running, the next start runs the change. Every applied or undone change is also a version of your profile's history, which `delorun recover` can restore.

## The second confirmation

Before you apply a change, Delorun prints a summary of what the change can do: change a consent, a guard or the sandbox policy; add a tool the model can call; run commands; open network connections; read files under your Delorun home; or add a dependency or an install or build script. It also names content the diff does not show: a file Node can load that is not text, a file too large for the diff or past where it was cut short, and files of a package inside the plugin's folder. When the checks flag the change, `apply` asks a second time and names what they found, each file the diff did not show included.

The summary helps you read the change; it is not a protection. A plugin's code can do anything Delorun can.

## Plugin code from an imported setup

`delorun setup import` ([Move your setup](move-your-setup.md)) writes the files of a plugin made on another computer to a folder under `archive/setup-plugins/` in your home and links the plugin from there, so the rules above apply to it: with protection on, its code waits in `delorun changes list` until you apply it; with protection off, it loads at the next start and is recorded as an unreviewed change.

## Working on a plugin

With protection off, your saved edits already load live without a work session. With protection on, reviewing every edit while you write a plugin gets in the way: `delorun changes work <plugin>` asks you to confirm, then loads what the plugin's folder holds now and every edit you save after it, without review, until you end the work session or its time is up: two hours, or the minutes you give with `--for`, at most 480. It prints "Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>, at the latest until <time>." Delorun has to be running, and only one plugin of a profile is worked on at a time; `delorun status`, `delorun changes list` and `delorun doctor` name it while the session lasts.

If an edit fails to load, Delorun goes back to the last version of the plugin that loaded and keeps running it. The session stays open, so your next edit loads again; `delorun doctor` shows the error until a version loads.

`delorun changes done <plugin>` shows what the folder holds as a version, such as `3f9a2c1`, with its files, the summary of what it can do and the diff against the version you approved before, and asks you to approve that version. Exactly that version becomes the approved one, and everything you changed during the session is one change, which you can undo with `delorun changes undo <id>` like any other. If the folder changes while the question waits, nothing is approved and the session stays open; run `done` again to see what it holds now. If the version fails to load, nothing is approved either.

A session that ends without you approves nothing: when Delorun stops, when the next start finds a session Delorun left open, and when its time is up. Your plugin then runs the version you approved before the session, and what the folder holds waits for your review in `delorun changes list` like any other edit, or with protection off loads at the next start.

`delorun plugin dev <folder>` ([Write a plugin for Delorun](../plugin-guides/plugins.md#run-it-while-you-work-on-it)) follows these rules too. With protection off, each edit it builds loads live. With protection on, an edit waits for your review like any other edit in the folder, and `delorun plugin dev` loads nothing from the folder until you apply it or start `delorun changes work <plugin>`.

Both commands run only in a terminal on your computer; the studio's Changes section does the same in a browser on that computer ([In the studio](#in-the-studio)). A phone can start or end a work session only after it confirms that one action with [Face ID](../everyday-use/reach.md#confirm-with-face-id) or your PIN. Your agent cannot start or end one.

## When your agent changes a plugin

With protection off, the agent's writes to a plugin's folder do not ask: what it writes loads like your own edits and is recorded. Its plugin tool works as it does in DeepSeek Harness once you give the one full-access approval: it installs and removes plugins, turns them on, changes their settings, and undoes or restores your plugin versions, and a plugin it installs from a folder or links reloads each time it saves, without review. In a chat that already has full access, or runs in dangerous mode, the tool asks nothing, so the agent installs, turns on and starts plugins with no prompt at all; that is how DeepSeek Harness works. Each of these is listed in `delorun changes list` as a change that loaded without review, and `delorun changes undo <id>` or Undo in the studio brings your plugins and their settings back as they were before it, keeping what you edited by hand before it; a later change is undone first. Each is recorded before it runs, so a plugin it loads is listed even if Delorun stops while loading it. If Delorun cannot read the protection setting, the agent's plugin tool is held as it is with protection on.

With protection on, the first time the agent writes to the folder of a plugin you approved in a chat, the chat asks you first, names the plugin and shows the diff, because the agent is changing what your harness runs. Once you allow it, the agent's other writes to that plugin in the same chat go ahead; another chat asks again. What it wrote is a change in `delorun changes list` like your own edits, and runs only after you apply it, or at once while you work on the plugin.

When the agent asks to install, update or remove a plugin with protection on, nothing is installed or removed. The request waits in `delorun changes list`, marked as asked in a chat, and the agent is told that it waits for you. `delorun changes show <id>` says what applying it does; `delorun changes apply <id>`, or Apply in the studio, runs it as `delorun plugin` would add or remove the plugin, and `discard` drops it. A plugin from a folder is added with nothing loaded: its content is a second change that you review and apply like any other. The agent cannot turn plugins on or off, change their settings, or bring back an earlier version of your plugins while protection is on; it is told that you do that yourself.

## Changing Delorun itself

`delorun changes edit-harness` makes your own copy of the installed Delorun's program files, under `changes/harness/` in your Delorun home, and prints its folder. Each file you save there, add or delete is a change to Delorun itself, listed by `delorun changes list`. With protection off, the next `delorun start` applies every such change without review and prints `Delorun itself (<file>) changed without review, because protection is off: delorun changes show <id>`; `delorun changes undo <id>` takes one back. With protection on, each waits for your review: you apply, discard and undo it with the same commands as a plugin's change, and an applied change runs from Delorun's next start. The installed release itself is never edited: Delorun checks it as it always does, and runs it with exactly the changes you applied.

| Command | What happens |
| --- | --- |
| `delorun changes edit-harness` | Makes your copy and prints its folder; when the copy exists, prints the folder and changes nothing. |
| `delorun changes apply <id>` | Shows the change and asks; Delorun runs the file as you saved it from its next start. |
| `delorun changes discard <id>` | Your copy gets back the file Delorun runs. |
| `delorun changes undo <id>` | Delorun runs the file as before from its next start. |
| `delorun changes edit-harness --discard` | Asks, then takes back every change to Delorun itself and removes your copy; the next start runs the installed release unchanged. |

These commands run only in a terminal, and only in an installed Delorun, not in a source checkout. The studio's Changes section applies, undoes and discards the same changes at your computer, and Make my copy there makes your copy. A phone confirms each of discarding, applying or undoing a change, and making your copy, with [Face ID](../everyday-use/reach.md#confirm-with-face-id) or your PIN, unless a Face ID pass is open. When Delorun fails to start right after you applied a change to it, including when a changed file stops Delorun before it starts, it starts once more without your newest change to it, as it does for a plugin. When it does not start without that change either, it names `delorun changes undo <id>` for your newest applied change and `delorun changes edit-harness --discard`, which takes back every change to Delorun itself. Safe mode, `delorun recover safe-mode`, runs the installed release without any of your changes to it until you leave safe mode. `delorun verify` and `delorun doctor` list the files you changed. Your changes belong to the installed version: after an update, the update report says how each one carries over.

Your agent can edit your copy for you. In a chat with full access, the `delorun-harness-copy` skill points it at your copy of Delorun, and it works only there. It never applies, undoes or discards a change and never changes protection: those decisions stay yours.

## Turning one plugin off

`delorun changes off <plugin>` stops one plugin without touching the others, and `delorun changes on <plugin>` runs it again. Both ask first, and both are changes you can undo with `delorun changes undo <id>`. Delorun's own plugin always stays on; to start without every other plugin, use `delorun recover safe-mode`.

## When a change stops Delorun from starting

When Delorun fails to start right after you applied a change to a plugin, or turned one on, it starts once more without that change and tells you which it was:

```text
Delorun did not start with your latest change to my-plugin (c1a2b3c4d5e): SyntaxError: Unexpected token.
It starts without it now; your files are unchanged.
To try it again: delorun changes apply c1a2b3c4d5e. To undo it: delorun changes undo c1a2b3c4d5e.
```

The plugin runs the version it ran before the change, or does not run when the change added it or turned it on. Every start says so, and so do `delorun changes list` and `delorun doctor`, until you apply the change again or undo it. Delorun leaves out only that one change and rewrites none of your files. When Delorun does not start without it either, it stops and says: "Delorun did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start."

## The protection setting

| Setting | What happens to a change |
| --- | --- |
| `off` (the default) | It loads without review: a plugin's folder at each start and each time you save while Delorun runs, your copy of Delorun itself at the next start. Each change is listed in `delorun changes list`, named by `delorun verify` and `delorun doctor`, and can be undone. Your agent's plugin tool runs as in DeepSeek Harness, after its one full-access approval (a chat with full access gives none), and each action is listed and can be undone. |
| `on` | It waits for your review and loads only once you apply it; a plugin you never approved does not run. Your agent asks before it first changes an approved plugin in a chat, and its plugin installs and removals wait for you. |

With protection off, anything that can write a linked plugin's folder can change what Delorun runs before you see it: an agent working with full access, a program you downloaded, any program running as you. Commands in a confined workspace write only where the sandbox allows: a plugin folder inside that workspace, never your Delorun home, so they cannot change your copy of Delorun itself. Turn protection on when you want to review each change first.

`delorun changes protection` prints the setting and what it means. `delorun changes protection on` or `off` changes it in a terminal on your computer, and the studio's Changes section changes it at your computer. A phone can turn it on without a prompt, and turns it off only after [Face ID](../everyday-use/reach.md#confirm-with-face-id) or your PIN. Each way says what the new setting means, such as "Changes will load without your review." for `off`, and asks you to confirm; the new setting applies at once, without a restart. Full setup also offers to turn protection on.

Turning protection off asks a second time and names what would then load without review: the plugins whose waiting changes would load at once, and the files of your copy of Delorun that would apply at the next start. That second question stops a slip of the finger. It does not stop someone who is at your computer, because they can answer it too.

When a phone changes the setting, your computer keeps a notice. The studio shows it, and `delorun changes list` prints it under "Changed from a phone:" and clears it once it has printed to a terminal.

## In the studio

Settings has a Changes section that shows what `delorun changes list` shows: the plugin you are working on, the changes a failed start left out with its error, the changes waiting for your review with their folder, the number of files and what the checks found, your agent's plugin requests, your recent changes, your changes to Delorun itself with their diff, and the protection setting; with protection off it says that changes load without your review and that a linked plugin reloads live each time you save it.

| Action | What happens |
| --- | --- |
| Review | Opens the change with its folder, its files marked added, changed or removed, what it can do, the files the diff does not show, and the diff. |
| Apply, in the review | The plugin runs the content you reviewed. When the checks flagged the change, the studio asks a second time and names what they found and each file the diff does not show. |
| Discard, in the review | The change never runs; your folder stays as it is. |
| Undo, Apply again | Asks first, then takes back an applied change, or loads a change a failed start left out again. |
| Start working | Asks first, then loads the plugin's edits live for two hours. While the session lasts, a badge at the foot of the sidebar names the plugin. |
| Done | Shows your folder's version, such as `3f9a2c1`, with its diff, and approves exactly that version; a flagged version asks a second time. |
| Make my copy | Makes your copy of Delorun, or finds the one you have, and shows its folder. |
| Review, then Apply, for a change to Delorun itself | Opens the change waiting in your copy with its diff and the version of the file, such as `9c41e07`, and applies exactly that version. When the file changed again after you opened it, nothing is applied and the studio asks you to look again. The row then says whether the change runs now or after a restart. |
| Discard, for a change to Delorun itself | Asks first; the file in your copy goes back to the installed release's. |
| Restart now | Shown when changes to Delorun itself run after a restart. It says which chats are running: Delorun waits for them to finish, starting no new turn meanwhile, or you stop them. The page reconnects by itself after a few seconds. If Delorun does not start with your changes, it keeps running as before, leaves the newest change out and says so, with Undo. Without `delorun start`, the changes run at the next start instead. |
| The protection switch | Turning it on asks once and says how many changes loaded without review while it was off. Turning it off asks once and names what would then load without review. |

An agent's request to install, update or remove a plugin can be applied, after a second confirmation that says Delorun cannot show what it installs before it runs, or discarded. The studio also applies, undoes and discards changes to Delorun itself, makes your copy of it, and turns protection on or off, with the second question described above for `off`. Each outcome shows briefly at the bottom of the window, including the error when a change failed to load and Delorun went back to what ran before.

At your computer, every action works. On a phone, the section shows everything. Turning protection on needs no prompt, and every other action asks for [Face ID](../everyday-use/reach.md#confirm-with-face-id) or your PIN each time, unless a Face ID pass is open. Opening the Changes page on a phone never asks. A button the phone may not use is greyed out and says "Needs your computer" when you point at it. When a phone changed protection, your computer's Changes section shows a notice with the phone's name and the time, until you dismiss it.
