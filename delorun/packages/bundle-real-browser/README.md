---
description: "Lets the agent work in your own Chrome, signed in as you, in a chat where you allow it, through browse."
---

# @delorun/bundle-real-browser

English | [中文](README.zh.md)

## Summary

Add **Your own browser** in Plugins to let the agent work in your own Chrome, where you are signed in, for a task you allow in a chat. The agent asks first; a chat you do not allow never reaches your browser, and the isolated browser of [`@delorun/bundle-browser`](../bundle-browser/README.md) stays as it is. [Use your own browser](../../docs/guide/everyday-use/use-your-own-browser.md) is the guide.

The bundle carries Delorun's pinned copy of [browse](https://github.com/anomalyco/browse) (MIT, by Anomaly): one variant per platform holds browse's program for that system, checked byte for byte against the lockfile's pin when the release is built, and the linux-x64 variant also holds the Windows program, for WSL with Chrome on Windows (`variant: windows-x64` on the driver row). The copy never updates itself. Its rows are the browse driver `browser-use-browse`, off until you turn it on, and the skill [`@delorun/skill-real-browser`](../skill-real-browser/package.json), which the agent loads only while the driver is on. The driver runs browse's program in one folder of the home, so one MCP consent covers every chat. browse has no program for Windows on Arm. It is experimental.

## Needs setup

- The driver needs the browse extension paired with this computer once. Until a paired browser has connected, Plugins shows "Needs setup · Connect Chrome" with the steps: add the extension from the Chrome Web Store, select **Get a pairing code**, and enter the code in the extension's options. The code comes from the computer only; a paired phone cannot start a pairing. The check reads browse's `browsers.json` and never its token files.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person adds it in Plugins, and the release carries it as an optional pack rather than in the default install.
