/**
 * Assembling what a run observed: the in-process hooks' summary and the helper's container-level report are merged,
 * the no-plugin baseline's items are subtracted, and the result is the {@link Observed} the marker builders read.
 *
 * @module @delorun/tools/compat-bench/privacy/observed
 */
import { subtractBaseline } from './events.ts'
import type { EventSummary } from './events.ts'
import { compareRequests } from './requests.ts'
import type { RequestSignature } from './requests.ts'
import { isLoopback, normalisePath } from './markers.ts'
import type { HelperReport, Observed, ProxyHost } from './types.ts'

/** Everything one run (a plugin run or the baseline) recorded. */
export type RunFacts = Readonly<{
  hooks: EventSummary
  /** The helper's report; undefined when no helper ran. */
  helper?: HelperReport | undefined
  /** `docker diff` of the plugin container after uninstall (or at the end of a baseline run). */
  fileChanges: ReadonlyArray<{ kind: 'A' | 'C' | 'D'; path: string }>
  /** The canaries found in the filesystem after uninstall. */
  leftCanaries: ReadonlyArray<{ canary: string; path: string }>
  /** The model request the mock received, if the run made one. */
  request?: RequestSignature | undefined
}>

/**
 * Merge the helper's container-level events into the hooks' summary.
 * @param hooks - the hooks' summary.
 * @param helper - the helper's report, if any.
 * @returns the merged summary: a connect seen by both is one entry carrying the name when either knows it.
 */
export function mergeHelper(hooks: EventSummary, helper: HelperReport | undefined): EventSummary {
  if (helper === undefined) return hooks
  const connects = new Map(hooks.connects)
  const listens = new Map(hooks.listens)
  const execs = new Set(hooks.execs)
  for (const event of helper.net) {
    if (event.t === 'connect') {
      const key = `${event.host}:${event.port}`
      const known = connects.get(key)
      const name = known?.name ?? event.name
      connects.set(key, { host: event.host, port: event.port, ...name === undefined ? {} : { name }, ...known?.udp === true ? { udp: true as const } : {} })
    } else if (event.t === 'listen') {
      listens.set(`${event.host}:${event.port}`, { host: event.host, port: event.port })
    } else {
      execs.add(event.cmd)
    }
  }
  return { ...hooks, connects, listens, execs }
}

/**
 * Normalised-path set of a list of changes, for comparing a run with the baseline when ids in paths differ.
 * @param changes - changes or canary finds.
 * @returns the set.
 */
function pathSet(changes: ReadonlyArray<{ path: string }>): Set<string> {
  return new Set(changes.map(change => normalisePath(change.path)))
}

/**
 * Work out what a plugin run observed beyond the baseline.
 * @param run - the plugin run's facts.
 * @param baseline - the baseline's facts, when one was recorded.
 * @returns the observations.
 */
export function assemble(run: RunFacts, baseline?: RunFacts): Observed {
  const merged = mergeHelper(run.hooks, run.helper)
  const baseMerged = baseline === undefined ? undefined : mergeHelper(baseline.hooks, baseline.helper)
  const reduced = baseMerged === undefined ? merged : subtractBaseline(merged, baseMerged)
  const baselineHosts = new Set((baseline?.helper?.hosts ?? []).filter(host => host.pinned).map(host => host.host))
  const baselineFiles = pathSet(baseline?.fileChanges ?? [])
  const baselineCopies = new Set((baseline?.leftCanaries ?? []).map(copy => `${copy.canary}|${normalisePath(copy.path)}`))
  const connects = [...reduced.connects.values()].map(connect => ({ host: connect.host, port: connect.port, ...connect.name === undefined ? {} : { name: connect.name } }))
  // A datagram is not read by the proxy: its contents are not checked.
  const datagrams: ProxyHost[] = [...reduced.connects.values()].filter(connect => connect.udp === true && !isLoopback(connect.host)).map(connect => ({ host: connect.name ?? connect.host, port: connect.port, canaries: [], where: {}, requests: 0, pinned: true }))
  const proxy: ProxyHost[] = [...(run.helper?.hosts ?? []).filter(host => (host.canaries.length > 0 || host.pinned) && !(host.canaries.length === 0 && baselineHosts.has(host.host))), ...datagrams]
  const requestChanges = run.request === undefined || baseline?.request === undefined ? [] : compareRequests(run.request, baseline.request)
  return {
    connects,
    listens: [...reduced.listens.values()],
    execs: [...reduced.execs],
    envNames: [...reduced.envNames],
    envEnumerated: reduced.envEnumerated,
    opens: [...reduced.opens.values()],
    fileChanges: run.fileChanges.filter(change => !baselineFiles.has(normalisePath(change.path))),
    leftCanaries: run.leftCanaries.filter(copy => !baselineCopies.has(`${copy.canary}|${normalisePath(copy.path)}`)),
    proxy,
    requestChanges,
    contentsChecked: run.helper !== undefined,
  }
}
