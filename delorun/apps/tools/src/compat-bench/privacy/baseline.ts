/**
 * The no-plugin baseline (`bench baseline`): a run with no plugin records its connects, listens, programs, environment
 * names read, file changes and model request. Each plugin run subtracts it, so Delorun's own start-up does not show as
 * the plugin's behaviour. One baseline file per host kind.
 *
 * @module @delorun/tools/compat-bench/privacy/baseline
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EventSummary } from './events.ts'
import type { RunFacts } from './observed.ts'

/**
 * The default folder of the bench's cache, which holds the baselines.
 * @returns the folder: `~/.cache/delorun/compat-bench`, or under `XDG_CACHE_HOME`.
 */
export function defaultBaselineDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'delorun', 'compat-bench')
}

/**
 * Name the baseline file of a host kind.
 * @param dir - the baseline folder.
 * @param host - the host kind.
 * @returns the baseline file's path.
 */
export function baselinePath(dir: string, host: string): string {
  return join(dir, `privacy-baseline-${host}.json`)
}

/** A baseline as stored: the run's facts with maps and sets as arrays, and when and what it was made on. */
type StoredBaseline = Readonly<{
  schema: 'delorun.privacy-baseline/1'
  host: string
  recordedAt: string
  hooks: Readonly<{
    connects: ReadonlyArray<{ host: string; port: string; name?: string; udp?: true }>
    listens: ReadonlyArray<{ host: string; port: string }>
    execs: ReadonlyArray<string>
    envNames: ReadonlyArray<string>
    envEnumerated: boolean
    opens: ReadonlyArray<{ label: string; path: string }>
  }>
  helper?: RunFacts['helper']
  fileChanges: RunFacts['fileChanges']
  leftCanaries: RunFacts['leftCanaries']
  request?: RunFacts['request']
}>

/**
 * @param summary - a hooks summary.
 * @returns the stored form.
 */
function storeHooks(summary: EventSummary): StoredBaseline['hooks'] {
  return {
    connects: [...summary.connects.values()],
    listens: [...summary.listens.values()],
    execs: [...summary.execs],
    envNames: [...summary.envNames],
    envEnumerated: summary.envEnumerated,
    opens: [...summary.opens.values()],
  }
}

/**
 * Write a baseline.
 * @param dir - the baseline folder.
 * @param host - the host kind.
 * @param facts - the baseline run's facts.
 * @param recordedAt - the time, as an ISO string.
 * @returns the file written.
 */
export async function saveBaseline(dir: string, host: string, facts: RunFacts, recordedAt: string): Promise<string> {
  const stored: StoredBaseline = {
    schema: 'delorun.privacy-baseline/1', host, recordedAt, hooks: storeHooks(facts.hooks),
    ...facts.helper === undefined ? {} : { helper: facts.helper }, fileChanges: facts.fileChanges, leftCanaries: facts.leftCanaries,
    ...facts.request === undefined ? {} : { request: facts.request },
  }
  const path = baselinePath(dir, host)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  return path
}

/**
 * Read the baseline of a host kind.
 * @param dir - the baseline folder.
 * @param host - the host kind.
 * @returns its facts, or undefined when none was recorded or the file is not a baseline.
 */
export async function loadBaseline(dir: string, host: string): Promise<RunFacts | undefined> {
  let stored: StoredBaseline
  try {
    stored = JSON.parse(await readFile(baselinePath(dir, host), 'utf8')) as StoredBaseline
  } catch {
    return undefined
  }
  if (stored.schema !== 'delorun.privacy-baseline/1') return undefined
  return {
    hooks: {
      connects: new Map(stored.hooks.connects.map(connect => [`${connect.host}:${connect.port}`, connect])),
      listens: new Map(stored.hooks.listens.map(listen => [`${listen.host}:${listen.port}`, listen])),
      execs: new Set(stored.hooks.execs),
      envNames: new Set(stored.hooks.envNames),
      envEnumerated: stored.hooks.envEnumerated,
      opens: new Map(stored.hooks.opens.map(open => [open.path, open])),
    },
    ...stored.helper === undefined ? {} : { helper: stored.helper },
    fileChanges: stored.fileChanges,
    leftCanaries: stored.leftCanaries,
    ...stored.request === undefined ? {} : { request: stored.request },
  }
}
