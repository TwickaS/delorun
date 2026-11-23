/**
 * `delorun devices list | approve | elevate | remove <device id> | code | pin` (contract C5): the devices this home trusts, managed at
 * the home's own computer.
 *
 * - `list` reads the home's records, without key material.
 * - `approve` opens the approval window through the home socket's `devices.approve` (C19), which only the person's own
 *   command may call, waits for a new device's request and lists every pending request with its name, platform, time
 *   and short request id. The person chooses one to approve and types the 8-digit code its device shows, or chooses
 *   one to cancel, which frees its place when 5 are pending. A wrong code may be typed again; the third cancels that
 *   request only, and the list is shown again.
 * - `remove` removes a device, ending its sessions at once: through the home socket's `devices.remove` when Delorun runs,
 *   so its open connections end too, or on the records when it does not. No command reaches a device route over HTTP.
 * - `elevate` answers a device's request to unlock sensitive actions (C14, "Elevation") through the home socket's
 *   `devices.elevate`, which only the person's own command may call. It lists the waiting requests and the running
 *   unlocks; the person approves a request by typing the 8-digit code its device shows, declines one, or ends an unlock.
 * - `code` prints a new owner code, only to a terminal.
 * - `pin set | options | off | resume | status` turns PIN mode on and off and changes its options at this computer (C14, "PIN mode"); see `./pin.ts`.
 *
 * @module @delorun/cli/devices/command
 */
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as clack from '@clack/prompts'
import type { DeviceId } from '@delorun/contract-admission'
import { HomeAuth, HomeAuthError, type DeviceSummary } from '@delorun/home-auth'
import { resolveDelorunHome } from '@delorun/home'
import { signInAddress, type TailscalePrivateRow } from '@delorun/setup-apply'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delorun/home-process'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { readReachRow } from '../reach/row.ts'
import { requireTerminal } from '../needs-terminal.ts'
import { notRunningText, REMOTE_ACCESS_OFF } from '../messages.ts'
import { readableTime } from '../output.ts'
import { printable } from '../terminal-text.ts'
import { runPin, type PinDependencies } from './pin.ts'

/** What the command runs against. */
export interface DevicesDependencies {
  /**
   * Whether the profile's home process runs.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the home socket with the token file's token.
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   * @param request - the request.
   * @returns the response lines.
   */
  readonly send: (home: string, profile: string, request: UnsignedRequest) => Promise<ResponseLine[]>
  /**
   * Ask the person for a line of text.
   * @param message - the question.
   * @returns the answer, or undefined when the person cancelled.
   */
  readonly ask: (message: string) => Promise<string | undefined>
  /** Whether standard output is a terminal, which an owner code is printed to only. */
  readonly terminal: boolean
  /** What `devices pin` needs besides the home socket and the running check above. */
  readonly pin: Pick<PinDependencies, 'secret' | 'stdinLine' | 'interactive' | 'stdinIsTerminal' | 'now'>
}

/** The usage line. */
const USAGE = 'Usage: delorun devices list | approve | elevate | remove <device id> | code | pin set|options|off|resume|status [--profile <name>]'

/** How many codes `approve` and `elevate` take for one request: C5's and C14's count before the home cancels it. */
const CODE_ATTEMPTS = 3

/** How many characters of a request id `approve` and `elevate` show to tell requests apart. */
const SHORT_REQUEST_ID = 8

/**
 * Build the command over its dependencies.
 * @param dependencies - the running check, the home socket, the prompt and the terminal check.
 * @returns the command.
 */
export function createDevicesCommand(dependencies: DevicesDependencies): CliCommand {
  return {
    name: 'devices',
    summary: 'The devices you let sign in to your studio: list, approve, elevate, remove, code, pin',
    async run(args, context) {
      const [action, ...rest] = args
      if (action === 'pin') {
        const [pinAction, ...pinOptions] = rest
        // Each action rejects an unknown option itself; this read only finds the profile it runs against.
        const { values } = parseArgs({ args: pinOptions, options: { profile: { type: 'string' } }, strict: false, allowPositionals: true })
        const profile = selectProfile(typeof values.profile === 'string' ? values.profile : undefined, context.env)
        const home = (await resolveDelorunHome(context.env)).path
        return runPin(pinAction, pinOptions, { home, profile, context, dependencies: { running: dependencies.running, send: dependencies.send, ...dependencies.pin } })
      }
      // `remove` names its device first: `delorun devices remove <device id> [--profile <name>]`. A device id is base64url
      // text, which may begin with `-`, so only the profile option is read as an option there.
      const positional = action === 'remove' && rest[0] !== undefined && rest[0] !== '--profile' && !rest[0].startsWith('--profile=') ? [rest[0]] : []
      const options = rest.slice(positional.length)
      const values = parseOptions(`devices ${String(action)}`, options, { profile: { type: 'string' } })
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDelorunHome(context.env)).path
      const where = { home, profile, context, dependencies }
      switch (action) {
        case 'list': return list(where)
        case 'approve': return approve(where)
        case 'elevate': return elevate(where)
        case 'remove': return remove(where, positional)
        case 'code': return code(where)
        default: throw new CliError(EXIT.usage, `delorun devices: ${action === undefined ? 'choose an action' : `unknown action ${JSON.stringify(action)}`}\n${USAGE}`)
      }
    },
  }
}

