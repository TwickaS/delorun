---
area: Setup
section: Added
---

- The `delorun` command keeps your data in your own Delorun home, `~/.delorun` or the directory `DELORUN_HOME` names, readable only by you, and never touches DeepSeek Harness's `~/.dsh`. Its first run sets up the command-line profile; after that it starts Delorun in your terminal and opens the studio. Only one Delorun runs per profile.
- If the profile's `cordis.patch.yml` sets the sandbox row's `runnerCommand` or `runnerFailureSignatures`, `delorun start` refuses with an error naming them and asking for their removal: your home's protection runs through the sandbox's built-in runner selection.
