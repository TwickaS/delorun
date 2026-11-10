---
description: "Design of opening imported chats and applying an archive's customisation: the untrusted state with its banner, history kept out of model context until the person trusts a chat, the diff screen, the rules for imported skills, presets and plugin declarations, and the import of a stock DeepSeek Harness home."
---

# Imported chats and customisation

English

## Summary

`delorun import` validates an archive, checks its signature and stores its workspaces under the home, and nothing reads what it stores. This page holds the rules Delo has adopted for using an import: opening imported chats in the studio as untrusted chats whose history stays out of model context until the person trusts them, applying the archive's customisation rows after a diff screen, and importing a stock DeepSeek Harness home. The archive format and the import's validation are [contract C8](../contracts/c08-archive-and-trash.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- `delorun import` publishes each imported workspace's manifest documents and objects under `archive/imported/<id>/` in the home. It creates no session, and no row of the CLI profile reads `archive/imported/`, so no imported chat reaches the studio, a Host plugin or a model request.
- An imported chat has no trust state, no banner and no action that marks it trusted, and it has no path to the trash or to a purge.
- `delorun import` prints each customisation row's kind and target and applies none of them: no bundle, profile row, preset, skill, theme or plugin declaration from an archive is written. `delorun export` writes no customisation rows.
- `delorun import-home` and setup's `import` section import a stock DeepSeek Harness home ([C8](../contracts/c08-archive-and-trash.md#the-stock-home-import)). Its chats land in `sessions/` and the studio opens them as the person's own: they have no trust state or banner yet. Each copied chat is recorded in `archive/stock-import/imports.json`, which `readImportedChats` of `@delo/archive/dsh-import` reads back, and no chat that stopped inside a turn is carried.

## The rules

### Untrusted imported chats

1. Every imported chat opens in the studio as untrusted until the person marks it trusted. An untrusted chat shows a banner that names its source, meaning the archive's origin or file name, and whether the archive was signed by a key the home vouches for or accepted as unverified.
2. An untrusted chat's history stays out of model context: no model request carries any of its events until the person marks the chat trusted. Marking a chat trusted is an action of the person at the studio, recorded in the chat's session log, and no tool, plugin route or remote session can take it.
3. Deleting an untrusted chat moves it to the trash, and purging it removes it from every store [C8](../contracts/c08-archive-and-trash.md#trash-and-purge) lists.

### Applying customisation

4. The customisation applies only after the person has seen its diff. The diff screen shows each row, its kind and its target before the change is written.
5. Imported skills start disabled.
6. An imported preset cannot raise a permission above the person's own presets.
7. Imported plugin declarations and bundles are listed and never installed automatically.
8. The denied row kinds and the refusal of `!!js` expressions and `insert` rows that C8 states hold for every row applied.

### A stock home

9. The import of a stock DeepSeek Harness home never modifies the stock home. Its sessions are imported chats under the rules above; marking them untrusted, with the banner and the history kept out of model context, is what remains to build for them.

## What this does not protect against

- **Text the person trusts.** Once the person marks a chat trusted, its history is model context like any other chat, including any instruction injected into it.
- **A signer the person confirmed.** The signature shows which key signed the archive, not that its content is safe.
- **Customisation the person applies.** An applied row takes effect as if the person had written it.

## Denial tests

| Test | Proves |
| --- | --- |
| `imported chat stays out of model context until trusted` | An untrusted chat shows its banner, and its history is absent from every model request until the person marks it trusted. |
| `no tool or remote session marks a chat trusted` | A tool call, a plugin route and a remote session that try to mark an imported chat trusted are refused and the chat stays untrusted. |
| `imported skills start disabled` | Each imported skill is disabled after its row is applied. |
| `imported presets do not raise permissions` | An imported preset cannot grant a permission above the person's own presets. |
| `imported plugin declarations are listed and never installed` | After the customisation is applied, no plugin declared by the archive is installed. |
| `no row applies before its diff is shown` | No customisation row is written before the diff screen has shown it and the person has accepted. |
| `a stock home is never modified` | After a stock-home import, every file of the fixture stock home is byte-identical. |

## What is built so far

The archive format, the validation, the signature check, the refusal of `!!js` expressions, `insert` rows and denied row kinds, and the publication under `archive/imported/` are built and [C8](../contracts/c08-archive-and-trash.md) describes them. None of the rules above is built.
