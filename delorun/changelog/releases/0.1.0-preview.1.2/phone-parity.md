---
area: Reach
section: Changed
---

- A paired phone now does what the computer's studio does. Reading and tightening work without an unlock; changes that widen access (accepting an MCP server, allowing an agent into a workspace, a workspace's full access or network, saving or switching a setup version, deleting from the trash for good) work after an unlock, with a code from the computer or your PIN, whether or not dangerous mode is on. A locked phone is told to unlock first. Approving devices, setting the PIN, turning remote access on or off, and turning update checks off stay at the computer.
- A newly approved phone starts unlocked at its first sign-in, so setup runs without prompts. The unlock ends when setup finishes or after the unlock minutes (`approvalGraceMinutes` in the `delorun-home-auth` row; 15 by default, 0 turns it off), and never covers what stays at the computer.
- A phone lists the paired devices and can remove itself; removing another device stays at the computer.
