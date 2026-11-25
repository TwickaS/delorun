/**
 * The words of the external-agent consent: the agent's name, the delegation
 * tool's description, the approval's ask in English and Chinese, and every
 * refusal the model reads. One home for the facts the onboarding step, the
 * approval card and the guide repeat: an external agent runs as its own
 * program, outside Delorun's sandbox and approval prompts, can read and change
 * files in the workspace and wherever its own settings allow, Delorun's home
 * included, reads the workspace's own project settings under its own rules
 * rather than Delorun's MCP consent, and uses its own sign-in and account.
 *
 * @module @delorun/plugin-delegation-consent/copy
 */

/** The display names of the external providers Delorun's composition knows; any other provider is named by its id. */
const AGENT_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
}

/** The command a person allows or revokes an external agent with. */
export const CLI_COMMAND = 'delorun workspace external-agents'

/**
 * The name a person knows an external provider by.
 * @param provider - the registered provider name.
 * @returns the product name, or the provider name.
 */
export function agentName(provider: string): string {
  return AGENT_NAMES[provider] ?? provider
}

/**
 * The model-facing description of a delegation tool whose provider is external.
 * @param provider - the registered provider name.
 * @returns the opening sentences of the tool's description.
 */
export function describeAgent(provider: string): string {
  const name = agentName(provider)
  return `Delegate a self-contained task to ${name}, a separate coding agent program installed on this computer. `
    + `Use it only when the person asks for ${name} or when a second, independent agent clearly helps; do the work yourself otherwise. `
    + `${name} runs outside Delorun's sandbox and approval prompts with its own settings, and it uses the person's own ${name} sign-in and account, so every run may cost them money. `
    + `Every run waits until the person approves it at their computer, unless they allowed ${name} for this workspace; a full-access chat, where the person chose to run without prompts, starts it without asking unless they turned that off in Settings, and where no one can be asked it is refused unless allowed for the workspace. `
    + `${name} does not share this conversation's context, so the prompt must include everything it needs; it returns its final answer, not its intermediate steps.`
}

/** The facts of one ask. */
export interface AskFacts {
  /** The registered provider name. */
  readonly provider: string
  /** The chat's workspace key. */
  readonly workspace: string
  /** The canonical folder the agent runs in: the workspace or a folder inside it. */
  readonly cwd: string
  /** The task's display label. */
  readonly label: string | undefined
}

/**
 * The ask in English, which is also the audited approval reason.
 * @param facts - the provider, the workspace and the task.
 * @returns the text.
 */
export function askText(facts: AskFacts): string {
  const name = agentName(facts.provider)
  const where = facts.cwd === facts.workspace ? facts.workspace : `${facts.cwd}, inside the workspace ${facts.workspace}`
  const task = facts.label === undefined ? '' : ` Task: "${facts.label}".`
  return `Start ${name} in ${where}?${task} ${name} runs as its own program, outside Delorun's sandbox and approval prompts. `
    + `It can read and change files in this workspace and anywhere else its own settings allow, including Delorun's home folder with its keys and tokens. `
    + `It reads this workspace's own project settings, including any MCP servers the project declares, under its own rules rather than Delorun's MCP consent. `
    + `It uses your own ${name} sign-in and account, so any cost goes to that account. `
    + `Allow once starts this run only. To let ${name} start here without asking, allow it for this workspace; revoke that in Settings → Safety → External agents, or with ${CLI_COMMAND}.`
}

/**
 * The ask in Chinese.
 * @param facts - the provider, the workspace and the task.
 * @returns the text.
 */
export function askTextZh(facts: AskFacts): string {
  const name = agentName(facts.provider)
  const where = facts.cwd === facts.workspace ? facts.workspace : `${facts.cwd}（位于工作区 ${facts.workspace} 内）`
  const task = facts.label === undefined ? '' : `任务：“${facts.label}”。`
  return `要在 ${where} 中启动 ${name} 吗？${task}${name} 作为独立程序运行，不受 Delorun 的沙箱和审批提示约束。`
    + '它可以读取和修改此工作区中的文件，以及其自身设置允许的任何其他位置，包括存放密钥和令牌的 Delorun 主目录。'
    + '它会读取此工作区自己的项目设置，包括项目声明的任何 MCP 服务器，并按其自身的规则处理，而不是 Delorun 的 MCP 同意。'
    + `它使用你自己的 ${name} 登录和账户，所有费用都计入该账户。`
    + `“允许一次”只启动这一次运行。要让 ${name} 在此处无需询问即可启动，请为此工作区允许；可在“设置 → 外部智能体”中或通过 ${CLI_COMMAND} 撤销。`
}