/**
 * Ask one question in the terminal.
 * @param message - the question.
 * @param command - the command named in the failure when no terminal can answer.
 * @returns the answer, or undefined when the person cancels.
 * @throws {CliError} `EXIT.failed` when standard input is not a terminal.
 */
export async function askInTerminal(message: string, command = 'delorun devices'): Promise<string | undefined> {
  requireTerminal(command)
  const answer = await clack.text({ message })
  return clack.isCancel(answer) ? undefined : answer
}

/**
 * Ask for a secret in the terminal with the typed characters hidden.
 * @param message - the question.
 * @param command - the command named in the failure when no terminal can answer.
 * @returns the answer, or undefined when the person cancels.
 * @throws {CliError} `EXIT.failed` when standard input is not a terminal.
 */
export async function askSecretInTerminal(message: string, command = 'delorun devices pin'): Promise<string | undefined> {
  requireTerminal(command)
  const answer = await clack.password({ message })
  return clack.isCancel(answer) ? undefined : answer
}

/**
 * Read the first line of standard input.
 * @returns the line without its line ending, or undefined when input ends first.
 */
export async function readStdinLine(): Promise<string | undefined> {
  const lines = createInterface({ input: process.stdin })
  try {
    for await (const line of lines) return line
    return undefined
  } finally {
    lines.close()
  }
}

/** `delorun devices`, over the home socket and a terminal prompt. */
export const devicesCommand: CliCommand = createDevicesCommand({
  running: homeRuns,
  send: sendHomeRequest,
  ask: askInTerminal,
  terminal: process.stdout.isTTY,
  pin: { secret: askSecretInTerminal, stdinLine: readStdinLine, interactive: process.stdin.isTTY === true && process.stdout.isTTY === true, stdinIsTerminal: process.stdin.isTTY === true, now: Date.now },
})

/** One invocation's home, profile, output and dependencies. */
interface Where {
  readonly home: string
  readonly profile: string
  readonly context: CommandContext
  readonly dependencies: DevicesDependencies
}

/**
 * The home's records, read the way the running home reads them.
 * @param home - the Delorun home.
 * @returns a home-auth instance over its secrets directory.
 */
function records(home: string): HomeAuth {
  return new HomeAuth({ directory: join(home, 'secrets', 'home-auth') })
}

/**
 * One device as a line.
 * @param device - the device.
 * @returns the line.
 */
function deviceLine(device: DeviceSummary): string {
  const approved = device.approvedBy === 'local' ? 'approved at this computer' : device.approvedBy === null ? 'claimed this home' : `approved by ${printable(device.approvedBy)}`
  const signIn = device.lastSignInAt === null ? 'never signed in' : `last signed in ${readableTime(device.lastSignInAt)}`
  return `${printable(device.id)}  ${deviceName(device)}\n    ${printable(device.address)}, ${approved} ${readableTime(device.approvedAt)}, ${signIn}`
}

/**
 * A device's label and platform as the terminal shows them, with every character a terminal acts on escaped: the home
 * refuses such characters in a request, but reads its device records as written.
 * @param device - the label and platform.
 * @returns the label, followed by the platform in parentheses when there is one.
 */
function deviceName(device: { readonly label: string; readonly platform: string }): string {
  return `${printable(device.label)}${device.platform === '' ? '' : ` (${printable(device.platform)})`}`
}

