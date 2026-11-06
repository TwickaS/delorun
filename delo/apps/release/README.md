# Delo release tooling

English | [中文](README.zh.md)

`@delo/release` is Delo's release tooling, a private package in `delo/apps/release`. It holds the changelog gate, the release-notes assembly, the published recipe that builds the runtime closures, and the comparison of two builds that signing requires. The [release manifest contract](../../docs/contracts/c02-release-manifest.md) (C2) defines the release files, the reproducibility scope and the signing rules this package implements.

## Modules

- `src/changelog/paths.ts` classifies a path as a product file, which needs a changelog entry, or as a fragment.
- `src/changelog/fragment.ts` parses a fragment's front matter and body, and lists the unreleased folder.
- `src/changelog/version.ts` accepts release versions.
- `src/changelog/check.ts` is the gate `gates:changelog`. It checks each commit of a range and every fragment in the working tree.
- `src/changelog/assemble.ts` assembles a release's notes, its `CHANGELOG.md` block and its moved fragments.
- `src/build-closure.ts` is the closure recipe's command; `src/closure/` holds its steps: the recipe files (`config.ts`), the pinned downloads (`sources.ts`), the staged tree and the runtime file list (`tree.ts`), the native-code check (`native.ts`) and the archiving (`archive-closure.ts`).
- `src/archive/` holds the deterministic tar, gzip and ZIP writers, their readers, and the inspection that checks an archive is in the deterministic form.
- `src/compare-rebuild.ts` is the rebuild comparison's command; `src/rebuild/` holds the comparison and the PE normalisation of its first exception.
- `tests/` holds the specs. The changelog specs run both entry points on temporary git repositories; the archive, closure and rebuild specs build fixture closures in temporary directories and serve pinned downloads from a local HTTP stand-in, so none needs the network.

## The gate

`node_modules/.bin/tsx delo/apps/release/src/changelog/check.ts --base <rev>` checks each commit after `<rev>`. A commit that changes a product file adds a fragment under `delo/changelog/unreleased/` or carries a `Changelog: none (<reason>)` trailer. Product files are every path outside the documentation, tooling, release, workflow and changelog trees, except Markdown files and bilingual pairing records (`*.i18n.yaml`), which are documentation wherever they are. The gate also refuses a reason-less trailer and every fragment that does not parse. It prints one line per violation and exits 1.

## Assembly

`node_modules/.bin/tsx delo/apps/release/src/changelog/assemble.ts --version <version> [--dry-run] [--first-public-release]` builds a release from the unreleased fragments. The version is `0.x.y`, optionally with an `-alpha.N`, `-beta.N` or `-rc.N` suffix. `1.0.0` is refused unless `--first-public-release` is passed.

The "From upstream" section names the upstream release in `upstream.ref` of `delo/upstream-patches.json`. The assembly prepends a `## <version>` block to `CHANGELOG.md` at the repository root and writes the release notes to `delo/changelog/releases/<version>.md`. Upstream's tag has no `CHANGELOG.md`, so the file is Delo's own. The first release that commits it adds its divergence-ledger entry in the same commit. A version that already has notes or a block is refused.

The assembly moves each consumed fragment into `delo/changelog/releases/<version>/`. `--dry-run` prints the block and the notes and writes nothing.

## Runtime closures

A runtime closure is one platform's installable runtime: the pinned Node executable and its licence under `node/` (`node/bin/node`, or `node/node.exe` on Windows), pnpm under `pnpm/`, and the closure root package's `package.json`, `pnpm-lock.yaml` and production dependencies under `app/`. The root package is the one `closure.json` names: upstream's `dsh-python-runtime-closure` (`python/sdk-runtime`), the dependency-only manifest whose dependencies are the `dsh` command with every plugin its shipped profiles load and their workspace peers, which upstream's `verify-runtime-closure` check keeps complete. The `dsh` command's entry file is `app/node_modules/@deepseek-ai/dsh/lib/bin.js`.

`node_modules/.bin/tsx delo/apps/release/src/build-closure.ts --version <version> --out <dir> [--commit <rev>] [--platform <platform>]... [--cache <dir>]` builds the closures of every platform, or of the named ones, from a commit (`HEAD` by default). It runs on Linux or macOS and refuses to run under a Node or pnpm version other than `toolchain.json` pins. For each build it:

