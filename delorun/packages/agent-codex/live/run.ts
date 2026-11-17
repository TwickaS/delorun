/**
 * Live runs of the Codex driver under the person's own Codex sign-in, one command each:
 *
 *   node_modules/.bin/tsx delorun/packages/agent-codex/live/run.ts <task|steer|interrupt|resume|questions|model|limits|hostkill>
 *
 * Each run uses a throwaway git folder under `/tmp`, one small file and short commands, passes `gpt-5.6-luna` (override
 * with `EA1_CODEX_MODEL`) except where the model rule is the subject, and checks that the Codex home's top-level
 * listing is unchanged. Redacted logs go to `~/delorun-rc-release/ea1-codex-logs/`. Never part of a Vitest lane.
 * @module @delorun/agent-codex/live/run
 */
import { spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { ProgramFailureError } from '../src/contract.ts'
import { REPO, answerText, listingDiff, live, processesIn, removeTask, sleep, taskFolder, topListing, untilTurnEnd, type Live } from './common.ts'

/** Run one scenario with set-up, the leftover checks and clean-up around it. */
async function scenario(name: string, body: (run: Live) => Promise<void>, task?: string): Promise<void> {
  const before = topListing()
  const run = await live(name, task)
  try {
    await body(run)
  } catch (error: unknown) {
    run.log.report('failed', error instanceof ProgramFailureError ? error.failure : String(error))
    process.exitCode = 1
  } finally {
    await run.dispose()
    run.log.report('programs left in the task folder', processesIn(run.task))
    removeTask(run.task)
    run.log.report('codex home top-level changes', listingDiff(before, topListing()))
    run.log.report('log', run.log.path)
  }
}

const scenarios: Readonly<Record<string, () => Promise<void>>> = {
  /** A tiny task: one short command, allowed once, and the answer. */
  task: () => scenario('task', async (run) => {
    run.answers = ['allow-once']
    const session = await run.driver.open(run.request())
    run.log.report('thread', session.programSessionId)
    await session.send('Run this shell command exactly: echo hello > hello.txt. Then reply with the single word: done.', 'start')
    const events = await untilTurnEnd(session, run.log)
    run.log.report('answer', answerText(events))
    run.log.report('hello.txt made', existsSync(join(run.task, 'hello.txt')))
    await session.close()
  }),

  /** A steer while a command runs joins the running turn. */
  steer: () => scenario('steer', async (run) => {
    run.answers = ['allow-once']
    const session = await run.driver.open(run.request())
    await session.send('Run this shell command exactly: sleep 8 && echo slept. Then reply with what it printed.', 'start')
    let steered = false
    const events = await untilTurnEnd(session, run.log, async (event) => {
      if (event.kind !== 'tool-call' || steered) return
      steered = true
      await sleep(2_000)
      await session.send('Also end your reply with the word banana.', 'steer')
      run.log.report('steer', `sent during the command; turn still running: ${String(session.turnRunning)}`)
    })
    run.log.report('answer', answerText(events))
    await session.close()
  }),

  /** Stop during a running command: the process closes and the command is dead. */
  interrupt: () => scenario('interrupt', async (run) => {
    run.answers = ['allow-once']
    const session = await run.driver.open(run.request())
    await session.send('Run this shell command exactly: sleep 30 && echo late > late.txt. Then say done.', 'start')
    const events = await untilTurnEnd(session, run.log, async (event) => {
      if (event.kind !== 'tool-call') return
      await sleep(3_000)
      run.log.report('programs before Stop', processesIn(run.task))
      await session.interrupt()
    })
    run.log.report('turn end', events.at(-1))
    run.log.report('closed reason', session.closedReason ?? 'still open')
    await session.close()
    await sleep(1_000)
    run.log.report('programs 1 s after Stop', processesIn(run.task))
    await sleep(32_000)
    run.log.report('late.txt exists 33 s after Stop', existsSync(join(run.task, 'late.txt')))
  }),

  /** Resume the thread in a new process after closing the first. */
  resume: () => scenario('resume', async (run) => {
    const first = await run.driver.open(run.request())
    await first.send('Remember the word "lantern". Reply with the single word: ok.', 'start')
    await untilTurnEnd(first, run.log)
    const threadId = first.programSessionId
    await first.close()
    const started = Date.now()
    const resumed = await run.driver.open(run.request({ resume: threadId }))
    run.log.report('resume', { sameThread: resumed.programSessionId === threadId, spawnToResumedMs: Date.now() - started })
    await resumed.send('Which word did I ask you to remember? One word.', 'start')
    run.log.report('answer after resume', answerText(await untilTurnEnd(resumed, run.log)))
    await resumed.close()
  }),

  /** One question with each answer; "Allow for this run" also lets the same command through unasked. */
  questions: () => scenario('questions', async (run) => {
    const session = await run.driver.open(run.request())
    const turns: readonly { readonly answer: 'allow-once' | 'allow-run' | 'reject' | 'cancel'; readonly prompt: string; readonly file: string }[] = [
      { answer: 'allow-once', prompt: 'Run this shell command exactly: touch once.txt. Then say done.', file: 'once.txt' },
      { answer: 'allow-run', prompt: 'Run this shell command exactly: touch run.txt. Then run exactly the same command once more: touch run.txt. Then say done.', file: 'run.txt' },
      { answer: 'reject', prompt: 'Run this shell command exactly: touch rejected.txt. Then say done.', file: 'rejected.txt' },
      { answer: 'cancel', prompt: 'Run this shell command exactly: touch cancelled.txt. Then say done.', file: 'cancelled.txt' },
    ]
    for (const turn of turns) {
      const asked = run.questions.length
      run.answers = [turn.answer]
      await session.send(turn.prompt, 'start')
      const events = await untilTurnEnd(session, run.log)
      run.log.report(`${turn.answer}`, {
        questions: run.questions.length - asked,
        calls: events.filter(event => event.kind === 'tool-call').length,
        made: existsSync(join(run.task, turn.file)),
        outcome: events.at(-1),
      })
    }
    await session.close()
  }),

  /** The model rule against the person's configured default, with no model picked. */
  model: () => scenario('model', async (run) => {
    const { model: _picked, ...unpicked } = run.request()
    try {
      const session = await run.driver.open(unpicked)
      run.log.report('opened with the configured model', session.programSessionId)
      await session.close()
    } catch (error: unknown) {
      if (!(error instanceof ProgramFailureError)) throw error
      run.log.report('open refused', error.failure)
    }
  }),

  /** A limits check: no thread, no task. */
  limits: () => scenario('limits', async (run) => {
    const observation = await run.driver.probe({ spawn: run.spawn, cwd: run.task, signal: AbortSignal.timeout(120_000) })
    run.log.report('observation', observation)
  }),

  /** SIGKILL a Host mid-command; the program must be gone within seconds, and a new Host resumes the thread. */
  hostkill: async () => {
    const task = taskFolder()
    await scenario('hostkill', async (run) => {
      const host = spawnChild(process.execPath, ['--import', 'tsx/esm', join(REPO, 'delorun/packages/agent-codex/live/host.ts'), task], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
      const ready = await new Promise<{ readonly threadId: string }>((resolveReady, reject) => {
        const timer = setTimeout(() => { reject(new Error('the Host did not report ready within 240 s')) }, 240_000)
        createInterface({ input: host.stdout }).on('line', (line) => {
          if (!line.startsWith('{')) return
          clearTimeout(timer)
          resolveReady(JSON.parse(line) as { readonly threadId: string })
        })
      })
      run.log.report('programs before the kill', processesIn(task))
      host.kill('SIGKILL')
      const killedAt = Date.now()
      let left = processesIn(task)
      while (left.length > 0 && Date.now() - killedAt < 60_000) {
        await sleep(250)
        left = processesIn(task)
      }
      run.log.report('all gone after ms', left.length === 0 ? Date.now() - killedAt : `still running: ${JSON.stringify(left)}`)
      run.log.report('command finished after the kill (late.txt)', existsSync(join(task, 'late.txt')))
      const resumed = await run.driver.open(run.request({ resume: ready.threadId }))
      run.answers = ['allow-once', 'allow-once']
      await resumed.send('Is there a file named late.txt in this folder? Answer yes or no.', 'start')
      run.log.report('answer after resume', answerText(await untilTurnEnd(resumed, run.log)))
      await resumed.close()
    }, task)
  },
}

const name = process.argv[2] ?? ''
const run = scenarios[name]
if (run === undefined) {
  console.error(`usage: run.ts <${Object.keys(scenarios).join('|')}>`)
  process.exitCode = 2
} else {
  await run()
}
