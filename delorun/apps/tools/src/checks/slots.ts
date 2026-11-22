/**
 * The machine-wide budget that heavy check runs and wrapped commands share, in place of one run at a time. The machine has
 * a number of CPU slots (its parallelism unless `DELORUN_CHECKS_SLOTS` names another), the memory the runner budgets, and a
 * small number of disk-heavy places (`DELORUN_CHECKS_DISK_RUNS`, default 3) for installs, builds and the fork suite, because
 * the disk, not the CPU, saturates first on a shared machine.
 *
 * A run asks for slots by writing a request `req-<priority>-<milliseconds>-<pid>.json` into one directory. Requests are
 * served first come, first served within a priority, and priority 0 (a push to the trunk) goes ahead of waiting priority 1
 * requests; no holder is interrupted. A request is granted when its minimum fits beside the holders and every request ahead
 * of it has been granted, except that a request that touches no disk may pass one that waits only for a disk-heavy place, and
 * that a later request may start beside the head, the first waiting request that does not fit, when it fits, touches no disk
 * and is granted its minimum, and the slots and memory held by runs granted after the head began to wait, with this grant, stay
 * within the machine less the head's minimum and memory: so the head fits as soon as the holders that were there before it
 * have finished, whatever the runs that started beside it are doing.
 * The grant is elastic: the run gets what it asks for up to the free slots, and at most the machine less a reserve of a
 * quarter of the slots, so a small run can always start beside a large one; a trunk push may take the reserve. A grant is
 * recorded as `held-<pid>.json` and removed when the process ends; the files of dead processes are removed by whichever run
 * notices them. Each file records its process's start time, so a later process that reuses the id is not taken for it. Two
 * runs that claim at once and overfill the slots, the memory or the disk-heavy places are resolved by the later request
 * among those using the overfilled resource stepping back.
 *
 * Runs of old worktrees take a ticket in the previous queue directory and the single lock file; a held ticket or the lock
 * of a live process that holds no grant counts as holding the whole machine, and an earlier waiting ticket there is served
 * first. Every request here also holds a waiting ticket there, held once granted, so an old run keeps first come, first
 * served with new runs and waits for new holders as it did for one holder. The old files record no start time, so a ticket,
 * the lock or a slot file without `start` counts for a process only if that process started before the file was last
 * written; a reused id of a later process, or the id of a thread of another process, holds nothing.
 *
 * A machine hold stops the queue from granting anything new. `hold.json` in the same directory (`{ reason, since, allow }`)
 * makes every request wait with the reason `machine held: <reason>`, whatever slots are free, except a request whose working
 * directory is inside one of the worktree roots in `allow`; a request that records no working directory is not exempt.
 * Holders already running are never interrupted, and when the file goes the waiting requests proceed in their normal order.
 * A hold file that is not valid counts as a hold with the reason `hold file unreadable`, so a damaged file fails closed;
 * `run-checks --unhold` removes it. Runs of old worktrees do not read the hold: they take their turn in the previous queue
 * as before, so a hold binds only runs of a worktree that has this code.
 *
 * The file system, clock, process table and signals are injected, so the specs start no process.
 *
 * @module @delorun/tools/checks/slots
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
export const GRANT_ENV = 'DELORUN_CHECKS_GRANT'

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
  /** The working directory it runs in, which a machine hold's allowed worktrees are matched against. */
  readonly cwd?: string
}

/** A grant. */
export interface SlotGrant {
  readonly slots: number
  readonly memoryBytes: number
  /** Milliseconds the run waited for it. */
  readonly waitedMs: number
}

// `start` is the process's start time from QueueHost.startOf; a file without one is checked by the process id alone.
const Request = z.strictObject({ pid: z.number().int(), start: z.string().optional(), want: z.number().int().positive(), min: z.number().int().positive(), memoryBytes: z.number().nonnegative(), disk: z.boolean(), priority: z.union([z.literal(0), z.literal(1)]), label: z.string(), since: z.number(), cwd: z.string().optional() })
const Held = z.strictObject({ pid: z.number().int(), start: z.string().optional(), slots: z.number().int().positive(), memoryBytes: z.number().nonnegative(), disk: z.boolean(), priority: z.union([z.literal(0), z.literal(1)]), label: z.string(), since: z.number(), requested: z.number() })

const MAX_DATE_MILLISECONDS = 8.64e15
const Hold = z.strictObject({ reason: z.string(), since: z.number().min(0).max(MAX_DATE_MILLISECONDS), allow: z.array(z.string()) })

