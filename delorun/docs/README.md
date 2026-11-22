---
description: "Delorun's documentation index: what each tier holds (user guide, cookbook, reference, defensive patterns and architecture notes) and where to start reading."
---

# Delorun documentation

English | [中文](README.zh.md)

Delorun's documentation is organised in tiers under `delorun/docs/`, beside upstream's documentation under `docs/`. Each fact has one home in the tier whose job it is, and other pages link there. Pages about upstream link to upstream's documentation instead of restating it. The [guide](guide/README.md) is for people who use Delorun. Every other tier is for developers and maintainers, who need precise definitions of behaviour.

- [Guide](guide/README.md): the user guide for people who install and use Delorun, written in plain English with technical terms explained where they first appear, starting with [Install and first run](guide/get-started/install.md). [Roadmap and vision](guide/roadmap.md) is the one page about planned work.
- [Cookbook](cookbook/README.md): step-by-step recipes for tasks, each ending in numbered verify steps. The cookbook holds no recipes.
- [Reference](reference/README.md): lookup pages for anyone who needs an exact definition, starting with the [glossary](reference/glossary.md), whose entries open with a plain-English sentence. Its other pages are for developers and maintainers.
- [Defensive patterns](defensive-patterns/README.md): rules that review enforces in Delorun's code, extending upstream's [defensive patterns](../../docs/defensive-patterns/README.md). Delorun has no patterns of its own.
- [Architecture notes](architecture/README.md): the ordered map of Delorun's subsystems, with one current-state page for each subsystem. The map lists no subsystem pages.
- [Security](security/README.md): the threat model, trust across each way Delorun runs, and the [security fundamentals](security/fundamentals.md), the governed list of rules Delorun holds itself to, each with the code that enforces it and the test that proves it.
- [Performance](performance/README.md): the wait-time benchmarks, how to run them, and the timings recorded so far: [update timings](performance/update-timings.md) and [commands and start](performance/commands-and-start.md).
- [Designs](design/README.md): the rules of features that are not built or only partly built, kept apart from the [contract pages](contracts/README.md), which describe only what is built: [update and rollback](design/update-and-rollback.md), [reach on your own tailnet](design/reach.md), [the first run](design/first-run.md), [changes to your harness](design/changes.md), [security extension points](design/security-extension-points.md) and [the journey check](design/journey-check.md).
