---
description: "The Delorun developer reference index: the glossary of plain-English definitions for anyone, and the developer and maintainer pages for the divergence ledger, the parity checklist, the parity baseline and the harness feedback log."
---

# Delorun developer reference

English | [中文](README.zh.md)

The developer reference is for looking something up about how Delorun is built and checked. The glossary here is for everyone; the other pages are for developers and maintainers. If you want to learn how to use Delorun, read the [user guide](../guide/README.md) instead.

## For everyone

The [glossary](glossary.md) defines the words that Delorun's guide, interface and pull requests use. Each entry starts with one plain-English sentence, then adds technical detail where it helps. Look a word up here when the guide uses it and you do not know it. The glossary extends upstream's [glossary](../../../docs/glossary.md), which defines the words of DeepSeek Harness, the project Delorun is a fork of.

## For developers and maintainers

These pages assume that you work on Delorun's code or on the merge of an upstream release.

- The [divergence index](parity-with-deepseek-harness/divergence/README.md) answers which upstream files Delorun changes and why. It defines the ledger of those changes, their classes and the divergence budget.
- The [parity checklist](parity-with-deepseek-harness/parity.md) answers whether Delorun behaves like stock DeepSeek Harness (DSH) in an area, and what evidence shows it. It records, at the upstream tag `dsh-v0.2.2-rc.1`, the status of Delorun's deliberate differences and of the stock areas they are compared with.
- The [parity baseline](parity-with-deepseek-harness/parity-baseline.md) answers which of upstream's own tests pass on Delorun's reference host at that tag. It records two passes, a Node 24 check, the classification of each failure, and the environment and host state the results depend on.
- The [harness feedback log](harness-feedback.md) answers which problems the maintainers met while working in this repository and what to do instead. Each entry has a status.
