/**
 * The machine-wide budget that heavy check runs and wrapped commands share, in place of one run at a time. The machine has
 * a number of CPU slots (its parallelism unless `DELO_CHECKS_SLOTS` names another), the memory the runner budgets, and a
 * small number of disk-heavy places (`DELO_CHECKS_DISK_RUNS`, default 2) for installs, builds and the fork suite, because
 * the disk, not the CPU, saturates first on a shared machine.
 *
 * A run asks for slots by writing a request `req-<priority>-<milliseconds>-<pid>.json` into one directory. Requests are
 * served first come, first served within a priority, and priority 0 (a push to the trunk) goes ahead of waiting priority 1
 * requests; no holder is interrupted. A request is granted when its minimum fits beside the holders and every request ahead
 * of it has been granted, except that a request that touches no disk may pass one that waits only for a disk-heavy place.
 * The grant is elastic: the run gets what it asks for up to the free slots, and at most the machine less a reserve of a
 * quarter of the slots, so a small run can always start beside a large one; a trunk push may take the reserve. A grant is
 * recorded as `held-<pid>.json` and removed when the process ends; the files of dead processes are removed by whichever run
 * notices them. Two runs that claim at once and overfill the machine are resolved by the later request stepping back.
 *
 * Runs of old worktrees take a ticket in the previous queue directory and the single lock file; a held ticket or the lock
 * of a live process that holds no grant counts as holding the whole machine, and an earlier waiting ticket there is served
 * first. Every request here also holds a waiting ticket there, held once granted, so an old run keeps first come, first
 * served with new runs and waits for new holders as it did for one holder.
 *
 * The file system, clock, process table and signals are injected, so the specs start no process.
 *
 * @module @delo/tools/checks/slots
 */
import { z } from 'zod'
import type { QueueHost } from './run-queue.ts'

/** How long a waiting run sleeps between looks at the requests. */
export const SLOT_POLL_MILLISECONDS = 1000
/** How often a waiting run repeats its position and the time it has waited. */
export const WAIT_REPORT_MILLISECONDS = 30_000
const MILLISECONDS_WIDTH = 15

/** The machine's budget. */
export interface SlotBudget {
  /** CPU slots on the machine. */
  readonly slots: number
  /** Memory the runs may hold together, in bytes. */
  readonly memoryBytes: number
  /** Disk-heavy holders at once. */
  readonly diskRuns: number
}

/** The variable through which a run hands its grant to the process it re-executes inside a memory scope. */
export const GRANT_ENV = 'DELO_CHECKS_GRANT'

/**
 * A grant as the re-executed process receives it.
 * @param grant - the grant.
 * @returns `<slots>:<memory bytes>:<milliseconds waited>`.
 */
export function grantToEnv(grant: SlotGrant): string {
  return `${String(grant.slots)}:${String(Math.round(grant.memoryBytes))}:${String(Math.round(grant.waitedMs))}`
}

/**
 * The grant a parent run handed down, if any.
 * @param text - the variable's value.
 * @returns the grant, or undefined when the variable is unset.
 * @throws Error when the value is not a grant, since a run must not guess its share of the machine.
 */
export function grantFromEnv(text: string | undefined): SlotGrant | undefined {
  if (text === undefined) return undefined
  const match = /^(\d+):(\d+):(\d+)$/.exec(text)
  if (match === null || Number(match[1]) < 1) throw new Error(`${GRANT_ENV} must be <slots>:<memory bytes>:<milliseconds>, got ${text}`)
  return { slots: Number(match[1]), memoryBytes: Number(match[2]), waitedMs: Number(match[3]) }
}

/** What a run or command asks for. */
export interface SlotDemand {
  /** The slots it can use. */
  readonly want: number
  /** The fewest slots it can run with; at most `want`. */
  readonly min: number
  /** The memory it needs at least, in bytes; it is granted at least this, and the slots' share of the budget beyond it. */
  readonly memoryBytes: number
  /** Whether it installs, builds or runs the fork suite. */
  readonly disk: boolean
  /** 0 for a push to the trunk, otherwise 1. */
  readonly priority: 0 | 1
  /** What it runs, for `--queue`: such as the worktree and the checks. */
  readonly label: string
}

