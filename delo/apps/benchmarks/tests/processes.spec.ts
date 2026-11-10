import { describe, expect, it } from 'vitest'
import { expectSuccess, firstMatch, outputTail, run, start, type Finished, type TimedLine } from '../src/harness/processes.ts'

const NODE = process.execPath
const base = { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 30_000 }

describe('timed child processes', () => {
  it('times each line of both streams, the first output and the exit', async () => {
    const seen: TimedLine[] = []
    const finished = await run({ ...base, command: NODE, args: ['-e', 'process.stdout.write("a\\r\\nb\\n"); process.stderr.write("c"); setTimeout(() => process.stdout.write("d\\n"), 50)'], onLine: line => { seen.push(line) } })
    expect(finished.code).toBe(0)
    expect(finished.timedOut).toBe(false)
    expect(finished.lines.map(line => [line.stream, line.text]).sort()).toEqual([['stderr', 'c'], ['stdout', 'a'], ['stdout', 'b'], ['stdout', 'd']])
    expect(seen).toEqual(finished.lines)
    expect(finished.firstOutputAt).toBeGreaterThanOrEqual(finished.startedAt)
    expect(finished.endedAt).toBeGreaterThanOrEqual(firstMatch(finished.lines, /^d$/u)!.at)
    expect(firstMatch(finished.lines, /^nothing$/u)).toBeUndefined()
  })

  it('passes input, and reports no first output for a silent child', async () => {
    const echoed = await run({ ...base, command: NODE, args: ['-e', 'process.stdin.pipe(process.stdout)'], input: 'typed\n' })
    expect(echoed.lines.map(line => line.text)).toEqual(['typed'])
    const silent = await run({ ...base, command: NODE, args: ['-e', ''] })
    expect(silent.firstOutputAt).toBeUndefined()
  })

  it('kills the whole process group at the deadline', async () => {
    const finished = await run({ ...base, timeoutMs: 300, command: NODE, args: ['-e', 'require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)'] })
    expect(finished.timedOut).toBe(true)
    expect(finished.signal).toBe('SIGKILL')
    expect(() => expectSuccess(finished, 'the sleeper')).toThrow('the sleeper ran past its deadline')
  })

  it('kills on request, and does nothing once the child has exited', async () => {
    const running = start({ ...base, command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] })
    running.kill('SIGTERM')
    const finished = await running.finished
    expect(finished.signal).toBe('SIGTERM')
    expect(() => { running.kill() }).not.toThrow()
  })

  it('rejects when the command cannot start', async () => {
    await expect(run({ ...base, command: '/nonexistent/command', args: [] })).rejects.toThrow('ENOENT')
  })

  it('names how a failed child ended and the end of its output', () => {
    const failed: Finished = { code: 3, signal: null, startedAt: 0, firstOutputAt: 0, endedAt: 1, lines: [{ at: 0, stream: 'stderr', text: 'boom' }], timedOut: false }
    expect(() => expectSuccess(failed, 'the tool')).toThrow('the tool exited 3:\nboom')
    expect(() => expectSuccess({ ...failed, code: null, signal: 'SIGSEGV' }, 'the tool')).toThrow('the tool ended by SIGSEGV')
    expect(expectSuccess({ ...failed, code: 0 }, 'the tool').code).toBe(0)
    expect(outputTail({ lines: [{ at: 0, stream: 'stdout', text: '1' }, { at: 0, stream: 'stdout', text: '2' }] }, 1)).toBe('2')
  })
})
