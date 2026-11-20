---
area: Safety and privacy
section: Changed
---

- With protection off, the agent's plugin tool works as it does in stock DeepSeek Harness once you give its single full-access approval: it installs, removes, turns on, configures, undoes and restores plugins, and plugins it installs or links reload when it saves them. Each of these is listed in Changes as a change that loaded without review, and you can undo it there or with `delorun changes undo`. With protection on, nothing changes: installs wait for your review, and turning a plugin on, undoing and restoring are left to you. A protection setting that cannot be read keeps every action held, as with protection on. A chat that already has full access or runs in dangerous mode gives no further prompt, as in DeepSeek Harness. Each action is recorded before it runs, undoing it keeps your own hand edits, your home patch and the plugins kept disabled, and going back to an earlier Delorun release still starts your profile.
