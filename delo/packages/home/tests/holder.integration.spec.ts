import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkHolder, currentHolder, darwinProcessStart, holderAlive, holderIdentity, holderOf, linuxProcessStart, parseHolder, readPidNamespace, readProcessStart, SYSTEM_PROCESS_TABLE, type ProcessTable } from '../src/index.ts'

const BOOT_ID = '6f1e3c52-8a1b-4d6e-9c0f-1234567890ab'

/**
 * The process id of a process that has exited.
 * @returns the pid.
 */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 30_000 }).stdout)
}

/**
 * A stat line whose command name holds spaces and parentheses, with a start time in field 22.
 * @param starttime - field 22.
 * @returns the line.
 */
function statLine(starttime: string): string {
  // Fields 3 to 21, then 22 (starttime), then more.
  const before = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1))]
  return `4242 (a) b (c) ${[...before, starttime, '9', '9'].join(' ')}\n`
}

describe('the start identity parsers', () => {
  it('read field 22 of a Linux stat line after the command name, with the boot id', () => {
    expect(linuxProcessStart(statLine('123456'), `${BOOT_ID}\n`)).toBe(`linux:${BOOT_ID}:123456`)
  })

  it('reject a malformed Linux stat line or boot id', () => {
    expect(linuxProcessStart('no parenthesis here', BOOT_ID)).toBeUndefined()
    expect(linuxProcessStart('1 (short) S 1 2', BOOT_ID)).toBeUndefined()
    expect(linuxProcessStart(statLine('12x'), BOOT_ID)).toBeUndefined()
    expect(linuxProcessStart(statLine('123456'), 'not a boot id')).toBeUndefined()
  })

  it('read `ps -o lstart=` as UTC milliseconds, a space-padded day included', () => {
    expect(darwinProcessStart('Tue Nov  3 09:12:34 2026\n')).toBe(`darwin:${String(Date.UTC(2026, 10, 3, 9, 12, 34))}`)
    expect(darwinProcessStart('Mon Dec 21 23:59:59 2026')).toBe(`darwin:${String(Date.UTC(2026, 11, 21, 23, 59, 59))}`)
  })

  it('reject output that is not one start time', () => {
    expect(darwinProcessStart('')).toBeUndefined()
    expect(darwinProcessStart('Tue Foo  3 09:12:34 2026')).toBeUndefined()
    expect(darwinProcessStart('Tue Nov  3 09:12:34 2026\nWed Nov  4 09:12:34 2026')).toBeUndefined()
  })
})

describe.runIf(process.platform === 'linux')('the Linux reader', () => {
  it('reads this process\'s start from /proc, which agrees with the boot time and `ps`\'s start time', () => {
    const identity = readProcessStart(process.pid, 'linux')
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    expect(identity).toMatch(new RegExp(`^linux:${bootId}:\\d+$`, 'u'))
    if (!existsSync('/bin/ps')) return
    const ticks = Number(identity!.split(':').at(-1))
    const hertz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 30_000 }).trim())
    const bootSeconds = Number(/^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))![1])
    const psMillis = Number(readProcessStart(process.pid, 'darwin')!.slice('darwin:'.length))
    expect(Math.abs((bootSeconds + ticks / hertz) * 1000 - psMillis)).toBeLessThanOrEqual(2000)
  })

  it('gives another process its own start, and none once it has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      const identity = readProcessStart(child.pid!, 'linux')
      expect(identity).toMatch(/^linux:/u)
      expect(identity).not.toBe(readProcessStart(process.pid, 'linux'))
      expect(holderOf(child.pid!)).toEqual({ pid: child.pid, processStart: identity, pidNamespace: readPidNamespace('linux') })
    } finally {
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
    }
    expect(readProcessStart(child.pid!, 'linux')).toBeUndefined()
  })

  it('reads this process\'s pid namespace from /proc/self/ns/pid', () => {
    expect(readPidNamespace('linux')).toBe(readlinkSync('/proc/self/ns/pid'))
    expect(readPidNamespace('linux')).toMatch(/^pid:\[\d+\]$/u)
  })
})

describe.runIf(existsSync('/bin/ps'))('the macOS reader', () => {
  it('reads a live process\'s start through ps, and none for a process that does not exist', () => {
    expect(readProcessStart(process.pid, 'darwin')).toMatch(/^darwin:\d+$/u)
    expect(readProcessStart(deadPid(), 'darwin')).toBeUndefined()
  })
})

