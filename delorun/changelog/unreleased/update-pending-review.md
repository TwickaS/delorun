---
area: Install and update
section: Fixed
---

- Updates no longer leave a pending review on Claude Code. The pack that adds Claude Code named the build's temporary folder in its dependency list, which differed with every build, so Changes showed a dependency change after each update. A pack now names the exact version of each package it carries, and the release build refuses a pack whose metadata names a folder on the build machine. The first update after this one still shows that review once, because the list changes from the temporary folder to the version.
