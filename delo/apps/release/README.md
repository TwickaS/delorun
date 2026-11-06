# Delo release tooling

English | [中文](README.zh.md)

`@delo/release` is Delo's release tooling, a private package in `delo/apps/release`. It holds the changelog gate and the release-notes assembly. The signing, rebuild and advisory checks that the release manifest contract describes arrive with later work packages.

## Modules

- `src/changelog/paths.ts` classifies a path as a product file, which needs a changelog entry, or as a fragment.
- `src/changelog/fragment.ts` parses a fragment's front matter and body, and lists the unreleased folder.
- `src/changelog/version.ts` accepts release versions.
- `src/changelog/check.ts` is the gate `gates:changelog`. It checks each commit of a range and every fragment in the working tree.
- `src/changelog/assemble.ts` assembles a release's notes, its `CHANGELOG.md` block and its moved fragments.
- `tests/changelog/` holds the specs. They run both entry points on temporary git repositories and fixture trees.

## The gate

`node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>` checks each commit after `<rev>`. A commit that changes a product file adds a fragment under `delo/changelog/unreleased/` or carries a `Changelog: none (<reason>)` trailer. Product files are every path outside the documentation, tooling, release, workflow and changelog trees, and every non-Markdown file in those trees is not product. The gate also refuses a reason-less trailer and every fragment that does not parse. It prints one line per violation and exits 1.

## Assembly

`node_modules/.bin/tsx delo/apps/release/src/changelog/assemble.ts --version <version> [--dry-run] [--first-public-release]` builds a release from the unreleased fragments. The version is `0.x.y`, optionally with an `-alpha.N`, `-beta.N` or `-rc.N` suffix. `1.0.0` is refused unless `--first-public-release` is passed.

The "From upstream" section names the upstream release in `upstream.ref` of `delo/upstream-patches.json`. The assembly prepends a `## <version>` block to `CHANGELOG.md` at the repository root and writes the release notes to `delo/changelog/releases/<version>.md`. Upstream's tag has no `CHANGELOG.md`, so the file is Delo's own. The first release that commits it adds its divergence-ledger entry in the same commit. A version that already has notes or a block is refused.

The assembly moves each consumed fragment into `delo/changelog/releases/<version>/`. `--dry-run` prints the block and the notes and writes nothing.
