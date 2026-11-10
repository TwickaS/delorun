/**
 * `delorun devices list | approve | remove <device id> | code` (contract C5): the devices this home trusts, managed at
 * the home's own computer.
 *
 * - `list` reads the home's records, without key material.
 * - `approve` opens the approval window through the home socket's `devices.approve` (C19), which only the person's own
 *   command may call, waits for a new device's request, shows its name, platform and time, and asks for the 8-digit
 *   code the new device shows. A wrong code may be typed again; the third cancels the request.
 * - `remove` removes a device, ending its sessions at once: through the running studio, so its open connections end
 *   too, or on the records when Delo is not running.
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
import { loopbackStudio, refusalOf, studioPort, type StudioClient } from '../reach/studio.ts'

/** What the command runs against. */
export interface DevicesDependencies {
  /** Reaches the profile's studio on its loopback port. */
  readonly studio: StudioClient
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

/**
 * Build the command over its dependencies.
 * @param dependencies - the studio client, the running check, the home socket, the prompt and the terminal check.
 * @returns the command.
 */
export function createDevicesCommand(dependencies: DevicesDependencies): CliCommand {
  return {
    name: 'devices',
    summary: 'The devices this home trusts: list, approve, remove, code',
    async run(args, context) {
      const [action, ...rest] = args
      // `remove` names its device first: `delorun devices remove <device id> [--profile <name>]`.
      const positional = action === 'remove' && rest[0] !== undefined && !rest[0].startsWith('-') ? [rest[0]] : []
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

/** `delorun devices`, over the loopback studio, the home socket and a terminal prompt. */
export const devicesCommand: CliCommand = createDevicesCommand({
  studio: loopbackStudio,
  running: homeRuns,
  send: (home, profile, request) => sendHomeRequest(home, profile, request),
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
  const approved = device.approvedBy === 'local' ? 'approved at this computer' : device.approvedBy === null ? 'claimed this home' : `approved by ${device.approvedBy}`
  const signIn = device.lastSignInAt === null ? 'never signed in' : `last signed in ${new Date(device.lastSignInAt).toISOString()}`
  return `${device.id}  ${device.label}${device.platform === '' ? '' : ` (${device.platform})`}\n    ${device.address}, ${approved} ${new Date(device.approvedAt).toISOString()}, ${signIn}`
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

/**
 * `delorun devices approve`.
 * @param where - the invocation.
 * @returns the exit code.
 */
async function approve(where: Where): Promise<ExitCode> {
  const { home, profile, context, dependencies } = where
  if (!dependencies.running(home, profile)) return failed(context, 'Delo is not running. Start it with delorun start, then run delorun devices approve again')
  context.stdout('Waiting for a new device for up to 5 minutes. Open this home\'s address on it and choose Ask for approval.\n')
  const opened = final(await dependencies.send(home, profile, { op: 'devices.approve', args: {} }))
  if (opened.ok !== true) return failed(context, `the home refused: ${String(opened.error)}${typeof opened.detail === 'string' ? ` (${opened.detail})` : ''}`)
  const pending: readonly unknown[] = Array.isArray(opened.pending) ? opened.pending : []
  const request = pending[0]
  if (typeof request !== 'object' || request === null) return failed(context, 'No device asked for approval before the window closed. Run delorun devices approve again')
  const requestId = String(Reflect.get(request, 'requestId'))
  const platform = String(Reflect.get(request, 'platform'))
  context.stdout(`A device asks for approval: ${String(Reflect.get(request, 'label'))}${platform === '' ? '' : ` (${platform})`}, at ${new Date(Number(Reflect.get(request, 'createdAt'))).toISOString()}.\n`)
  for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt += 1) {
    const typed = await dependencies.ask('Type the 8-digit code the new device shows')
    if (typed === undefined) return failed(context, 'cancelled; the device was not approved')
    const answer = final(await dependencies.send(home, profile, { op: 'devices.approve', args: { requestId, typedCode: typed } }))
    if (answer.ok === true) {
      const device: unknown = answer.device
      const label: unknown = typeof device === 'object' && device !== null ? Reflect.get(device, 'label') : undefined
      context.stdout(`Approved ${String(label)}. It signs in on its own now.\n`)
      return EXIT.ok
    }
    const detail = typeof answer.detail === 'string' ? answer.detail : String(answer.error)
    if (!detail.startsWith('APPROVAL_CODE_MISMATCH')) return failed(context, `the device was not approved: ${detail}`)
    context.stderr(`That code is not the one the device shows.${attempt < CODE_ATTEMPTS ? ' Try again.' : ''}\n`)
  }
  return failed(context, 'three wrong codes cancelled the request; ask the device again')
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
  if (dependencies.running(home, profile)) {
    const reply = await dependencies.studio(studioPort(home, profile), 'POST', '/auth/devices/remove', { v: 1, deviceId })
    if (reply.status !== 200) return failed(context, refusalOf(reply).message || refusalOf(reply).error)
    const ended: unknown = typeof reply.body === 'object' && reply.body !== null ? Reflect.get(reply.body, 'sessions') : 0
    sessions = Number(ended)
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
