---
area: Chats and workspaces
section: Added
---

- A new Delorun home has a default workspace on every platform: `Delo/default-workspace` in your documents folder when the computer reports one that is not your home folder, otherwise `Delo` directly in your home folder. `delorun start` picks the folder, and it is created when the studio first needs it. Restating the `workspace-controller` row in the profile's `cordis.patch.yml` with your own `defaultWorkspaceDirectory` chooses another folder.
