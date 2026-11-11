---
area: Plugins
section: Security
---

- Installing a plugin checks it and every package it brings before any of its code loads: a package without an integrity hash, a git source not pinned to a full commit, a known GitHub advisory, a version published in the last 24 hours and a name close to one you already have are each shown where you install it, on the Plugins page and in `delorun plugin`'s output. A known critical advisory stops the installation until you choose to install it anyway, with "Install anyway" or `--allow-advisory <id>`; everything else only warns. When the advisory or publish-time lookup cannot run, you are told so. Scopes and git owners you trust can be listed so their plugins show only critical advisories; linked and local plugin folders are not checked.
- Delo records every file of each plugin it installs, checks them at every start and fully in `delorun verify`, and warns when a plugin changed since it was installed. Installed plugins get their own copies of their files, so an edit to pnpm's shared store no longer reaches them.
- Plugins no longer fall back to the npmmirror registry unless you turn it on, a plugin registry that is not https stops the start, and a package installed under the name of one of Delo's own components cannot stand in for it.
