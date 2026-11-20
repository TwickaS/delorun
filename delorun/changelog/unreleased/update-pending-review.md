---
area: Install and update
section: Fixed
---

- Updates no longer leave a pending review on Claude Code. The pack that adds Claude Code named the build's temporary folder in its dependency list, which differed with every build, so Changes showed a dependency change after each update. A pack now names the exact version of each package it carries and no longer ships the install state pnpm leaves behind, and the release build refuses a pack whose files name a folder on the build machine. An update also makes the release's own pack files the new baseline in Changes, once Delorun has checked them against the signed release, so it no longer leaves the previous release's files waiting for review, including the review the earlier build left behind. An edit of your own to a pack, or to any other file of it, still waits.