/**
 * `delorun devices list`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function list(where: Where): Promise<ExitCode> {
  let devices: readonly DeviceSummary[]
  try {
    devices = (await records(where.home).devices()).devices
  } catch (error) {
    if (!(error instanceof HomeAuthError)) throw error
    if (error.code !== 'NO_OWNER') return failed(where.context, error.detail)
    devices = []
  }
  where.context.stdout(devices.length === 0
    ? 'No device is trusted on this computer yet. Add one with delorun devices approve.\n'
    : `${devices.map(deviceLine).join('\n')}\n`)
  return EXIT.ok
}

/** A pending request as `devices.approve` lists it. */
interface PendingRequest {
  readonly requestId: string
  readonly label: string
  readonly platform: string
  readonly createdAt: number
  /** The Tailscale user the request named, if any. */
  readonly identity: string | undefined
  /** Whether the request arrived without an approval window. */
  readonly windowless: boolean
}

/** What the person chose: a request to approve or to cancel. */
interface Choice {
  readonly action: 'approve' | 'cancel'
  readonly request: PendingRequest
}

/** How a chosen request ended: the command's exit code, or `again` to show the pending requests again. */
type Outcome = ExitCode | 'again'

/**
 * `delorun devices approve`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function approve(where: Where): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  if (!dependencies.running(home, profile)) return notRunning(context, profile)
  const row = readReachRow(home, profile)
  if (!row.enabled || row.address === '') {
    context.stderr(`${REMOTE_ACCESS_OFF}\n`)
    return EXIT.failed
  }
  context.stdout(`Waiting for a new device for up to 5 minutes. ${openLine(row)}\n`)
  for (;;) {
    const opened = final(await dependencies.send(home, profile, { op: 'devices.approve', args: {} }))
    if (opened.ok !== true) return failed(context, `Delorun refused: ${refusal(opened)}`)
    const pending = pendingOf(opened.pending)
    if (pending === undefined) return failed(context, 'Delorun answered with a list of requests this command cannot read')
    if (pending.length === 0) return failed(context, 'No device asked for approval before the window closed. Run delorun devices approve again')
    context.stdout(`Devices asking for approval:\n${pending.map((request, index) => `  ${String(index + 1)}. ${pendingLine(request)}`).join('\n')}\n`)
    const choice = await choose(where, pending)
    if (choice === undefined) return failed(context, 'cancelled; no device was approved')
    const outcome = choice.action === 'approve' ? await typeCode(where, deviceRound(choice.request)) : await cancel(where, choice.request)
    if (outcome !== 'again') return outcome
  }
}

/**
 * What the person opens on the new device: the sign-in address while the profile's remote access is on.
 * @param row - the profile's Tailscale private row.
 * @returns the sentence.
 */
function openLine(row: TailscalePrivateRow): string {
  return `Open ${signInAddress(row.address)} on it and choose Ask for approval.`
}

/**
 * One pending request as a line.
 * @param request - the request.
 * @returns its label, platform, time and short id.
 */
function pendingLine(request: PendingRequest): string {
  const who = request.identity === undefined ? '' : `, from Tailscale user ${printable(request.identity)}`
  const how = request.windowless ? ', asked without an approval window' : ''
  return `${deviceName(request)}${who}, asked at ${readableTime(request.createdAt)}${how}, request ${printable(request.requestId.slice(0, SHORT_REQUEST_ID))}`
}

/**
 * Read the pending requests of a `devices.approve` answer.
 * @param value - the answer's `pending` field.
 * @returns the requests, oldest first; empty without the field; undefined when an entry is not a request.
 */
function pendingOf(value: unknown): readonly PendingRequest[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries: readonly unknown[] = value
  const requests: PendingRequest[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const requestId: unknown = Reflect.get(entry, 'requestId')
    const label: unknown = Reflect.get(entry, 'label')
    const platform: unknown = Reflect.get(entry, 'platform')
    const createdAt: unknown = Reflect.get(entry, 'createdAt')
    if (typeof requestId !== 'string' || typeof label !== 'string' || typeof platform !== 'string') return undefined
    if (typeof createdAt !== 'number' || Number.isNaN(new Date(createdAt).getTime())) return undefined
    const identity: unknown = Reflect.get(entry, 'identity')
    const login: unknown = typeof identity === 'object' && identity !== null ? Reflect.get(identity, 'login') : undefined
    requests.push({ requestId, label, platform, createdAt, identity: typeof login === 'string' ? login : undefined, windowless: Reflect.get(entry, 'windowless') === true })
  }
  return requests
}

