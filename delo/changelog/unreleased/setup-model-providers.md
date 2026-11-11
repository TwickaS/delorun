---
area: Setup
section: Added
---

- `delorun setup` asks which model provider Delorun uses: Anthropic, DeepSeek, Google Gemini, Groq, Mistral, Moonshot AI, OpenAI, OpenRouter, Together AI, xAI or any OpenAI-compatible endpoint, listed by name, or none for now. DeepSeek works without any extra install, and so does every other provider in the list.
- For each provider setup asks where its key comes from, typed now or read from the provider's variable at each start, and the model new chats start on; an OpenAI-compatible endpoint also takes its base URL and model id. Quick keeps DeepSeek's default model and asks the model of every other provider; Full asks it of all of them.
- A typed key is checked with one request for the provider's model list, or OpenRouter's key details, to the provider's own address, never a completion; a failed check says why and lets you enter the key again or continue with the key marked not verified.
- `delorun setup --yes` sets up no provider unless `--provider <id>` names one, with `--model`, `--base-url` for an OpenAI-compatible endpoint and `--key-env` for another variable, and says how to add one when none is named. `delorun setup key` takes the same flags on a profile that is set up and asks nothing. A key is never taken from the command line.
- Setup writes what the studio's Settings → Models and the model picker save, so the studio shows the provider and model setup chose; DeepSeek with its own variable and default model leaves the profile as DeepSeek Harness composes it.
