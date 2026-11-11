/**
 * Builds one signed release into a directory laid out as a release channel, for a launcher built with that directory's
 * origin as its channel origin. The same commit can be built as two versions, so an update exists to take:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/local-release.ts --version <version> --out <channel dir> --root <root file>...
 * --targets-key <targets.pem> --timestamp-key <timestamp.pem> --state <state.json> --log-submit <url> --log-checkpoint <url>
 * --log-tiles <url> [--log-poll-seconds <n>] [--artifacts build|existing] [--commit <rev>] [--closures-from <dir>] [--cache <dir>]`
 *
 * Without `--closures-from`, the command builds the Linux x64 runtime closure from `--commit` (`HEAD` by default) with
 * `build-closure.ts`'s recipe, which needs the pinned Node and pnpm and a long build (`--artifacts existing` reuses the
 * artifacts already built in the worktree instead of building them); with it, the command signs the
 * `delorun-<version>-linux-x64.tar.gz` and `.files.json` that a `build-closure.ts --platform linux-x64` run left there.
 * `--log-submit`, `--log-checkpoint` and `--log-tiles` are `log-release.ts`'s log endpoints: the command submits the
 * manifest's entry to the log they name, so point them at a log you run, never at a public log unless the release is
 * meant to be logged there. The command asks the log for a witnessed checkpoint at most 60 times, `--log-poll-seconds`
 * apart (30 by default). `--state` is the timestamp signer's state file, created on the first release.
 *
 * @module @delo/release/local-release
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { RuntimePlatform } from '@delo/contract-release-manifest'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { buildClosuresChecked, type BuildRequest } from './build-closure.ts'
import type { ClosureFiles } from './closure/archive-closure.ts'
import { isArtifactSource } from './closure/artifacts.ts'
import { readSigningKey } from '@delo/release-formats/sign/envelope'
import { semanticVersion } from '@delo/release-formats/brands'
import { buildLocalRelease, copyClosureFiles, LOCAL_PLATFORM } from './local/release.ts'

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
  const ledger = JSON.parse(execFileSync('git', ['show', `${commit}:delo/upstream-patches.json`], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { upstream?: { ref?: string } }
  const ref = ledger.upstream?.ref ?? ''
  const match = UPSTREAM_REF.exec(ref)
  if (match === null) throw new Error(`delo/upstream-patches.json at ${commit} names upstream ref ${JSON.stringify(ref)}, which is not a dsh-v<version> tag`)
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
      'out': { type: 'string' },
      'root': { type: 'string', multiple: true },
      'targets-key': { type: 'string' },
      'timestamp-key': { type: 'string' },
      'state': { type: 'string' },
      'log-submit': { type: 'string' },
      'log-checkpoint': { type: 'string' },
      'log-tiles': { type: 'string' },
      'log-poll-seconds': { type: 'string', default: '30' },
      'artifacts': { type: 'string', default: 'build' },
      'commit': { type: 'string', default: 'HEAD' },
      'closures-from': { type: 'string' },
      'cache': { type: 'string', default: join(homedir(), '.cache', 'delo-release') },
    },
  })
  try {
    const { version, out, root, state } = values
    const keys = [values['targets-key'], values['timestamp-key']]
    const log = [values['log-submit'], values['log-checkpoint'], values['log-tiles']]
    if (version === undefined || out === undefined || root === undefined || state === undefined || keys.includes(undefined) || log.includes(undefined)) {
      throw new Error('pass --version, --out, --root, --targets-key, --timestamp-key, --state, --log-submit, --log-checkpoint and --log-tiles')
    }
    semanticVersion(version)
    if (!isArtifactSource(values.artifacts)) throw new Error(`--artifacts is build or existing, not ${values.artifacts}`)
    const artifacts = values.artifacts
    const poll = Number(values['log-poll-seconds'])
    if (!Number.isFinite(poll) || poll < 0) throw new Error(`--log-poll-seconds ${values['log-poll-seconds']} is not a number of seconds`)
    const repository = repositoryRoot(process.cwd())
    const commit = execFileSync('git', ['rev-parse', '--verify', `${values.commit}^{commit}`], { cwd: repository, encoding: 'utf8' }).trim()
    const cache = resolve(values.cache)
    const closures = async (directory: string): Promise<void> => {
      if (values['closures-from'] !== undefined) return copyClosureFiles(resolve(values['closures-from']), version, directory)
      // The build writes its files into a directory of its own, and only the Linux x64 files go on.
      const built = mkdtempSync(join(directory, 'closure-'))
      await build(repository, { version, commit, out: built, platforms: [LOCAL_PLATFORM], cache, writePins: false, artifacts })
      await copyClosureFiles(built, version, directory)
      rmSync(built, { recursive: true, force: true })
    }
    const released = await buildLocalRelease({
      commit,
      version,
      dsh: upstreamVersion(repository, commit),
      channel: resolve(out),
      roots: root.map(path => readFileSync(resolve(path))),
      targetsKey: readSigningKey(resolve(values['targets-key']!)),
      timestampKey: readSigningKey(resolve(values['timestamp-key']!)),
      state: resolve(state),
      log: { submit: values['log-submit']!, checkpoint: values['log-checkpoint']!, tiles: values['log-tiles']! },
      logAttempts: 60,
      logWait: () => delay(poll * 1000),
      closures,
      now: new Date(),
    })
    console.log(`local-release: signed ${released.manifestName} for ${LOCAL_PLATFORM} in ${resolve(out)} (timestamp ${String(released.timestampVersion)}); the manifest lists no other platform`)
    return 0
  } catch (error) {
    console.error(`local-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