/** A machine hold, as read from `hold.json`. */
export type SlotHold = z.infer<typeof Hold>

/** The reason of a hold file that cannot be read. */
export const UNREADABLE_HOLD = 'hold file unreadable'

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
  /** The machine hold, when `hold.json` exists. */
  readonly hold?: SlotHold
}

/** The hold file's name in the slots directory. */
const HOLD_FILE = 'hold.json'

/**
 * Parse a JSON file's text, or give undefined for text that is not JSON.
 * @param text - the text.
 * @returns the value.
 */
function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    // SyntaxError: a file written by another program, or cut short; it is no request.
    void error
    return undefined
  }
}

/**
 * The machine hold, if the slots directory has one. A file that cannot be read or is not a hold counts as a hold, so a
 * damaged file fails closed.
 * @param host - the file system.
 * @param paths - the directories.
 * @returns the hold, or undefined when there is no `hold.json`.
 */
export function readHold(host: QueueHost, paths: SlotPaths): SlotHold | undefined {
  const path = `${paths.dir}/${HOLD_FILE}`
  let text: string | undefined
  try {
    text = host.fs.read(path)
  } catch (unreadable) {
    // EACCES or EISDIR: the file exists but cannot be read, which holds the machine.
    void unreadable
    return { reason: UNREADABLE_HOLD, since: host.fs.modified(path) ?? 0, allow: [] }
  }
  if (text === undefined) return undefined
  const parsed = Hold.safeParse(json(text))
  return parsed.success ? parsed.data : { reason: UNREADABLE_HOLD, since: host.fs.modified(path) ?? 0, allow: [] }
}

/**
 * Hold the machine: write `hold.json` in one step, so a reader never sees it half written.
 * @param host - the file system and clock.
 * @param paths - the directories.
 * @param reason - why the machine is held.
 * @param allow - the worktree roots whose requests are exempt.
 * @returns the lines to print: the hold as `--queue` shows it.
 */
export function holdMachine(host: QueueHost, paths: SlotPaths, reason: string, allow: readonly string[]): string[] {
  const { fs } = host
  fs.ensureDir(paths.dir)
  const path = `${paths.dir}/${HOLD_FILE}`
  const now = host.now()
  const hold: SlotHold = { reason, since: now, allow: [...allow] }
  fs.remove(`${path}.tmp`)
  fs.create(`${path}.tmp`, JSON.stringify(hold))
  fs.rename(`${path}.tmp`, path)
  return describeHold(hold, now)
}

/**
 * Lift the machine hold, damaged or not.
 * @param host - the file system.
 * @param paths - the directories.
 * @returns the line to print.
 */
export function unholdMachine(host: QueueHost, paths: SlotPaths): string[] {
  const path = `${paths.dir}/${HOLD_FILE}`
  const held = host.fs.list(paths.dir).includes(HOLD_FILE)
  host.fs.remove(path)
  host.fs.remove(`${path}.tmp`)
  return [held ? 'machine hold removed; waiting requests proceed in their order' : 'no machine hold was in force']
}

/**
 * Whether a working directory is inside one of a hold's allowed worktrees: equal to a root or below it, so `/w/ab` is not
 * inside `/w/a`.
 * @param hold - the hold.
 * @param cwd - the request's working directory, or undefined when it recorded none.
 * @returns true when the request is exempt.
 */
function allowed(hold: SlotHold, cwd: string | undefined): boolean {
  if (cwd === undefined) return false
  return hold.allow.some((root) => {
    const base = root.replace(/\/+$/, '')
    return cwd === base || cwd.startsWith(`${base}/`)
  })
}

/**
 * The lines that show a hold: the reason, since when, and the allowed worktrees.
 * @param hold - the hold.
 * @param now - the current time in milliseconds.
 * @returns the lines.
 */
export function describeHold(hold: SlotHold, now: number): string[] {
  const lines = [`machine held: ${hold.reason}; since ${new Date(hold.since).toISOString()}, ${String(Math.max(0, Math.round((now - hold.since) / 1000)))} s ago`]
  if (hold.allow.length === 0) lines.push('  allowed worktrees: none')
  for (const root of hold.allow) lines.push(`  allowed worktree: ${root}`)
  return lines
}

/** How much later than a file's last write a process may start and still be taken for the writer: the boot time's resolution. */
const START_SLACK_MILLISECONDS = 2000

