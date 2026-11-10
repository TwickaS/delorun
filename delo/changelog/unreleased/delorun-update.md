---
section: Added
---

- `delorun update` fetches the newest release on your channel, checks it, shows what it would change in your profile before anything changes, and applies it once you confirm; `--check` only shows the report. Running chats finish first, and an update whose new version fails its health check goes back on its own.
- When an update changes the format of your chat data, the report says so and Delo copies your chats and workspaces first, unless you choose to continue without the copy. Going back restores that copy and keeps the chats written since in a set-aside folder; nothing is deleted.
- `delorun recover status` lists the update you can go back from and every kept copy and set-aside folder with its size, `delorun recover rollback` goes back, `--profile-only` restores only your profile, and `delorun recover discard` removes a kept folder you no longer need.