/** A grant. */
export interface SlotGrant {
  readonly slots: number
  readonly memoryBytes: number
  /** Milliseconds the run waited for it. */
  readonly waitedMs: number
}

const Request = z.strictObject({ pid: z.number().int(), want: z.number().int().positive(), min: z.number().int().positive(), memoryBytes: z.number().nonnegative(), disk: z.boolean(), priority: z.union([z.literal(0), z.literal(1)]), label: z.string(), since: z.number() })
const Held = z.strictObject({ pid: z.number().int(), slots: z.number().int().positive(), memoryBytes: z.number().nonnegative(), disk: z.boolean(), priority: z.union([z.literal(0), z.literal(1)]), label: z.string(), since: z.number(), requested: z.number() })

/** A waiting request, as read from its file. */
export type SlotRequest = z.infer<typeof Request> & { readonly file: string }
/** A holder, as read from its file. */
export type SlotHolder = z.infer<typeof Held> & { readonly file: string }

/** Where the budget lives: its directory, and the previous queue's directory and lock file. */
export interface SlotPaths {
  readonly dir: string
  readonly oldQueue: string
  readonly oldLock: string
}

/** The machine's state as one run sees it. */
export interface SlotState {
  readonly waiting: readonly SlotRequest[]
  readonly holders: readonly SlotHolder[]
  /** A live process of an old worktree that holds the previous queue or lock without a grant here. */
  readonly oldHolder?: number
  /** Live runs of old worktrees waiting in the previous queue, with the priority and time of their tickets. */
  readonly oldWaiting: readonly { readonly pid: number, readonly priority: number, readonly since: number }[]
}

/**
 * Parse a JSON file's text, or give undefined for text that is not JSON.
 * @param text - the text.
 * @returns the value.
 */
function json(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    // SyntaxError: a file written by another program, or cut short; it is no request.
    void error
    return undefined
  }
}

/**
 * The live requests and holders, removing the files of dead processes and files that are not requests.
 * @param host - the process and file system.
 * @param paths - the directories.
 * @returns the waiting requests in serving order, the holders, and an old worktree's holder.
 */
export function readSlots(host: QueueHost, paths: SlotPaths): SlotState {
  const { fs } = host
  const waiting: SlotRequest[] = []
  const holders: SlotHolder[] = []
  for (const file of fs.list(paths.dir)) {
    const path = `${paths.dir}/${file}`
    if (file.startsWith('req-')) {
      const parsed = Request.safeParse(json(fs.read(path)))
      if (parsed.success && (parsed.data.pid === host.pid || host.alive(parsed.data.pid))) waiting.push({ ...parsed.data, file })
      else if (parsed.success || !file.endsWith('.tmp')) fs.remove(path)
    } else if (file.startsWith('held-')) {
      const parsed = Held.safeParse(json(fs.read(path)))
      if (parsed.success && (parsed.data.pid === host.pid || host.alive(parsed.data.pid))) holders.push({ ...parsed.data, file })
      else if (parsed.success || !file.endsWith('.tmp')) fs.remove(path)
    }
  }
  waiting.sort((a, b) => a.priority - b.priority || a.since - b.since || a.pid - b.pid)
  // A new run holds a ticket in the previous queue too, waiting or held, so an old run keeps its place; it is not an old run.
  const granted = new Set([...holders, ...waiting].map(each => each.pid))
  const tickets = fs.list(paths.oldQueue).flatMap((file) => {
    const match = /^([01])-(\d+)-(\d+)(\.held)?$/.exec(file)
    const pid = Number(match?.[3])
    return match !== null && pid !== host.pid && !granted.has(pid) && host.alive(pid) ? [{ pid, priority: Number(match[1]), since: Number(match[2]), held: match[4] !== undefined }] : []
  })
  const old = tickets.filter(ticket => ticket.held).map(ticket => ticket.pid)
  const oldWaiting = tickets.filter(ticket => !ticket.held).map(({ pid, priority, since }) => ({ pid, priority, since }))
  const lock = Number(fs.read(paths.oldLock))
  const oldHolder = old[0] ?? (Number.isInteger(lock) && lock > 0 && lock !== host.pid && !granted.has(lock) && host.alive(lock) ? lock : undefined)
  return { waiting, holders, oldWaiting, ...oldHolder === undefined ? {} : { oldHolder } }
}

