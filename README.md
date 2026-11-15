# Delorun

English | [中文](README.zh.md)

<!-- GIF SLOT: the recorded demo goes here, in the first screen, below the title and above the headline. -->

**Your harness. No limits.**

Change anything. Undo everything.

Delorun is an agent harness that you shape to your own work: the themes, the sidebar, the plugins, the modes, even Delorun itself. Every change can be undone in one step, so you can try things without fear. A saved copy of your setup is kept before each update, and one command takes you back.

Undo covers the harness and your chats: your setup, plugins and settings come back as they were. It does not undo what an agent did to the files in your workspace, because workspace checkpoints are not built.

Run it with `npx delorun`. Built on DeepSeek Harness; runs its plugins and imports your chats.

Delorun is independent. It is not a DeepSeek product, and DeepSeek does not endorse it.

## Status

Delorun is a preview, signed with preview keys, and has had no outside security review yet. [What you trust when you use Delorun](delorun/docs/guide/trust.md) explains what that means and when it changes. Delorun runs on Linux and on Windows through WSL2.

## What Delorun provides

The `delorun` command provides:

- `setup`, `start`, `stop` and `status` to create the Delorun home, run the home process and inspect it.
- `doctor` to check the home's permissions, Docker, the DeepSeek API key's format and whether the studio's port is free.
- `logs` to find, read, follow, clear and prune Delorun's operational logs.
- `update` to show the newest release's report and apply it after you confirm, and `recover` to see where the profile stands after an update and to roll back, restore a version or enter safe mode.
- `verify` to check the installed release against its signed manifest and the release log.
- `trash`, `export` and `import` to restore or purge deleted chats and workspaces, and to move a chat or a workspace between homes as a signed archive.
- `open` to open the studio in your browser, or print a link that signs in once.
- `reach` and `devices` to reach the studio from your phone over your own tailnet, and to approve, unlock and remove the devices that may sign in, including PIN mode.
- `changes` to review, apply, discard or undo the changes that wait for you.
- `workspace` to let chats use full access in a folder, or let an outside agent start there, from this computer.
- `mcp` to answer, from this computer, the questions about tool servers that chats want to start.
- `import-home` to copy a DeepSeek Harness home (`~/.dsh`) into your Delorun home after a preview.
- `plugin` and `headless`. `delorun plugin` runs DeepSeek Harness's plugin installer inside your Delorun home, without Delorun's protections. `delorun headless` answers one task and exits, as `dsh headless` does, but with Delorun's sandbox protection, guards and consents, and with DeepSeek's session-log upload off; a consent that would ask you refuses instead, because nobody is there to answer.

"Undo everything" means the harness and your chats. It does not mean the files an agent changed in a workspace, so keep those in git.

Review the [safety notice](SAFETY.md) before running the project. The [user guide](delorun/docs/guide/README.md) explains how to install and use Delorun. The [roadmap](delorun/docs/guide/roadmap.md) says what is being built, what follows and what comes later.

## Run

Install Node.js 24.9 or later, then run `npx delorun`. [Install and first run](delorun/docs/guide/install.md) walks through setup and the first chat.

### Run from source

To run a checkout, install Node.js 24.9 or later and pnpm, then run:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the artifacts, and `pnpm dsh web` starts the Web UI from them. `pnpm dsh --profile headless "task"` runs one task and needs a `DEEPSEEK_API_KEY`. When `delorun start` from a checkout says a built file is missing, run `pnpm run build:artifacts` and `pnpm --filter @delorun/bundle-local run build`, then start again. To run the checks that cover your change, use `pnpm check`. [AGENTS.md](AGENTS.md) lists every command.

## Known issues and questions

The [known issues](delorun/docs/guide/known-issues.md) page lists the rough edges you may meet, each with what happens and what to do. The [questions and answers](delorun/docs/guide/questions.md) page answers the hard questions: why Delorun is built on DeepSeek Harness, why it is not a set of plugins on stock, what it means that agents wrote most of the code, how safe it is and what the catch is.

## How Delorun is built

The maintainer has worked on this project for a long time, and agents did most of the implementation. Every change passes review, denial tests that fail when a protection is removed, and recorded checks that replay real sessions. [Contributing](CONTRIBUTING.md) describes the rules a change follows, whether a person or an agent wrote it.

## For teams

Delorun can be shaped to a team's work with custom plugins, modes and integrations. Write to support@delorun.com.

## Compatibility with stock

Delorun keeps upstream's plugin API, profile and Session formats compatible with stock. Before a change reaches the trunk, a check replays upstream's recorded scenarios with every model-visible Delorun change switched off; it does not load a stock user's own plugins or profiles. Delorun's interface and defaults may differ from stock. [Delorun and stock DeepSeek Harness](delorun/docs/guide/delorun-vs-stock.md) lists every difference.

## Relationship to upstream

Delorun is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source agent harness from [DeepSeek AI](https://deepseek.com). Delorun's own code lives under `delorun/`, and a change to one of upstream's files is recorded with the feature it serves. The [divergence index](delorun/docs/reference/divergence/README.md) describes the record. For the stock documentation, see [upstream's repository](https://github.com/deepseek-ai/deepseek-harness) and its [documentation site](https://deepseek-harness.github.io/deepseek-harness/).

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
