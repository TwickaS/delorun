---
area: Install and update
section: Security
---

- Release root 2 lists the keys allowed to sign a release's log entry, ECDSA P-256 first and Ed25519ph as the alternative, and the logs whose checkpoints count. Delorun accepts a log entry only when a key the root lists for its type signed it, in a listed log cosigned by a listed witness, and verifies no release under a root without these lists, so a log that stops accepting one key type, or a new log shard, needs a root rotation by the offline root key and no client release. Copies on 0.1.0-preview.2.7 or earlier cannot read root 2: reinstall once with `npx delorun@latest`; your home, chats and settings stay.
