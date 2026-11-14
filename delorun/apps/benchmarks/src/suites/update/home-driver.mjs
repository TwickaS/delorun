/**
 * The home process of the update suite: `delorun start --foreground`'s own function, run by the installed runtime's
 * own Node from the runtime's own modules, with its update support built exactly as `storeUpdateSupport` builds it:
 * the store, the launcher's anchored roots, the release-log start check, the channel the installing launcher recorded
 * in `trust/channel.json` (the run's loopback channel), the CLI's report sources, profile history and data copies.
 *
 * The driver only observes: it wraps the support's store, channel, report sources, profile history and copies to append
 * one timing record per call boundary to a JSON-lines file, and changes no argument or result. The successor an update
 * starts is the target runtime's own `delorun start`, not this driver.
 *
 * Argument: `<timings file>`. The file sits in a directory whose `node_modules` links to the runtime's
 * `app/node_modules`, so every import resolves to the runtime's files; `DELORUN_LAUNCHER_ROOTS` names the launcher's
 * roots, as the launcher sets it for the runtime it starts.
 */
import { appendFileSync } from 'node:fs'

const [timings] = process.argv.slice(2)
if (timings === undefined) throw new Error('usage: home-driver.mjs <timings file>')

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

const { applyDelorunVersionEnvironment } = await import('@delorun/cli/src/version.js')
const { prepareHome } = await import('@delorun/cli/src/command.js')
const { startForeground, upstreamDependencies } = await import('@delorun/cli/src/start.js')
const { homeUpdateSupport } = await import('@delorun/cli/src/update/support.js')
const { storeReportSources } = await import('@delorun/cli/src/update/sources.js')
const { fullCheckDaysOf, storeChannelOpener } = await import('@delorun/cli/src/update/store-support.js')
const { launcherAnchor } = await import('@delorun/cli/src/update/trusted-root.js')
const { releaseLogStartCheck } = await import('@delorun/cli/src/update/release-check.js')
const { runtimePlatformOf } = await import('@delorun/cli/src/update/channel.js')
const { RuntimeStore } = await import('@delorun/runtime-store')

const context = { env: { ...process.env }, stdout: text => void process.stdout.write(text), stderr: text => void process.stderr.write(text) }
applyDelorunVersionEnvironment()
const { home, profile } = await prepareHome(context, undefined)
const cli = upstreamDependencies()

/** `storeUpdateSupport`'s wiring, with each part timed. */
function updates(homePath, profileName, running, logger, env) {
  const store = new RuntimeStore({ home: homePath, platform: runtimePlatformOf(process.platform, process.arch), logger })
  const anchor = launcherAnchor(homePath, env)
  const fullCheckDays = fullCheckDaysOf(env)
  const opener = storeChannelOpener(homePath, store, running, anchor, fullCheckDays)
  const openChannel = async (line) => {
    mark('channel.open:start')
    const channel = await opener((text) => {
      mark('install.line', { text: text.slice(0, 40) })
      line(text)
    })
    mark('channel.open:end')
    return timed(channel, 'channel', ['resolve', 'fill', 'recordInstalled'])
  }
  const sources = storeReportSources({ home: homePath, profile: profileName, store, running, root: anchor.root, fullCheckDays })
  const timedSources = Object.fromEntries(Object.entries(sources).map(([name, read]) => [name, name === 'now' ? read : async (...args) => {
    mark(`report.${name}:start`)
    try {
      return await read(...args)
    } finally {
      mark(`report.${name}:end`)
    }
  }]))
  const support = homeUpdateSupport({
    home: homePath, profile: profileName, store, root: anchor.root, fullCheckDays,
    preLaunch: (version, root) => releaseLogStartCheck(homePath, store.paths.platform, version, root),
    openChannel, sources: timedSources, now: () => new Date(),
  })
  return {
    store: timed(support.store, 'store', ['prepare', 'switchTo', 'restore', 'reportRollback']),
    snapshots: timed(support.snapshots, 'snapshots', ['save']),
    copies: timed(support.copies, 'copies', ['plan', 'save', 'rollback', 'discard', 'commit']),
  }
}

mark('driver.start')
await startForeground({ home: home.path, profile, open: false, output: context, env: context.env }, { ...cli, updates })
mark('driver.ready')
