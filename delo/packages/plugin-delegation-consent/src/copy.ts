/**
 * The words of the external-agent consent: the agent's name, the delegation
 * tool's description, the approval's ask in English and Chinese, and every
 * refusal the model reads. One home for the facts the onboarding step, the
 * approval card and the guide repeat: an external agent runs as its own
 * program, outside Delo's sandbox and approval prompts, can read and change
 * files in the workspace and wherever its own settings allow, Delo's home
 * included, and uses its own sign-in and account.
 *
 * @module @delo/plugin-delegation-consent/copy
 */

/** The display names of the external providers Delo's composition knows; any other provider is named by its id. */
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
    + `${name} runs outside Delo's sandbox and approval prompts with its own settings, and it uses the person's own ${name} sign-in and account, so every run may cost them money. `
    + 'The first run in a workspace waits until the person approves it at their computer. '
    + `${name} does not share this conversation's context, so the prompt must include everything it needs; it returns its final answer, not its intermediate steps.`
}

/** The facts of one ask. */
export interface AskFacts {
  /** The registered provider name. */
  readonly provider: string
  /** The chat's workspace key, or empty for a chat without a folder. */
  readonly workspace: string
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
  const where = facts.workspace === '' ? 'this chat\'s folder' : facts.workspace
  const task = facts.label === undefined ? '' : ` Task: "${facts.label}".`
  return `Start ${name} in ${where}?${task} ${name} runs as its own program, outside Delo's sandbox and approval prompts. `
    + `It can read and change files in this workspace and anywhere else its own settings allow, including Delo's home folder with its keys and tokens. `
    + `It uses your own ${name} sign-in and account, so any cost goes to that account. `
    + `Allow once starts this run only. To let ${name} start here without asking, allow it for this workspace; revoke that in Settings, Permissions, or with ${CLI_COMMAND}.`
}

/**
 * The ask in Chinese.
 * @param facts - the provider, the workspace and the task.
 * @returns the text.
 */
export function askTextZh(facts: AskFacts): string {
  const name = agentName(facts.provider)
  const where = facts.workspace === '' ? '此对话的文件夹' : facts.workspace
  const task = facts.label === undefined ? '' : `任务：“${facts.label}”。`
  return `要在 ${where} 中启动 ${name} 吗？${task}${name} 作为独立程序运行，不受 Delo 的沙箱和审批提示约束。`
    + '它可以读取和修改此工作区中的文件，以及其自身设置允许的任何其他位置，包括存放密钥和令牌的 Delo 主目录。'
    + `它使用你自己的 ${name} 登录和账户，所有费用都计入该账户。`
    + `“允许一次”只启动这一次运行。要让 ${name} 在此处无需询问即可启动，请为此工作区允许；可在“设置 → 权限”中或通过 ${CLI_COMMAND} 撤销。`
}

/**
 * The refusal for a chat whose permission preset is read-only.
 * @param provider - the registered provider name.
 * @returns the reason the model reads.
 */
export function readOnlyRefusal(provider: string): string {
  const name = agentName(provider)
  return `${name} was not started: this chat runs read-only, and ${name} can change files outside Delo's sandbox, so a read-only chat never starts it. `
    + 'Tell the person; to use it, they switch this chat to a preset that allows edits, such as "workspace-write", with the permission control or /permission, and ask again.'
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
 * The refusal for an ask the person or the chat's policy did not grant.
 * @param provider - the registered provider name.
 * @param outcome - the approval's outcome.
 * @param workspace - the chat's workspace key, or empty.
 * @returns the reason the model reads.
 */
export function notApprovedRefusal(provider: string, outcome: 'rejected' | 'cancelled' | 'unavailable' | 'no-approval', workspace: string): string {
  const name = agentName(provider)
  const allow = workspace === ''
    ? ''
    : ` The person can also allow it for this workspace with ${CLI_COMMAND} "${workspace}" ${provider} on.`
  switch (outcome) {
    case 'rejected':
      return `${name} was not started: the person declined, or this chat does not ask for approvals (full access or Auto). Do not retry unless the person asks for ${name} again.${allow}`
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
  return `${agentName(provider)} was not started: Delo's record of external-agent approvals cannot be read (${problem}), so no approval counts. Tell the person to repair or remove that file.`
}
