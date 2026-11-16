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
 * An allow is not remembered: if the person later revokes it, the next refusal asks again.
 *
 * @module @delorun/plugin-permission-defaults/abstract-socket-consent
 */
import type { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider, checkAbstractSockets, refuseAbstractSockets, type AbstractSocketCheck } from '@deepseek-ai/dsh-sandbox-local'
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

/**
 * The card's text in both interface languages. Socket names come from the host and are shown with control characters
 * replaced and a bound on their length.
 * @param names - the listening abstract socket names the host lists.
 * @returns the English and Chinese text.
 */
export function abstractSocketAsk(names: readonly string[]): { readonly en: string, readonly zh: string } {
  const shown = names.slice(0, NAMES_SHOWN).map(name => JSON.stringify(`${name.replace(/[^\x20-\x7e]/g, '?').slice(0, NAME_LENGTH)}${name.length > NAME_LENGTH ? '…' : ''}`))
  const list = shown.length === 0 ? '' : ` (${shown.join(', ')}${names.length > shown.length ? `, and ${String(names.length - shown.length)} more` : ''})`
  const listZh = shown.length === 0 ? '' : `（${shown.join('、')}${names.length > shown.length ? `，另有 ${String(names.length - shown.length)} 个` : ''}）`
  return {
    en: `A command in this workspace is about to run with an open network while a program on this computer is listening on a shared socket${list}, whose names are shown as data only, such as the Docker command line or the display server. The sandbox cannot hide that socket, so a command could use it to act outside the sandbox. Allow commands to run anyway in this workspace? This applies to this workspace only, and you can change it later in Settings, Network.`,
    zh: `此工作区中的一条命令即将在开放网络下运行，而这台电脑上有程序正在共享套接字上监听${listZh}（名称仅作数据显示），例如 Docker 命令行或显示服务器。沙箱无法隐藏该套接字，命令可能借此在沙箱之外执行操作。是否允许此工作区中的命令照常运行？此选择只对这个工作区有效，之后可在“设置 → 网络”中更改。`,
  }
}

/**
 * The text of the runners' own refusal for a finding ({@link refuseAbstractSockets}), so the ask and the refusal cannot
 * disagree about what counts.
 * @param found - what the host's socket table showed.
 * @returns the refusal's message, or `undefined` when the runner would not refuse.
 */
function refusalOf(found: AbstractSocketCheck): string | undefined {
  try {
    refuseAbstractSockets(found)
    return undefined
  } catch (refusal) {
    return refusal instanceof Error ? refusal.message : String(refusal)
  }
}

/**
 * Whether the call asks for a wider sandbox mode itself (`sandbox_permissions`). Its own approval comes first and a
 * widened call is not the one the abstract-socket refusal stops.
 * @param exec - the pending call.
 * @returns true when the arguments carry a non-empty `sandbox_permissions`.
 */
