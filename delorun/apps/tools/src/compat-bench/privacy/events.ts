/**
 * Reading the in-process hooks' log (`events.jsonl`): parse its lines and reduce them to what a marker needs, with a
 * no-plugin baseline's events subtracted.
 *
 * @module @delorun/tools/compat-bench/privacy/events
 */
import type { HookEvent } from './types.ts'

/**
 * Parse a JSON-lines log, skipping lines that do not parse (a process killed mid-write leaves a torn last line).
 * @param text - the log's text.
 * @returns the events.
 */
export function parseEvents(text: string): ReadonlyArray<HookEvent> {
  const events: HookEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && 't' in value && typeof value.t === 'string') events.push(value as HookEvent)
    } catch { /* a torn line */ }
  }
  return events
}

/** The hooks' events, reduced to sets without repeats. */
export type EventSummary = Readonly<{
  /** `host:port` of every connect, with the address the name resolved to, when known. */
  connects: ReadonlyMap<string, { host: string; port: string; name?: string; udp?: true }>
  listens: ReadonlyMap<string, { host: string; port: string }>
  /** Each started program, as `file args`. */
  execs: ReadonlySet<string>
  envNames: ReadonlySet<string>
  envEnumerated: boolean
  opens: ReadonlyMap<string, { label: string; path: string }>
}>

/**
 * @param host - a host name or address as the code gave it.
 * @param address - what it resolved to, when known.
 * @returns the name when `host` is a name and `address` an address, else undefined.
 */
function nameOf(host: string, address: string | undefined): string | undefined {
  if (address === undefined || address === '' || address === host) return undefined
  return /^[\d.:a-f]+$/i.test(host) ? undefined : host
}

/**
 * Reduce events to sets.
 * @param events - the hooks' events.
 * @returns the summary.
 */
export function summarise(events: ReadonlyArray<HookEvent>): EventSummary {
  const connects = new Map<string, { host: string; port: string; name?: string; udp?: true }>()
  const listens = new Map<string, { host: string; port: string }>()
  const execs = new Set<string>()
  const envNames = new Set<string>()
  const opens = new Map<string, { label: string; path: string }>()
  let envEnumerated = false
  const resolved = new Map<string, string>()
  for (const event of events) {
    if (event.t === 'connected') resolved.set(`${event.host}:${event.port}`, event.address)
  }
  for (const event of events) {
    if (event.t === 'connect') {
      const address = resolved.get(`${event.host}:${event.port}`)
      const name = nameOf(event.host, address)
      const host = address ?? event.host
      connects.set(`${host}:${event.port}`, { host, port: event.port, ...name === undefined ? {} : { name }, ...event.proto === 'udp' ? { udp: true as const } : {} })
    } else if (event.t === 'listen') {
      listens.set(`${event.host}:${event.port}`, { host: event.host, port: event.port })
    } else if (event.t === 'exec') {
      execs.add(event.args === '' ? event.file : `${event.file} ${event.args}`)
    } else if (event.t === 'env') {
      if (event.name === '*') envEnumerated = true
      else envNames.add(event.name)
    } else if (event.t === 'open') {
      opens.set(event.path, { label: event.label, path: event.path })
    }
  }
  return { connects, listens, execs, envNames, envEnumerated, opens }
}

/** The first port the system hands out when a program listens on port 0; a listen on one is Delorun's or the plugin's own pick, not a fixed address. */
const EPHEMERAL_FROM = 32768

/**
 * Remove from a run's summary everything the no-plugin baseline also did. A started program is compared by its file
 * name only, since Delorun's own helper programs carry arguments that differ between runs (temporary paths). A listen
 * on a system-chosen port is removed once per such listen the baseline made on the same address, since the port
 * differs between runs.
 * @param run - the plugin run's summary.
 * @param baseline - the baseline's summary.
 * @returns the run's summary without the baseline's items.
 */
export function subtractBaseline(run: EventSummary, baseline: EventSummary): EventSummary {
  const baselineExecFiles = new Set([...baseline.execs].map(exec => exec.split(' ')[0] ?? exec))
  const baselineConnects = new Set([...baseline.connects.values()].flatMap(connect => [`${connect.host}:${connect.port}`, ...connect.name === undefined ? [] : [`${connect.name}:${connect.port}`]]))
  const ephemeralBudget = new Map<string, number>()
  for (const listen of baseline.listens.values()) {
    if (Number(listen.port) >= EPHEMERAL_FROM) ephemeralBudget.set(listen.host, (ephemeralBudget.get(listen.host) ?? 0) + 1)
  }
  const listens = new Map<string, { host: string; port: string }>()
  for (const [key, listen] of run.listens) {
    if (baseline.listens.has(key)) continue
    const budget = ephemeralBudget.get(listen.host) ?? 0
    if (Number(listen.port) >= EPHEMERAL_FROM && budget > 0) {
      ephemeralBudget.set(listen.host, budget - 1)
      continue
    }
    listens.set(key, listen)
  }
  return {
    connects: new Map([...run.connects].filter(([, connect]) => !baselineConnects.has(`${connect.host}:${connect.port}`) && (connect.name === undefined || !baselineConnects.has(`${connect.name}:${connect.port}`)))),
    listens,
    execs: new Set([...run.execs].filter(exec => !baseline.execs.has(exec) && !baselineExecFiles.has(exec.split(' ')[0] ?? exec))),
    envNames: new Set([...run.envNames].filter(name => !baseline.envNames.has(name))),
    envEnumerated: run.envEnumerated && !baseline.envEnumerated,
    opens: new Map([...run.opens].filter(([path]) => !baseline.opens.has(path))),
  }
}
