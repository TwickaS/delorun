/**
 * The first-refusal consent for the abstract-socket risk. When a workspace's network is `open`, the setting does not
 * accept that risk, the calling chat runs a sandboxed command tool, and the host lists a listening abstract Unix socket
 * (`docker` CLI processes listen on `@docker_cli_<hash>`), the local runners refuse the command. This module asks the
 * person before the command starts, through the composed approval service, the same ask the full-access consent uses:
 * the card is answered at the person's computer, the ask and its outcome are logged as `approval/asked` and
 * `approval/decided`, and the model has no tool that answers it. An allow records the same acceptance as the Network
 * settings section ({@link CommandNetwork.acceptAbstractSockets}) and the command then runs as the one the model sent,
 * because the ask comes before the wrap that would refuse it. A decline, or an approval service that cannot ask
 * (`delorun headless`), leaves the runner's refusal as it is, and the workspace is not asked again until Delorun restarts.
 *
 * @module @delorun/plugin-permission-defaults/abstract-socket-consent
 */
import type { Context } from '@deepseek-ai/cordis'
import { checkAbstractSockets, type AbstractSocketCheck } from '@deepseek-ai/dsh-sandbox-local/src/abstract-sockets.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { CommandNetwork } from './command-network.ts'
import { NO_WORKSPACE, workspaceKey } from './workspace.ts'

/** The tools whose commands the local runners confine on the host's network. */
export const CONFINED_COMMAND_TOOLS: readonly string[] = ['bash', 'pwsh']

/** The most socket names the card lists. */
const NAMES_SHOWN = 3

/** The longest socket name the card shows, in characters. */
const NAME_LENGTH = 60

/** What the person's answer to one workspace's ask came to. */
type Answer = 'accepted' | 'declined' | 'cancelled'

/**
 * The card's text in both interface languages. Socket names come from the host and are shown with control characters
 * replaced and a bound on their length.
 * @param names - the listening abstract socket names the host lists.
 * @returns the English and Chinese text.
 */
export function abstractSocketAsk(names: readonly string[]): { readonly en: string, readonly zh: string } {
  const shown = names.slice(0, NAMES_SHOWN).map(name => name.replace(/[^\x20-\x7e]/g, '?').slice(0, NAME_LENGTH))
  const list = shown.length === 0 ? '' : ` (${shown.join(', ')}${names.length > shown.length ? `, and ${String(names.length - shown.length)} more` : ''})`
  const listZh = shown.length === 0 ? '' : `（${shown.join('、')}${names.length > shown.length ? `，另有 ${String(names.length - shown.length)} 个` : ''}）`
  return {
    en: `A command in this workspace is about to run with an open network while a program on this computer is listening on a shared socket${list}, such as the Docker command line or the display server. The sandbox cannot hide that socket, so a command could use it to act outside the sandbox. Allow commands to run anyway in this workspace? This applies to this workspace only, and you can change it later in Settings, Network.`,
    zh: `此工作区中的一条命令即将在开放网络下运行，而这台电脑上有程序正在共享套接字上监听${listZh}，例如 Docker 命令行或显示服务器。沙箱无法隐藏该套接字，命令可能借此在沙箱之外执行操作。是否允许此工作区中的命令照常运行？此选择只对这个工作区有效，之后可在“设置 → 网络”中更改。`,
  }
}

/** What {@link AbstractSocketConsent} reads from its surroundings, replaceable in a test. */
export interface AbstractSocketConsentOptions {
  /** Reads the host's listening abstract sockets; the kernel table by default. */
  readonly check?: () => AbstractSocketCheck
  /** Whether the host's runners make the check; true on Linux only. */
  readonly applies?: boolean
}

/** The pre-execute review that asks once per workspace before a command the abstract-socket check would refuse. */
export class AbstractSocketConsent {
  /** The in-flight or final answer for each workspace key. */
  private readonly answers = new Map<string, Promise<Answer>>()
  /** Reads the host's listening abstract sockets. */
  private readonly check: () => AbstractSocketCheck
  /** Whether the host's runners make the check. */
  private readonly applies: boolean