/**
 * Whether a process started no later than a file was last written, within the clock's resolution.
 * @param host - the process table.
 * @param pid - the process.
 * @param modified - when the file was last written, or undefined when it is gone.
 * @returns false only when both times are known and the process started after the write.
 */
function startedBefore(host: QueueHost, pid: number, modified: number | undefined): boolean {
  const started = host.startedAt(pid)
  return started === undefined || modified === undefined || started <= modified + START_SLACK_MILLISECONDS
}

/**
 * The live requests and holders, removing the files of dead processes and files that are not requests. A file that is gone
 * by the time it is read is skipped, not removed, since its process may have just replaced it.
 * @param host - the process and file system.
 * @param paths - the directories.
 * @returns the waiting requests in serving order, the holders, and an old worktree's holder.
 */
export function readSlots(host: QueueHost, paths: SlotPaths): SlotState {
  const { fs } = host
  const waiting: SlotRequest[] = []
  const holders: SlotHolder[] = []
  // A process is the one that wrote the file when it runs, is not a thread of another process, and started when the file
  // says; a file without a start time counts only for a process that started before the file was last written.
  const holds = (pid: number, path: string, start?: string): boolean => pid === host.pid
    || (host.alive(pid) && !host.isThread(pid) && (start === undefined ? startedBefore(host, pid, fs.modified(path)) : host.startOf(pid) === start))
  for (const file of fs.list(paths.dir)) {
    const path = `${paths.dir}/${file}`
    const schema = file.startsWith('req-') ? Request : file.startsWith('held-') ? Held : undefined
    if (schema === undefined) continue
    const text = fs.read(path)
    if (text === undefined) continue
    const parsed = schema.safeParse(json(text))
    if (parsed.success && holds(parsed.data.pid, path, parsed.data.start)) {
      if ('slots' in parsed.data) holders.push({ ...parsed.data, file })
      else waiting.push({ ...parsed.data, file })
    } else if (parsed.success || !file.endsWith('.tmp')) fs.remove(path)
  }
  waiting.sort((a, b) => a.priority - b.priority || a.since - b.since || a.pid - b.pid)
  // A new run holds a ticket in the previous queue too, waiting or held, so an old run keeps its place; it is not an old run.
  const granted = new Set([...holders, ...waiting].map(each => each.pid))
  const tickets = fs.list(paths.oldQueue).flatMap((file) => {
    const match = /^([01])-(\d+)-(\d+)(\.held)?$/.exec(file)
    const pid = Number(match?.[3])
    return match !== null && pid !== host.pid && !granted.has(pid) && holds(pid, `${paths.oldQueue}/${file}`) ? [{ pid, priority: Number(match[1]), since: Number(match[2]), held: match[4] !== undefined }] : []
  })
  const old = tickets.filter(ticket => ticket.held).map(ticket => ticket.pid)
  const oldWaiting = tickets.filter(ticket => !ticket.held).map(({ pid, priority, since }) => ({ pid, priority, since }))
  const lock = Number(fs.read(paths.oldLock))
  const hold = readHold(host, paths)
  const oldHolder = old[0] ?? (Number.isInteger(lock) && lock > 0 && lock !== host.pid && !granted.has(lock) && holds(lock, paths.oldLock) ? lock : undefined)
  return { waiting, holders, oldWaiting, ...oldHolder === undefined ? {} : { oldHolder }, ...hold === undefined ? {} : { hold } }
}

/**
 * The grant a waiting request gets now, or undefined while it must wait.
 * @param state - the machine's state, which holds the request among the waiting ones.
 * @param pid - the requesting process.
 * @param budget - the machine's budget.
 * @returns the grant's slots and memory, or why the request waits.
 */
