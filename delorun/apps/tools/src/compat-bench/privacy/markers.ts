/**
 * Turning what a run observed into the eight privacy markers (A587). Each marker says, in plain English, what was seen
 * in this test ("sent your chat to api.example.com in this test"); it never says what a plugin could or may do (L141).
 * Declared access (`dsh.access`) turns a seen marker into `declared`; a seen marker without a declaration is a finding.
 *
 * @module @delorun/tools/compat-bench/privacy/markers
 */
import { posix } from 'node:path'
import { DEFAULT_LAYOUT } from './canaries.ts'
import type { CanaryLayout } from './canaries.ts'
import { MARKER_KEYS, MARKER_TITLES } from './types.ts'
import type { MarkerKey, Observed, PrivacyReport, RawMarker } from './types.ts'

/** Environment names that point at a model provider's key. */
const MODEL_KEY_NAME = /^(DEEPSEEK|ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE_API|MOONSHOT|KIMI|GROQ|OPENROUTER|MISTRAL|XAI|DASHSCOPE|QWEN|ZHIPU|BIGMODEL|TOGETHER|FIREWORKS|COHERE)[A-Z0-9_]*(KEY|TOKEN|SECRET)$|^(LLM|MODEL|API)_?(API_)?KEY$/
/** Environment names that look like other secrets. */
const OTHER_SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|SESSION_KEY)|^(AWS_|GH_|GITHUB_|GITLAB_|NPM_|SSH_AUTH_SOCK|KUBECONFIG|DOCKER_|GOOGLE_APPLICATION_CREDENTIALS)/

/** Paths whose changes are Delorun's or the system's own noise, not a plugin's footprint. */
const IGNORED_CHANGE_PREFIXES: ReadonlyArray<string> = ['/tmp', '/var/tmp', '/proc', '/sys', '/dev', '/run', '/out', '/var/cache', '/var/log']

/**
 * Join items into one plain phrase, naming the first few and counting the rest.
 * @param items - strings to name.
 * @param max - how many to name before "and N more".
 * @returns the items as one plain phrase.
 */
export function phrase(items: ReadonlyArray<string>, max = 3): string {
  const shown = items.slice(0, max)
  const more = items.length - shown.length
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? ''
  return more > 0 ? `${shown.join(', ')} and ${more} more` : head
}

/**
 * Tell this machine's own addresses from other machines'.
 * @param host - a host or address as seen in a connect.
 * @returns whether it is this machine: a loopback address, `localhost` or a socket file.
 */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::' || host.startsWith('/') || /^127\./.test(host) || host.startsWith('::ffff:127.')
}

/**
 * @param host - a listen address.
 * @returns whether a listener there is reachable from outside this machine's loopback interface.
 */
function listensBeyondLoopback(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || !isLoopback(host)
}

/**
 * Make a path comparable with the baseline's.
 * @param path - a file path in the container.
 * @returns the path with each run of hex digits or digits of four or more characters replaced by `*`, so a path with a random id compares equal to the baseline's.
 */
export function normalisePath(path: string): string {
  return path.replace(/[0-9a-f]{8,}|\d{4,}/gi, '*')
}

/**
 * Show a host, with its port when it is not the usual 443.
 * @param connect - a connect.
 * @returns the text.
 */
function hostText(connect: { host: string; port: string; name?: string }): string {
  const name = connect.name ?? connect.host
  return connect.port === '' || connect.port === '443' ? name : `${name}:${connect.port}`
}

/** What every marker's builder needs. */
type Input = Readonly<{ observed: Observed; layout: CanaryLayout }>

/**
 * @param input - the run's observations.
 * @param canary - a canary's name.
 * @returns the non-local hosts the proxy saw carrying that canary.
 */
function leakedTo(input: Input, canary: string): ReadonlyArray<string> {
  return input.observed.proxy.filter(host => host.canaries.includes(canary)).map(host => `${host.host}${host.port === '' || host.port === '443' ? '' : `:${host.port}`}`)
}

/**
 * @param input - the run's observations.
 * @returns the hosts whose contents could not be read.
 */
function unreadableHosts(input: Input): ReadonlyArray<string> {
  return input.observed.proxy.filter(host => host.pinned).map(host => host.host)
}

