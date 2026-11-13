---
area: Safety and privacy
section: Changed
---

- A Delorun that keeps running for weeks now deletes expired log records itself, at the first hourly check after they are 14 days old, instead of waiting for you to run a `delorun` command.
- Delorun's log now removes more of what it holds: the keys it loads from the credentials file, `.env` files and the environment, keys you set later from the studio or a phone, the studio's signing secret, session tokens, owner codes, pairing codes and the home key. Records of a chat's turn carry its session id and turn number, so `delorun logs --session` and `--turn` find them.
- Delorun's log labels messages from upstream and other code it does not own as captured, because they can quote your chats. Delorun's log now also removes the elevation codes you type at the computer and the keys in your `.env` files, and it keeps a replaced or deleted provider key hidden, since the provider still accepts it until you revoke it.
