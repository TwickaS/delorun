/**
 * The local release channel of one benchmark run: throwaway keys and a root over them, the release tooling's stand-in
 * release log served on loopback, one loopback origin that serves whichever channel directory a suite selects, the
 * launcher built for that origin and that log (`build.ts`), and the signing of releases into channel directories with
 * `local-release.ts`. The keys, the root and the log live only as long as the run; nothing is published.
 *
 * @module @delorun/benchmarks/fixtures/channel
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyFile, serveChannel, serveLog, trust, type CleanupScope } from '@delorun/release/tests/local/support'
import { expectSuccess, run } from '../harness/processes.ts'
import type { ClosureDirectory } from './closure.ts'

/** A run's channel. */
export interface LocalChannel {
  /** The channel's loopback origin. */
  readonly origin: string
  /** The stand-in log's loopback origin. */
  readonly logOrigin: string
  /** The launcher's entry file, `dist/bin.js` of the package built for this channel. */
  readonly launcher: string
  /**
   * Sign releases, in order, into a new channel directory, which then names the last of them. A second call with the
   * same name returns the first call's directory, so suites share a channel.
   * @param name - the directory's name.
   * @param releases - the closures, oldest first.
   * @param after - an earlier channel directory to start from, whose releases and signer state are copied.
   * @returns the channel directory.
   */
  publish(name: string, releases: readonly ClosureDirectory[], after?: string): Promise<string>
  /**
   * Serve a channel directory from the channel's origin.
   * @param directory - the directory {@link LocalChannel.publish} returned.
   */
  serve(directory: string): void
}

/** Where the harness's own tools are. */
export interface ChannelTools {
  /** The repository root. */
  readonly repository: string
  /** A directory for the keys, the root, the launcher and the channel directories. */
  readonly directory: string
  /** Registers the servers' shutdown. */
  readonly scope: CleanupScope
}

/**
 * Run one of the release tooling's commands with `tsx`.
 * @param repository - the repository root.
 * @param entry - the command's file below the repository root.
 * @param args - its arguments.
 * @param what - what it does, for a failure.
 */
async function tool(repository: string, entry: string, args: readonly string[], what: string): Promise<void> {
  const finished = await run({ command: join(repository, 'node_modules/.bin/tsx'), args: [join(repository, entry), ...args], env: { ...process.env, CI: '', GITHUB_ACTIONS: '' }, cwd: repository, timeoutMs: 900_000 })
  expectSuccess(finished, what)
}

/**
 * Create the run's channel: keys, root, servers and launcher.
 * @param tools - the repository, the working directory and the cleanup scope.
 * @returns the channel.
 */
export async function createChannel(tools: ChannelTools): Promise<LocalChannel> {
  const { repository, directory, scope } = tools
  mkdirSync(directory, { recursive: true })
  const trusted = trust()
  const log = await serveLog(scope, trusted)
  let served = join(directory, 'nothing-served')
  const origin = await serveChannel(scope, () => served)
  const rootPath = join(directory, 'root.json')
  writeFileSync(rootPath, trusted.root)
  const targetsKey = keyFile(directory, 'targets.pem', trusted.keys.targets)
  const timestampKey = keyFile(directory, 'timestamp.pem', trusted.keys.timestamp)
  const published = new Map<string, Promise<string>>()
  const launcherOut = join(directory, 'launcher')
  await tool(repository, 'delorun/apps/npm-launcher/src/build.ts', ['--root', rootPath, '--out', launcherOut, '--channel-origin', origin, '--log-origin', log.origin, '--package-version', '0.0.1-bench'], 'the launcher build')
  return {
    origin,
    logOrigin: log.origin,
    launcher: join(launcherOut, 'package', 'dist', 'bin.js'),
    publish(name, releases, after) {
      const existing = published.get(name)
      if (existing !== undefined) return existing
      const signing = sign(name, releases, after)
      published.set(name, signing)
      return signing
    },
    serve(channelDirectory) {
      served = channelDirectory
    },
  }

  /**
   * Sign releases into a new channel directory.
   * @param name - the directory's name.
   * @param releases - the closures, oldest first.
   * @param after - the channel directory to start from.
   * @returns the channel directory.
   */
  async function sign(name: string, releases: readonly ClosureDirectory[], after: string | undefined): Promise<string> {
    const channel = join(directory, 'channels', name)
    const state = `${channel}.state.json`
    mkdirSync(join(directory, 'channels'), { recursive: true })
    if (after !== undefined) {
      cpSync(after, channel, { recursive: true })
      cpSync(`${after}.state.json`, state)
    }
    for (const release of releases) {
      await tool(repository, 'delorun/apps/release/src/local-release.ts', [
        '--version', release.version, '--summary', `Benchmark release ${release.version}`, '--out', channel, '--root', rootPath,
        '--targets-key', targetsKey, '--timestamp-key', timestampKey, '--state', state,
        '--log-submit', log.endpoints.submit, '--log-checkpoint', log.endpoints.checkpoint, '--log-tiles', log.endpoints.tiles,
        '--log-poll-seconds', '0', '--closures-from', release.directory,
      ], `signing release ${release.version}`)
    }
    return channel
  }
}
