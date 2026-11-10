---
description: "The root package of Delo's runtime closures: upstream's runtime closure, the delorun command and Delo's packages, deployed by the release recipe."
---

# @delo/runtime-closure

English | [中文](README.zh.md)

## Summary

This package holds no code to run. Its dependencies are what a Delo runtime closure installs: upstream's `dsh-python-runtime-closure`, whose dependencies are the `dsh` command with every plugin its shipped profiles load, and [`@delo/cli`](../cli/README.md), the `delorun` command with Delo's packages. The release recipe in [`@delo/release`](../release/README.md#runtime-closures) deploys it for each platform.

What the launcher starts in a closure built from this package is fixed by contract C1's launch protocol 1: the closure's own Node, `node/bin/node` (`node/node.exe` on Windows), runs `app/node_modules/@delo/cli/src/bin.js`. The build refuses to archive a closure without those two files, and stamps the release's version into `@delo/cli`, so `delorun --version` reports the release and not the workspace's `0.0.0`. `tests/launch-files.spec.ts` keeps the build's list of those files equal to the runtime store's, and shows that a closure the build archives lists the files the store names.