/**
 * The grant a waiting request gets now, or undefined while it must wait.
 * @param state - the machine's state, which holds the request among the waiting ones.
 * @param pid - the requesting process.
 * @param budget - the machine's budget.
 * @returns the grant's slots and memory, or why the request waits.
 */
export function decide(state: SlotState, pid: number, budget: SlotBudget): { readonly slots: number, readonly memoryBytes: number } | { readonly waits: string } {
  if (state.oldHolder !== undefined) return { waits: `an old worktree's run in process ${String(state.oldHolder)} holds the machine` }
  let slots = budget.slots - state.holders.reduce((sum, holder) => sum + holder.slots, 0)
  let memory = budget.memoryBytes - state.holders.reduce((sum, holder) => sum + holder.memoryBytes, 0)
  let disk = budget.diskRuns - state.holders.filter(holder => holder.disk).length
  const perSlot = budget.memoryBytes / budget.slots
  const reserve = Math.floor(budget.slots / 4)
  // What a fitting request is granted from the free slots: what it asks for, at most the machine less the reserve.
  const grantOf = (request: SlotRequest, free: number): number => Math.max(request.min, Math.min(request.want, free, request.priority === 0 ? budget.slots : budget.slots - reserve))
  // An earlier request that does not fit holds back every later one; one that waits only for a disk-heavy place holds back
  // the later disk-heavy ones. Each earlier request that would start keeps for itself the grant it would get.
  let ahead: string | undefined
  let diskAhead: string | undefined
  for (const request of state.waiting) {
    const need = Math.max(request.memoryBytes, request.min * perSlot)
    const fits = request.min <= slots && need <= memory
    const diskFree = !request.disk || disk > 0
    if (request.pid === pid) {
      const older = state.oldWaiting.find(ticket => ticket.priority < request.priority || (ticket.priority === request.priority && ticket.since < request.since))
      if (older !== undefined) return { waits: `an old worktree's run in process ${String(older.pid)} arrived earlier and waits in the previous queue` }
      if (ahead !== undefined) return { waits: ahead }
      if (request.disk && diskAhead !== undefined) return { waits: diskAhead }
      if (request.min > slots) return { waits: `${String(slots)} of ${String(budget.slots)} slots are free and it needs ${String(request.min)}` }
      if (!fits) return { waits: `${(memory / 1024 ** 3).toFixed(1)} GiB of memory is free and it needs ${(need / 1024 ** 3).toFixed(1)} GiB` }
      if (!diskFree) return { waits: `the ${String(budget.diskRuns)} disk-heavy places are taken` }
      const granted = grantOf(request, slots)
      return { slots: granted, memoryBytes: Math.min(memory, Math.max(request.memoryBytes, granted * perSlot)) }
    }
    if (!fits) {
      ahead ??= `the request of process ${String(request.pid)} is ahead in the queue`
      continue
    }
    if (ahead !== undefined) continue
    const takes = grantOf(request, slots)
    slots -= takes
    memory -= Math.max(need, Math.min(memory, takes * perSlot))
    if (!request.disk) continue
    if (diskFree) disk -= 1
    else diskAhead ??= `the request of process ${String(request.pid)} waits ahead for a disk-heavy place`
  }
  return { waits: 'its request is gone' }
}

/**
 * Wait for a grant and hold it until the process ends.
 * @param host - the process and file system.
 * @param paths - the directories.
 * @param budget - the machine's budget.
 * @param demand - what the run asks for.
 * @returns the grant.
 */
