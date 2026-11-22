---
description: "Move your plugins, model choices and settings to another computer or profile with delorun setup export and delorun setup import: what the file holds and never holds, how the import shows who signed it and what it replaces, how plugin code you made is held for review, the key you add afterwards, and how to undo an import."
---

# Move your setup to another computer

English | [中文](move-your-setup.zh.md)

## Summary

`delorun setup export` writes the plugins you added, your model choices and your settings into one signed file. `delorun setup import` on another computer, or into another [profile](../../reference/glossary.md#profile), replaces that profile's setup with the file's, after it shows you everything that changes and asks. The file never holds a key, a chat, a paired device or an answer you gave setup. You need Delorun on both computers and a terminal on the one that imports.

## Contents

- [Write the file](#write-the-file)
- [What the file holds](#what-the-file-holds)
- [Import the file](#import-the-file)
- [After the import](#after-the-import)
- [Go back](#go-back)
- [In the studio](#in-the-studio)
- [For the technically curious](#for-the-technically-curious)

## Write the file

```sh
delorun setup export --out my-setup.delorun
```

Delorun prints what went in, the key of this computer that signed the file, and what it left out and why. It never replaces a file that exists. Add `--profile <name>` to export another profile.

You choose what goes in:

| Option | Effect |
| --- | --- |
| `--no-settings` | Leaves out the settings besides your model choices. The file records that it has none. |
| `--plugin <name>` (repeat it) | Puts in only the plugins you name, so a file you share holds one plugin and nothing else of yours. |
| `--no-local-code` | Names the plugins you made without their code. Whoever imports the file copies them. |
| `--note "…"` | A note the importer reads beside the signer. |

Your model provider, models and any custom endpoint address always go in; the studio's Export setup dialog has the same choices as switches and a checklist (**Include settings**, **Include my own plugins' code**, the plugins, and a note).

## What the file holds

| In the file | Left out of the file |
| --- | --- |
| Each plugin you added, by its exact version and the checksum of its package | Delorun's own packages, which every computer has |
| For a plugin you made yourself: the files of the copy you approved | A plugin you made that you have not approved yet, and symbolic links inside one |
| Your default model and provider, and the model settings, with a custom endpoint address | Any key, token or password. The export stops and names the setting if one is in a settings row |
| The look of the studio, and the settings of the plugins in the file | The sandbox, permissions, network, devices and reach settings: they protect one computer |
| | Chats, attachments, your paired devices, the exemptions you gave, and the answers you gave setup |

A setting that reads an environment variable with `!!js` stays behind, because an expression runs code.

## Import the file

```sh
delorun setup import my-setup.delorun
```

Add `--dry-run` to see what the file would do without a terminal and without changing anything. Add `--no-settings` to leave your settings exactly as they are (only your model choices are replaced), and `--remove-others` to also remove the plugins the file does not list. The import then:

1. Checks the file in full before it writes anything. A file that was changed after it was signed, or that holds a path outside the plugin's folder, is refused.
2. Says who signed it. A file from your own computer shows as signed by this computer's key. A file from another computer, or an unsigned file, is shown as **Unverified signer** with the key's fingerprint. Compare the fingerprint with the one the export printed on the other computer. You can still import it; what you read next is the safeguard.
3. Lists what it would do and says which parts it replaces: the plugins it adds or moves, the plugins it removes (only with `--remove-others`), the settings it sets, changes or takes back to their defaults, the sender's note, the plugins the file names without code, the endpoints your model settings would send requests to, the plugins it keeps as they are, and what it does not apply.
4. Asks `Replace the setup of the profile default with this one? [y/N]`. Your keys, chats, devices, exemptions and setup answers are never touched.
5. If a model setting sends requests to an address that is not the provider's own, asks about each one separately: `Requests and your custom key will go to models.example.com. Allow that? [y/N]`. Say no and nothing changes.

By default the import replaces your model choices and your other settings, and touches only the plugins the file lists, so a file holding one plugin cannot wipe your setup. A model or plugin setting the file does not carry goes back to its default, except the settings of plugins you keep: they stay as they are. A model provider may name only its own key variable, so a file cannot make Delorun send another variable of your computer to a server. With `--remove-others` a plugin the file does not list is removed too. Settings that protect the computer, such as the sandbox, permissions and network, are never carried and stay as they are.

The import installs and removes plugins the way `delorun plugin` does, with the same checks. A plugin made on another computer is written to a folder under your home and linked from there. Its code is **not approved by the import**. With [protection](../../reference/glossary.md#changes-protection) on, it waits in `delorun changes list` until you review it ([Changing your harness](changing-your-harness.md)). With protection off, it loads at the next start without review, as any plugin you link from a folder does; turn protection on first with `delorun changes protection on` if you want to read it first.

## After the import

Delorun names the model provider that needs a key. Add it with `delorun setup key`, or in the studio under Settings → Agent → Models. A setup never carries one.

## Go back

Before it changes anything, the import saves your setup as the version **Before importing a setup**. One restore puts everything back:

```sh
delorun recover restore <version>
```

The command prints the version. You can also choose it under Settings → Setup versions in the studio ([Changing your harness](changing-your-harness.md)). Going back also discards the code reviews the import was holding for plugins you made elsewhere.

<details>
<summary>Edge cases</summary>

- If the import stops partway, for example because a package cannot be installed, the steps before it stay done and the saved version restores the setup you had. The message names the step.
- If a package arrives with another checksum than the file names, or the checksum cannot be checked, the import stops before that package loads, and nothing of it is applied.
- If the file lists a package of Delorun's own, the import refuses it.
- If a plugin you made needs packages it installed in its own folder, install them there after the import. Links are not carried.
- If you run the import without a terminal, it refuses; `--dry-run` works without one.

</details>

## In the studio

Settings → Setup versions has an **Export setup** button and an **Import setup** button; they work only in the studio on the computer that runs Delorun, not from a phone. Export setup opens a dialog with the **Include settings** and **Include my own plugins' code** switches, a checklist of your plugins and a note. Import setup shows the list of changes first, with an **Include settings** switch (only when the file has settings) and **Remove plugins not in this archive** (off), and replaces your setup only when you press **Replace my setup**. When a model setting sends requests to an address that is not the provider's own, the list says `Requests and your <provider> key will go to <address>` and **Replace my setup** stays off until you switch on **I confirm these endpoints**. Changing any switch plans again, and the plan you apply is always the one you were shown.

## For the technically curious

The file is the [archive format of contract C8](../../contracts/c08-archive-and-trash.md#the-setup-archive) with `content` `setup`, signed with this computer's home key, so one reader checks every archive. The import applies plugins through the same plugin requests the agent's `plugin_manager` records ([`@delorun/changes`](../../../packages/changes/README.md)), so no check a hand install meets is skipped.