/**
 * Ask which request to approve or cancel, until the answer names one or the person cancels.
 * @param where - the invocation.
 * @param pending - the listed requests.
 * @returns the choice, or undefined when the person cancelled.
 */
async function choose(where: Where, pending: readonly PendingRequest[]): Promise<Choice | undefined> {
  for (;;) {
    const answer = await where.dependencies.ask('Type the number of the device to approve, or c and its number to cancel its request')
    if (answer === undefined) return undefined
    const match = /^(c(?:ancel)?\s*)?(\d+)$/i.exec(answer.trim())
    const request = match === null ? undefined : pending[Number(match[2]) - 1]
    if (match !== null && request !== undefined) return { action: match[1] === undefined ? 'approve' : 'cancel', request }
    where.context.stderr(`Type a number from 1 to ${String(pending.length)}, or c and a number.\n`)
  }
}

/** A request the person answers with the code its device shows. */
interface CodeRound {
  /** The device's name. */
  readonly label: string
  /**
   * The request that carries the typed code.
   * @param typedCode - what the person typed.
   * @returns the request.
   */
  readonly request: (typedCode: string) => UnsignedRequest
  /**
   * What the person reads once the home accepted the code.
   * @param answer - the home's final line.
   * @returns the line.
   */
  readonly accepted: (answer: ResponseLine) => string
  /** What did not happen, after `cancelled; ` and before a refusal's code. */
  readonly unchanged: string
}

/**
 * The round that approves a new device.
 * @param request - the chosen request.
 * @returns the round.
 */
function deviceRound(request: PendingRequest): CodeRound {
  return {
    label: request.label,
    request: typedCode => ({ op: 'devices.approve', args: { requestId: request.requestId, typedCode } }),
    accepted: () => `Approved ${printable(request.label)}. It signs in on its own now.\n`,
    unchanged: 'no device was approved',
  }
}

/**
 * Send the code the person types until the home accepts it, refuses it for another reason, or cancels the request.
 * @param where - the invocation.
 * @param round - the request and what the person reads.
 * @returns the exit code, or `again` when the request ended before the home accepted a code.
 */
async function typeCode(where: Where, round: CodeRound): Promise<Outcome> {
  const { home, profile, context, dependencies } = where
  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    const typed = await dependencies.ask(`Type the 8-digit code ${printable(round.label)} shows`)
    if (typed === undefined) return failed(context, `cancelled; ${round.unchanged}`)
    const answer = final(await dependencies.send(home, profile, round.request(typed)))
    if (answer.ok === true) {
      context.stdout(round.accepted(answer))
      return EXIT.ok
    }
    const detail = refusal(answer)
    if (detail.startsWith('APPROVAL_EXPIRED')) return noLongerWaiting(context)
    if (!detail.startsWith('APPROVAL_CODE_MISMATCH')) return failed(context, `${round.unchanged}: ${detail}`)
    context.stderr(attempt < CODE_ATTEMPTS
      ? 'That code is not the one the device shows. Try again.\n'
      : 'That code is not the one the device shows. Three wrong codes cancelled this request; any other request still waits.\n')
  }
  return 'again'
}

/**
 * Cancel the chosen request, which frees its place among the pending requests.
 * @param where - the invocation.
 * @param request - the chosen request.
 * @returns `again`, or the exit code of a refusal.
 */
async function cancel(where: Where, request: PendingRequest): Promise<Outcome> {
  const { home, profile, context, dependencies } = where
  const answer = final(await dependencies.send(home, profile, { op: 'devices.approve', args: { cancelRequestId: request.requestId } }))
  if (answer.ok === true) {
    context.stdout(`Cancelled the request of ${printable(request.label)}. Waiting for a new device.\n`)
    return 'again'
  }
  const detail = refusal(answer)
  if (detail.startsWith('APPROVAL_EXPIRED')) return noLongerWaiting(context)
  return failed(context, `the request was not cancelled: ${detail}`)
}

/**
 * Say that the chosen request ended on its own, before the pending requests are shown again.
 * @param context - the output.
 * @returns `again`.
 */
function noLongerWaiting(context: CommandContext): Outcome {
  context.stderr('That request is no longer waiting.\n')
  return 'again'
}

/** A request to unlock or a running unlock, as `devices.elevate` lists them. */
interface Unlock {
  readonly kind: 'request' | 'running'
  /** The request id or the elevation id. */
  readonly id: string
  readonly label: string
  readonly platform: string
  /** When the device asked, or when its unlock ends. */
  readonly at: number
}

