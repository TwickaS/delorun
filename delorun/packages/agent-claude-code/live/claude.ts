/**
 * Live Claude Code runs through the driver, under the person's own sign-in and settings, each in a throwaway task
 * folder. One command each:
 *
 *   node_modules/.bin/tsx delorun/packages/agent-claude-code/live/claude.ts <task|steer|interrupt|resume|questions|limits|hostkill|settings>
 *
 * Logs are redacted and kept under `~/delorun-rc-release/ea1-claude-logs/`. Never part of a Vitest lane.
 * @module @delorun/agent-claude-code/live/claude
 */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramOpenRequest, ProgramRunRule, ProgramSession, SessionId } from '@delorun/external-agents/contract'
import { driver, Log, processesIn, readTurn, REPO, removeTask, runtime, taskFolder, textOf, type Runtime } from './common.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function request(rt: Runtime, task: string, log: Log, extra: Partial<ProgramOpenRequest> = {}): ProgramOpenRequest {
  return {
    sessionId: 'live' as SessionId, cwd: task, level: 'standard', runRules: [], harnessTools: [], sharesFolder: () => false, spawn: rt.spawn,
    onApproval: (question) => {
      log.line('question (answered allow-once)', `${question.toolName}: ${question.reason}`)
      return Promise.resolve('allow-once')
    },
    onLimits: (observation) => { log.line('limits', observation) },
    signal: new AbortController().signal,
    ...extra,
  }
}

