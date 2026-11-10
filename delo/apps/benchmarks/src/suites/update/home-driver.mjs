/**
 * The home process of the update suite: `delorun start --foreground`'s own function, run by the installed runtime's
 * own Node from the runtime's own modules, with one start dependency replaced. The update support is the CLI's
 * (`homeUpdateSupport` over C1's store, the CLI's report sources, profile history and session-data copies), except that
 * its release channel reads the benchmark's loopback channel and log instead of the published hosts, which the runtime
 * names as constants. The channel is `@delo/install`'s `LauncherChannel`, anchored on the root chain the home stored at
 * install, as `homeReleaseChannel` builds it, with the download rule a launcher built for a loopback channel uses.
 *
 * Every other step is unchanged. The driver only observes: it wraps the support's store, channel, downloader, report
 * sources, profile history and copies to append one timing record per step boundary to a JSON-lines file, and changes
 * no argument or result. The successor an update starts is the target runtime's own `delorun start`, not this driver.
 *
 * Arguments: `<channel origin> <log origin> <timings file>`. The file sits in a directory whose `node_modules` links to
 * the runtime's `app/node_modules`, so every import resolves to the runtime's files.
 */
import { appendFileSync } from 'node:fs'

const [channelOrigin, logOrigin, timings] = process.argv.slice(2)
if (timings === undefined) throw new Error('usage: home-driver.mjs <channel origin> <log origin> <timings file>')

/** Append one timing record. */
function mark(event, data = {}) {
  appendFileSync(timings, `${JSON.stringify({ event, at: Date.now(), ...data })}\n`)
}

/** Time each call of the named async methods of an object, keeping its prototype and every other member. */
function timed(target, prefix, names) {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver)
      if (typeof value !== 'function') return value
      // Every method runs on the object itself, so private fields work as they do without the wrapper.
      if (typeof key !== 'string' || !names.includes(key)) return value.bind(object)
      return async (...args) => {
        mark(`${prefix}.${key}:start`)
        try {
          return await value.apply(object, args)
        } finally {
          mark(`${prefix}.${key}:end`)
        }
      }
    },
  })
}

const { applyDeloVersionEnvironment } = await import('@delo/cli/src/version.js')
const { prepareHome } = await import('@delo/cli/src/command.js')
const { startForeground, upstreamDependencies } = await import('@delo/cli/src/start.js')
const { homeUpdateSupport } = await import('@delo/cli/src/update/support.js')
const { storeReportSources } = await import('@delo/cli/src/update/sources.js')
const { installLines, runtimePlatformOf } = await import('@delo/cli/src/update/channel.js')
const { Downloader, LauncherChannel, readStoredRootBytes, readStoredRootChain } = await import('@delo/install')
const { tilesTransport } = await import('@delo/release-verify')
const { readStoredRoot, RuntimeStore } = await import('@delo/runtime-store')

const context = { env: { ...process.env }, stdout: text => void process.stdout.write(text), stderr: text => void process.stderr.write(text) }
applyDeloVersionEnvironment()
const { home, profile } = await prepareHome(context, undefined)
const cli = upstreamDependencies()

/** The update support of `storeUpdateSupport`, over the loopback channel. */
function updates(homePath, profileName, running, logger) {
  const store = new RuntimeStore({ home: homePath, platform: runtimePlatformOf(process.platform, process.arch), logger })
  const openChannel = async (line) => {
    mark('channel.open:start')
    const release = await store.checkRuntime(running, await readStoredRoot(homePath))
    const chain = await readStoredRootChain(homePath)
    const root = await readStoredRootBytes(homePath)
    const roots = chain.length > 0 ? chain : root === undefined ? [] : [root]
    if (roots.length === 0) throw new Error('this home stores no verified release root')
    const fetch = globalThis.fetch.bind(globalThis)
    const progress = installLines(line)
    const channel = new LauncherChannel({
      home: homePath,
      platform: store.paths.platform,
      roots,
      channel: release.manifest.channel,
      log: () => tilesTransport({ fetch, checkpoint: `${logOrigin}/checkpoint`, tiles: logOrigin }),
      source: { metadata: channelOrigin, files: (version, name) => `${channelOrigin}/releases/download/v${version}/${name}` },
      // The download rule a launcher built for a loopback channel uses: that origin's scheme and host only.
      downloader: timed(new Downloader({ hosts: { scheme: new URL(channelOrigin).protocol, hosts: [new URL(channelOrigin).hostname], maxRedirects: 5 } }), 'download', ['bytes', 'file']),
      progress: (event) => {
        mark(`install.${event.step}`)
        progress(event)
      },
    })
    mark('channel.open:end')
    return timed(channel, 'channel', ['resolve', 'fill', 'recordInstalled'])
  }
  const sources = storeReportSources({ home: homePath, profile: profileName, store, running })
  const timedSources = Object.fromEntries(Object.entries(sources).map(([name, read]) => [name, name === 'now' ? read : async (...args) => {
    mark(`report.${name}:start`)
    try {
      return await read(...args)
    } finally {
      mark(`report.${name}:end`)
    }
  }]))
  const support = homeUpdateSupport({ home: homePath, profile: profileName, store, openChannel, sources: timedSources, now: () => new Date() })
  return {
    store: timed(support.store, 'store', ['prepare', 'switchTo', 'restore', 'reportRollback']),
    snapshots: timed(support.snapshots, 'snapshots', ['save']),
    copies: timed(support.copies, 'copies', ['plan', 'save', 'rollback', 'discard', 'commit']),
  }
}

mark('driver.start')
await startForeground({ home: home.path, profile, open: false, output: context }, { ...cli, updates })
mark('driver.ready')