function escalates(exec: ToolExecution): boolean {
  const requested = (exec.arguments as { sandbox_permissions?: unknown } | undefined)?.sandbox_permissions
  return typeof requested === 'string' && requested !== ''
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
  /**
   * The in-flight ask for each workspace key, and a decline until restart. An accepted, cancelled or failed ask leaves
   * no entry, so a later refusal (after the person revoked the acceptance) asks again.
   */
  private readonly answers = new Map<string, Promise<PreToolDecision | 'declined'>>()
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
   * The `tools/pre-execute` decision for one call. A later `tools/pre-execute` listener can still deny the call after an
   * allow here, so an accepted setting does not promise the command runs.
   * @param exec - the pending call.
   * @returns `deny` when the person allowed but the setting could not be saved; otherwise `allow`, so the runner
   *   either runs the command or refuses it with its own message.
   */
  async review(exec: ToolExecution): Promise<PreToolDecision> {
    const agent = exec.agent
    if (!this.applies || agent === undefined || !CONFINED_COMMAND_TOOLS.includes(exec.name) || escalates(exec)) return { kind: 'allow' }
    const cwd = agent.session.header.cwd ?? ''
    const workspace = workspaceKey(cwd)
    if (workspace === NO_WORKSPACE || !this.refusable(workspace, agent.session)) return { kind: 'allow' }
    const found = this.check()
    const refusal = refusalOf(found)
    if (refusal === undefined || !await this.refusedFor(refusal, agent.session)) return { kind: 'allow' }
    let asked = this.answers.get(workspace)
    if (asked === undefined) {
      const pending = this.ask(exec, workspace, found.kind === 'names' ? found.names : [])
      asked = pending
      this.answers.set(workspace, pending)
      // Only a decline is remembered; every other settled ask is forgotten, whichever caller started it.
      void pending.then((answer) => { if (answer !== 'declined' && this.answers.get(workspace) === pending) this.answers.delete(workspace) })
    }
    const answer = await asked
    return answer === 'declined' ? { kind: 'allow' } : answer
  }

  /**
   * Whether the local provider's own wrap of this call fails with the abstract-socket refusal, rather than for an
   * earlier reason (the escape-socket refusal, no usable runner). The wrap runs the runner's checks in order, so only
   * a failure with the same text as {@link refusalOf} means the abstract sockets are what would stop the call.
   * @param refusal - the text the abstract-socket refusal carries for the finding.
   * @param session - the calling chat.
   * @returns true when the abstract-socket refusal is the one the call meets.
   */
  private async refusedFor(refusal: string, session: Session): Promise<boolean> {
    const provider = this.ctx.get('sandbox')
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session })
    if (!(provider instanceof LocalSandboxProvider) || policy === undefined) return false
    const mode = policy.mode
    if (mode === 'danger-full-access') return false
    try {
      await provider.confine(['true'], { ...policy, mode })
    } catch (error) {
      return error instanceof Error && error.message === refusal
    }
    return false
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
    // Only the local provider makes the check; a remote or ssh provider never refuses for this reason.
    if (!(this.ctx.get('sandbox') instanceof LocalSandboxProvider)) return false
    return this.ctx.get('sandboxPolicy')?.resolve({ session }).mode !== 'danger-full-access'
  }

  /**
   * Put the ask to the person and record an allow.
   * @param exec - the call that met the refusal.
   * @param workspace - the workspace key.
   * @param names - the listening abstract socket names, empty when the table could not be read.
   * @returns `declined` for a decline or an approval service that cannot ask; `allow` for a cancelled ask or a saved
   *   acceptance; `deny` when the acceptance could not be saved.
   */
  private async ask(exec: ToolExecution, workspace: string, names: readonly string[]): Promise<PreToolDecision | 'declined'> {
    const approver = this.ctx.get('approval')
    if (approver === undefined || exec.agent === undefined) return 'declined'
    const text = abstractSocketAsk(names)
    let outcome: ApprovalOutcome
    try {
      // `grants: 'full-access'` is only a marker the home's authenticator reads: an answer from a remote (reach) device
      // is refused with `LOOPBACK_REQUIRED` unless that device holds an unlock, like the Network section's own routes.
      // It records nothing and grants no workspace full access; an allow only reaches `acceptAbstractSockets`.
      outcome = await approver.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason: text.en, displayReason: text, grants: 'full-access', signal: exec.signal })
    } catch (error) {
      this.ctx.logger.warn(`permission-defaults: the abstract-socket consent for ${JSON.stringify(workspace)} could not be asked: ${String(error)}`)
      return 'declined'
    }
    switch (outcome) {
      case 'allowed-once': return this.accept(workspace)
      case 'cancelled': return { kind: 'allow' }
      case 'rejected':
      case 'unavailable': return 'declined'
    }
  }

  /**
   * Record the allow. The model sees a fixed sentence; the store's error text, which can name the home, goes to the log.
   * @param workspace - the workspace key.
   * @returns `allow`, or `deny` when the setting could not be saved.
   */
  private async accept(workspace: string): Promise<PreToolDecision> {
    try {
      await this.network.acceptAbstractSockets(workspace)
    } catch (error) {
      this.ctx.logger.warn(`permission-defaults: the abstract-socket acceptance for ${JSON.stringify(workspace)} could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'deny', reason: 'You allowed commands to run in this workspace, but the setting could not be saved, so this command did not run. Details are in the operational log.' }
    }
    return { kind: 'allow' }
  }
}
