---
area: Setup
section: Added
---

- `delorun setup` opens with Quick or Full. Quick asks the model key and how careful prompts should be; Full also asks whether Delorun keeps running in the background, whether changes to your plugins and to Delo itself wait for your review before they load (no by default; a yes turns changes protection on, and setup never turns it off), and the profile's name and port. A typed key is checked with one live request to DeepSeek before it is stored, and a failed check says why and lets you enter the key again or continue. Every question can return to the one before it, and a review screen lists the answers before anything is written.
- "Safer prompts" and "Same as stock" take effect: they set Delo's consent and permission defaults to their Delo or stock values in the new profile.
- `delorun setup <section>` runs one section again, and `delorun setup --list` lists them.
- A terminal setup ends by offering to install the `delorun` command, then starts Delorun and opens the studio, and prints that it keeps running after the terminal closes with the commands `delorun status`, `delorun logs --follow` and `delorun stop`. With no browser it prints the address and the SSH port-forward line.
- `delorun setup --yes` applies every default and reads the model key from `DEEPSEEK_API_KEY`; `delorun setup --config <file>` applies an answers document. Neither form turns on reach, credential forwarding or changes protection, and `--check-key` checks the key with one live request.
- `delorun setup` does not ask about the two upstream opt-ins, desktop analytics and DeepSeek's session-log upload. Both stay off, and Settings → Privacy changes them.
- An interrupted setup resumes at the step it did not finish, and a finished setup is left unchanged.
- Setup from a source checkout adds Delo's bundle to the new profile, so the Privacy section in Settings loads on the first start without a manual step.