export async function takeSlots(host: QueueHost, paths: SlotPaths, budget: SlotBudget, demand: SlotDemand): Promise<SlotGrant> {
  const { fs } = host
  fs.ensureDir(paths.dir)
  fs.ensureDir(paths.oldQueue)
  const want = Math.max(1, Math.min(demand.want, budget.slots))
  const min = Math.max(1, Math.min(demand.min, want))
  const since = host.now()
  const stamp = `${String(demand.priority)}-${String(since).padStart(MILLISECONDS_WIDTH, '0')}-${String(host.pid)}`
  const request = `${paths.dir}/req-${stamp}.json`
  const held = `${paths.dir}/held-${String(host.pid)}.json`
  const waitingTicket = `${paths.oldQueue}/${stamp}`
  const ticket = `${waitingTicket}.held`
  const write = (path: string, value: object): void => {
    fs.remove(path)
    fs.create(`${path}.tmp`, JSON.stringify(value))
    fs.rename(`${path}.tmp`, path)
  }
  write(request, { pid: host.pid, want, min, memoryBytes: demand.memoryBytes, disk: demand.disk, priority: demand.priority, label: demand.label, since })
  // The same ticket in the previous queue keeps an old run that arrived later behind this one.
  fs.create(waitingTicket, '')
  host.guard(() => { fs.remove(request); fs.remove(held); fs.remove(waitingTicket); fs.remove(ticket) })
  let said: string | undefined
  let lastReport = since
  for (;;) {
    const state = readSlots(host, paths)
    const decision = decide(state, host.pid, budget)
    if ('slots' in decision) {
      write(held, { pid: host.pid, slots: decision.slots, memoryBytes: decision.memoryBytes, disk: demand.disk, priority: demand.priority, label: demand.label, since: host.now(), requested: since })
      fs.remove(request)
      // Another run may have claimed in the same instant; the later request of an overfilled machine steps back.
      const after = readSlots(host, paths)
      const total = after.holders.reduce((sum, holder) => sum + holder.slots, 0)
      const latest = [...after.holders].sort((a, b) => a.priority - b.priority || a.requested - b.requested || a.pid - b.pid).at(-1)
      if ((total <= budget.slots || latest?.pid !== host.pid) && after.oldHolder === undefined) {
        fs.rename(waitingTicket, ticket)
        return { slots: decision.slots, memoryBytes: decision.memoryBytes, waitedMs: host.now() - since }
      }
      fs.remove(held)
      write(request, { pid: host.pid, want, min, memoryBytes: demand.memoryBytes, disk: demand.disk, priority: demand.priority, label: demand.label, since })
    } else {
      const position = state.waiting.findIndex(each => each.pid === host.pid) + 1
      const now = host.now()
      const line = `run-checks: waiting for ${String(min)} of ${String(budget.slots)} slots: ${decision.waits}; position ${String(position)} of ${String(state.waiting.length)}, ${String(state.holders.length)} run(s) holding slots`
      if (line !== said || now - lastReport >= WAIT_REPORT_MILLISECONDS) {
        host.say(`${line}; waited ${String(Math.round((now - since) / 1000))} s (\`run-checks --queue\` shows the holders)\n`)
        said = line
        lastReport = now
      }
    }
    await host.sleep(SLOT_POLL_MILLISECONDS)
  }
}

/**
 * The lines `run-checks --queue` prints: the budget, each holder with its slots, memory and how long it has held, and each
 * waiting request in serving order.
 * @param state - the machine's state.
 * @param budget - the machine's budget.
 * @param now - the current time in milliseconds.
 * @returns the lines.
 */
export function describeSlots(state: SlotState, budget: SlotBudget, now: number): string[] {
  const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  const used = state.holders.reduce((sum, holder) => sum + holder.slots, 0)
  const lines = [`slots: ${String(used)} of ${String(budget.slots)} held, ${String(budget.diskRuns)} disk-heavy places, ${gib(budget.memoryBytes)} of memory; ${String(state.waiting.length)} waiting`]
  if (state.oldHolder !== undefined) lines.push(`  an old worktree's run in process ${String(state.oldHolder)} holds the whole machine`)
  if (state.oldWaiting.length > 0) lines.push(`  ${String(state.oldWaiting.length)} run(s) of old worktrees wait in the previous queue`)
  for (const holder of state.holders) lines.push(`  holding: process ${String(holder.pid)}, ${String(holder.slots)} slots, ${gib(holder.memoryBytes)}${holder.disk ? ', disk-heavy' : ''}${holder.priority === 0 ? ', trunk' : ''}, for ${String(Math.round((now - holder.since) / 1000))} s: ${holder.label}`)
  state.waiting.forEach((request, index) => { lines.push(`  waiting ${String(index + 1)}: process ${String(request.pid)}, ${String(request.min)}-${String(request.want)} slots${request.disk ? ', disk-heavy' : ''}${request.priority === 0 ? ', trunk' : ''}, for ${String(Math.round((now - request.since) / 1000))} s: ${request.label}`) })
  return lines
}
