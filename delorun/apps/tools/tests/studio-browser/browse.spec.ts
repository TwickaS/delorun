import { describe, expect, it } from 'vitest'
import {
  createBrowseAdapter,
  errorMessage,
  loopbackOrigin,
  locateBrowse,
  realDeps,
  spawnRunner,
  type BrowseDeps,
  type ProcessResult,
} from '../../src/studio-browser/index.ts'
import { existsSync, readFileSync } from 'node:fs'

const ORIGIN = loopbackOrigin('http://127.0.0.1:4000/')
const OK: ProcessResult = { status: 0, stdout: '', stderr: '' }
const WIN_BIN = '/winprofile/.local/bin/browse.exe'

type Call = readonly [file: string, ...args: string[]]
type Responder = (file: string, args: readonly string[]) => ProcessResult | undefined

interface Harness {
  readonly deps: BrowseDeps
  readonly calls: Call[]
  readonly temps: Map<string, string>
  readonly removed: string[]
}

/**
 * Fake dependencies: every call is recorded, `respond` answers the ones a case cares about and the rest succeed.
 * @param respond - per-call override.
 * @param env - the environment.
 * @returns the dependencies and what they saw.
 */
function harness(respond: Responder = () => undefined, env: Record<string, string> = {}): Harness {
  const calls: Call[] = []
  const temps = new Map<string, string>()
  const removed: string[] = []
  const deps: BrowseDeps = {
    run: (file, args) => {
      calls.push([file, ...args])
      return respond(file, args) ?? OK
    },
    env,
    randomHex: () => 'abcd1234',
    writeTemp: code => {
      const path = `/tmp/fake/script-${String(temps.size)}.js`
      temps.set(path, code)
      return path
    },
    removeTemp: path => {
      removed.push(path)
    },
  }
  return { deps, calls, temps, removed }
}

const failing = (matchArg: string, result: Partial<ProcessResult> = {}): Responder => (_file, args) =>
  args.includes(matchArg) ? { status: 1, stdout: '', stderr: 'boom', ...result } : undefined

describe('locateBrowse', () => {
  it('prefers DELORUN_BROWSE_BIN', () => {
    const h = harness(undefined, { DELORUN_BROWSE_BIN: '/opt/browse' })
    expect(locateBrowse(h.deps)).toBe('/opt/browse')
    expect(h.calls).toEqual([['/opt/browse', '--version']])
  })

  it('fails loud when DELORUN_BROWSE_BIN does not answer', () => {
    const h = harness(file => (file === '/opt/browse' ? { status: 1, stdout: '', stderr: '' } : undefined), { DELORUN_BROWSE_BIN: '/opt/browse' })
    expect(() => locateBrowse(h.deps)).toThrow('DELORUN_BROWSE_BIN is set to /opt/browse')
  })

  it('ignores an empty DELORUN_BROWSE_BIN and uses browse on PATH', () => {
    const h = harness(undefined, { DELORUN_BROWSE_BIN: '' })
    expect(locateBrowse(h.deps)).toBe('browse')
  })

  it('finds the Windows install under WSL', () => {
    const h = harness((file, args) => {
      if (file === 'browse') return { status: null, stdout: '', stderr: 'ENOENT' }
      if (file === 'cmd.exe') return { status: 0, stdout: 'C:\\Users\\someone\r\n', stderr: '' }
      if (file === 'wslpath') return { status: 0, stdout: '/winprofile\n', stderr: '' }
      return args[0] === '--version' ? OK : undefined
    }, { WSL_DISTRO_NAME: 'Ubuntu' })
    expect(locateBrowse(h.deps)).toBe(WIN_BIN)
    expect(h.calls).toEqual([
      ['browse', '--version'],
      ['cmd.exe', '/c', 'echo %USERPROFILE%'],
      ['wslpath', '-u', 'C:\\Users\\someone'],
      [WIN_BIN, '--version'],
    ])
  })

  const notFound = (file: string): ProcessResult | undefined => (file === 'browse' ? { status: 127, stdout: '', stderr: '' } : undefined)

  it.each([
    ['cmd.exe fails', (file: string) => (file === 'cmd.exe' ? { status: 1, stdout: '', stderr: '' } : notFound(file))],
    ['the profile is empty', (file: string) => (file === 'cmd.exe' ? { status: 0, stdout: '\r\n', stderr: '' } : notFound(file))],
    ['wslpath fails', (file: string) => (file === 'wslpath' ? { status: 1, stdout: '', stderr: '' } : file === 'cmd.exe' ? { status: 0, stdout: 'C:\\x', stderr: '' } : notFound(file))],
    ['the Windows binary does not answer', (file: string) => (file.endsWith('.exe') && file !== 'cmd.exe' ? { status: 1, stdout: '', stderr: '' } : file === 'cmd.exe' ? { status: 0, stdout: 'C:\\x', stderr: '' } : notFound(file))],
  ])('names all three places when %s', (_label, respond) => {
    const h = harness(respond, { WSL_DISTRO_NAME: 'Ubuntu' })
    expect(() => locateBrowse(h.deps)).toThrow(/DELORUN_BROWSE_BIN.*`browse` on PATH.*Windows install.*github\.com\/anomalyco\/browse/)
  })

  it('does not look for the Windows install outside WSL', () => {
    const h = harness(notFound)
    expect(() => locateBrowse(h.deps)).toThrow('browse not found')
    expect(h.calls.map(call => call[0])).toEqual(['browse'])
  })

  it('treats an empty WSL_DISTRO_NAME as not WSL', () => {
    const h = harness(notFound, { WSL_DISTRO_NAME: '' })
    expect(() => locateBrowse(h.deps)).toThrow('browse not found')
    expect(h.calls).toHaveLength(1)
  })
})