describe('holders', () => {
  it('have no start identity or pid namespace on a platform without a reader, such as Windows', () => {
    expect(readProcessStart(process.pid, 'win32')).toBeUndefined()
    expect(readPidNamespace('win32')).toBeUndefined()
    expect(readPidNamespace('darwin')).toBeUndefined()
    expect(holderOf(deadPid())).toEqual({ pid: expect.any(Number) as number, ...holderIdentity({ pidNamespace: readPidNamespace() }) })
  })

  it('describe this process once, with this platform\'s start identity and pid namespace', () => {
    const holder = currentHolder()
    expect(holder).toEqual({ pid: process.pid, ...holderIdentity({ processStart: readProcessStart(process.pid), pidNamespace: readPidNamespace() }) })
    expect(Object.values(holder)).not.toContain(undefined)
    expect(currentHolder()).toBe(holder)
  })

  it('are alive while their process exists with the recorded start identity, or with none recorded', () => {
    expect(holderAlive(currentHolder())).toBe(true)
    expect(holderAlive({ pid: process.pid })).toBe(true)
    expect(holderAlive({ pid: deadPid() })).toBe(false)
  })

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')('are dead when the process id names a process with another start identity', () => {
    const own = readProcessStart(process.pid)!
    expect(holderAlive({ pid: process.pid, processStart: own.replace(/\d+$/u, digits => String(Number(digits) + 1)) })).toBe(false)
  })

  it('are alive, whatever their process id and start identity, when recorded in another pid namespace than this process\'s', () => {
    expect(holderAlive({ pid: deadPid(), pidNamespace: 'pid:[1]' })).toBe(true)
    expect(holderAlive({ pid: deadPid(), processStart: `linux:${BOOT_ID}:1`, pidNamespace: 'pid:[1]' })).toBe(true)
    expect(holderAlive({ pid: process.pid, processStart: `linux:${BOOT_ID}:1`, pidNamespace: 'pid:[1]' })).toBe(true)
  })

  it.runIf(readPidNamespace() !== undefined)('are judged by process id and start identity when recorded in this process\'s pid namespace', () => {
    const pidNamespace = readPidNamespace()!
    expect(holderAlive({ pid: deadPid(), pidNamespace })).toBe(false)
    expect(holderAlive({ pid: process.pid, pidNamespace })).toBe(true)
    const own = readProcessStart(process.pid)!
    expect(holderAlive({ pid: process.pid, processStart: own, pidNamespace })).toBe(true)
    expect(holderAlive({ pid: process.pid, processStart: own.replace(/\d+$/u, digits => String(Number(digits) + 1)), pidNamespace })).toBe(false)
  })

  it('are confirmed only when a live process has the recorded id and start identity, in the recorded pid namespace', () => {
    const start = `linux:${BOOT_ID}:99`
    const table = (platform: NodeJS.Platform, live: string | undefined, exists = true): ProcessTable => ({ platform, exists: () => exists, start: () => live, pidNamespace: () => 'pid:[2]' })
    expect(checkHolder({ pid: 7, processStart: start, pidNamespace: 'pid:[2]' }, table('linux', start))).toEqual({ kind: 'confirmed' })
    expect(checkHolder({ pid: 7, processStart: start }, table('linux', start))).toEqual({ kind: 'confirmed' })
    expect(checkHolder({ pid: 7, processStart: start }, table('linux', `linux:${BOOT_ID}:100`))).toEqual({ kind: 'replaced' })
    expect(checkHolder({ pid: 7, processStart: start }, table('linux', start, false))).toEqual({ kind: 'exited' })
    expect(checkHolder({ pid: 7 }, table('linux', start))).toEqual({ kind: 'unconfirmed', reason: 'no-start-identity' })
    expect(checkHolder({ pid: 7, processStart: start }, table('linux', undefined))).toEqual({ kind: 'unconfirmed', reason: 'start-unreadable' })
    expect(checkHolder({ pid: 7, processStart: start, pidNamespace: 'pid:[1]' }, table('linux', start))).toEqual({ kind: 'unconfirmed', reason: 'other-namespace' })
    expect(checkHolder({ pid: 7, processStart: start }, table('win32', start))).toEqual({ kind: 'unconfirmed', reason: 'no-start-reader' })
    expect(checkHolder({ pid: 7 }, table('win32', undefined, false))).toEqual({ kind: 'exited' })
  })

  it('are checked against this operating system\'s processes by default', () => {
    expect(SYSTEM_PROCESS_TABLE.platform).toBe(process.platform)
    expect(SYSTEM_PROCESS_TABLE.pidNamespace()).toBe(readPidNamespace())
    expect(checkHolder(currentHolder()).kind).toBe(readProcessStart(process.pid) === undefined ? 'unconfirmed' : 'confirmed')
    expect(checkHolder({ pid: deadPid() })).toEqual({ kind: 'exited' })
  })

  it('parse from a record: a positive integer pid and an optional well-formed start identity', () => {
    expect(parseHolder({ pid: 7 })).toEqual({ pid: 7 })
    expect(parseHolder({ pid: 7, processStart: `linux:${BOOT_ID}:99` })).toEqual({ pid: 7, processStart: `linux:${BOOT_ID}:99` })
    expect(parseHolder({ pid: 7, processStart: 'darwin:1700000000000' })).toEqual({ pid: 7, processStart: 'darwin:1700000000000' })
    expect(parseHolder({ pid: 0 })).toBeUndefined()
    expect(parseHolder({ pid: 1.5 })).toBeUndefined()
    expect(parseHolder({ pid: '7' })).toBeUndefined()
    expect(parseHolder({ pid: 7, processStart: 7 })).toBeUndefined()
    expect(parseHolder({ pid: 7, processStart: 'windows:1' })).toBeUndefined()
    expect(parseHolder({ pid: 7, processStart: `darwin:${'1'.repeat(80)}` })).toBeUndefined()
  })

  it('parse an optional pid namespace of the form pid:[<inode>], and refuse a malformed one', () => {
    expect(parseHolder({ pid: 7, pidNamespace: 'pid:[4026531836]' })).toEqual({ pid: 7, pidNamespace: 'pid:[4026531836]' })
    expect(parseHolder({ pid: 7, processStart: `linux:${BOOT_ID}:99`, pidNamespace: 'pid:[4026531836]' })).toEqual({ pid: 7, processStart: `linux:${BOOT_ID}:99`, pidNamespace: 'pid:[4026531836]' })
    expect(Object.keys(parseHolder({ pid: 7 })!)).toEqual(['pid'])
    expect(parseHolder({ pid: 7, pidNamespace: 4026531836 })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: null })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: '' })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: 'net:[4026531836]' })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: 'pid:[x]' })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: 'pid:[4026531836]\n' })).toBeUndefined()
    expect(parseHolder({ pid: 7, pidNamespace: `pid:[${'1'.repeat(21)}]` })).toBeUndefined()
  })
})