/**
 * Finish a content marker: when nothing was seen but some traffic could not be read, the marker is not checked.
 * @param input - the run's observations.
 * @param seenLines - what was seen, as plain sentences.
 * @param evidence - the evidence lines.
 * @param quiet - what to say when nothing was seen.
 * @returns the marker.
 */
function contentMarker(input: Input, seenLines: ReadonlyArray<string>, evidence: ReadonlyArray<string>, quiet: string): RawMarker {
  if (seenLines.length > 0) return { seen: true, summary: `${seenLines.join(' ')}`, evidence }
  const unreadable = unreadableHosts(input)
  if (unreadable.length > 0 || (!input.observed.contentsChecked && input.observed.connects.length > 0)) {
    const where = unreadable.length > 0 ? ` to ${phrase(unreadable)}` : ''
    return { seen: false, notChecked: true, summary: `${quiet} The contents of what it sent out${where} could not be read in this test, so this is not checked.`, evidence: unreadable.map(host => `contents not checked: ${host}`) }
  }
  return { seen: false, summary: quiet, evidence: [] }
}

/** @param input - the run's observations. @returns the "Your code" marker. */
function codeMarker(input: Input): RawMarker {
  const { observed, layout } = input
  const lines: string[] = []
  const evidence: string[] = []
  const workspaceOpens = observed.opens.filter(open => open.label === 'workspace marker file')
  if (workspaceOpens.length > 0) {
    lines.push('Opened a file in your workspace that the test planted.')
    evidence.push(...workspaceOpens.map(open => `opened ${open.path}`))
  }
  const changed = observed.fileChanges.filter(change => change.path.startsWith(`${layout.workspace}/`) && !IGNORED_CHANGE_PREFIXES.some(prefix => change.path.startsWith(prefix)))
  if (changed.length > 0) {
    lines.push(`Changed ${changed.length} ${changed.length === 1 ? 'file' : 'files'} in your workspace (${phrase(changed.map(change => posix.relative(layout.workspace, change.path)))}).`)
    evidence.push(...changed.map(change => `${change.kind === 'A' ? 'added' : change.kind === 'D' ? 'deleted' : 'changed'} ${change.path}`))
  }
  for (const host of leakedTo(input, 'workspace marker file')) {
    lines.push(`Sent the contents of a file in your workspace to ${host} in this test.`)
    evidence.push(`workspace marker file found in a request to ${host}`)
  }
  return contentMarker(input, lines, evidence, 'Did not open or change your workspace files in this test.')
}

/** @param input - the run's observations. @returns the "Your chats" marker. */
function chatsMarker(input: Input): RawMarker {
  const lines: string[] = []
  const evidence: string[] = []
  for (const host of leakedTo(input, 'chat word')) {
    lines.push(`Sent your chat to ${host} in this test.`)
    evidence.push(`the test chat's marker word found in a request to ${host}`)
  }
  const kept = input.observed.leftCanaries.filter(left => left.canary === 'chat word')
  if (kept.length > 0) {
    lines.push(`Kept a copy of your chat in ${phrase(kept.map(left => left.path))} after it was removed.`)
    evidence.push(...kept.map(left => `chat marker word found in ${left.path} after uninstall`))
  }
  return contentMarker(input, lines, evidence, 'Did not send your chat anywhere or keep a copy of it in this test.')
}

/** @param input - the run's observations. @returns the "Model keys" marker. */
function modelKeysMarker(input: Input): RawMarker {
  const { observed } = input
  const lines: string[] = []
  const evidence: string[] = []
  for (const host of leakedTo(input, 'model key')) {
    lines.push(`Sent your model key to ${host} in this test.`)
    evidence.push(`the fake model key found in a request to ${host}`)
  }
  const opened = observed.opens.filter(open => open.label === 'Delorun key store' || open.label === 'Delorun home secrets')
  if (opened.length > 0) {
    lines.push('Opened the place Delorun keeps your model key.')
    evidence.push(...opened.map(open => `opened ${open.path}`))
  }
  const names = observed.envNames.filter(name => MODEL_KEY_NAME.test(name))
  if (names.length > 0) {
    lines.push(`Looked up ${phrase(names)} in its environment.`)
    evidence.push(...names.map(name => `read environment name ${name}`))
  }
  const kept = observed.leftCanaries.filter(left => left.canary === 'model key')
  if (kept.length > 0) {
    lines.push(`Kept a copy of your model key in ${phrase(kept.map(left => left.path))} after it was removed.`)
    evidence.push(...kept.map(left => `model key found in ${left.path} after uninstall`))
  }
  return contentMarker(input, lines, evidence, 'Did not touch your model key in this test.')
}

