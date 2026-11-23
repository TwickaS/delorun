---
description: "The model providers Delorun sets up: DeepSeek, Anthropic, Google Gemini, Groq, Mistral, Moonshot AI, OpenAI, OpenRouter, Together AI, xAI and any OpenAI-compatible endpoint, what each needs, how setup checks its key, and how to change provider later."
---

# Model providers

English | [中文](providers.zh.md)

## Summary

This page helps you choose which AI model service Delorun talks to, give it your key, and change that later. You need Delorun installed ([Install and first run](install.md)) and an account with a provider. A [model provider](../../reference/glossary.md#provider) is a company or server that runs the AI model; a key is the secret text that lets Delorun use your account there. Delorun works with the provider you choose. The studio's welcome screen asks for a DeepSeek key the first time it opens; `delorun setup key` is the terminal form, which asks which provider to use, takes its key and, for most providers, the model new chats start on. Every provider below is set up the same way and is listed in the same order setup lists it, by name. DeepSeek support is built in and needs no extra install; every other provider runs on the multi-provider adapter that ships with DeepSeek Harness, so none of them needs an install either. The studio lists more providers than setup does, and more of each provider's settings, in Settings → Agent → Models.

## Contents

- [Choose a provider in setup](#choose-a-provider-in-setup)
- [The providers](#the-providers)
- [An OpenAI-compatible endpoint](#an-openai-compatible-endpoint)
- [How setup checks a key](#how-setup-checks-a-key)
- [Where the key is kept](#where-the-key-is-kept)
- [Set up without questions](#set-up-without-questions)
- [Change the provider later](#change-the-provider-later)
- [Providers set up in the studio](#providers-set-up-in-the-studio)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Choose a provider in setup

The first setup run does not ask for a model key. The studio's first-run guide does, in its Models step: it uses a key it finds in the environment, or you paste a DeepSeek key and Delorun tests it with a free request. Other providers are under **Add another provider** there, and in Settings → Agent → Models. In a terminal, or for a script, `delorun setup key` asks the model provider question, `Which model provider should Delorun use?`, with DeepSeek (recommended), More providers and Choose later. It then asks:

1. For an OpenAI-compatible endpoint, the base URL and the model id.
2. `How should Delorun get the <provider> API key?`: **Paste it now**, which stores it in your home's credentials file, or **Use `<VARIABLE>`**, which reads that environment variable at each start. Setup names the provider's key page and warns at once when the variable is unset.
3. For a typed key, the key itself, which setup checks before it stores it.
4. The model new chats start on, from the provider's model list, starting on a current general model of that provider. Setup asks it for every provider except DeepSeek, which starts on the profile's default model, DeepSeek-V4.1-Flash; `delorun setup key` asks it for DeepSeek too.

**Choose later** changes no provider setting: new chats keep the model the profile already uses, DeepSeek-V4.1-Flash on a new profile, and setup tells you which model that is and how to add a key, in the studio or with `delorun setup key`. You can change the model of any chat in the studio's model picker.

## The providers

| Provider | Id for `--provider` | Key variable | What setup asks |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | The key and the model |
| DeepSeek | `deepseek-official` | `DEEPSEEK_API_KEY` | The key; `delorun setup key` also asks the model |
| Google Gemini | `google` | `GEMINI_API_KEY` | The key and the model |
| Groq | `groq` | `GROQ_API_KEY` | The key and the model |
| Mistral | `mistral` | `MISTRAL_API_KEY` | The key and the model |
| Moonshot AI | `moonshotai` | `MOONSHOT_API_KEY` | The key and the model |
| OpenAI | `openai` | `OPENAI_API_KEY` | The key and the model |
| OpenAI-compatible endpoint | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | The base URL, the model id and the key |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | The key and the model |
| Together AI | `together` | `TOGETHER_API_KEY` | The key and the model |
| xAI | `xai` | `XAI_API_KEY` | The key and the model |

The model list of each provider is the list installed with Delorun. Some key variables differ from the name the studio's Settings → Agent → Models would give the key it stores: Google Gemini uses `GEMINI_API_KEY` and Moonshot AI `MOONSHOT_API_KEY`, the names those providers' own tools read. Setup records the variable it used, so the studio reads the key from the same place. Every provider but the OpenAI-compatible endpoint uses the address the provider publishes. DeepSeek also reads `DEEPSEEK_BASE_URL` when you set it, as DeepSeek Harness does.

## An OpenAI-compatible endpoint

Choose **OpenAI-compatible endpoint** for any server that speaks OpenAI's Chat Completions API: a gateway, a hosted service not in the list, or a server on your own computer such as Ollama, LM Studio or vLLM. Setup asks:

- **Base URL of the endpoint**: the address that comes before `/chat/completions`, such as `http://127.0.0.1:11434/v1`. It cannot hold a user name, password, query or fragment; put the key in the key question instead. Plain `http` to another computer works, but setup warns you, because the key and your prompts then cross the network unencrypted.
- **Model id the endpoint serves**: the name the server knows the model by, such as `qwen3:8b`.
- **The key**. A server that needs no key still needs some text here, because the adapter always sends one; enter any text.

Run `delorun setup key` again to add another model of the same endpoint; setup keeps the models it added before.

## How setup checks a key

Setup checks a typed key with one request to the provider before it stores it. The request asks for the provider's model list, or for OpenRouter its key's details, and never for a completion. It goes to the provider's own address and nowhere else: a redirect makes the check fail. A key the provider refuses is not stored unless you choose **Continue without a successful check**; the review screen then says the key is not verified, and why. The reason names the address and the HTTP status and never the key.

A key read from the environment is not checked unless you run setup with `--check-key`. An OpenAI-compatible server that answers its model list without any key passes the check whatever key you enter.

## Where the key is kept

A typed key is stored in `.credentials.yaml` in your Delorun home, which only you can read, under the provider's key variable. A key read from the environment is not stored: Delorun reads the variable each time it starts, from the environment it starts in, the `.env` file of the folder you start it from, or the `.env` file of your home. The setup answers, the profile and the logs never hold a key. `delorun doctor` checks that the key of the provider new chats start on is set and well formed, without sending it anywhere.

## Set up without questions

`delorun setup --yes` sets up no provider unless you name one, and tells you how to add one. Name it with `--provider`, and keep the key in the provider's variable:

```sh
ANTHROPIC_API_KEY=... delorun setup --yes --provider anthropic --model claude-sonnet-5
DEEPSEEK_API_KEY=... delorun setup --yes --provider deepseek-official
delorun setup --yes --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --model qwen3:8b --key-env LOCAL_LLM_KEY
```

`--model` is needed for every provider but DeepSeek, and must be in the provider's model list. `--base-url` is for an OpenAI-compatible endpoint only. `--key-env <NAME>` reads the key from another variable. A key is never accepted on the command line. Add `--check-key` to check the key before anything is written. An answers file for `delorun setup --config` names the same choices in `modelProvider`, as [contract C11](../../contracts/c11-setup-answers.md#answer-schema) describes.

## Change the provider later

Run `delorun setup key` to choose again; it asks every question of the provider section. With `--provider` and its flags it asks nothing, so a script can run it. Restart Delorun afterwards with `delorun stop`, then `delorun start`. The studio's Settings → Agent → Models shows what setup wrote, and changes it there too. Choosing DeepSeek again returns new chats to DeepSeek's default model and keeps the other providers you set up, so their models stay in the model picker.

## Providers set up in the studio

The multi-provider adapter knows more providers than setup lists, among them Amazon Bedrock, Azure OpenAI, Cerebras, Cloudflare, Fireworks, GitHub Copilot, Google Vertex AI, Hugging Face, MiniMax, NVIDIA, Z.AI and Xiaomi. Add any of them in the studio's Settings → Agent → Models, which also signs in to providers that use an account instead of a key, and edits any provider's address, models and request settings.

Claude Code and Codex are not model providers for Delorun's chats: they are agents that a chat can hand work to, and they run as their own programs with their own sign-in. The full guide, from Settings → General → Getting started, offers to add them.

<details>
<summary>Edge cases</summary>

- If you choose **Choose later**, then chats cannot answer until you add a provider. New chats keep the profile's model, and `delorun doctor` shows a `!` line for `key`.
- If setup cannot reach the provider, then the key check fails with the address and HTTP status. Choose **Continue without a successful check** to store the key anyway, or fix the network first.
- If your endpoint needs no key, then enter any text; the adapter always sends one.
- If you use plain `http` to another computer, then setup warns you that the key and prompts cross the network unencrypted.
- If you change the provider while Delorun runs, then stop and start it: `delorun stop`, then `delorun start`.
- If you run setup without a terminal, then `--yes` sets up no provider unless you name one with `--provider`.

</details>

<details>
<summary>Go further</summary>

- Use several providers: run `delorun setup key` again with another provider. Setup keeps the providers you set up before, so all their models stay in the model picker.
- Run a model on your own computer through Ollama, LM Studio or vLLM with the OpenAI-compatible endpoint.
- Add providers setup does not list, sign in with an account instead of a key, or edit a provider's address and request settings in Settings → Agent → Models.
- Hand work to Claude Code or Codex from a chat: Settings → General → Getting started opens the full guide, whose Agents step adds them ([Install and first run](install.md#the-studio-and-your-first-chat)).

</details>

## Next

- Start a chat: [Daily use](../everyday-use/daily-use.md).
- See what a chat costs: [See what a chat costs](../everyday-use/cost-meter.md).
- If the key was refused: [Setup and the model key](../help/troubleshooting.md#setup-and-the-model-key).

## For the technically curious

[Contract C11](../../contracts/c11-setup-answers.md) defines the setup answers, including `modelProvider`.
