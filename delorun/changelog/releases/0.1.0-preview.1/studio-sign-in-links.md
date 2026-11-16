---
area: Safety and privacy
section: Security
---

- A link that signs you in to the studio works once and only for one minute, so a copy of it left in your terminal's scrollback, your shell history, your browser history or another program's command line cannot be used to sign in after you have opened it. Run `delorun open` to open the studio in your browser at any time; `delorun open --print` prints a fresh link instead, for a computer without a browser or one you reach through an SSH port forward, and `--port` makes it for a forwarded port other than the studio's own. A link works only at the address it names, and opened at another address it says which one it was made for. Starting Delorun prints the studio's address without a link, and an old link tells you to run `delorun open`.