export function decide(state: SlotState, pid: number, budget: SlotBudget): { readonly slots: number, readonly memoryBytes: number } | { readonly waits: string } {
  // A held machine grants nothing new to a request outside the allowed worktrees; holders keep what they have.
  if (state.hold !== undefined && !allowed(state.hold, state.waiting.find(request => request.pid === pid)?.cwd)) return { waits: `machine held: ${state.hold.reason}` }
  if (state.oldHolder !== undefined) return { waits: `an old worktree's run in process ${String(state.oldHolder)} holds the machine` }
  let slots = budget.slots - state.holders.reduce((sum, holder) => sum + holder.slots, 0)
  let memory = budget.memoryBytes - state.holders.reduce((sum, holder) => sum + holder.memoryBytes, 0)
  let disk = budget.diskRuns - state.holders.filter(holder => holder.disk).length
  const perSlot = budget.memoryBytes / budget.slots
  const reserve = Math.floor(budget.slots / 4)
  // What a fitting request is granted from the free slots: what it asks for, at most the machine less the reserve.
  const grantOf = (request: SlotRequest, free: number): number => Math.max(request.min, Math.min(request.want, free, request.priority === 0 ? budget.slots : budget.slots - reserve))
  // The first earlier request that does not fit is the head. It holds back every later one, except that a small later
  // request may start beside it while the head is not delayed (see `backfills`). A request that waits only for a disk-heavy
  // place holds back the later disk-heavy ones. Each earlier request that would start keeps for itself the grant it would get.
  let ahead: string | undefined
  let diskAhead: string | undefined
  let head: { readonly min: number, readonly need: number } | undefined
  // Slots and memory held by runs granted after the head began to wait, and by earlier requests that start in this pass:
  // what the head cannot count on getting back when the runs that were already there finish.
  let lateSlots = 0
  let lateMemory = 0
  let takenSlots = 0
  let takenMemory = 0
  // A later request may start beside the blocked head when it fits, touches no disk, and the runs granted after the head
  // began to wait, with this one, leave room for the head's minimum and memory; so the head fits as soon as every holder
  // that was there before it has finished, whatever the later runs are doing.
  const backfills = (request: SlotRequest, need: number): boolean => head !== undefined
    && !request.disk
    && request.min <= slots
    && need <= memory
    && lateSlots + request.min <= budget.slots - head.min
    && lateMemory + need <= budget.memoryBytes - head.need
  for (const request of state.waiting) {
    // A request the hold blocks starts nothing while it lasts, so it neither takes slots nor holds back a later request.
    if (state.hold !== undefined && !allowed(state.hold, request.cwd)) continue
    const need = Math.max(request.memoryBytes, request.min * perSlot)
    const fits = request.min <= slots && need <= memory
    const diskFree = !request.disk || disk > 0
    if (request.pid === pid) {
      const older = state.oldWaiting.find(ticket => ticket.priority < request.priority || (ticket.priority === request.priority && ticket.since < request.since))
      if (older !== undefined) return { waits: `an old worktree's run in process ${String(older.pid)} arrived earlier and waits in the previous queue` }
      if (ahead !== undefined) return backfills(request, need) ? { slots: request.min, memoryBytes: need } : { waits: ahead }
      if (request.disk && diskAhead !== undefined) return { waits: diskAhead }
      if (request.min > slots) return { waits: `${String(slots)} of ${String(budget.slots)} slots are free and it needs ${String(request.min)}` }
      if (!fits) return { waits: `${(memory / 1024 ** 3).toFixed(1)} GiB of memory is free and it needs ${(need / 1024 ** 3).toFixed(1)} GiB` }
      if (!diskFree) return { waits: `the ${String(budget.diskRuns)} disk-heavy places are taken` }
      const granted = grantOf(request, slots)
      return { slots: granted, memoryBytes: Math.min(memory, Math.max(request.memoryBytes, granted * perSlot)) }
    }
    if (!fits) {
      if (head === undefined) {
        head = { min: request.min, need }
        const later = state.holders.filter(holder => holder.since > request.since)
        lateSlots = takenSlots + later.reduce((sum, holder) => sum + holder.slots, 0)
        lateMemory = takenMemory + later.reduce((sum, holder) => sum + holder.memoryBytes, 0)
      }
      ahead ??= `the request of process ${String(request.pid)} is ahead in the queue`
      continue
    }
    if (ahead !== undefined) {
      if (backfills(request, need)) {
        slots -= request.min
        memory -= need
        lateSlots += request.min
        lateMemory += need
      }
      continue
    }
    const takes = grantOf(request, slots)
    const takesMemory = Math.max(need, Math.min(memory, takes * perSlot))
    slots -= takes
    memory -= takesMemory
    takenSlots += takes
    takenMemory += takesMemory
    if (!request.disk) continue
    if (diskFree) disk -= 1
    else diskAhead ??= `the request of process ${String(request.pid)} waits ahead for a disk-heavy place`
  }
  return { waits: 'its request is gone' }
}

