---
area: Setup
section: Changed
---

- `delorun setup` opens with "How will you use Delorun?": just me on this computer, also from my phone or another device, or scripts and automation. The answer sets the defaults and decides which questions come next, so most people answer three: the model provider and its key, and how much Delorun asks. The review screen lists every answer, including the release check and the prompts answer, and its More settings choice asks the rest. This replaces the Quick or Full choice.
- Every choice shows what it does, who it suits and how to change it later, and the recommended one is marked. The prompts choices are Ask me first, Ask less (like DeepSeek Harness) and Never ask (dangerous), which stays the third option with its two confirmations.
- Each provider's key question names the provider's key page where one is known, says what an environment variable is, and warns at once, with the fix, when the variable you pick is not set in your terminal.
- Setup ends by printing the next steps and starts nothing: `delorun` to start and open the studio, the install guide's section on your first chat, and `delorun setup <section>` to change an answer. Ctrl-C exits with code 130 and says nothing was saved. Choosing Back at the dangerous-mode confirmation returns to the prompts question.
- An answers document may carry `"useCase": "local" | "remote" | "automation"`; without it, `local` is used.
