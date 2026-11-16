---
area: Safety and privacy
section: Added
---

- On Linux, a sandboxed command on a workspace with the Open network is now refused while a program on your computer listens on an abstract socket, such as the display server or the session bus. The sandbox cannot hide those sockets, so a command could have used them to act outside it. The refusal names the sockets and the fixes: set the workspace's network to Allowlist or Off, or switch on "Run commands even when desktop sockets are reachable" beside Open in Settings, Safety, Network. With that switch on the command runs, and the sandbox reports that it confines only in part. The check runs when a command starts, so a socket that starts listening later is not caught.
