/**
 * Builds one signed release into a directory laid out as a release channel, for a launcher built with that directory's
 * origin as its channel origin. The same commit can be built as two versions, so an update exists to take:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/local-release.ts --version <version> --summary <text> [--security] [--notes <file>] --out <channel dir>
 * --root <root file>... --targets-key <targets.pem> --timestamp-key <timestamp.pem> --state <state.json> --log-submit <url>
 * --log-checkpoint <url> --log-tiles <url> [--log-poll-seconds <n>] [--log-entry-key <type>=<key.pem>]... [--platform <platform>]...
 * [--artifacts build|existing] [--commit <rev>] [--closures-from <dir>] [--cache <dir>] [--production-keys <file>] [--allow-builder-paths]`
 *
 * `--summary` is the release's one-line summary and `--security` marks the release as a security fix; the signed
 * manifest carries both as `summary` and `security` (false without the flag), which an update notice shows.
 *
 * `--notes` is a plain-text release-notes file of at most 64 KiB (the highlights `assemble.ts --notes` writes). The
 * command copies it to the release directory and the manifest names it as `notes`. Without the flag the manifest has no
 * `notes` field, which an updater that predates the field requires.
 *
 * `--platform` names each runtime platform the release carries, one of the release platforms `closure.json` lists;
 * `linux-x64` alone when none is named. Without `--closures-from`, the command builds those platforms' runtime closures
 * from `--commit` (`HEAD` by default) with `build-closure.ts`'s recipe, which needs the pinned Node and pnpm and a long
 * build (`--artifacts existing` reuses the artifacts already built in the worktree instead of building them); with it,
 * the command signs each platform's `delorun-<version>-<platform>` archive and `.files.json` that a `build-closure.ts`
 * run left there.
 * Before it signs anything the command refuses closure or pack files that name the building user's home directory, user
 * name as a folder or the unique build root (`@delorun/release-formats/gate/home-paths`), naming each file; `--allow-builder-paths` replaces
 * it with one warning per file, for a local candidate built with `--artifacts existing`, which embeds the worktree's paths.
 * Nothing else sets it: a public release is built with `--artifacts build`.
 * `--log-submit`, `--log-checkpoint` and `--log-tiles` are `log-release.ts`'s log endpoints: the command submits the
 * manifest's entry to the log they name, so point them at a log you run, never at a public log unless the release is
 * meant to be logged there. The command asks the log for a witnessed checkpoint at most 60 times, `--log-poll-seconds`
 * apart (30 by default). `--state` is the timestamp signer's state file, created on the first release.
 * `--log-entry-key` names a log-entry private key besides the targets key, with its entry key type, such as
 * `PKIX_ECDSA_P256_SHA_256=<log-entry.pem>` (a mode-0600 PEM file). The entry is signed with the newest root's listed
 * `active` log-entry keys in the root's order, each that the targets key or a `--log-entry-key` belongs to, and the next
 * is tried only when the log refuses the entry's key type. A root without `logEntryKeys` verifies no release, so the
 * command refuses it before building anything.
 * `--production-keys` is the production-keys registry, `delorun/release/production-keys.json` of the repository by
 * default; the command refuses, before it builds anything, a `--root` file, a key one of those roots lists, or a
 * `--targets-key` or `--timestamp-key` that the registry lists.
 *
 * @module @delorun/release/local-release
 */