describe('browse adapter check', () => {
  it('is ok when doctor exits 0 and reports Status: ok', () => {
    const h = harness((_file, args) => (args[0] === 'doctor' ? { status: 0, stdout: 'browse doctor\nStatus: ok\nEndpoint: x\nPaths: y\nCLI: z\n', stderr: '' } : undefined))
    const check = createBrowseAdapter(h.deps).check()
    expect(check).toEqual({ ok: true, detail: 'browse doctor\nStatus: ok\nEndpoint: x\nPaths: y' })
    expect(createBrowseAdapter(h.deps).id).toBe('browse')
  })

  it('is not ok when the status line says otherwise', () => {
    const h = harness((_file, args) => (args[0] === 'doctor' ? { status: 0, stdout: 'Status: no extension\n', stderr: '' } : undefined))
    expect(createBrowseAdapter(h.deps).check()).toEqual({ ok: false, detail: 'Status: no extension' })
  })

  it('reports the failure when doctor prints nothing', () => {
    const h = harness((_file, args) => (args[0] === 'doctor' ? { status: 2, stdout: '', stderr: 'crashed' } : undefined))
    const check = createBrowseAdapter(h.deps).check()
    expect(check.ok).toBe(false)
    expect(check.detail).toBe('browse doctor failed (exit 2):\ncrashed')
  })
})

