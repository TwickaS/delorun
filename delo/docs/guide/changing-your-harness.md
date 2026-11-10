---
description: "Changing what Delo runs: why a plugin you link from a folder runs the copy you approved, how delorun changes lists, shows, applies, discards and undoes changes, the second confirmation, working on a plugin with live reload, turning one plugin off, what happens when a change stops Delo from starting, and the protection setting."
---

# Changing your harness

Delo has no release yet; this page describes the first release.

## Summary

Nothing changes what your Delo runs unless you approved it at your computer. A plugin you link from a folder runs from a copy of the content you approved, so edits in the folder, yours or your agent's, wait for your review and break nothing that is running. `delorun changes` lists what waits, shows each change with its files, a diff and a summary of what it can do, and applies, discards or undoes it. While you work on a plugin, `delorun changes work` loads your edits live until you are done. It also turns one plugin off or on, and sets how Delo treats changes you have not reviewed. A change that stops Delo from starting is left out, and Delo starts without it.

## Contents

- [Plugins you link from a folder](#plugins-you-link-from-a-folder)
- [Seeing what waits for review](#seeing-what-waits-for-review)
- [Applying, discarding and undoing](#applying-discarding-and-undoing)
- [The second confirmation](#the-second-confirmation)
- [Working on a plugin](#working-on-a-plugin)
- [When your agent changes a plugin](#when-your-agent-changes-a-plugin)
- [Turning one plugin off](#turning-one-plugin-off)
- [When a change stops Delo from starting](#when-a-change-stops-delo-from-starting)
- [The protection setting](#the-protection-setting)

## Plugins you link from a folder

When you add a plugin with `delorun plugin add link:<folder>`, Delo keeps a copy of the content you approved in your Delo home and runs that copy, not the folder. Edits in the folder appear in `delorun changes list` as a change waiting for your review. Until you apply it, Delo runs the copy you approved; a plugin you linked and never approved does not run at all. That holds while Delo runs too: `delorun plugin add link:<folder>` prints `<plugin> is not loaded until you review it: delorun changes show <id>`, and neither that command nor a restore or undo of an earlier version of your plugins in the studio loads anything from the folder.

The copy includes the installed packages the plugin links to, such as those of a pnpm workspace, so a change to one of them is not what runs until it is part of a change you applied. A copy holds at most 50,000 files and 512 MiB with those packages. Under the default protection, a plugin larger than that does not run, or keeps running the copy you approved, and every start says why; under Warn it runs and loads its installed packages from where they are installed, and every start says so. A folder Delo cannot read, such as one that keeps changing, never stops Delo from starting: the plugin runs the copy you approved and the start names it.

Before Delo reloads its plugins, while it runs, it checks that each plugin's copy is the one you approved; when one is not, it does not reload, and what was running keeps running.

The first start of a release with this behaviour approves the plugins you already link as they are and says so once, so nothing you run changes.

## Seeing what waits for review

| Command | Prints |
| --- | --- |
| `delorun changes` or `delorun changes list` | the changes waiting for your review first, then your recent changes, newest first, the protection setting, and the plugin Delo is working on, if any |
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
| `delorun changes undo <id>` | An applied change is taken back: the plugin runs what it ran before, or nothing after undoing its install. |

Each of these runs only in a terminal, prints what it is about to do and asks you to confirm; any answer but `y` or `yes` changes nothing. `apply` prints the diff before it asks: press Enter for the next page, or `a` for the rest. Names, lines and messages that hold control characters are printed with those characters written as `\uXXXX`, so a file cannot change what your terminal shows. With input or output redirected, the command refuses with "This needs you at your computer: run it in a terminal."

When Delo is running, the change takes effect at once. If the plugin then fails to load, Delo goes back to what ran before, prints the error, and the change waits for your review again with that error. When Delo is not running, the next start runs the change. Every applied or undone change is also a version of your profile's history, which `delorun recover` can restore.

## The second confirmation

Before you apply a change, Delo prints a summary of what the change can do: change a consent, a guard or the sandbox policy; add a tool the model can call; run commands; open network connections; read files under your Delo home; or add a dependency or an install or build script. It also names content the diff does not show: a file Node can load that is not text, a file too large for the diff or past where it was cut short, and files of a package inside the plugin's folder. When the checks flag the change, `apply` asks a second time and names what they found, each file the diff did not show included.

The summary helps you read the change; it is not a protection. A plugin's code can do anything Delo can.

## Working on a plugin

While you write a plugin, reviewing every edit gets in the way. `delorun changes work <plugin>` asks you to confirm, then loads what the plugin's folder holds now and every edit you save after it, without review, until you end the work session or its time is up: two hours, or the minutes you give with `--for`, at most 480. It prints "Working on <plugin>: edits in <folder> load live until delorun changes done <plugin>, at the latest until <time>." Delo has to be running, and only one plugin of a profile is worked on at a time; `delorun status`, `delorun changes list` and `delorun doctor` name it while the session lasts.

If an edit fails to load, Delo goes back to the last version of the plugin that loaded and keeps running it. The session stays open, so your next edit loads again; `delorun doctor` shows the error until a version loads.

`delorun changes done <plugin>` shows what the folder holds as a version, such as `3f9a2c1`, with its files, the summary of what it can do and the diff against the version you approved before, and asks you to approve that version. Exactly that version becomes the approved one, and everything you changed during the session is one change, which you can undo with `delorun changes undo <id>` like any other. If the folder changes while the question waits, nothing is approved and the session stays open; run `done` again to see what it holds now. If the version fails to load, nothing is approved either.

A session that ends without you approves nothing: when Delo stops, when the next start finds a session Delo left open, and when its time is up. Your plugin then runs the version you approved before the session, and what the folder holds waits for your review in `delorun changes list` like any other edit.

Both commands run only in a terminal on your computer. The studio, a remote session and your agent cannot start or end a work session.

## When your agent changes a plugin

The first time the agent writes to the folder of a plugin you approved in a chat, the chat asks you first, names the plugin and shows the diff, because the agent is changing what your harness runs. Once you allow it, the agent's other writes to that plugin in the same chat go ahead; another chat asks again. What it wrote is a change in `delorun changes list` like your own edits, and runs only after you apply it, or at once while you work on the plugin.

When the agent asks to install, update or remove a plugin, nothing is installed or removed. The request waits in `delorun changes list`, marked as asked in a chat, and the agent is told that it waits for you. `delorun changes show <id>` says what applying it does; `delorun changes apply <id>` runs it as `delorun plugin add` or `remove` would, and `discard` drops it. A plugin from a folder is added with nothing loaded: its content is a second change that you review and apply like any other. The agent cannot turn plugins on or off, change their settings, or bring back an earlier version of your plugins; it is told that you do that yourself.

## Turning one plugin off

`delorun changes off <plugin>` stops one plugin without touching the others, and `delorun changes on <plugin>` runs it again. Both ask first, and both are changes you can undo with `delorun changes undo <id>`. Delo's own plugin always stays on; to start without every other plugin, use `delorun recover safe-mode`.

## When a change stops Delo from starting

When Delo fails to start right after you applied a change to a plugin, or turned one on, it starts once more without that change and tells you which it was:

```text
Delo did not start with your latest change to my-plugin (c1a2b3c4d5e): SyntaxError: Unexpected token.
It starts without it now; your files are unchanged.
To try it again: delorun changes apply c1a2b3c4d5e. To undo it: delorun changes undo c1a2b3c4d5e.
```

The plugin runs the version it ran before the change, or does not run when the change added it or turned it on. Every start says so, and so do `delorun changes list` and `delorun doctor`, until you apply the change again or undo it. Delo leaves out only that one change and rewrites none of your files. When Delo does not start without it either, it stops and says: "Delo did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start."

## The protection setting

| Setting | A plugin whose folder you changed and did not review |
| --- | --- |
| `block` (the default) | runs the copy you approved; a plugin you never approved does not run |
| `warn` | runs the folder's content, and every start names it |
| `off` | runs the folder's content, and nothing says so |

`delorun changes protection` prints the setting. `delorun changes protection block`, `warn` or `off` changes it, only in a terminal on your computer; the studio cannot change it. Before it lowers the setting, the command says "Changed plugins will run without your review." and asks you to confirm. The next start uses the new setting.
