---
area: Install and update
section: Added
---

- `delorun update` fetches the newest release on your channel, checks it, shows what it would change in your profile before anything changes, and applies it once you confirm; `--check` only shows the report. Running chats finish first, and an update whose new version fails its health check goes back on its own.
- While an update or `delorun stop` waits for running chats to finish, a new message starts no turn: the chat shows that Delo is updating and that the message was not sent, so you send it again once Delo is back, and the wait ends once the running chats end. Background jobs count as running chats, and stopping with `--now` cancels them too.
- Before an update applies, Delo works out what the new release would change in the person's profile: each plugin it would disable or remove and why, each bundle that leaves the bundle list or cannot load, and each row and Include that loads a plugin the update disables. The report marks every prediction it could not fully make from metadata it could read, so those are never counted as safe, and it shows both the CLI home's and the desktop Host's versions and update states, because the two update independently. Nothing applies until the person confirms, and `delorun update --yes` will not confirm a report that disables or removes anything or rests on metadata Delo could not read.
- When an update changes the format of your chat data, the report says so and Delo copies your chats and workspaces first, unless you choose to continue without the copy. Going back restores that copy and keeps the chats written since in a set-aside folder; nothing is deleted.
- `delorun recover status` lists the update you can go back from and every kept copy and set-aside folder with its size, `delorun recover rollback` goes back, `--profile-only` restores only your profile, and `delorun recover discard` removes a kept folder you no longer need.
