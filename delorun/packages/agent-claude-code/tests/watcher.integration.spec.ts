import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { GateProcess, watcherPath } from '../src/process.ts'

/**
 * A stand-in for Claude Code: it starts a child in its process group, as Claude Code starts a shell for a tool call,
 * prints its parent's, its own and its child's process ids, and ignores the end of its input, as Claude Code does while a tool call runs. With
 * `stubborn`, both ignore SIGTERM, so only the later SIGKILL ends them.
 */
function standIn(stubborn: boolean): string[] {
  const trap = stubborn ? "process.on('SIGTERM', () => {});" : ''
  const grandchild = `${trap} setInterval(() => {}, 1000)`
  const program = `${trap}
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })
    console.log(JSON.stringify({ watcher: process.ppid, program: process.pid, command: child.pid }))
    process.stdin.resume()
    setInterval(() => {}, 1000)`
  return [process.execPath, '-e', program]
}

const contexts: Context[] = []
const started: number[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (_gone) {
      // ESRCH: the process already ended, which is what the spec expects.
    }
  }
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (_gone) {
    // ESRCH: no such process.
    return false
  }
}

async function pidsFrom(stdout: NodeJS.ReadableStream): Promise<{ watcher: number, program: number, command: number }> {
  const line = await new Promise<string>((resolve) => { createInterface({ input: stdout }).once('line', resolve) })
  const pids = JSON.parse(line) as { watcher: number, program: number, command: number }
  started.push(pids.program, pids.command)
  return pids
}

async function goneWithin(pids: readonly number[], ms: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pids.every(pid => !alive(pid))) return Date.now() - start
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`still running after ${ms} ms: ${pids.filter(alive).join(', ')}`)
}

async function ownerSpawn(argv: string[]): Promise<SubprocessHandle> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx.subprocess.spawn({ argv, cwd: process.cwd(), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 3000 })
}

describe.skipIf(process.platform === 'win32')('the watcher', () => {
  it('ends the program and its command when the Host\'s pipe closes, under the harness\'s subprocess owner', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), ...standIn(false)])
    if (handle.stdout === undefined || handle.stdin === undefined) throw new Error('no pipes')
    const pids = await pidsFrom(handle.stdout)
    expect(alive(pids.program) && alive(pids.command)).toBe(true)
    handle.stdin.end()
    expect(await goneWithin([pids.program, pids.command], 4000)).toBeLessThan(4000)
    expect((await handle.done).exitCode).not.toBe(0)
  })

  it('kills a program that ignores SIGTERM five seconds after the pipe closes', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), ...standIn(true)])
    if (handle.stdout === undefined || handle.stdin === undefined) throw new Error('no pipes')
    const pids = await pidsFrom(handle.stdout)
    handle.stdin.end()
    await new Promise(resolve => setTimeout(resolve, 2000))
    expect(alive(pids.program)).toBe(true)
    const gone = await goneWithin([pids.program, pids.command], 8000)
    expect(gone).toBeGreaterThan(2000)
  })

  it('lets the subprocess owner end the program and its command', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), ...standIn(false)])
    if (handle.stdout === undefined) throw new Error('no pipes')
    const pids = await pidsFrom(handle.stdout)
    handle.terminate()
    await handle.waitForExit()
    await goneWithin([pids.program, pids.command], 4000)
  })

  it('refuses to start the program outside a process group of its own, so it never signals its starter\'s group', async () => {
    const watcher = spawn(process.execPath, [watcherPath(), ...standIn(false)], { stdio: ['pipe', 'pipe', 'ignore'] })
    children.push(watcher)
    let printed = ''
    watcher.stdout?.on('data', (chunk: Buffer) => { printed += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => { watcher.once('exit', resolve) })
    expect(code).toBe(126)
    expect(printed).toBe('')
  })

  it('leaves nothing of a program that ignores SIGTERM once the subprocess owner terminates it', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), ...standIn(true)])
    if (handle.stdout === undefined) throw new Error('no pipes')
    const pids = await pidsFrom(handle.stdout)
    handle.terminate()
    await handle.waitForExit()
    await goneWithin([pids.program, pids.command], 6000)
  })

  it('leaves no program when the watcher is killed outright while the Host lives', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), ...standIn(false)])
    const program = new GateProcess(handle)
    const pids = await pidsFrom(program.stdout)
    const exited = new Promise((resolve) => { program.on('exit', resolve) })
    process.kill(pids.watcher, 'SIGKILL')
    await exited
    await goneWithin([pids.program, pids.command], 8000)
  })

  it('passes the program\'s own exit code on when it ends by itself', async () => {
    const handle = await ownerSpawn([process.execPath, watcherPath(), process.execPath, '-e', 'process.exit(3)'])
    expect((await handle.done).exitCode).toBe(3)
  })
})