  /**
   * @param ctx - the context whose approval service carries the ask and whose sandbox policy names the chat's mode.
   * @param network - the service whose setting the acceptance changes.
   * @param options - replaceable reads for a test.
   */
  constructor(private readonly ctx: Context, private readonly network: CommandNetwork, options: AbstractSocketConsentOptions = {}) {
    this.check = options.check ?? (() => checkAbstractSockets())
    this.applies = options.applies ?? process.platform === 'linux'
  }

  /**
   * The `tools/pre-execute` decision for one call.
   * @param exec - the pending call.
   * @returns `deny` when the person allowed but the setting could not be saved; otherwise `allow`, so the runner
   *   either runs the command or refuses it with its own message.
   */
  async review(exec: ToolExecution): Promise<PreToolDecision> {
    const agent = exec.agent
    if (!this.applies || agent === undefined || !CONFINED_COMMAND_TOOLS.includes(exec.name)) return { kind: 'allow' }
    const cwd = agent.session.header.cwd ?? ''
    const workspace = workspaceKey(cwd)
    if (workspace === NO_WORKSPACE || !this.refusable(workspace, agent.session)) return { kind: 'allow' }
    const found = this.check()
    if (found.kind === 'names' && found.names.length === 0) return { kind: 'allow' }
    let asked = this.answers.get(workspace)
    if (asked === undefined) {
      const names = found.kind === 'names' ? found.names : []
      asked = this.ask(exec, workspace, names)
      this.answers.set(workspace, asked)
    }
    const answer = await asked
    if (answer === 'cancelled') this.answers.delete(workspace)
    if (answer !== 'accepted') return { kind: 'allow' }
    try {
      await this.network.acceptAbstractSockets(workspace)
    } catch (error) {
      this.answers.delete(workspace)
      return { kind: 'deny', reason: `You allowed commands to run in this workspace, but the setting could not be saved, so this command did not run: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { kind: 'allow' }
  }

  /**
   * Whether the runners would refuse for the setting: the workspace network is open without the acceptance, and the
   * chat's commands are confined at all.
   * @param workspace - the workspace key.
   * @param session - the calling chat.
   * @returns true when the setting alone leaves the command refusable.
   */
  private refusable(workspace: string, session: Session): boolean {
    const network = this.network.networkOf(workspace)
    if (network.access !== 'open' || network.acceptAbstractSockets === true) return false
    return this.ctx.get('sandboxPolicy')?.resolve({ session }).mode !== 'danger-full-access'
  }

  /**
   * Put the ask to the person and record an allow.
   * @param exec - the call that met the refusal.
   * @param workspace - the workspace key.
   * @param names - the listening abstract socket names, empty when the table could not be read.
   * @returns the person's answer; an approval service that cannot ask reads as a decline.
   */
  private async ask(exec: ToolExecution, workspace: string, names: readonly string[]): Promise<Answer> {
    const approver = this.ctx.get('approval')
    if (approver === undefined || exec.agent === undefined) return 'declined'
    const text = abstractSocketAsk(names)
    let outcome: ApprovalOutcome
    try {
      // `full-access` keeps the answer at the home's own computer, like the Network section that records the same acceptance.
      outcome = await approver.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: text.en, displayReason: text, grants: 'full-access', signal: exec.signal })
    } catch (error) {
      this.ctx.logger.warn(`permission-defaults: the abstract-socket consent for ${JSON.stringify(workspace)} could not be asked: ${String(error)}`)
      return 'declined'
    }
    switch (outcome) {
      case 'allowed-once': return 'accepted'
      case 'cancelled': return 'cancelled'
      case 'rejected':
      case 'unavailable': return 'declined'
    }
  }
}