/**
 * Whether a process that has just recorded its grant gives it back: an old worktree's run holds the machine, or the
 * holders overfill the slots, the memory or the disk-heavy places and the process holds the latest grant among those
 * that use the overfilled resource.
 * @param state - the machine's state read after the grant was recorded.
 * @param pid - the process.
 * @param budget - the machine's budget.
 * @returns true when the process must wait again.
 */
export function stepsBack(state: SlotState, pid: number, budget: SlotBudget): boolean {
  if (state.oldHolder !== undefined) return true
  const latest = (holders: readonly SlotHolder[]): number | undefined => [...holders].sort((a, b) => a.priority - b.priority || a.requested - b.requested || a.pid - b.pid).at(-1)?.pid
  const disk = state.holders.filter(holder => holder.disk)
  const overfilled = [
    state.holders.reduce((sum, holder) => sum + holder.slots, 0) > budget.slots ? state.holders : [],
    state.holders.reduce((sum, holder) => sum + holder.memoryBytes, 0) > budget.memoryBytes ? state.holders : [],
    disk.length > budget.diskRuns ? disk : [],
  ]
  return overfilled.some(holders => latest(holders) === pid)
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
  // The rename replaces the file in one step, so a reader never finds it missing while it is rewritten.
  const write = (path: string, value: object): void => {
    fs.remove(`${path}.tmp`)
    fs.create(`${path}.tmp`, JSON.stringify(value))
    fs.rename(`${path}.tmp`, path)
  }
  const start = host.startOf(host.pid)
  const asked = { pid: host.pid, ...start === undefined ? {} : { start }, want, min, memoryBytes: demand.memoryBytes, disk: demand.disk, priority: demand.priority, label: demand.label, since, ...demand.cwd === undefined ? {} : { cwd: demand.cwd } }
  write(request, asked)
  // The same ticket in the previous queue keeps an old run that arrived later behind this one.
  fs.create(waitingTicket, '')
  host.guard(() => { fs.remove(request); fs.remove(held); fs.remove(waitingTicket); fs.remove(ticket) })
  let said: string | undefined
  let lastReport = since
  for (;;) {
    const state = readSlots(host, paths)
    const decision = decide(state, host.pid, budget)
    if ('slots' in decision) {
      write(held, { pid: host.pid, ...start === undefined ? {} : { start }, slots: decision.slots, memoryBytes: decision.memoryBytes, disk: demand.disk, priority: demand.priority, label: demand.label, since: host.now(), requested: since })
      fs.remove(request)
      // Another run may have claimed in the same instant: the later claim on each overfilled resource steps back.
      const after = readSlots(host, paths)
      if (!stepsBack(after, host.pid, budget)) {
        fs.rename(waitingTicket, ticket)
        return { slots: decision.slots, memoryBytes: decision.memoryBytes, waitedMs: host.now() - since }
      }
      fs.remove(held)
      write(request, asked)
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
 * @returns the lines, the machine hold first when there is one.
 */
export function describeSlots(state: SlotState, budget: SlotBudget, now: number): string[] {
  const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  const used = state.holders.reduce((sum, holder) => sum + holder.slots, 0)
  const lines = state.hold === undefined ? [] : describeHold(state.hold, now)
  lines.push(`slots: ${String(used)} of ${String(budget.slots)} held, ${String(budget.diskRuns)} disk-heavy places, ${gib(budget.memoryBytes)} of memory; ${String(state.waiting.length)} waiting`)
  if (state.oldHolder !== undefined) lines.push(`  an old worktree's run in process ${String(state.oldHolder)} holds the whole machine`)
  if (state.oldWaiting.length > 0) lines.push(`  ${String(state.oldWaiting.length)} run(s) of old worktrees wait in the previous queue`)
  for (const holder of state.holders) lines.push(`  holding: process ${String(holder.pid)}, ${String(holder.slots)} slots, ${gib(holder.memoryBytes)}${holder.disk ? ', disk-heavy' : ''}${holder.priority === 0 ? ', trunk' : ''}, for ${String(Math.round((now - holder.since) / 1000))} s: ${holder.label}`)
  state.waiting.forEach((request, index) => { lines.push(`  waiting ${String(index + 1)}: process ${String(request.pid)}, ${String(request.min)}-${String(request.want)} slots${request.disk ? ', disk-heavy' : ''}${request.priority === 0 ? ', trunk' : ''}, for ${String(Math.round((now - request.since) / 1000))} s: ${request.label}`) })
  return lines
}
