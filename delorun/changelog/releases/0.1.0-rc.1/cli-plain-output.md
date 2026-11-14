---
area: Commands
section: Changed
---

- Command output says "Delorun", not "Delorun", in sentences and drops internal labels: `delorun logs` heads its list "Logs under …" and no longer lists a relay you may not run, `delorun verify` lists the checks it runs and says in one line how many more Delorun does not include, and `delorun reach status` says whether remote access is on or off and how to turn it on.
- `delorun status` prints whether Delorun is running, the studio address, the version and the running chats. The process id, the start id, the home folder and the profile appear with `--verbose`, and `--json` still carries them.
- `delorun start` that fails says "Delorun did not start", points to `delorun logs` and `delorun doctor`, and when another program holds the studio's port it says so and offers `delorun setup profile` or port 0. `delorun import-home` without a DeepSeek Harness folder says there is none and offers `--from`. `delorun workspace` with no action says to choose full-access or external-agents.
- `delorun devices approve` and `delorun devices elevate` stop at once, with a message, when they have no terminal to type the code in, instead of waiting for five minutes.
- `delorun --version` prints "Delorun" on its first line, and `delorun setup` and the default workspace's message name Delorun too.
- `delorun plugin list` on a new profile says "No plugins added to the profile default." instead of printing nothing, `delorun plugin` on a profile that does not exist yet says "delorun: initialized profile …" where it said "dsh: …", and `delorun plugin` with no arguments shows Delorun's usage, not pnpm's message. Its other lines also say "delorun:" where they said "dsh:": warnings, the failed-command line and the rejected-installation lines, and the hints name `delorun plugin allow-version`, the command that grants the exemption. <!-- us-spelling: quoted output -->
- `delorun open --print` and other output piped into a reader that stops early, such as `head -1`, ends quietly with exit 0 instead of reporting "write EPIPE".
