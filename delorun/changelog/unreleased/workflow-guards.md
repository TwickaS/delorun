---
area: Commands
section: Changed
---

- A push from a worktree is refused while the shared checkout holds uncommitted changes to tracked files, and no script, hook or workflow may skip a git hook with `--no-verify` or disable Lefthook. Both refusals name what to fix, so a stray write in the shared checkout or a skipped hook stops the push instead of reaching the trunk.
