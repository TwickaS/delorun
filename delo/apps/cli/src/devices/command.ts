/**
 * `delorun devices list | approve | remove <device id> | code` (contract C5): the devices this home trusts, managed at
 * the home's own computer.
 *
 * - `list` reads the home's records, without key material.
 * - `approve` opens the approval window through the home socket's `devices.approve` (C19), which only the person's own
 *   command may call, waits for a new device's request and lists every pending request with its name, platform, time
 *   and short request id. The person chooses one to approve and types the 8-digit code its device shows, or chooses
 *   one to cancel, which frees its place when 5 are pending. A wrong code may be typed again; the third cancels that
 *   request only, and the list is shown again.
 * - `remove` removes a device, ending its sessions at once: through the home socket's `devices.remove` when Delo runs,
 *   so its open connections end too, or on the records when it does not. No command reaches a device route over HTTP.
 * - `code` prints a new owner code, only to a terminal.
 *
 * @module @delo/cli/devices/command
 */
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as clack from '@clack/prompts'
import type { DeviceId } from '@delo/contract-admission'
import { HomeAuth, HomeAuthError, type DeviceSummary } from '@delo/home-auth'
import { resolveDeloHome } from '@delo/home'
import { sendHomeRequest, type ResponseLine, type UnsignedRequest } from '@delo/home-process'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { homeRuns } from '../reach/command.ts'
import { readReachRow, signInAddress, type TailscalePrivateRow } from '../reach/row.ts'
import { printable } from '../terminal-text.ts'