/** @param input - the run's observations. @returns the "Other secrets" marker. */
function otherSecretsMarker(input: Input): RawMarker {
  const { observed } = input
  const lines: string[] = []
  const evidence: string[] = []
  const labels = [...new Set(observed.opens.filter(open => open.label !== 'workspace marker file' && open.label !== 'Delorun key store' && open.label !== 'Delorun home secrets').map(open => open.label))]
  if (labels.length > 0) {
    lines.push(`Opened ${phrase(labels)} in this test.`)
    evidence.push(...observed.opens.filter(open => labels.includes(open.label)).map(open => `opened ${open.path}`))
  }
  const secretNames = observed.proxy.flatMap(host => host.canaries.filter(name => name !== 'chat word' && name !== 'model key' && name !== 'workspace marker file').map(name => ({ name, host: host.host })))
  for (const { name, host } of secretNames) {
    lines.push(`Sent the contents of ${name} to ${host} in this test.`)
    evidence.push(`${name} found in a request to ${host}`)
  }
  const names = observed.envNames.filter(name => OTHER_SECRET_NAME.test(name) && !MODEL_KEY_NAME.test(name))
  if (names.length > 0) {
    lines.push(`Looked up ${phrase(names)} in its environment.`)
    evidence.push(...names.map(name => `read environment name ${name}`))
  }
  if (observed.envEnumerated) {
    lines.push('Listed all the names in its environment.')
    evidence.push('listed the whole environment')
  }
  const kept = observed.leftCanaries.filter(left => !['chat word', 'model key', 'workspace marker file'].includes(left.canary))
  if (kept.length > 0) {
    lines.push(`Kept a copy of ${phrase([...new Set(kept.map(left => left.canary))])} after it was removed.`)
    evidence.push(...kept.map(left => `${left.canary} found in ${left.path} after uninstall`))
  }
  return contentMarker(input, lines, evidence, 'Did not open credential files or look for other secrets in this test.')
}

/** @param input - the run's observations. @returns the "Sends out" marker. */
function sendsOutMarker(input: Input): RawMarker {
  const outside = input.observed.connects.filter(connect => !isLoopback(connect.host))
  if (outside.length === 0) return { seen: false, summary: 'Did not connect to anything outside this machine in this test.', evidence: [] }
  const names = [...new Set(outside.map(hostText))]
  return {
    seen: true,
    summary: `Connected to ${phrase(names)} in this test.`,
    evidence: [...new Set(outside.map(connect => `connect ${connect.name === undefined ? connect.host : `${connect.name} (${connect.host})`}:${connect.port}`))],
  }
}

/** @param input - the run's observations. @returns the "Acts for you" marker. */
function actsForYouMarker(input: Input): RawMarker {
  const { observed } = input
  const lines: string[] = []
  const evidence: string[] = []
  if (observed.execs.length > 0) {
    const programs = [...new Set(observed.execs.map(exec => posix.basename(exec.split(' ')[0] ?? exec)))]
    lines.push(`Started ${phrase(programs)} on your machine in this test.`)
    evidence.push(...observed.execs.map(exec => `started ${exec}`))
  }
  if (observed.requestChanges.length > 0) {
    lines.push('Changed what Delorun sent to the model in this test.')
    evidence.push(...observed.requestChanges.map(change => `model request: ${change}`))
  }
  if (lines.length === 0) return { seen: false, summary: 'Did not start programs or change what the model is sent in this test.', evidence: [] }
  return { seen: true, summary: lines.join(' '), evidence }
}