/** Run one experiment in a fresh task folder and runtime, logging the outcome and what is left running. */
async function inTask(name: string, body: (rt: Runtime, task: string, log: Log) => Promise<void>): Promise<void> {
  const log = new Log(`claude-${name}`)
  const task = taskFolder()
  const rt = await runtime(task)
  try {
    await body(rt, task, log)
  } catch (error: unknown) {
    log.line('failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    process.exitCode = 1
  } finally {
    await rt.dispose()
    log.line('processes left in the task folder', processesIn(task))
    removeTask(task)
    log.line('log', log.path)
  }
}

/** A tiny task: read a file and answer. */
const task = (): Promise<void> => inTask('task', async (rt, folder, log) => {
  const session = await driver().open(request(rt, folder, log))
  await session.send('What colour is written in notes.txt? Answer with the one word.', 'start')
  log.line('answer', textOf(await readTurn(session, log)))
  await session.close()
  log.line('processes after close', processesIn(folder))
})

/** A steer while a command runs: the program takes it inside the same turn. */
const steer = (): Promise<void> => inTask('steer', async (rt, folder, log) => {
  const session = await driver().open(request(rt, folder, log))
  await session.send('Run this shell command exactly, in the foreground: sleep 8 && echo slept. Then reply with what it printed.', 'start')
  const events = await readTurn(session, log, async (event) => {
    if (event.kind !== 'tool-call') return
    await sleep(3000)
    await session.send('Also end your reply with the word banana.', 'steer')
    log.line('steer sent', 'priority next')
  })
  log.line('turn ends seen', events.filter(event => event.kind === 'turn-end').length)
  log.line('answer', textOf(events))
  await session.close()
})

/** An interrupt during a command, then a second turn on the same process. */
const interrupt = (): Promise<void> => inTask('interrupt', async (rt, folder, log) => {
  const session = await driver().open(request(rt, folder, log))
  await session.send('Run this shell command exactly, in the foreground: python3 -c "import time; time.sleep(30)" && echo late > late.txt. Then say done.', 'start')
  await readTurn(session, log, async (event) => {
    if (event.kind !== 'tool-call') return
    await sleep(3000)
    await session.interrupt()
    log.line('interrupt sent', '')
  })
  await session.send('Reply with the single word: ready.', 'start')
  log.line('second turn', textOf(await readTurn(session, log)))
  await session.close()
  log.line('late.txt after the interrupt', existsSync(join(folder, 'late.txt')))
})

/** Close the process, then resume the program session in a new one. */
const resume = (): Promise<void> => inTask('resume', async (rt, folder, log) => {
  const first = await driver().open(request(rt, folder, log))
  await first.send('Remember the word kiwi. Reply with: noted.', 'start')
  log.line('first answer', textOf(await readTurn(first, log)))
  await first.close()
  const started = Date.now()
  const again = await driver().open(request(rt, folder, log, { resume: first.programSessionId }))
  await again.send('Which word did I ask you to remember? One word.', 'start')
  const events = await readTurn(again, log)
  log.line('resumed answer', { answer: textOf(events), sameSession: again.programSessionId === first.programSessionId, msToTurnEnd: Date.now() - started })
  await again.close()
})

/** One question with each answer, then "Allow for this run" re-applied after a resume. */
const questions = (): Promise<void> => inTask('questions', async (rt, folder, log) => {
  const answers: ProgramApprovalAnswer[] = []
  let runRule: ProgramRunRule | undefined
  const onApproval = (question: ProgramApprovalRequest): Promise<ProgramApprovalAnswer> => {
    const answer = answers.shift() ?? 'reject'
    if (answer === 'allow-run' && question.runRule !== undefined) runRule = question.runRule
    log.line('question', { tool: question.toolName, reason: question.reason, runRule: question.runRule?.summary ?? null, answer })
    return Promise.resolve(answer)
  }
  const turn = async (session: ProgramSession, text: string, answer: ProgramApprovalAnswer[]): Promise<void> => {
    answers.splice(0, answers.length, ...answer)
    await session.send(text, 'start')
    const events = await readTurn(session, log)
    log.line('turn', { outcome: events.at(-1)?.kind === 'turn-end' ? events.at(-1) : null, unusedAnswers: answers.length })
  }
  const session = await driver().open(request(rt, folder, log, { onApproval }))
  await turn(session, 'Run this shell command exactly: touch once.txt. Then say done.', ['allow-once'])
  await turn(session, 'Run this shell command exactly, twice, one call after the other: touch run.txt. Then say done.', ['allow-run'])
  await turn(session, 'Run this shell command exactly: touch rejected.txt. Then say done.', ['reject'])
  await turn(session, 'Run this shell command exactly: touch cancelled.txt. Then say done.', ['cancel'])
  await turn(session, 'Run this shell command exactly: echo prefix > prefix.txt. Then say done.', ['allow-once'])
  await session.close()
  log.line('files', { once: existsSync(join(folder, 'once.txt')), run: existsSync(join(folder, 'run.txt')), rejected: existsSync(join(folder, 'rejected.txt')), cancelled: existsSync(join(folder, 'cancelled.txt')), settingsWritten: existsSync(join(folder, '.claude')) })
  const resumed = await driver().open(request(rt, folder, log, { onApproval, resume: session.programSessionId, runRules: runRule === undefined ? [] : [runRule] }))
  await turn(resumed, 'Run this shell command exactly once more: touch run.txt. Then say done.', [])
  await resumed.close()
})

/** A limits check: no message, no task, none of the person's settings files. */
const limits = (): Promise<void> => inTask('limits', async (rt, folder, log) => {
  const empty = mkdtempSync(join(tmpdir(), 'ea1-claude-probe-'))
  try {
    const observation = await driver().probe({ spawn: rt.spawn, cwd: empty, signal: AbortSignal.timeout(90_000) })
    log.line('observation', observation)
    const again = await driver().probe({ spawn: rt.spawn, cwd: empty, signal: AbortSignal.timeout(90_000) })
    log.line('figures moved between checks', JSON.stringify(observation.windows.map(window => window.usedPercent)) !== JSON.stringify(again.windows.map(window => window.usedPercent)))
    log.line('processes in the empty folder after the checks', processesIn(empty))
    log.line('task folder untouched', processesIn(folder).length === 0)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

/** SIGKILL a Host while a command runs: the watcher ends the program's group; a new Host resumes. */
const hostkill = (): Promise<void> => inTask('hostkill', async (rt, folder, log) => {
  const host = spawnChild(process.execPath, ['--import', 'tsx/esm', join(REPO, 'delorun/packages/agent-claude-code/live/host.ts'), folder, 'claude-hostkill-host'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
  if (host.stdout === null) throw new Error('the Host has no output')
  const ready = await new Promise<{ programSessionId: string }>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the Host was not ready within 180 s')) }, 180_000)
    createInterface({ input: host.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return
      clearTimeout(timer)
      resolve(JSON.parse(line) as { programSessionId: string })
    })
  })
  log.line('processes before the kill', processesIn(folder))
  host.kill('SIGKILL')
  const killedAt = Date.now()
  await sleep(3000)
  log.line('processes 3 s after the Host was killed', processesIn(folder))
  let left = processesIn(folder)
  while (left.length > 0 && Date.now() - killedAt < 60_000) {
    await sleep(500)
    left = processesIn(folder)
  }
  log.line('all gone after ms', left.length === 0 ? Date.now() - killedAt : null)
  for (const { pid } of left) process.kill(pid, 'SIGKILL')
  await sleep(40_000 - (Date.now() - killedAt) > 0 ? 40_000 - (Date.now() - killedAt) : 0)
  log.line('command finished after the kill (late.txt)', existsSync(join(folder, 'late.txt')))
  const resumed = await driver().open(request(rt, folder, log, { resume: ready.programSessionId }))
  await resumed.send('Is there a file named late.txt in this folder? Answer yes or no.', 'start')
  log.line('next message after the kill', textOf(await readTurn(resumed, log)))
  await resumed.close()
})

/** The person's own settings apply: a project rule in the task folder allows one exact command; another one asks. */
const settings = (): Promise<void> => inTask('settings', async (rt, folder, log) => {
  mkdirSync(join(folder, '.claude'))
  writeFileSync(join(folder, '.claude', 'settings.json'), `${JSON.stringify({ permissions: { allow: ['Bash(touch allowed.txt)'] } })}\n`)
  const asked: string[] = []
  const onApproval = (question: ProgramApprovalRequest): Promise<ProgramApprovalAnswer> => {
    asked.push(question.reason)
    log.line('question', question.reason)
    return Promise.resolve('allow-once')
  }
  const session = await driver().open(request(rt, folder, log, { onApproval }))
  await session.send('Run this shell command exactly: touch allowed.txt. Then say done.', 'start')
  await readTurn(session, log)
  log.line('questions after the allowed command', asked.length)
  await session.send('Run this shell command exactly: touch other.txt. Then say done.', 'start')
  await readTurn(session, log)
  log.line('questions after the other command', asked.length)
  await session.close()
  log.line('files', { allowed: existsSync(join(folder, 'allowed.txt')), other: existsSync(join(folder, 'other.txt')) })
})

const runs: Readonly<Record<string, () => Promise<void>>> = { task, steer, interrupt, resume, questions, limits, hostkill, settings }
const name = process.argv[2] ?? ''
const run = runs[name]
if (run === undefined) {
  console.error(`usage: claude.ts <${Object.keys(runs).join('|')}>`)
  process.exitCode = 2
} else {
  await run()
}