/**
 * `delorun devices elevate`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function elevate(where: Where): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  if (!dependencies.running(home, profile)) return notRunning(context, profile)
  for (;;) {
    const listed = final(await dependencies.send(home, profile, { op: 'devices.elevate', args: {} }))
    if (listed.ok !== true) return failed(context, `Delorun refused: ${refusal(listed)}`)
    const unlocks = unlocksOf(listed)
    if (unlocks === undefined) return failed(context, 'Delorun answered with a list of unlocks this command cannot read')
    if (unlocks.length === 0) {
      context.stdout('No device asks to unlock sensitive actions, and none holds an unlock.\n')
      return EXIT.ok
    }
    context.stdout(`Sensitive actions:\n${unlocks.map((unlock, index) => `  ${String(index + 1)}. ${unlockLine(unlock)}`).join('\n')}\n`)
    const chosen = await chooseUnlock(where, unlocks)
    if (chosen === undefined) return failed(context, 'cancelled; nothing changed')
    const outcome = chosen.action === 'approve' ? await typeCode(where, unlockRound(chosen.unlock)) : await endUnlock(where, chosen.unlock)
    if (outcome !== 'again') return outcome
  }
}

/**
 * One request to unlock or running unlock as a line.
 * @param unlock - the request or the unlock.
 * @returns the device's name and when it asked, or until when its unlock runs.
 */
function unlockLine(unlock: Unlock): string {
  const at = readableTime(unlock.at)
  return unlock.kind === 'request'
    ? `${deviceName(unlock)} asks to unlock, asked at ${at}, request ${printable(unlock.id.slice(0, SHORT_REQUEST_ID))}`
    : `${deviceName(unlock)} is unlocked until ${at}`
}

/**
 * Read the requests and the running unlocks of a `devices.elevate` answer.
 * @param answer - the answer.
 * @returns the requests, oldest first, then the running unlocks; undefined when an entry cannot be read.
 */
function unlocksOf(answer: ResponseLine): readonly Unlock[] | undefined {
  const unlocks: Unlock[] = []
  for (const [field, kind, id, at] of [['pending', 'request', 'requestId', 'requestedAt'], ['running', 'running', 'id', 'endsAt']] as const) {
    const value = answer[field]
    if (!Array.isArray(value)) return undefined
    const entries: readonly unknown[] = value
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) return undefined
      const read = { id: Reflect.get(entry, id), label: Reflect.get(entry, 'label'), platform: Reflect.get(entry, 'platform'), at: Reflect.get(entry, at) }
      if (typeof read.id !== 'string' || typeof read.label !== 'string' || typeof read.platform !== 'string') return undefined
      if (typeof read.at !== 'number' || Number.isNaN(new Date(read.at).getTime())) return undefined
      unlocks.push({ kind, id: read.id, label: read.label, platform: read.platform, at: read.at })
    }
  }
  return unlocks
}

/**
 * Ask which request to approve, or which request or unlock to end, until the answer names one or the person cancels.
 * @param where - the invocation.
 * @param unlocks - the listed requests and unlocks.
 * @returns the choice, or undefined when the person cancelled.
 */
async function chooseUnlock(where: Where, unlocks: readonly Unlock[]): Promise<{ readonly action: 'approve' | 'end'; readonly unlock: Unlock } | undefined> {
  for (;;) {
    const answer = await where.dependencies.ask('Type the number of a request to approve, or e and a number to decline a request or end an unlock')
    if (answer === undefined) return undefined
    const match = /^(e(?:nd)?\s*)?(\d+)$/i.exec(answer.trim())
    const unlock = match === null ? undefined : unlocks[Number(match[2]) - 1]
    if (match !== null && unlock !== undefined) {
      if (match[1] !== undefined) return { action: 'end', unlock }
      if (unlock.kind === 'request') return { action: 'approve', unlock }
      where.context.stderr('That device is unlocked already. Type e and its number to end the unlock.\n')
      continue
    }
    where.context.stderr(`Type a number from 1 to ${String(unlocks.length)}, or e and a number.\n`)
  }
}

/**
 * The round that unlocks sensitive actions on a device.
 * @param unlock - the chosen request.
 * @returns the round.
 */