/** @param input - the run's observations. @returns the "Opens a door" marker. */
function opensADoorMarker(input: Input): RawMarker {
  const { listens } = input.observed
  if (listens.length === 0) return { seen: false, summary: 'Did not start listening for connections in this test.', evidence: [] }
  const reachable = listens.filter(listen => listensBeyondLoopback(listen.host))
  const here = listens.filter(listen => !listensBeyondLoopback(listen.host))
  const lines: string[] = []
  if (reachable.length > 0) lines.push(`Started listening on ${phrase(reachable.map(listen => listen.port === '' ? listen.host : `${listen.host === '0.0.0.0' || listen.host === '::' ? 'all addresses' : listen.host}, port ${listen.port}`))}, where other machines can connect, in this test.`)
  if (here.length > 0) lines.push(`Started listening on ${phrase(here.map(listen => listen.port === '' ? listen.host : `${listen.host}:${listen.port}`))}, on this machine only, in this test.`)
  return { seen: true, summary: lines.join(' '), evidence: listens.map(listen => `listen ${listen.host}${listen.port === '' ? '' : `:${listen.port}`}`) }
}

/** @param input - the run's observations. @returns the "Leaves behind" marker. */
function leavesBehindMarker(input: Input): RawMarker {
  const { observed } = input
  const left = observed.fileChanges.filter(change => change.kind !== 'D' && !IGNORED_CHANGE_PREFIXES.some(prefix => change.path === prefix || change.path.startsWith(`${prefix}/`)) && !change.path.startsWith(`${input.layout.workspace}/`))
  const copies = observed.leftCanaries
  if (left.length === 0 && copies.length === 0) return { seen: false, summary: 'Left nothing new behind after it was removed in this test.', evidence: [] }
  const lines: string[] = []
  const evidence: string[] = []
  if (left.length > 0) {
    lines.push(`Left ${left.length} ${left.length === 1 ? 'file' : 'files'} behind after it was removed (${phrase(left.map(change => change.path))}).`)
    evidence.push(...left.map(change => `${change.kind === 'A' ? 'added' : 'changed'} ${change.path} (still there after uninstall)`))
  }
  if (copies.length > 0) {
    lines.push(`Kept copies of ${phrase([...new Set(copies.map(copy => copy.canary))])} after it was removed.`)
    evidence.push(...copies.map(copy => `${copy.canary} found in ${copy.path} after uninstall`))
  }
  return { seen: true, summary: lines.join(' '), evidence }
}

const BUILDERS: Readonly<Record<MarkerKey, (input: Input) => RawMarker>> = {
  code: codeMarker,
  chats: chatsMarker,
  modelKeys: modelKeysMarker,
  otherSecrets: otherSecretsMarker,
  sendsOut: sendsOutMarker,
  actsForYou: actsForYouMarker,
  opensADoor: opensADoorMarker,
  leavesBehind: leavesBehindMarker,
}

/**
 * Turn observations into the privacy section.
 * @param observed - what the run saw, baseline already subtracted.
 * @param declared - the author's `dsh.access` reasons.
 * @param layout - where the canaries were planted.
 * @returns the section, with findings for what was seen and not declared.
 */
export function buildPrivacy(observed: Observed, declared: Readonly<Partial<Record<MarkerKey, string>>>, layout: CanaryLayout = DEFAULT_LAYOUT): PrivacyReport {
  const input: Input = { observed, layout }
  const findings: string[] = []
  const entries = MARKER_KEYS.map((key) => {
    const raw = BUILDERS[key](input)
    const reason = declared[key]
    const state = reason !== undefined ? 'declared' : raw.seen ? 'seen' : raw.notChecked === true ? 'not-checked' : 'not-seen'
    const summary = reason === undefined
      ? raw.summary
      : raw.seen ? `${raw.summary} The author declared this: ${reason}` : `The author declared: ${reason} ${raw.summary}`
    if (raw.seen && reason === undefined) findings.push(`${MARKER_TITLES[key]}: seen and not declared in dsh.access. ${raw.summary}`)
    const evidence = raw.seen && reason === undefined ? ['finding: seen and not declared in dsh.access', ...raw.evidence] : raw.evidence
    return [key, { state, summary, evidence }] as const
  })
  return {
    markers: Object.fromEntries(entries) as PrivacyReport['markers'],
    contentsChecked: observed.contentsChecked && unreadableHosts(input).length === 0,
    ...findings.length > 0 ? { findings } : {},
    ...Object.keys(declared).length > 0 ? { declared } : {},
  }
}