/** What the command runs against. */
export interface DevicesDependencies {
  /**
   * Whether the profile's home process runs.
   * @param home - the Delo home.
   * @param profile - the CLI profile.
   * @returns true when a live process holds its lock.
   */
  readonly running: (home: string, profile: string) => boolean
  /**
   * Send one request over the home socket with the token file's token.
   * @param home - the Delo home.
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
}

/** The usage line. */
const USAGE = 'Usage: delorun devices list | approve | remove <device id> | code [--profile <name>]'

/** How many codes `approve` takes for one request, which is C5's count before the home cancels it. */
const CODE_ATTEMPTS = 3

/** How many characters of a request id `approve` shows to tell requests apart. */
const SHORT_REQUEST_ID = 8

/**
 * Build the command over its dependencies.
 * @param dependencies - the running check, the home socket, the prompt and the terminal check.
 * @returns the command.
 */
export function createDevicesCommand(dependencies: DevicesDependencies): CliCommand {
  return {
    name: 'devices',
    summary: 'The devices this home trusts: list, approve, remove, code',
    async run(args, context) {
      const [action, ...rest] = args
      // `remove` names its device first: `delorun devices remove <device id> [--profile <name>]`. A device id is base64url
      // text, which may begin with `-`, so only the profile option is read as an option there.
      const positional = action === 'remove' && rest[0] !== undefined && rest[0] !== '--profile' && !rest[0].startsWith('--profile=') ? [rest[0]] : []
      const options = rest.slice(positional.length)
      const values = parseOptions(`devices ${String(action)}`, options, { profile: { type: 'string' } })
      const profile = selectProfile(values.profile, context.env)
      const home = (await resolveDeloHome(context.env)).path
      const where = { home, profile, context, dependencies }
      switch (action) {
        case 'list': return list(where)
        case 'approve': return approve(where)
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
 * @returns the answer, or undefined when the person cancels.
 */
export async function askInTerminal(message: string): Promise<string | undefined> {
  const answer = await clack.text({ message })
  return clack.isCancel(answer) ? undefined : answer
}

/** `delorun devices`, over the home socket and a terminal prompt. */
export const devicesCommand: CliCommand = createDevicesCommand({
  running: homeRuns,
  send: sendHomeRequest,
  ask: askInTerminal,
  terminal: process.stdout.isTTY,
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
 * @param home - the Delo home.
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
  const signIn = device.lastSignInAt === null ? 'never signed in' : `last signed in ${new Date(device.lastSignInAt).toISOString()}`
  return `${printable(device.id)}  ${deviceName(device)}\n    ${printable(device.address)}, ${approved} ${new Date(device.approvedAt).toISOString()}, ${signIn}`
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
    ? 'This home trusts no device yet. Add one with delorun devices approve.\n'
    : `${devices.map(deviceLine).join('\n')}\n`)
  return EXIT.ok
}

/** A pending request as `devices.approve` lists it. */
interface PendingRequest {
  readonly requestId: string
  readonly label: string
  readonly platform: string
  readonly createdAt: number
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
  if (!dependencies.running(home, profile)) return failed(context, 'Delo is not running. Start it with delorun start, then run delorun devices approve again')
  context.stdout(`Waiting for a new device for up to 5 minutes. ${openLine(readReachRow(home, profile))}\n`)
  for (;;) {
    const opened = final(await dependencies.send(home, profile, { op: 'devices.approve', args: {} }))
    if (opened.ok !== true) return failed(context, `the home refused: ${refusal(opened)}`)
    const pending = pendingOf(opened.pending)
    if (pending === undefined) return failed(context, 'the home answered with a list of requests this command cannot read')
    if (pending.length === 0) return failed(context, 'No device asked for approval before the window closed. Run delorun devices approve again')
    context.stdout(`Devices asking for approval:\n${pending.map((request, index) => `  ${String(index + 1)}. ${pendingLine(request)}`).join('\n')}\n`)
    const choice = await choose(where, pending)
    if (choice === undefined) return failed(context, 'cancelled; no device was approved')
    const outcome = choice.action === 'approve' ? await typeCode(where, choice.request) : await cancel(where, choice.request)
    if (outcome !== 'again') return outcome
  }
}

/**
 * What the person opens on the new device: the sign-in address while the profile's remote access is on.
 * @param row - the profile's Tailscale private row.
 * @returns the sentence.
 */
function openLine(row: TailscalePrivateRow): string {
  return row.enabled && row.address !== ''
    ? `Open ${signInAddress(row.address)} on it and choose Ask for approval.`
    : 'Remote access is off for this profile, so a phone cannot reach this home yet: turn it on with delorun reach on tailscale. Then open the sign-in address it prints on the device and choose Ask for approval.'
}

/**
 * One pending request as a line.
 * @param request - the request.
 * @returns its label, platform, time and short id.
 */
function pendingLine(request: PendingRequest): string {
  return `${deviceName(request)}, asked at ${new Date(request.createdAt).toISOString()}, request ${printable(request.requestId.slice(0, SHORT_REQUEST_ID))}`
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
    requests.push({ requestId, label, platform, createdAt })
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

/**
 * Approve the chosen request with the code its device shows.
 * @param where - the invocation.
 * @param request - the chosen request.
 * @returns the exit code, or `again` when the request ended before it was approved.
 */
async function typeCode(where: Where, request: PendingRequest): Promise<Outcome> {
  const { home, profile, context, dependencies } = where
  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    const typed = await dependencies.ask(`Type the 8-digit code ${printable(request.label)} shows`)
    if (typed === undefined) return failed(context, 'cancelled; no device was approved')
    const answer = final(await dependencies.send(home, profile, { op: 'devices.approve', args: { requestId: request.requestId, typedCode: typed } }))
    if (answer.ok === true) {
      context.stdout(`Approved ${printable(request.label)}. It signs in on its own now.\n`)
      return EXIT.ok
    }
    const detail = refusal(answer)
    if (detail.startsWith('APPROVAL_EXPIRED')) return noLongerWaiting(context)
    if (!detail.startsWith('APPROVAL_CODE_MISMATCH')) return failed(context, `the device was not approved: ${detail}`)
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

/**
 * A refused answer's code and sentence.
 * @param answer - the final line.
 * @returns the sentence home-auth wrote, which starts with its code, or the channel's code with its detail.
 */
function refusal(answer: ResponseLine): string {
  if (answer.error === 'APPROVAL_FAILED' && typeof answer.detail === 'string') return answer.detail
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
    if (answer.ok !== true) return failed(context, `the home refused: ${refusal(answer)}`)
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
 * Report a failure.
 * @param context - the output.
 * @param message - the sentence.
 * @returns {@link EXIT.failed}.
 */
function failed(context: CommandContext, message: string): ExitCode {
  context.stderr(`delorun devices: ${message}\n`)
  return EXIT.failed
}
