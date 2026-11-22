---
description: "Why Delorun: what the open-source coding agent studio built on DeepSeek Harness gives you, what it changes from DeepSeek Harness, how it compares with T3 Code, Claude Code, Codex, Command Code and herdr, and when another tool fits better."
---

# Why Delorun

[English](why-delorun.md) | 中文

## Summary

Delorun is an open-source coding agent studio built on DeepSeek Harness, for open models, in your browser, on your desktop\* and on your phone. This page is for developers comparing coding agents: what you get, what Delorun changes from DeepSeek Harness, how it compares with six other tools, and when one of them fits better. Each claim links to the page that holds its detail and limits. Delorun is a preview that runs on Linux and on Windows through WSL2 ([Known issues](known-issues.zh.md#where-delorun-runs)).

\* Windows preview, unsigned.

## Contents

- [What you get](#what-you-get)
- [What Delorun changes from DeepSeek Harness](#what-delorun-changes-from-deepseek-harness)
- [How it compares](#how-it-compares)
- [When another tool fits better](#when-another-tool-fits-better)
- [Try it](#try-it)
- [Next](#next)
- [Sources](#sources)

## What you get

### Web first, phone included

The whole studio is a web page, so it works wherever a browser does. The [studio](../reference/glossary.zh.md#studio) runs on your own computer and opens in any browser, and the desktop app is the same studio in its own window. On a phone there is no app to download: open the studio's address in the phone's browser, or choose **Add to Home screen** to install it. The phone reaches your computer over your own Tailscale network, with no Delorun service in between, once you approve it at your computer ([Reach the studio from your phone](reach.zh.md)). It is the same studio there, though a few steps, such as approving a new device, stay at your computer ([what a phone can and cannot do](reach.zh.md#what-an-approved-phone-can-and-cannot-do)).

![Three tracks on one bench, each carrying a sealed capsule from a phone to a computer: one runs straight through past a counter, one stops in a station under a reader head, and one passes through a closed tunnel.](pictures/reach-paths.svg)

The picture shows who stands between your phone and your computer.

1. **Delorun today.** The capsule runs straight to your computer over your own Tailscale network, and no Delorun service stands on the track. Tailscale is the counter beside the rails: it sees device names, addresses and connection times ([What Tailscale sees](reach.zh.md#what-tailscale-sees)).
2. **A hosted service in the middle.** Some tools send the phone through a service their maker runs. What that service can see depends on the service, so read its own page.
3. **The Delorun relay, planned.** For reach without Tailscale, the relay is designed as a closed tunnel that passes encrypted traffic it cannot read. It is not built; the [roadmap](roadmap.zh.md#next) says where it stands.


Delorun shows you what is about to happen, and keeps a way back.

- **Releases are checked before they run.** `npx delorun` verifies the download against the signed release and a public release log ([What the launcher verifies](install.zh.md#what-the-launcher-verifies)).
- **Risky steps ask first.** By default Delorun asks before a workspace gets full access, before the model writes instruction files or schedules work, and before a new MCP server runs a command ([Consents](safety.zh.md#consents)).
- **Commands run in a sandbox** that confines file writes and keeps Delorun's own folder and secrets out of reach ([The sandbox](safety.zh.md#the-sandbox)).
- **Changes to Delorun are listed and can be undone.** Turn [changes protection](../reference/glossary.zh.md#changes-protection) on and each one waits for your review ([The protection setting](changing-your-harness.zh.md#the-protection-setting)).
- **A phone confirms sensitive actions with a passkey.** The passkey stays on the phone and answers only to the phone's own lock, such as Face ID or a fingerprint, so each sensitive action is confirmed by you, on that phone, at that moment. A phone without one uses a PIN ([Confirm with Face ID](reach.zh.md#confirm-with-face-id)).
- **Updates go back by themselves** when their health check fails ([Updates](updates.zh.md)).
- **No telemetry.** Delorun sends nothing about you ([What leaves your machine](trust.zh.md#what-leaves-your-machine)).

The limits are as plain: releases are signed with preview keys, nobody outside the project has reviewed the code, and commands run with your own access ([What you trust](trust.zh.md)).

### Bring your own inference

Delorun runs on the models you already pay for or host, and sells none of its own. Bring a key from DeepSeek, Anthropic, Google Gemini, OpenAI, OpenRouter, Groq, Together AI or another provider, point Delorun at any OpenAI-compatible endpoint, or serve a model yourself with Ollama, LM Studio or vLLM ([Model providers](providers.zh.md)). Delorun needs no account of its own, your keys stay in your [home](../reference/glossary.zh.md#home), and the model picker changes the model of any chat. If you have a Claude Code or Codex plan, a chat can hand tasks to them under your own account, outside Delorun's sandbox ([Hand work to Claude Code or Codex](agents.zh.md)).

Open-weight models suit this well. The two models DeepSeek's API serves, DeepSeek-V4.1-Flash and DeepSeek-V4-Pro, have their weights published under the MIT licence; Qwen publishes weights under Apache-2.0, and Kimi under its own licence. Because the weights are public, several companies host the same model: OpenRouter and Together AI list DeepSeek-V4.1-Flash beside DeepSeek's own API. Changing host means a new key and no new tool.

New chats start on DeepSeek, where a long chat can read much of its input from the provider's cache. DeepSeek caches the start of each request automatically, and DeepSeek Harness is designed to keep that start unchanged, with the credit its makers': a chat's history grows only at the end. At DeepSeek's published prices, cached input costs about a fiftieth of uncached input on Flash and about a thirtieth on Pro. DeepSeek calls its cache best effort, so this page promises no hit rate; the [cost meter](cost-meter.zh.md) shows each chat's cache reads and writes.

### Open by design

The harness has no fixed core to work around: everything in Delorun is a [plugin](../reference/glossary.zh.md#plugin), and you can edit even the harness itself, so nothing sets a limit on what you may change. That leaves two ways to make it yours, and you can mix them.

**Use what others have made.** Plugins written for DeepSeek Harness install on Delorun with one command, from npm, a git repository or a folder ([Install it](plugins.zh.md#install-it)). People already build well beyond coding tools: [dsh-layerfs](https://github.com/Ephemeral-AI-Lab/dsh-layerfs) is a plugin bundle for LayerFS, [dsh-context](https://github.com/bowenliang123/dsh-context) gives insight into a chat's context, [billion-context](https://github.com/ranxianglei/billion-context) compresses context for sessions that run for a month, [dsh-im](https://github.com/xmanrui/dsh-im) connects messaging bots on nine channels, and [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) puts live wallpapers behind the studio. Their authors made these for DeepSeek Harness, and Delorun has not tested them. A plugin marketplace, a community catalogue with "tested with Delorun X" badges, is a planned direction on the [roadmap](roadmap.zh.md#later) and is not built.

**Make your own.** Ask a chat for a plugin, or start one with `delorun plugin new` ([Your first plugin](first-plugin.zh.md)). Each idea below is a plugin you write, on an extension point that exists today:

- **Add an inference service.** Most services need no plugin: add the endpoint and its models in the studio's settings, and its prices in the cost meter's settings ([Prices](cost-meter.zh.md#prices)). For a service that speaks a protocol of its own, your plugin can register a model adapter, and everyone who installs it gets the service without touching their other providers.
- **Choose models your way.** Your plugin can add its own controls to the message box's model slot. To replace the shipped picker with one that chooses by role, such as planner, builder and reviewer, fork it ([Fork a shipped plugin](customise.zh.md#fork-a-shipped-plugin)).
- **Give each repository its own agent.** `delorun plugin new --kind preset` starts a plugin that registers an agent preset: the tools, instructions, skills and model an agent begins with ([Make an agent preset](customise.zh.md#make-an-agent-preset)).
- **Build the panel you keep wishing for.** Your plugin can add a sidebar panel, a tab in the right sidebar or a settings page: a release checklist, the state of your deploys, the tickets for this branch. `--kind ui` starts you with a settings page ([Write a plugin for Delorun](plugins.zh.md)).
- **Let events start the work.** Your plugin can register a rule that opens a chat and sends its first message when a signed GitHub webhook arrives. It builds on Delorun's optional Webhooks plugin, which is experimental and whose endpoint stays off until you turn it on ([Optional plugins](customise.zh.md#optional-plugins)).
- **Watch what the agent does.** Your plugin can listen at fixed points of a turn, such as before each step and before and after each tool call, to log, check or refuse.

A chat can make these changes for you as well. Its plugin tool asks for full access when it changes your setup, and every change is listed and can be undone ([Changing your harness](changing-your-harness.zh.md)). You can also save a setup as a version, go back to an earlier one, or carry it to another computer ([Move your setup to another computer](move-your-setup.zh.md)).

The licence is MIT. A plugin runs with the harness's own access, and Delorun does not sandbox or audit plugins, so read one before you install it ([What Delorun does not protect against](safety.zh.md#what-delorun-does-not-protect-against)). Undo covers Delorun and your chats, not the files an agent changed in a workspace, so keep those in git. A fork of a shipped plugin is yours to keep up to date, and the Webhooks plugin is experimental.

## What Delorun changes from DeepSeek Harness

Delorun builds on DeepSeek Harness, the open-source agent harness made by DeepSeek AI. Its makers build the agent loop, the model providers and the plugin system, and Delorun builds the product around them. Delorun is independent: it is not a DeepSeek product, and DeepSeek does not endorse it ([Why is Delorun built on DeepSeek Harness?](questions.zh.md#why-is-delorun-built-on-deepseek-harness)).

- **An install that is checked first:** a signed release, verified before anything runs ([Install and first run](install.zh.md#what-the-launcher-verifies)).
- **Safer defaults:** consents on from setup, and commands that cannot write Delorun's own folder ([What Delorun protects](safety.zh.md)).
- **Your phone:** the studio over Tailscale, each device approved at your computer ([Reach the studio from your phone](reach.zh.md)).
- **Updates you can reverse:** a report before you confirm, then automatic rollback ([Going back](updates.zh.md#going-back)).
- **Changes you can undo:** `delorun changes` and saved setup versions ([Changing your harness](changing-your-harness.zh.md)).
- **A studio of its own:** theme, sidebar, chat states and searchable settings, with one switch back to the stock look.
- **Several agents in view:** panes for the agents a chat handed work to ([Watch several agents at once](agents.zh.md#watch-several-agents-at-once)).
- **Optional extras:** the [cost meter](cost-meter.zh.md) and a [thinking tab](thinking-tab.zh.md).
- **Privacy defaults:** DeepSeek Harness's analytics and session-log upload stay off until you turn them on.
- **Your chats come with you:** `delorun import-home` copies them from DeepSeek Harness ([Switching from DeepSeek Harness](switching.zh.md)).

Delorun also removes DeepSeek's account and Platform pages. [Switching from DeepSeek Harness](switching.zh.md#what-stays-the-same-and-what-is-different) holds the full list.

## How it compares

Checked on 2026-11-22 against each maker's own pages. "Not verified" means those pages did not say.

| Tool | Runs on | On a phone | Models | Open source | Safety controls |
| --- | --- | --- | --- | --- | --- |
| Delorun | Web studio in any browser; Windows desktop app: in preview, not out yet\*; its home on Linux and WSL2 | The phone's browser, over your own Tailscale; installs from the browser | DeepSeek first; other providers; any OpenAI-compatible endpoint | Yes, MIT | Consents on by default, sandbox, signed releases, updates that roll back |
| DeepSeek Harness | Desktop app (macOS, Windows), terminal, local web UI | Not verified | DeepSeek, plus other providers | Yes, MIT | Approvals under a permission policy; default not verified |
| T3 Code | Desktop app, web app, your own server | iOS and Android apps, hosted web app | Those of the agents it runs | Yes, MIT | Four permission modes, starting on Full access; optional git worktree per thread |
| Claude Code | Terminal, IDE extensions, desktop app, web | Claude mobile app, for cloud sessions and Remote Control | Claude models | No | Permission modes; system sandbox available, off by default; cloud sessions in a managed VM |
| Codex | Terminal, IDE extension, desktop app, web | iOS; Android not verified | OpenAI models by default; other providers by configuration | The CLI, Apache-2.0; the rest not stated | Sandbox modes and approval policies; network access off by default |
| Command Code | Terminal, desktop app | Not verified | Many vendors, among them DeepSeek, Qwen, Kimi and GLM | No licence stated | Permission modes, enforced by Command Code |
| herdr | Terminal, desktop app | iPhone, iPad and Android apps | Those of the agents it runs | Yes, Apache-2.0 | Not verified |

**DeepSeek Harness** is the harness Delorun runs on, in which everything is a plugin. It suits you if you want the harness as its makers release it, or work on macOS or native Windows. Delorun adds the product around it.

**T3 Code** is an open-source control plane for coding agents: one interface over Claude Code, Codex, Cursor, OpenCode and others, on desktop, web and phone from one server. It suits people who run several vendors' agents, and it has native phone apps, which Delorun does not. Both run the agents on your own machine. Delorun is a harness with its own agent and plugins, and a phone reaches it through its browser over your own Tailscale network, where T3 Code offers its apps or hosted web app, connected through T3 Connect, a LAN or Tailscale pairing, or SSH.

**Claude Code** is Anthropic's agentic coding tool for Claude models. It runs in more places than Delorun: the terminal, IDEs, a desktop app, the web and cloud sessions on Anthropic's machines. Delorun is open source and works with any provider, and a Delorun chat can hand a task to Claude Code.

**Codex** is OpenAI's coding agent: a CLI that runs locally, an IDE extension, a desktop app and Codex web. Its sandbox starts with network access off, a stricter default than Delorun's, whose network setting starts open. Delorun is a studio you reshape with plugins, and a Delorun chat can hand a task to Codex too.

**Command Code** is a coding agent that learns your coding taste, with a CLI and a desktop app, and it ships models from many vendors. It suits people who want that learning in a terminal agent. Delorun differs in its MIT licence, its plugins and its studio on a phone.

**herdr** is a runtime for the coding agents you already run: it owns their terminals instead of replacing them, in a terminal interface, a desktop app and phone apps. It suits people who run several terminal agents side by side. Delorun is a browser studio with its own agent, consents and sandbox.

## When another tool fits better

- **You work in one vendor's models.** Claude Code and Codex are made by the people who make those models.
- **You want a terminal-only tool or an IDE extension.** Delorun has neither; Claude Code, Codex and Command Code do.
- **You work on macOS or native Windows.** Delorun runs on Linux and WSL2.
- **You want a native phone app.** T3 Code and herdr have them.
- **You need an outside security review or a team behind the tool.** Delorun is a preview with one maintainer ([What is the catch?](questions.zh.md#what-is-the-catch)).
- **You are happy on stock DeepSeek Harness with your own plugins.** You may not need Delorun ([Why not just plugins on stock?](questions.zh.md#why-not-just-plugins-on-stock)).

## Try it

```sh
npx delorun@latest
```

The command downloads Delorun, checks it and asks a few setup questions; [Install and first run](install.zh.md) walks through them. The source is at [github.com/twickas/delorun](https://github.com/twickas/delorun).

## Next

- Coming from DeepSeek Harness: [Switching from DeepSeek Harness](switching.zh.md).
- The hard questions: [Questions and answers](questions.zh.md).
- If something went wrong: [Troubleshooting](troubleshooting.zh.md) and [Known issues](known-issues.zh.md).

## Sources

Every statement about another product comes from its maker's own pages, read on 2026-11-22. Products change, so check the links before you rely on a cell. To correct this page, write to support@delorun.com.

<details>
<summary>Sources</summary>

- **DeepSeek Harness:** [repository](https://github.com/deepseek-ai/deepseek-harness) and [deepseek.com/harness](https://deepseek.com/harness).
- **DeepSeek's cache and prices:** [Context caching](https://api-docs.deepseek.com/guides/kv_cache) and [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing). Off-peak, per million input tokens: Flash $0.003 cached against $0.15 uncached, Pro $0.022 against $0.66. Peak prices are double, so the fractions hold. The fractions are this page's arithmetic on those prices.
- **Open-weight models and their hosts:** model cards for [DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) and [DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813) (MIT), [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) (Apache-2.0) and [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) (Kimi K3 License). Hosts of DeepSeek-V4.1-Flash: [Together AI](https://www.together.ai/models/deepseek-v4-1-flash) and [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017).
- **Community plugins:** each project's own repository, linked where it is named; the descriptions follow each README.
- **T3 Code:** [repository](https://github.com/pingdotgg/t3code), [t3.codes](https://t3.codes/), [remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) and [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
- **Claude Code:** [overview](https://code.claude.com/docs/en/overview), [desktop](https://code.claude.com/docs/en/desktop), [web](https://code.claude.com/docs/en/claude-code-on-the-web), [mobile](https://code.claude.com/docs/en/mobile), [model routes](https://code.claude.com/docs/en/third-party-integrations), [security](https://code.claude.com/docs/en/security), [sandboxing](https://code.claude.com/docs/en/sandboxing) and [repository](https://github.com/anthropics/claude-code).
- **Codex:** [repository](https://github.com/openai/codex), [CLI](https://learn.chatgpt.com/docs/cli), [IDE](https://learn.chatgpt.com/docs/ide), [app](https://learn.chatgpt.com/docs/app), [cloud](https://learn.chatgpt.com/docs/cloud), [configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security) and [sandboxing](https://learn.chatgpt.com/docs/sandboxing).
- **Command Code:** [commandcode.ai](https://commandcode.ai/), [docs](https://commandcode.ai/docs), [permissions](https://commandcode.ai/docs/permissions) and [repository](https://github.com/CommandCodeAI/command-code), which holds no licence file.
- **herdr:** [herdr.dev](https://herdr.dev/), [repository](https://github.com/herdrdev/herdr) and [privacy](https://herdr.dev/privacy/).

</details>