function unlockRound(unlock: Unlock): CodeRound {
  return {
    label: unlock.label,
    request: typedCode => ({ op: 'devices.elevate', args: { requestId: unlock.id, typedCode } }),
    accepted: (answer) => {
      const endsAt: unknown = typeof answer.elevation === 'object' && answer.elevation !== null ? Reflect.get(answer.elevation, 'endsAt') : undefined
      const until = typeof endsAt === 'number' && !Number.isNaN(new Date(endsAt).getTime()) ? ` until ${readableTime(endsAt)}` : ''
      return `Unlocked sensitive actions on ${printable(unlock.label)}${until}. End it sooner with delorun devices elevate.\n`
    },
    unchanged: 'nothing was unlocked',
  }
}

/**
 * Decline the chosen request or end the chosen unlock.
 * @param where - the invocation.
 * @param unlock - the chosen request or unlock.
 * @returns `again`, or the exit code of a refusal.
 */
async function endUnlock(where: Where, unlock: Unlock): Promise<Outcome> {
  const { home, profile, context, dependencies } = where
  const answer = final(await dependencies.send(home, profile, { op: 'devices.elevate', args: { revokeId: unlock.id } }))
  if (answer.ok !== true) return failed(context, `nothing was ended: ${refusal(answer)}`)
  if (answer.revoked !== true) {
    context.stderr('That request or unlock had ended already.\n')
    return 'again'
  }
  context.stdout(unlock.kind === 'request' ? `Declined the request of ${printable(unlock.label)}.\n` : `Ended the unlock of ${printable(unlock.label)}.\n`)
  return 'again'
}

/**
 * A refused answer's code and sentence.
 * @param answer - the final line.
 * @returns the sentence home-auth wrote, which starts with its code, or the channel's code with its detail.
 */
function refusal(answer: ResponseLine): string {
  if ((answer.error === 'APPROVAL_FAILED' || answer.error === 'ELEVATION_FAILED') && typeof answer.detail === 'string') return answer.detail
  return `${String(answer.error)}${typeof answer.detail === 'string' ? ` (${answer.detail})` : ''}`
}

/**
 * `delorun devices remove <device id>`.
 * @param where - the invocation.
 * @param positional - the device id.
 * @returns the exit code.
 */
async function remove(where: Where, positional: readonly string[]): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  const [deviceId] = positional
  if (deviceId === undefined) throw new CliError(EXIT.usage, `delorun devices remove: name one device id from delorun devices list\n${USAGE}`)
  let sessions: number
  // A running home removes the device itself, through the home socket only the person's own command can use, so its
  // open connections close at once; a stopped home's records are changed directly.
  if (dependencies.running(home, profile)) {
    const answer = final(await dependencies.send(home, profile, { op: 'devices.remove', args: { deviceId } }))
    if (answer.ok !== true) return failed(context, `Delorun refused: ${refusal(answer)}`)
    sessions = Number(answer.sessions)
  } else {
    try {
      sessions = (await records(home).revokeDevice(brandString<DeviceId>(deviceId))).sessions
    } catch (error) {
      if (!(error instanceof HomeAuthError)) throw error
      return failed(context, error.detail)
    }
  }
  context.stdout(`Removed ${deviceId}; ${String(sessions)} session(s) ended.\n`)
  return EXIT.ok
}

/**
 * `delorun devices code`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function code(where: Where): Promise<ExitCode> {
  if (!where.dependencies.terminal) {
    where.context.stdout('An owner code is printed only to a terminal. Run delorun devices code in a terminal.\n')
    return EXIT.ok
  }
  const auth = records(where.home)
  await auth.start()
  const issued = await auth.issueOwnerCode()
  where.context.stdout(`Owner code: ${issued.code}\nIt works once, for 10 minutes, on this computer's studio.\n`)
  return EXIT.ok
}

/**
 * The final response line.
 * @param lines - the lines.
 * @returns the last one, or a failure when there is none.
 */
function final(lines: readonly ResponseLine[]): ResponseLine {
  return lines.at(-1) ?? { ok: false, error: 'NO_ANSWER' }
}

/**
 * Report that no home process runs.
 * @param context - the output.
 * @param profile - the profile.
 * @returns {@link EXIT.notRunning}.
 */
function notRunning(context: CommandContext, profile: string): ExitCode {
  context.stderr(`${notRunningText(profile)}\n`)
  return EXIT.notRunning
}

/**
 * Report a failure.
 * @param context - the output.
 * @param message - the sentence.
 * @returns {@link EXIT.failed}.
 */
function failed(context: CommandContext, message: string): ExitCode {
  context.stderr(`delorun devices: ${message}\n`)
  return EXIT.failed
}