import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { buildClosuresChecked, isRuntimePlatform, type BuildRequest } from './build-closure.ts'
import type { ClosureFiles } from './closure/archive-closure.ts'
import { isArtifactSource } from './closure/artifacts.ts'
import { readRecipe } from './closure/config.ts'
import { entryPublicKey, isLogEntryKeyDetails, type LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
import { readSigningKey } from '@delorun/release-formats/sign/envelope'
import { semanticVersion } from '@delorun/release-formats/brands'
import { buildLocalRelease, copyClosureFiles, LOCAL_PLATFORM } from './local/release.ts'
import { PRODUCTION_KEYS_PATH, readProductionKeysFile } from './local/production-keys.ts'

/**
 * Read a `--log-entry-key` value: an entry key type and a private key file of that type's kind.
 * @param value - `<type>=<path>`.
 * @returns the signer.
 * @throws Error when the value has no `=`, names a type this tool does not implement, the file is readable by others
 *   than its owner, or it holds no private key of the type's kind.
 */
export function readLogEntryKey(value: string): LogEntrySigner {
  const split = value.indexOf('=')
  const keyDetails = split < 0 ? '' : value.slice(0, split)
  if (!isLogEntryKeyDetails(keyDetails)) throw new Error(`--log-entry-key ${JSON.stringify(value)} is not <type>=<key.pem> with type PKIX_ED25519_PH or PKIX_ECDSA_P256_SHA_256`)
  const path = resolve(value.slice(split + 1))
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8).padStart(4, '0')}; a signing key file must be readable by its owner only (chmod 600)`)
  const key = createPrivateKey(readFileSync(path))
  if (entryPublicKey(keyDetails, createPublicKey(key).export({ format: 'der', type: 'spki' })) === undefined) throw new Error(`${path} holds no ${keyDetails} private key`)
  return { keyDetails, key }
}

/** The upstream release name a commit is based on: `upstream.ref` of the divergence ledger, `dsh-v<version>`. */
const UPSTREAM_REF = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u

/**
 * The upstream release a commit is based on.
 * @param repository - the repository.
 * @param commit - the commit.
 * @returns the upstream version, such as `0.2.2-rc.1`.
 * @throws Error when the commit has no ledger or its `upstream.ref` is not a `dsh-v<version>` tag.
 */
export function upstreamVersion(repository: string, commit: string): string {
  const ledger = JSON.parse(execFileSync('git', ['show', `${commit}:delorun/upstream-patches.json`], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { upstream?: { ref?: string } }
  const ref = ledger.upstream?.ref ?? ''
  const match = UPSTREAM_REF.exec(ref)
  if (match === null) throw new Error(`delorun/upstream-patches.json at ${commit} names upstream ref ${JSON.stringify(ref)}, which is not a dsh-v<version> tag`)
  return match[1]!
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @param build - builds the closures; `build-closure.ts`'s recipe, after its toolchain check, by default.
 * @returns the exit code: 0 when the release was written, 1 when the command refused or failed.
 */
export async function main(argv: readonly string[], build: (repository: string, request: BuildRequest) => Promise<Map<RuntimePlatform, ClosureFiles>> = buildClosuresChecked): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'version': { type: 'string' },
      'summary': { type: 'string' },
      'notes': { type: 'string' },
      'security': { type: 'boolean', default: false },
      'out': { type: 'string' },
      'root': { type: 'string', multiple: true },
      'targets-key': { type: 'string' },
      'timestamp-key': { type: 'string' },
      'state': { type: 'string' },
      'log-submit': { type: 'string' },
      'log-checkpoint': { type: 'string' },
      'log-tiles': { type: 'string' },
      'log-poll-seconds': { type: 'string', default: '30' },
      'log-entry-key': { type: 'string', multiple: true },
      'platform': { type: 'string', multiple: true },
      'artifacts': { type: 'string', default: 'build' },
      'commit': { type: 'string', default: 'HEAD' },
      'closures-from': { type: 'string' },
      'cache': { type: 'string', default: join(homedir(), '.cache', 'delorun-release') },
      'production-keys': { type: 'string' },
      'allow-builder-paths': { type: 'boolean', default: false },
    },
  })
  try {
    const { version, summary, out, root, state } = values
    const keys = [values['targets-key'], values['timestamp-key']]
    const log = [values['log-submit'], values['log-checkpoint'], values['log-tiles']]
    if (version === undefined || summary === undefined || out === undefined || root === undefined || state === undefined || keys.includes(undefined) || log.includes(undefined)) {
      throw new Error('pass --version, --summary, --out, --root, --targets-key, --timestamp-key, --state, --log-submit, --log-checkpoint and --log-tiles')
    }
    semanticVersion(version)
    if (!isArtifactSource(values.artifacts)) throw new Error(`--artifacts is build or existing, not ${values.artifacts}`)
    const artifacts = values.artifacts
    const poll = Number(values['log-poll-seconds'])
    if (!Number.isFinite(poll) || poll < 0) throw new Error(`--log-poll-seconds ${values['log-poll-seconds']} is not a number of seconds`)
    const released = readRecipe().closure.platforms
    const platforms = [...new Set(values.platform ?? [LOCAL_PLATFORM])].map((platform) => {
      if (!isRuntimePlatform(platform) || !released.includes(platform)) throw new Error(`--platform ${platform} is not a release platform; closure.json lists ${released.join(', ')}`)
      return platform
    })
    const repository = repositoryRoot(process.cwd())
    const productionKeys = readProductionKeysFile(values['production-keys'] === undefined ? join(repository, PRODUCTION_KEYS_PATH) : resolve(values['production-keys']))
    const commit = execFileSync('git', ['rev-parse', '--verify', `${values.commit}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
    const cache = resolve(values.cache)
    const closures = async (directory: string): Promise<void> => {
      if (values['closures-from'] !== undefined) return copyClosureFiles(resolve(values['closures-from']), version, platforms, directory)
      // The build writes its files into a directory of its own, and only the archives and file lists go on.
      const built = mkdtempSync(join(directory, 'closure-'))
      await build(repository, { version, commit, out: built, platforms, cache, writePins: false, artifacts })
      await copyClosureFiles(built, version, platforms, directory)
      rmSync(built, { recursive: true, force: true })
    }
    const result = await buildLocalRelease({
      commit,
      version,
      dsh: upstreamVersion(repository, commit),
      security: values.security,
      summary,
      ...values.notes === undefined ? {} : { notes: readFileSync(resolve(values.notes)) },
      channel: resolve(out),
      roots: root.map(path => readFileSync(resolve(path))),
      targetsKey: readSigningKey(resolve(values['targets-key']!)),
      timestampKey: readSigningKey(resolve(values['timestamp-key']!)),
      logEntryKeys: (values['log-entry-key'] ?? []).map(readLogEntryKey),
      productionKeys,
      platforms,
      state: resolve(state),
      log: { submit: values['log-submit']!, checkpoint: values['log-checkpoint']!, tiles: values['log-tiles']! },
      allowBuilderPaths: values['allow-builder-paths'],
      logAttempts: 60,
      logWait: () => delay(poll * 1000),
      closures,
      now: new Date(),
    })
    console.log(`local-release: signed ${result.manifestName} for ${platforms.join(', ')} in ${resolve(out)} (timestamp ${String(result.timestampVersion)}); the manifest lists no other platform`)
    return 0
  } catch (error) {
    console.error(`local-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
