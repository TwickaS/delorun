---
area: Plugins
section: Fixed
---

- A plugin folder you link, installed with npm, now starts when its development packages would have put the copy over the limit: Delorun copies only the installed packages the plugin loads when it runs (those its `package.json` lists under `dependencies`, `optionalDependencies` and `peerDependencies`, and theirs in turn). An installed development package the plugin does not need shows in the review as not included.
