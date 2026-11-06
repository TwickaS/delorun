---
description: "The Delo security index: the threat model, where release verification is specified, and how to report a vulnerability."
---

# Delo security

English | [中文](README.zh.md)

Security pages are references: they state what Delo protects, against whom and where it cannot, without a teaching sequence.

- [Threat model](threat-model.md): Delo's goal against stock DSH and each changed default, its assets, what each party can see and do, the defence at each trust boundary with the contract that specifies it, and what Delo does not protect against.
- Release verification: how clients check a release is specified by the [release manifest](../contracts/c02-release-manifest.md) and [release log](../contracts/c18-release-log.md) contracts, and `delorun verify` reports the result.
- Reporting: report a suspected vulnerability privately through [SECURITY.md](../../../SECURITY.md).
