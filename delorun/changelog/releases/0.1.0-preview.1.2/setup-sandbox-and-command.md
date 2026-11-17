---
area: Setup
section: Changed
---

- The end of `delorun setup` on Linux runs the sandbox check that `delorun doctor` has and prints the fix when the sandbox cannot run, such as `sudo apt install bubblewrap` on Debian or Ubuntu. The line that installs the `delorun` command also says what to do when npm refuses for lack of permission.
