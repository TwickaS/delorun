import { describe, expect, it, vi } from 'vitest'
import { main, realIo, resolve, type Io, type Request } from '../../src/studio-browser.ts'
import type { BrowseDeps, ProcessResult } from '../../src/studio-browser/index.ts'

const OK: ProcessResult = { status: 0, stdout: '', stderr: '' }

interface Run {
  readonly code: number
  readonly out: string[]
  readonly err: string[]
  readonly calls: string[][]
}

/**
 * Run the command against a fake browse.
 * @param argv - the command line.
 * @param env - the environment.
 * @param respond - answers for browse calls.
 * @returns the exit code, printed text and process calls.
 */
function drive(argv: string[], env: Record<string, string> = {}, respond: (args: readonly string[]) => ProcessResult = () => OK): Run {
  const calls: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const deps: BrowseDeps = {
    run: (file, args) => {
      calls.push([file, ...args])
      return respond(args)
    },
    env,
    randomHex: () => 'deadbeef',
    writeTemp: () => '/tmp/s.js',
    removeTemp: () => undefined,
  }
  const io: Io = {
    env, cwd: '/work', deps,
    readScript: path => {
      if (path === '/work/missing.js') throw new Error('ENOENT')
      return `// ${path}\nreturn 1`
    },
    out: text => out.push(text),
    err: text => err.push(text),
  }
  return { code: main(argv, io), out, err, calls }
}

describe('studio-browser check', () => {
  it('prints the adapter and the detail, exit 0', () => {
    const run = drive(['check'], {}, args => (args[0] === 'doctor' ? { status: 0, stdout: 'Status: ok\n', stderr: '' } : OK))
    expect(run.code).toBe(0)
    expect(run.out).toEqual(['adapter: browse\nStatus: ok'])
  })

  it('exits 1 when the browser is not ready', () => {
    const run = drive(['check'], {}, args => (args[0] === 'doctor' ? { status: 0, stdout: 'Status: not paired\n', stderr: '' } : OK))
    expect(run.code).toBe(1)
  })

  it('exits 1 with the message when the binary is missing', () => {
    const run = drive(['check'], {}, () => ({ status: 127, stdout: '', stderr: '' }))
    expect(run.code).toBe(1)
    expect(run.err[0]).toContain('browse not found')
  })
})

describe('studio-browser run', () => {
  it('prints the script output and exits 0', () => {
    const run = drive(['run', '--url', 'http://127.0.0.1:4000/', '--code', 'return 1'], {}, args => (args[0] === 'execute' ? { status: 0, stdout: '1\n', stderr: '' } : OK))
    expect(run.code).toBe(0)
    expect(run.out).toEqual(['1\n'])
    expect(run.calls.map(call => call[1])).toEqual(['--version', 'session', 'execute', 'session'])
  })

  it('prints nothing for a script with no output', () => {
    const run = drive(['run', '--url', 'http://localhost:1', '--code', 'x'])
    expect(run.code).toBe(0)
    expect(run.out).toEqual([])
  })

  it('records to an absolute path and reports it', () => {
    const run = drive(['run', '--url', 'http://localhost:1', '--file', 'a.js', '--record', 'out/x.webm', '--timeout-ms', '9000'])
    expect(run.code).toBe(0)
    expect(run.out).toEqual(['recording: /work/out/x.webm'])
    expect(run.calls).toContainEqual(['browse', 'recording', 'start', '-s', 'delorun-studio-deadbeef', '--frame-rate', '15', '/work/out/x.webm'])
    expect(run.calls).toContainEqual(['browse', 'execute', '-s', 'delorun-studio-deadbeef', '--timeout-ms', '9000', '--file', '/tmp/s.js'])
  })

  it('keeps an absolute --record path', () => {
    const run = drive(['run', '--url', 'http://localhost:1', '--code', 'x', '--record', '/abs/x.webm'])
    expect(run.out).toEqual(['recording: /abs/x.webm'])
  })

  it('exits 1 and prints the failure to stderr', () => {
    const run = drive(['run', '--url', 'http://localhost:1', '--code', 'x'], {}, args => (args[0] === 'execute' ? { status: 1, stdout: '', stderr: 'bad' } : OK))
    expect(run.code).toBe(1)
    expect(run.err[0]).toContain('bad')
  })

  it('selects the adapter from DELORUN_STUDIO_BROWSER, and --adapter wins', () => {
    expect(drive(['check'], { DELORUN_STUDIO_BROWSER: 'nope' }).code).toBe(2)
    const run = drive(['check', '--adapter', 'browse'], { DELORUN_STUDIO_BROWSER: 'nope' })
    expect(run.code).toBe(1)
    expect(run.out[0]).toContain('adapter: browse')
  })
})

describe('studio-browser usage errors exit 2 without touching the browser', () => {
  const url = ['--url', 'http://127.0.0.1:1']
  it.each([
    ['no command', []],
    ['unknown command', ['frobnicate']],
    ['extra argument', ['check', 'extra']],
    ['unknown flag', ['check', '--wat']],
    ['missing --url', ['run', '--code', 'x']],
    ['neither --file nor --code', ['run', ...url]],
    ['both --file and --code', ['run', ...url, '--file', 'a.js', '--code', 'x']],
    ['non-loopback URL', ['run', '--url', 'https://example.com/', '--code', 'x']],
    ['credentials trick', ['run', '--url', 'http://localhost@evil.example/', '--code', 'x']],
    ['file URL', ['run', '--url', 'file:///', '--code', 'x']],
    ['--record without .webm', ['run', ...url, '--code', 'x', '--record', 'x.gif']],
    ['zero timeout', ['run', ...url, '--code', 'x', '--timeout-ms', '0']],
    ['fractional timeout', ['run', ...url, '--code', 'x', '--timeout-ms', '1.5']],
    ['unknown adapter', ['check', '--adapter', 'nope']],
    ['unreadable script', ['run', ...url, '--file', 'missing.js']],
  ])('%s', (_label, argv) => {
    const run = drive(argv)
    expect(run.code).toBe(2)
    expect(run.err[0]).toContain('usage: studio-browser.ts')
    expect(run.calls).toEqual([])
  })

  it('names the loopback rule for a non-loopback URL', () => {
    expect(drive(['run', '--url', 'https://example.com/', '--code', 'x']).err[0]).toContain('studio-browser drives only a studio on this computer: https://example.com/ is not a loopback address')
  })
})

describe('resolve', () => {
  it('applies the default adapter and timeout', () => {
    const request: Request = { command: 'run', url: 'http://[::1]:5/', code: 'x' }
    expect(resolve(request, { DELORUN_STUDIO_BROWSER: '' }, '/w', () => '')).toEqual({
      command: 'run', adapter: 'browse', run: { origin: 'http://[::1]:5', code: 'x', timeoutMs: 60_000 },
    })
  })
})

describe('realIo', () => {
  it('reads script files and prints to the console', () => {
    const io = realIo({ A: '1' }, '/w')
    expect(io.cwd).toBe('/w')
    expect(io.env).toEqual({ A: '1' })
    expect(io.readScript(new URL(import.meta.url).pathname)).toContain('realIo')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    io.out('o')
    io.err('e')
    expect(log).toHaveBeenCalledWith('o')
    expect(error).toHaveBeenCalledWith('e')
    vi.restoreAllMocks()
  })
})
