---
description: "The Delo security index: the threat model, where release verification is specified, and how to report a vulnerability."
---

# Delo security

English | [中文](README.zh.md)

Security pages are references: they state what Delo protects, against whom and where it cannot, without a teaching sequence.

- [Trust across every execution vector](execution-vectors.md): which commands carry Delo's protections, what the native sandbox enforces on each platform, which vectors are not built, what no vector protects against, and how each compares with stock DSH.
- [Security fundamentals](fundamentals.md): the governed list of rules Delo holds itself to, each with its status, the code that enforces it and the test that proves it, and how a fundamental is changed.
- [Threat model](threat-model.md): Delo's goal against stock DSH and each changed default, where Delo's protections apply, its assets, what each party can see and do, the defence built at each trust boundary with the contract that specifies it, and what Delo does not protect against.
- Release verification: how clients check a release is specified by the [release manifest](../contracts/c02-release-manifest.md) and [release log](../contracts/c18-release-log.md) contracts, the launcher prints each check's outcome as it installs a release, and `delorun verify` reports the signature, release-log and file checks of an installed release.
- Reporting: report a suspected vulnerability privately through [SECURITY.md](../../../SECURITY.md).
