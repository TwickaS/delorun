---
area: Install and update
section: Fixed
---

- An update that waits for your running chats now notices when the last background job ends, as it does when a chat finishes. Before, a job that ended while the update waited could leave it waiting until it gave up with a timeout. A job that has already finished is no longer counted as running work, and an update still waits for every job and chat that is really running.
