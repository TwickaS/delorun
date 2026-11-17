/**
 * Experiment for the lead (not driver behaviour): does a session rule `Bash(<exact command>)` built from the call
 * itself, rather than from Claude Code's suggestion, make Claude Code skip asking for the identical command and still
 * ask for a different one, within the turn and, re-applied as `allowedTools`, after a resume? Only commands with no
 * `*`, `(`, `)`, newline, redirect or pipe are given such a rule. One command:
 *
 *   node_modules/.bin/tsx delorun/packages/agent-claude-code/live/exact-rule-experiment.ts [--fixture]
 *
 * `--fixture` runs keyless against the local Messages fixture with a scratch Claude Code home; without it the run uses
 * the person's own sign-in and settings. Never part of a Vitest lane.
 * @module @delorun/agent-claude-code/live/exact-rule-experiment
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanUseTool, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawnThroughGate } from '../src/process.ts'
import { Queue } from '../src/queue.ts'
import { loadClaudeSdk } from '../src/sdk.ts'
import { startMessagesFixture, type MessagesStep } from '../tests/messages-fixture.ts'
import { locateSdk, Log, processesIn, removeTask, runtime, taskFolder } from './common.ts'

const fixtureMode = process.argv.includes('--fixture')
const log = new Log(`claude-exact-rule${fixtureMode ? '-fixture' : ''}`)

/** Whether option C would give the call a rule: no wildcard, parenthesis, newline, redirect or pipe. */
function eligible(command: string): boolean {
  return !/[*()\n<>|]/.test(command)
}

const first = ['mkdir -p dir-a', 'mkdir -p dir-a', 'mkdir -p dir-b', 'touch x.txt && touch y.txt', 'touch x.txt && touch y.txt', 'touch x.txt && touch z.txt']
/** The calls the person answers "Allow for this run"; every other call is allowed once, with no rule. */
const allowedForRun = new Set(['mkdir -p dir-a', 'touch x.txt && touch y.txt'])
const second = ['mkdir -p dir-a', 'mkdir -p dir-b', 'touch x.txt && touch y.txt', 'touch x.txt && touch z.txt', 'mkdir -p dir-a && touch w.txt', 'mkdir -p dir-a; touch v.txt', 'touch x.txt']

function prompt(commands: readonly string[]): string {
  return `Run these shell commands exactly as written, one Bash call each, in this order, even when one repeats: ${commands.map(command => `\`${command}\``).join(', ')}. Then say done.`
}

function steps(commands: readonly string[]): MessagesStep[] {
  return [...commands.map(command => ({ tool: 'Bash', input: { command, description: 'Run it' } })), { text: 'done' }]
}

const task = taskFolder()
const rt = await runtime(task)
const scratch = fixtureMode ? mkdtempSync(join(tmpdir(), 'ea1-claude-exp-')) : undefined
const fixture = fixtureMode ? await startMessagesFixture([...steps(first), ...steps(second)]) : undefined
const sdk = await loadClaudeSdk(locateSdk())

function env(): Record<string, string | undefined> {
  if (scratch === undefined || fixture === undefined) return { ...scrubbedParentEnv() }
  const config = join(scratch, 'claude-config')
  mkdirSync(config, { recursive: true })
  mkdirSync(join(scratch, 'xdg'), { recursive: true })
  writeFileSync(join(config, 'settings.json'), `${JSON.stringify({ model: 'fixture-model', permissions: { defaultMode: 'default' } })}\n`)
  return {
    ...scrubbedParentEnv(), ANTHROPIC_API_KEY: 'ea1-fake-key', ANTHROPIC_BASE_URL: fixture.baseUrl, CLAUDE_CONFIG_DIR: config, HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, 'xdg'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    ANTHROPIC_MODEL: undefined, ANTHROPIC_SMALL_FAST_MODEL: undefined, NO_PROXY: '127.0.0.1,localhost',
  }
}

const rules: string[] = []

/** One program session with one turn; returns the commands Claude Code asked about and the commands it ran. */
async function session(phase: string, commands: readonly string[], resume?: string): Promise<string> {
  const asked: string[] = []
  const ran: string[] = []
  const canUseTool: CanUseTool = (toolName, input) => {
    const command = typeof input.command === 'string' ? input.command : ''
    asked.push(command)
    if (toolName === 'Bash' && phase === 'first' && allowedForRun.has(command) && eligible(command)) {
      const rule = `Bash(${command})`
      if (!rules.includes(rule)) rules.push(rule)
      return Promise.resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'session' }] })
    }
    return Promise.resolve({ behavior: 'allow', updatedInput: input })
  }
  const input = new Queue<SDKUserMessage>()
  input.push({ type: 'user', message: { role: 'user', content: prompt(commands) }, parent_tool_use_id: null })
  const options: Options = {
    cwd: task, env: env(), settingSources: ['user', 'project', 'local'], canUseTool, spawnClaudeCodeProcess: spawnThroughGate(rt.spawn),
    ...resume === undefined ? {} : { resume, allowedTools: [...rules] },
  }
  const stop = new AbortController()
  const query = sdk.query({ prompt: (async function * () { for (;;) yield await input.take(stop.signal) })(), options })
  let sessionId = ''
  const timer = setTimeout(() => { stop.abort() }, 240_000)
  for await (const message of query as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of message.message.content) if (block.type === 'tool_use' && block.name === 'Bash') ran.push(String((block.input as { command?: unknown }).command))
    }
    if (message.type === 'result') break
  }
  clearTimeout(timer)
  stop.abort()
  query.close()
  log.line(`${phase}: calls`, ran)
  log.line(`${phase}: asked`, asked)
  if (resume !== undefined) log.line(`${phase}: allowedTools re-applied`, rules)
  return sessionId
}

try {
  const id = await session('first', first)
  log.line('rules built from the calls', rules)
  await session('after resume', second, id)
} catch (error: unknown) {
  log.line('failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
} finally {
  await rt.dispose()
  await fixture?.close()
  log.line('processes left in the task folder', processesIn(task))
  removeTask(task)
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  log.line('log', log.path)
}
