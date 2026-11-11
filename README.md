# Delo

English | [中文](README.zh.md)

Delo is the community fork of DeepSeek Harness made for daily use: compatible with stock, safe to update, reachable from your phone, and built in the open.

Delo is independent. It is not a DeepSeek product, and DeepSeek does not endorse it.

## Status

Delo is pre-release. It has no tagged release yet, and interfaces and defaults can still change. Today the `delorun` command provides:

- `setup`, `start`, `stop` and `status` to create the Delo home, run the home process and inspect it.
- `doctor` to check the home's permissions, Docker, the DeepSeek API key's format and whether the studio's port is free.
- `logs` to find, read, follow, clear and prune Delo's operational logs.
- `update` to show the newest release's report and apply it after you confirm, and `recover` to see where the profile stands after an update and to roll back, restore a version or enter safe mode.
- `verify` to check the installed release against its signed manifest and the release log.
- `trash`, `export` and `import` to restore or purge deleted chats and workspaces, and to move a chat or a workspace between homes as a signed archive.
- `plugin` and `headless`, which run DeepSeek Harness's own commands and profiles unchanged. Delo's protections, consents and privacy defaults belong to the CLI profile that `delorun` starts, so none of them applies to `delorun headless`, which also uploads session logs to DeepSeek as stock does.

Review the [safety notice](SAFETY.md) before running the project. The [user guide](delo/docs/guide/README.md) explains how to install and use Delorun.

## Run

Delo has no published package yet, so run it from a checkout.

### Run from source

Install Node.js 24.9 or later and pnpm, then run from a checkout:

```sh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the artifacts, and `pnpm dsh web` starts the Web UI from them. `pnpm dsh --profile headless "task"` runs one task and needs a `DEEPSEEK_API_KEY`. To run the checks that cover your change, use `pnpm check`. [AGENTS.md](AGENTS.md) lists every command.

## Compatibility with stock

Delo keeps upstream's plugin API, profile and Session formats compatible with stock. Before a change reaches the trunk, a check replays upstream's recorded scenarios with every model-visible Delo change switched off; it does not load a stock user's own plugins or profiles. Delo's interface and defaults may differ from stock. [Delo and stock DeepSeek Harness](delo/docs/guide/delo-vs-stock.md) lists every difference.

## Relationship to upstream

Delo is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source agent harness from [DeepSeek AI](https://deepseek.com). Delo's own code lives under `delo/`, and a change to one of upstream's files is recorded with the feature it serves. The [divergence index](delo/docs/reference/divergence/README.md) describes the record. For the stock documentation, see [upstream's repository](https://github.com/deepseek-ai/deepseek-harness) and its [documentation site](https://deepseek-harness.github.io/deepseek-harness/).

## Documentation

- [User guide](delo/docs/guide/README.md): install, first run, daily use, updates, customisation, safety and troubleshooting
- [Delo documentation](delo/docs/README.md)
- [Architecture](delo/docs/architecture/README.md)
- [Security and threat model](delo/docs/security/README.md)
- [Security fundamentals](delo/docs/security/fundamentals.md)
- [Designs of features not built yet](delo/docs/design/README.md)

## Community

- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a bug, propose a feature and open a pull request.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately.
- [GOVERNANCE.md](GOVERNANCE.md) explains who decides what merges.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies in every project space.
- Ask questions in GitHub Discussions, or write to support@delorun.com.

## Licence

[MIT](LICENSE). The upstream copyright line stays in the licence file, and Delo Run and contributors hold the copyright of Delo's own changes. Third-party dependencies and their licences are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
