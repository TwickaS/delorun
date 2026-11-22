# Delorun

English | [中文](README.zh.md)

<!-- GIF SLOT: the recorded demo goes here, in the first screen, below the title and above the headline. -->

**Your harness. No limits.** Change anything. Undo everything.

Delorun is an open-source agent harness that runs on your own computer, and that you shape to the way you work. Change how it looks, what its agents can do and which plugins it runs; write a plugin of your own, or edit the harness itself. Each setup you try is kept as a version, so you can switch back when a change is not right.

Run it with `npx delorun`. Built on DeepSeek Harness; runs its plugins and imports your chats. Delorun is independent. It is not a DeepSeek product, and DeepSeek does not endorse it.

## Status

Delorun is a preview, signed with preview keys, and has had no outside security review. [What you trust when you use Delorun](delorun/docs/guide/safety-and-updates/trust.md) explains what that means. Delorun runs on Linux and on Windows through WSL2.

## What you can do

- **Make it yours.** Themes and your own name and icon, settings, agent presets, plugins, a plugin you write, a changed copy of a shipped plugin, or the harness's own code. [Where to customise what](delorun/docs/guide/customising/customise.md) shows each level and what an update costs it.
- **Try a setup, then keep it or go back.** Save your setup, see in plain words what another version would change, and switch. An update shows what it would change before it applies, saves your setup first, and goes back by itself if the new release fails its check. Deleted chats and workspaces go to a trash. This covers the harness and your chats; it does not undo what an agent did to your files, so keep your projects in git. [Updates](delorun/docs/guide/safety-and-updates/updates.md).
- **Use it from your phone.** Open the same chats on your phone over your own Tailscale network. Each new device is approved at your computer. [Reach the studio from your phone](delorun/docs/guide/everyday-use/reach.md).
- **Use the model you choose.** DeepSeek, Anthropic, OpenAI, Google Gemini and others, or any OpenAI-compatible endpoint, which includes a model running on your own machine. [Model providers](delorun/docs/guide/get-started/providers.md).
- **Stay in control.** Risky changes ask for your consent first, each release is checked against its signature before it runs, and Delorun has no telemetry; two release checks reach the internet by default. [Safety](delorun/docs/guide/safety-and-updates/safety.md) and [what leaves your machine](delorun/docs/guide/safety-and-updates/trust.md#what-leaves-your-machine).

## Commands

The `delorun` command provides:

- `setup`, `start`, `stop` and `status` to create the Delorun home, run the home process and inspect it.
- `doctor` to check the home's permissions, Docker, whether your model key is set and well formed and whether the studio's port is free.
- `logs` to find, read, follow, clear and prune Delorun's operational logs.
- `update` to show the newest release's report and apply it after you confirm, and `recover` to see where the profile stands after an update and to roll back, restore a version or enter safe mode.
- `verify` to check the installed release against its signed manifest and the release log.
- `trash`, `export` and `import` to restore or purge deleted chats and workspaces, and to move a chat or a workspace between homes as a signed archive.
- `open` to open the studio in your browser, or print a link that signs in once.
- `reach` and `devices` to reach the studio from your phone over your own tailnet, and to approve, unlock and remove the devices that may sign in, including PIN mode.
- `changes` to review, apply, discard or undo the changes that wait for you.
- `workspace` to let chats use full access in a folder, or let an outside agent start there, from this computer.
- `mcp` to answer, from this computer, the questions about tool servers that chats want to start.
- `import-home` to copy a DeepSeek Harness home (`~/.dsh`) into your Delorun home.
- `plugin` and `headless`. `delorun plugin` runs DeepSeek Harness's plugin installer inside your Delorun home, without Delorun's protections. `delorun headless` answers one task and exits, as `dsh headless` does, but with Delorun's sandbox protection, guards and consents, and with DeepSeek's session-log upload off; a consent that would ask you refuses instead, because nobody is there to answer.

Review the [safety notice](SAFETY.md) before running the project. The [user guide](delorun/docs/guide/README.md) explains how to install and use Delorun. The [roadmap](delorun/docs/guide/roadmap.md) lists what is being built and the directions after it.

## Run

Install Node.js 24.9 or later, which Delorun needs every time it starts, and on Linux install bubblewrap, then run `npx delorun`. [Install and first run](delorun/docs/guide/get-started/install.md) walks through setup and the first chat.

### Run from source

To work on Delorun's code from a checkout, install Node.js 24.9 or later and pnpm, then run:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the artifacts. `pnpm dsh web` starts DeepSeek Harness's own Web UI from the checkout, and `pnpm dsh --profile headless "task"` runs one task there and needs a `DEEPSEEK_API_KEY`. To run Delorun's own command from the checkout, use `pnpm --filter @delorun/cli run delorun start`. When it says a built file is missing, run `pnpm run build:artifacts` and `pnpm --filter @delorun/bundle-local run build`, then start again. To run the checks that cover your change, use `pnpm check`. [AGENTS.md](AGENTS.md) lists every command.

## Known issues and questions

The [known issues](delorun/docs/guide/help/known-issues.md) page lists the rough edges you may meet, each with what happens and what to do. The [questions and answers](delorun/docs/guide/help/questions.md) page answers the hard questions: why Delorun is built on DeepSeek Harness, why it is not a set of plugins on stock, what it means that agents wrote most of the code, how safe it is and what the catch is.

## How Delorun is built

The maintainer has worked on this project for a long time, and agents did most of the implementation. Every change passes review, denial tests that fail when a protection is removed, and recorded checks that replay real sessions. [Contributing](CONTRIBUTING.md) describes the rules a change follows, whether a person or an agent wrote it.

## For teams

Delorun can be shaped to a team's work with custom plugins, modes and integrations. Write to support@delorun.com.

## Compatibility with stock

DeepSeek Harness's plugins and your chat data stay compatible with Delorun. Everything else, including the interface and the defaults, is Delorun's own. [Switching from DeepSeek Harness](delorun/docs/guide/get-started/switching.md) says what is different.

## Relationship to upstream

Delorun is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source agent harness from [DeepSeek AI](https://deepseek.com). Delorun's own code lives under `delorun/`, and a change to one of upstream's files is recorded with the feature it serves. The [divergence index](delorun/docs/reference/parity-with-deepseek-harness/divergence/README.md) describes the record. For the stock documentation, see [upstream's repository](https://github.com/deepseek-ai/deepseek-harness) and its [documentation site](https://deepseek-harness.github.io/deepseek-harness/).

## Documentation

- [User guide](delorun/docs/guide/README.md): install, first run, daily use, updates, customisation, safety and troubleshooting
- [Delorun documentation](delorun/docs/README.md)
- [Architecture](delorun/docs/architecture/README.md)
- [Security and threat model](delorun/docs/security/README.md)
- [Security fundamentals](delorun/docs/security/fundamentals.md)
- [Roadmap](delorun/docs/guide/roadmap.md)
- [Designs of features not built](delorun/docs/design/README.md)

## Community

- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a bug, propose a feature and open a pull request.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately.
- [GOVERNANCE.md](GOVERNANCE.md) explains who decides what merges.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies in every project space.
- Ask questions in GitHub Discussions, or write to support@delorun.com.

## Licence

[MIT](LICENSE). The upstream copyright line stays in the licence file, and Delo Run and contributors hold the copyright of Delorun's own changes. Third-party dependencies and their licences are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
