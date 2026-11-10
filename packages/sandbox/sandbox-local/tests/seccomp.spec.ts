/**
 * The escape filter's decisions, read by running its classic BPF program over `struct seccomp_data` inputs for every
 * architecture it handles, and the shell loader's byte-exact copy of the program.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ESCAPE_FILTER, assemble, withSeccompFilter } from '../src/seccomp.ts'

const ALLOW = 0x7fff_0000
const EAFNOSUPPORT = 0x0005_0000 | 97
const ENOSYS = 0x0005_0000 | 38

const X86_64 = 0xc000_003e
const I386 = 0x4000_0003
const AARCH64 = 0xc000_00b7
const ARM = 0x4000_0028
const X32 = 0x4000_0000
const AF_INET = 2
const AF_UNIX = 1
const AF_VSOCK = 40

/**
 * Run a classic BPF program over one `struct seccomp_data`, with the subset of instructions the filter uses.
 * @returns the seccomp action.
 */
function run(program: Buffer, nr: number, arch: number, arg0 = 0n): number {
  const data = Buffer.alloc(64)
  data.writeUInt32LE(nr >>> 0, 0)
  data.writeUInt32LE(arch >>> 0, 4)
  data.writeBigUInt64LE(arg0, 16)
  let accumulator = 0
  for (let pc = 0; pc < program.length / 8;) {
    const code = program.readUInt16LE(pc * 8)
    const jt = program.readUInt8(pc * 8 + 2)
    const jf = program.readUInt8(pc * 8 + 3)
    const k = program.readUInt32LE(pc * 8 + 4)
    if (code === 0x20) {
      accumulator = data.readUInt32LE(k)
      pc += 1
    } else if (code === 0x15) {
      pc += 1 + (accumulator === k ? jt : jf)
    } else if (code === 0x06) {
      return k
    } else {
      throw new Error(`unexpected instruction ${code.toString(16)}`)
    }
  }
  throw new Error('the program ran off its end')
}

describe('the escape filter', () => {
  const cases: Array<[string, number, { socket: number[]; ioUring: number[]; other: number }]> = [
    ['x86-64', X86_64, { socket: [41, X32 | 41], ioUring: [425, X32 | 425], other: 42 }],
    ['i386', I386, { socket: [359], ioUring: [425], other: 362 }],
    ['aarch64', AARCH64, { socket: [198], ioUring: [425], other: 203 }],
    ['arm', ARM, { socket: [281], ioUring: [425], other: 283 }],
  ]

  it.each(cases)('on %s refuses a vsock socket and io_uring setup, and allows every other socket and call', (_name, arch, numbers) => {
    for (const socket of numbers.socket) {
      expect(run(ESCAPE_FILTER, socket, arch, BigInt(AF_VSOCK))).toBe(EAFNOSUPPORT)
      // The kernel reads the family as an int, so set high bits do not hide it.
      expect(run(ESCAPE_FILTER, socket, arch, 0xffff_ffff_0000_0000n | BigInt(AF_VSOCK))).toBe(EAFNOSUPPORT)
      expect(run(ESCAPE_FILTER, socket, arch, BigInt(AF_INET))).toBe(ALLOW)
      expect(run(ESCAPE_FILTER, socket, arch, BigInt(AF_UNIX))).toBe(ALLOW)
    }
    for (const setup of numbers.ioUring) expect(run(ESCAPE_FILTER, setup, arch)).toBe(ENOSYS)
    expect(run(ESCAPE_FILTER, numbers.other, arch, BigInt(AF_VSOCK))).toBe(ALLOW)
  })

  it('refuses socketcall\'s socket form on the 32-bit architectures, whose family it cannot read, and allows its other forms', () => {
    for (const arch of [I386, ARM]) {
      expect(run(ESCAPE_FILTER, 102, arch, 1n)).toBe(EAFNOSUPPORT)
      expect(run(ESCAPE_FILTER, 102, arch, 3n)).toBe(ALLOW)
    }
    expect(run(ESCAPE_FILTER, 102, X86_64, 1n)).toBe(ALLOW)
  })

  it('allows everything on an architecture it does not name', () => {
    expect(run(ESCAPE_FILTER, 41, 0x8000_0016, BigInt(AF_VSOCK))).toBe(ALLOW)
  })

  it('fits the kernel\'s program limit', () => {
    expect(ESCAPE_FILTER.length % 8).toBe(0)
    expect(ESCAPE_FILTER.length / 8).toBeLessThanOrEqual(4096)
  })
})

describe('the assembler', () => {
  it('refuses a missing label, a backward jump and a jump past 255 instructions', () => {
    expect(() => assemble([{ op: 'jeq', value: 1, then: 'nowhere' }])).toThrow('no label nowhere')
    const back = [{ op: 'label', name: 'back' }, { op: 'jeq', value: 1, then: 'back' }] as const
    expect(() => assemble(back)).toThrow('the jump to back cannot be encoded')
    const loads = Array.from({ length: 256 }, () => ({ op: 'load', offset: 0 }) as const)
    const far = [{ op: 'jeq', value: 1, then: 'far' }, ...loads, { op: 'label', name: 'far' }] as const
    expect(() => assemble(far)).toThrow('the jump to far cannot be encoded')
  })
})

describe('the loader', () => {
  const posix = process.platform !== 'win32'
  it.skipIf(!posix)('hands bwrap the program byte for byte, and keeps the caller\'s input and the exit status', () => {
    const [shell, flag, script, name, format, ...rest] = withSeccompFilter(['bwrap', '--ro-bind', '/', '/'])
    expect([shell, flag, name]).toEqual(['/bin/sh', '-c', 'sh'])
    expect(rest).toEqual(['bwrap', '--ro-bind', '/', '/', '--seccomp', '3'])
    // The same script with a stand-in for bwrap that copies descriptor 3 and standard input, then exits 5.
    const copy = spawnSync('/bin/sh', ['-c', script!, 'sh', format!, 'sh', '-c', 'cat <&3; printf "|"; cat; exit 5'], { input: 'stdin' })
    expect(copy.status).toBe(5)
    expect(Buffer.compare(copy.stdout.subarray(0, ESCAPE_FILTER.length), ESCAPE_FILTER)).toBe(0)
    expect(copy.stdout.subarray(ESCAPE_FILTER.length).toString()).toBe('|stdin')
  })
})
