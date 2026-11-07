---
description: "The root package of Delo's runtime closures: upstream's runtime closure, the delorun command and Delo's packages, deployed by the release recipe."
---

# @delo/runtime-closure

English | [中文](README.zh.md)

## Summary

This package holds no code. Its dependencies are what a Delo runtime closure installs: upstream's `dsh-python-runtime-closure`, whose dependencies are the `dsh` command with every plugin its shipped profiles load, and [`@delo/cli`](../cli/README.md), the `delorun` command with Delo's packages. The release recipe in [`@delo/release`](../release/README.md#runtime-closures) deploys it for each platform.
