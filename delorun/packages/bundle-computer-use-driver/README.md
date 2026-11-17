---
description: "Lets the agent see and operate desktop windows on Linux and Windows through the Cua Driver SDK. macOS has Computer use."
---

# @delorun/bundle-computer-use-driver

## Summary

Switch on **Computer use (Cua Driver)** in Plugins to let the agent inspect and operate desktop windows through the Cua Driver SDK. Screenshots reach models that accept images.

It runs on Linux and Windows. On macOS Plugins shows it unavailable and names the platform; use **Computer use** there. The two use the same provider slot, so do not turn both on. Grant desktop permissions to the program that starts Delorun; the bundle changes none. It is experimental.

## Needs setup

- Needs desktop permissions for the program that starts Delorun.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