/**
 * The refusal for a chat whose permission preset is read-only.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function readOnlyRefusal(provider: string): string {
  const name = agentName(provider)
  return `${name} was not started: this chat runs read-only, and ${name} can change files outside Delorun's sandbox, so a read-only chat never starts it. `
    + 'Tell the person; to use it, they switch this chat to a preset that allows edits, such as "workspace-write", with the permission control or /permission, and ask again.'
}

/**
 * The refusal for a chat without a workspace folder, where no folder bounds where the agent runs.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function noWorkspaceRefusal(provider: string): string {
  const name = agentName(provider)
  return `${name} was not started: this chat has no workspace folder, and ${name} starts only inside a chat's workspace. `
    + `Tell the person; to use ${name}, they open a chat in a workspace folder and ask again.`
}

/**
 * The refusal for a composition without a sandbox policy, where a read-only chat cannot be told apart.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function noSandboxPolicyRefusal(provider: string): string {
  return `${agentName(provider)} was not started: this composition has no sandbox policy, so whether this chat may change files cannot be checked. Tell the person.`
}

/**
 * The refusal for a run directory outside the chat's workspace.
 * @param provider - the registered provider name.
 * @param workspace - the chat's workspace key.
 * @param cwd - the requested run directory.
 * @returns the reason the model reads.
 */
export function outsideRefusal(provider: string, workspace: string, cwd: string): string {
  return `${agentName(provider)} was not started: it starts only inside this chat's workspace, ${workspace}, and the requested folder ${cwd} is outside it. Retry without cwd or with a folder inside the workspace.`
}

/**
 * Why an ask did not allow a start: the approval's outcome, `never` for a `rejected` answer that the chat's approval
 * policy `never` gave without asking anyone, or `no-approval` without an approval service.
 */
export type NotApprovedOutcome = 'rejected' | 'never' | 'cancelled' | 'unavailable' | 'no-approval'

/**
 * The refusal for an ask the person or the chat's policy did not grant.
 * @param provider - the registered provider name.
 * @param outcome - why the ask did not allow the start.
 * @param workspace - the chat's workspace key.
 * @returns the reason the model reads.
 */
export function notApprovedRefusal(provider: string, outcome: NotApprovedOutcome, workspace: string): string {
  const name = agentName(provider)
  const allow = ` The person can allow it for this workspace with ${CLI_COMMAND} "${workspace}" ${provider} on.`
  switch (outcome) {
    case 'rejected':
      return `${name} was not started: the person declined. Do not retry unless the person asks for ${name} again.${allow}`
    case 'never':
      return `${name} was not started: this chat's approval policy is never, which refuses every approval without asking anyone, and ${name} starts without asking only in a Full access chat while the person has "Full access chats start agents without asking" on. `
        + `So it starts here only once the person allows it for this workspace or, in a Full access chat, turns that switch on. `
        + `Tell the person: "Allow for this workspace" in Settings → Safety → External agents, or the switch "Full access chats start agents without asking" there.${allow}`
    case 'cancelled':
      return `${name} was not started: the approval was withdrawn before anyone answered.`
    case 'unavailable':
    case 'no-approval':
      return `${name} was not started: it needs the person's approval at their computer, and no one could be asked here.${allow}`
  }
}

/**
 * The refusal for a grants file that cannot be read.
 * @param provider - the registered provider name.
 * @param problem - the file's problem.
 * @returns the reason the model reads.
 */
export function storeRefusal(provider: string, problem: string): string {
  return `${agentName(provider)} was not started: Delorun's record of external-agent approvals cannot be read (${problem}), so no approval counts. Tell the person to repair or remove that file.`
}

/**
 * The refusal of a seat at hand-off when no chat has an open turn to show the approval card in.
 * @param provider - the registered provider name.
 * @param workspace - the chat's workspace key.
 * @returns the reason the model reads.
 */
export function noOpenTurnRefusal(provider: string, workspace: string): string {
  const name = agentName(provider)
  return `${name} was not started: it needs the person's approval in the chat, and the chat has no open turn to ask in. `
    + `Start ${name} from the chat, or the person allows it for this workspace in Settings or with ${CLI_COMMAND} "${workspace}" ${provider} on.`
}

/**
 * The refusal of a seat whose chat, or a chat above it, is archived.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function archivedRefusal(provider: string): string {
  return `${agentName(provider)} was not started: this chat or a chat above it is archived.`
}

/**
 * The refusal of a seat turn whose approval ended: the chat, its workspace, its folder or the agent changed, or the
 * approval was revoked.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function leaseEndedRefusal(provider: string): string {
  const name = agentName(provider)
  return `${name} was stopped: the person's approval for it in this chat has ended. Send it a new message to ask the person again.`
}