describe('browse adapter run', () => {
  const spec = { origin: ORIGIN, startUrl: `${ORIGIN}/`, code: 'return 1', timeoutMs: 5000 }

  it('runs create, execute, delete and removes the script file', () => {
    const h = harness((_file, args) => (args[0] === 'execute' ? { status: 0, stdout: '"probe"\nPage: a -> b\n', stderr: '' } : undefined))
    const result = createBrowseAdapter(h.deps).run(spec)
    expect(result).toEqual({ ok: true, output: '"probe"\nPage: a -> b\n' })
    expect(h.calls).toEqual([
      ['browse', '--version'],
      ['browse', 'session', 'new', '--allow-origin', 'http://127.0.0.1:4000', 'delorun-studio-abcd1234'],
      ['browse', 'execute', '-s', 'delorun-studio-abcd1234', '--timeout-ms', '5000', '--file', '/tmp/fake/script-0.js'],
      ['browse', 'session', 'delete', 'delorun-studio-abcd1234'],
    ])
    expect([...h.temps.values()]).toEqual(['return 1'])
    expect(h.removed).toEqual(['/tmp/fake/script-0.js'])
  })

  it('records between session creation and deletion', () => {
    const h = harness()
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result).toEqual({ ok: true, output: '', recording: '/tmp/out/run.webm' })
    expect(h.calls.slice(1)).toEqual([
      ['browse', 'session', 'new', '--allow-origin', 'http://127.0.0.1:4000', 'delorun-studio-abcd1234'],
      ['browse', 'execute', '-s', 'delorun-studio-abcd1234', 'await page.goto("http://127.0.0.1:4000/"); return null'],
      ['browse', 'recording', 'start', '-s', 'delorun-studio-abcd1234', '--frame-rate', '15', '/tmp/out/run.webm'],
      ['browse', 'execute', '-s', 'delorun-studio-abcd1234', '--timeout-ms', '5000', '--file', '/tmp/fake/script-0.js'],
      ['browse', 'recording', 'stop', '-s', 'delorun-studio-abcd1234'],
      ['browse', 'session', 'delete', 'delorun-studio-abcd1234'],
    ])
  })

  it('deletes the session and reports the output when execute fails', () => {
    const h = harness(failing('--file', { stderr: 'TimeoutError', stdout: 'partial' }))
    const result = createBrowseAdapter(h.deps).run(spec)
    expect(result.ok).toBe(false)
    expect(result.output).toBe('browse execute failed (exit 1):\nTimeoutError\npartial')
    expect(h.calls.at(-1)).toEqual(['browse', 'session', 'delete', 'delorun-studio-abcd1234'])
    expect(h.removed).toEqual(['/tmp/fake/script-0.js'])
  })

  it('cancels the recording instead of stopping it when execute fails', () => {
    const h = harness(failing('--file'))
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('recording')
    expect(h.calls.slice(-3)).toEqual([
      ['browse', 'execute', '-s', 'delorun-studio-abcd1234', '--timeout-ms', '5000', '--file', '/tmp/fake/script-0.js'],
      ['browse', 'recording', 'cancel', '-s', 'delorun-studio-abcd1234'],
      ['browse', 'session', 'delete', 'delorun-studio-abcd1234'],
    ])
    expect(h.calls.some(call => call.includes('stop'))).toBe(false)
  })

  it('cancels the recording when execute throws', () => {
    const h = harness()
    const throwing: BrowseDeps = {
      ...h.deps,
      run: (file, args) => {
        if (args.includes('--file')) throw new Error('spawn exploded')
        return h.deps.run(file, args, {})
      },
    }
    const result = createBrowseAdapter(throwing).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result).toEqual({ ok: false, output: 'spawn exploded' })
    expect(h.calls.map(call => call.slice(0, 2).join(' '))).toEqual(
      expect.arrayContaining(['browse recording', 'browse session']),
    )
    expect(h.calls.filter(call => call[1] === 'recording').map(call => call[2])).toEqual(['start', 'cancel'])
  })

  it('cancels the recording when stop fails', () => {
    const h = harness(failing('stop'))
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('browse recording stop failed')
    expect(h.calls.filter(call => call[1] === 'recording').map(call => call[2])).toEqual(['start', 'stop', 'cancel'])
  })

  it('reports a failure to open the tab before recording', () => {
    const h = harness((_file, args) => (args[0] === 'execute' ? { status: 1, stdout: '', stderr: 'no tab' } : undefined))
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result.output).toContain('browse open failed (exit 1):\nno tab')
    expect(h.calls.some(call => call[1] === 'recording')).toBe(false)
  })

  it('stops there and still deletes the session when it cannot start the recording', () => {
    const h = harness(failing('start'))
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result.output).toContain('browse recording start failed')
    expect(h.calls.some(call => call.includes('--file'))).toBe(false)
    expect(h.calls.at(-1)?.slice(1, 3)).toEqual(['session', 'delete'])
    expect(h.removed).toEqual([])
  })

  it('reports a failed session creation and attempts the delete', () => {
    const h = harness(failing('new'))
    const result = createBrowseAdapter(h.deps).run(spec)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('browse session new failed (exit 1):\nboom')
    expect(h.calls.some(call => call[1] === 'execute')).toBe(false)
    expect(h.calls.at(-1)?.slice(1, 3)).toEqual(['session', 'delete'])
  })

  it('reports cleanup failures in the output and fails the run', () => {
    const h = harness((_file, args) => (args[0] === 'session' && args[1] === 'delete' ? { status: 1, stdout: '', stderr: 'gone' } : undefined))
    const result = createBrowseAdapter({
      ...h.deps,
      removeTemp: () => {
        throw new Error('EBUSY')
      },
    }).run(spec)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('browse session delete delorun-studio-abcd1234 failed (exit 1):\ngone')
    expect(result.output).toContain('removing /tmp/fake/script-0.js failed: EBUSY')
  })

  it('reports a failed recording cancel', () => {
    const h = harness((_file, args) => (args.includes('--file') || (args[0] === 'recording' && args[1] === 'cancel') ? { status: 1, stdout: '', stderr: 'x' } : undefined))
    const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
    expect(result.output).toContain('browse recording cancel failed')
  })

  describe('Windows binary', () => {
    const responder: Responder = (file, args) => {
      if (file === 'wslpath') return { status: 0, stdout: `\\\\wsl.localhost\\Ubuntu${args[1]?.replaceAll('/', '\\') ?? ''}\n`, stderr: '' }
      return undefined
    }

    it('converts the recording and script paths with wslpath -w', () => {
      const h = harness(responder, { DELORUN_BROWSE_BIN: WIN_BIN })
      const result = createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
      expect(result.ok).toBe(true)
      expect(h.calls).toContainEqual([WIN_BIN, 'recording', 'start', '-s', 'delorun-studio-abcd1234', '--frame-rate', '15', '\\\\wsl.localhost\\Ubuntu\\tmp\\out\\run.webm'])
      expect(h.calls).toContainEqual([WIN_BIN, 'execute', '-s', 'delorun-studio-abcd1234', '--timeout-ms', '5000', '--file', '\\\\wsl.localhost\\Ubuntu\\tmp\\fake\\script-0.js'])
      expect(h.calls.filter(call => call[0] === 'wslpath')).toEqual([['wslpath', '-w', '/tmp/out/run.webm'], ['wslpath', '-w', '/tmp/fake/script-0.js']])
    })

    it('matches the .exe suffix case-insensitively', () => {
      const h = harness(responder, { DELORUN_BROWSE_BIN: '/x/BROWSE.EXE' })
      createBrowseAdapter(h.deps).run(spec)
      expect(h.calls.filter(call => call[0] === 'wslpath')).toHaveLength(1)
    })

    it('fails the run when wslpath fails', () => {
      const h = harness((file) => (file === 'wslpath' ? { status: 1, stdout: '', stderr: 'bad path' } : undefined), { DELORUN_BROWSE_BIN: WIN_BIN })
      const result = createBrowseAdapter(h.deps).run(spec)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('wslpath failed (exit 1):\nbad path')
    })

    it('leaves paths alone for a binary that is not an .exe', () => {
      const h = harness(undefined, { DELORUN_BROWSE_BIN: '/usr/local/bin/browse' })
      createBrowseAdapter(h.deps).run({ ...spec, recordTo: '/tmp/out/run.webm' })
      expect(h.calls.some(call => call[0] === 'wslpath')).toBe(false)
    })
  })
})

describe('real dependencies', () => {
  it('runs a process and captures its output', () => {
    const result = spawnRunner(process.execPath, ['-e', 'console.log("hi"); console.error("err"); process.exit(3)'], { timeoutMs: 20_000 })
    expect(result).toMatchObject({ status: 3, stdout: 'hi\n', stderr: 'err\n' })
  })

  it('reports a process that cannot start', () => {
    const result = spawnRunner('/nonexistent/delorun-studio-browser-test', [], { timeoutMs: 1000 })
    expect(result.status).toBeNull()
    expect(result.stderr).toContain('ENOENT')
  })

  it('writes and removes the script file and names sessions with eight hex digits', () => {
    const deps = realDeps({ A: 'b' })
    expect(deps.env).toEqual({ A: 'b' })
    expect(deps.randomHex()).toMatch(/^[0-9a-f]{8}$/)
    const path = deps.writeTemp('return 7')
    expect(readFileSync(path, 'utf8')).toBe('return 7')
    deps.removeTemp(path)
    expect(existsSync(path)).toBe(false)
  })

  it('formats caught values', () => {
    expect(errorMessage(new Error('a'))).toBe('a')
    expect(errorMessage('b')).toBe('b')
  })
})