1. exports the commit's tree to the build root `closure.json` fixes, `/var/tmp/delo-release-build/source`, so the absolute paths that bundlers embed in client artifacts are the same on every builder; a directory at that path that the command did not create is refused, never removed;
2. runs `pnpm install --frozen-lockfile` and `pnpm run build:artifacts` there with only the builder's `PATH`, `HOME`, `USER`, `TMPDIR` and proxy variables, plus `SOURCE_DATE_EPOCH` (the commit's committer time), `-ffile-prefix-map=<build root>=.` in `CFLAGS` and `CXXFLAGS`, `TZ=UTC`, `LC_ALL=C` and the commit id the client artifacts embed;
3. for each platform, runs `pnpm deploy --prod --ignore-scripts` of the root package with that platform's `--os`, `--cpu` and `--libc`, a hoisted `node_modules` and copied files, replaces package links with files, shares each workspace package between its consumers as upstream's executable build does, removes pnpm's deploy metadata and the root package's other files, and replaces each workspace package `prebuilt-pins.json` lists under `substitutes` with its published tarball, after checking the tarball's integrity and that its version equals the deployed source version;
4. adds the Node executable from the distribution archive `toolchain.json` pins by SHA-256, and pnpm from the tarball it pins by integrity, each downloaded once into the cache (`~/.cache/delo-release` by default) and used only when its bytes match;
5. checks every ELF, Mach-O and PE file outside `node/` against the platform's `files` entry in `prebuilt-pins.json`: an unlisted file, a changed digest or a listed file that is absent stops the build;
6. writes `delorun-<version>-<platform>.tar.gz` (`.zip` for `win32-x64`) and its unsigned runtime file list `delorun-<version>-<platform>.files.json` to `--out`, which never replaces an existing file.

`--write-pins` records the native files of the built platforms in `prebuilt-pins.json` instead of checking them; the recorded change is reviewed like any other change to the recipe.

Every native addon in a closure is a prebuilt file: upstream's `@deepseek-ai/node-addon-system` platform packages come from their npm publications, and the other addons from the npm tarballs the lockfile pins by integrity. `toolchain.json` therefore names no compiler or linker, and the prefix map applies only if a build step compiles code.

### Archive format

Both formats hold only regular files, in byte-wise UTF-8 path order, with no directory, link or device entry, and with mode `0644`, or `0755` for a file that any execute bit marks in the staged tree.

- **tar.gz**: POSIX ustar headers with uid and gid 0, empty user and group names and every mtime `SOURCE_DATE_EPOCH`; a path the name and prefix fields cannot hold gets a pax header with one `path` record. The archive ends with two zero blocks. The gzip member has mtime 0, no file name, operating system byte 255, and deflate at level 9.
- **ZIP**: "version made by" Unix 2.0 with the mode in the external attributes, UTF-8 names, no extra fields, comments, data descriptors or ZIP64 records, DOS time `SOURCE_DATE_EPOCH` in UTC rounded down to an even second, and each entry deflated at level 9 unless storing it is smaller. An archive holds at most 65,535 entries.

An archive is at most 1 GiB, the download limit of [C1](../../docs/contracts/c01-home-layout.md).

## Rebuild comparison

`node_modules/.bin/tsx delo/apps/release/src/compare-rebuild.ts <first> <second>` compares two output directories of the same release, such as the release workflow's and the targets-key holder's rebuild. It exits 0 when the two hold the same file names and every file matches, printing each difference that an entry of `rebuild-exceptions.json` accepts with that entry's id. It exits 1 on any other difference, printing each one, and signing refuses such a rebuild. It exits 2 on a usage error, an unreadable directory or an exceptions file that does not validate.

- A runtime archive matches when both copies are in the deterministic form (re-encoding the entries reproduces the archive's bytes), hold the same paths with the same modes and mtime, and every entry has the same bytes or a difference an exception accepts.
- A runtime file list matches when each copy equals the list derived from its own archive.
- Any other file matches when it is byte-identical.

`rebuild-exceptions.json` lists each accepted difference with an id, the comparison it applies (`pe` is the only one) and its reason; unknown fields fail validation. Its first entry, `pe-authenticode`, applies only to the Windows archive: it compares a PE file without its Authenticode certificate table, the security data directory entry and the header checksum, padded with zeros to 8 bytes, because the release workflow signs the Windows closure's PE files and a rebuild outside it cannot. The table must consist of `WIN_CERTIFICATE` entries of revision 2.0 and type PKCS #7 SignedData that fill it to the end of the file; any other appended bytes are a difference.
