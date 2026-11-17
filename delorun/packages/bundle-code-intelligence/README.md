---
description: "Lets the agent ask a language server for definitions, references and hover information. Needs typescript-language-server on your PATH."
---

# @delorun/bundle-code-intelligence

English | [中文](README.zh.md)

## Summary

Switch on **Code intelligence** in Plugins to give the agent a read-only `lsp` tool: go to definition, find references, find implementations and hover.

The bundle brings your own language server, not one of its own. It starts the server `typescript-language-server --stdio` for JavaScript and TypeScript files, The rows start off; Plugins shows "Needs setup" until `typescript-language-server` is on your PATH. To add another language or server, replace the `lsp-stdio` row's `config` in your profile's `cordis.patch.yml`, restating the servers you keep.

## Needs setup

- Needs typescript-language-server (or another language server you configure) on your PATH; without it the tool stays off.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
