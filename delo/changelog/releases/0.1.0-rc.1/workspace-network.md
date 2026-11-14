---
area: Safety and privacy
section: Security
---

- Each workspace has a network setting for the commands the model runs in the sandbox: open, as before and by default; allowlist, where commands reach only the hosts you list, through an egress proxy that never looks up an unlisted name and refuses a listed name that points at a private, loopback or link-local address; or off, with no network at all. `web_fetch` follows the same setting. Choose it in Settings, Network, at the computer that runs Delo; a change that lets commands reach more asks you to confirm it.
- An allowlist entry allows ports 80 and 443; write `host:port`, such as `github.com:22`, to allow another port. Under allowlist and off, commands also cannot reach the services that look names up or send traffic for them: systemd-resolved, nscd, avahi, the system D-Bus, snapd, CUPS and Tailscale's daemon. Other sockets stay reachable, such as an ssh connection you keep open or gpg's dirmngr under your home folder.
- The setting holds on Linux with bubblewrap, WSL2 included. Where the sandbox cannot enforce it (Landlock alone, or any platform other than Linux), a workspace set to allowlist or off runs no commands instead of running them with your network.
- A new guide page, "Prompt injection and data exfiltration", explains what each setting closes and what stays open whatever you choose: commands under full access, plugins and MCP servers, plugins the model writes, `web_search`, images and links in replies, files you share later, and a command that reaches a program outside the sandbox through a socket the sandbox does not hide, such as one in your home folder.
