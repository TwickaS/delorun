/**
 * The vsock filter's decisions, read by running its classic BPF program over `struct seccomp_data` inputs for every
 * architecture it names, and the shell loader's byte-exact copy of the program. The interpreter runs the program's
 * jumps over numbers this file restates, so it guards the jump layout only: a wrong system call number would be wrong
 * in both places. The real kernel's answers for the native, x32 and 32-bit entries are `wsl-vsock-denied`'s, in the
 * Delorun CLI's WSL integration spec, and `vsock-socket-denied`'s, in `bwrap.e2e.ts`.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILTER_DESCRIPTOR, VSOCK_FILTER, assemble, vsockOffered, withSeccompFilter } from '../src/seccomp.ts'

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
      expect(run(VSOCK_FILTER, socket, arch, BigInt(AF_VSOCK))).toBe(EAFNOSUPPORT)
      // The kernel reads the family as an int, so set high bits do not hide it.
      expect(run(VSOCK_FILTER, socket, arch, 0xffff_ffff_0000_0000n | BigInt(AF_VSOCK))).toBe(EAFNOSUPPORT)
      expect(run(VSOCK_FILTER, socket, arch, BigInt(AF_INET))).toBe(ALLOW)
      expect(run(VSOCK_FILTER, socket, arch, BigInt(AF_UNIX))).toBe(ALLOW)
    }
    for (const setup of numbers.ioUring) expect(run(VSOCK_FILTER, setup, arch)).toBe(ENOSYS)
    expect(run(VSOCK_FILTER, numbers.other, arch, BigInt(AF_VSOCK))).toBe(ALLOW)
  })

  it('refuses socketcall\'s socket form on the 32-bit architectures, whose family it cannot read, and allows its other forms', () => {
    for (const arch of [I386, ARM]) {
      expect(run(VSOCK_FILTER, 102, arch, 1n)).toBe(EAFNOSUPPORT)
      expect(run(VSOCK_FILTER, 102, arch, 3n)).toBe(ALLOW)
    }
    expect(run(VSOCK_FILTER, 102, X86_64, 1n)).toBe(ALLOW)
  })

  it('refuses every call of an architecture it does not name with ENOSYS, so such a host runs nothing unfiltered', () => {
    for (const nr of [41, 59, 221]) expect(run(VSOCK_FILTER, nr, 0x8000_0016, BigInt(AF_INET))).toBe(ENOSYS)
  })

  it('fits the kernel\'s program limit', () => {
    expect(VSOCK_FILTER.length % 8).toBe(0)
    expect(VSOCK_FILTER.length / 8).toBeLessThanOrEqual(4096)
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
  /** The loader's script and program format, with a stand-in command in place of bwrap. */
  function loader(): { script: string; format: string } {
    const [shell, flag, script, name, format, ...rest] = withSeccompFilter(['bwrap', '--ro-bind', '/', '/'])
    expect([shell, flag, name]).toEqual(['/bin/sh', '-c', 'sh'])
    expect(rest).toEqual(['bwrap', '--ro-bind', '/', '/', '--seccomp', String(FILTER_DESCRIPTOR)])
    return { script: script!, format: format! }
  }

  it.skipIf(!posix)('hands bwrap the program on descriptor 9 byte for byte, and keeps input, descriptors 3 and 4 and the exit status', () => {
    const { script, format } = loader()
    // The stand-in copies descriptor 9 and standard input, writes to the inherited descriptors 3 and 4, then exits 5.
    const standIn = 'cat <&9; printf "|"; cat; echo three >&3; echo four >&4; exit 5'
    const copy = spawnSync('/bin/sh', ['-c', script, 'sh', format, 'sh', '-c', standIn], {
      input: 'stdin', stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], timeout: 30_000,
    })
    expect(copy.status).toBe(5)
    const stdout = copy.output[1] as Buffer
    expect(Buffer.compare(stdout.subarray(0, VSOCK_FILTER.length), VSOCK_FILTER)).toBe(0)
    expect(stdout.subarray(VSOCK_FILTER.length).toString()).toBe('|stdin')
    expect([String(copy.output[3]), String(copy.output[4])]).toEqual(['three\n', 'four\n'])
  })

  it.skipIf(!posix)('reports a closed standard input as a bwrap failure, before starting anything', () => {
    const { script, format } = loader()
    const argv = ['-c', 'exec "$@" 0<&-', 'sh', '/bin/sh', '-c', script, 'sh', format, 'sh', '-c', 'echo started']
    const closed = spawnSync('/bin/sh', argv, { encoding: 'utf8', timeout: 30_000 })
    expect(closed.status).toBe(1)
    expect(closed.stdout).toBe('')
    expect(closed.stderr).toBe('bwrap: the seccomp loader found standard input closed\n')
  })

  const bash = posix && spawnSync('bash', ['-c', 'enable -n printf'], { stdio: 'ignore', timeout: 30_000 }).status === 0
  it.skipIf(!bash)('reports a shell without printf as a bwrap failure, before starting anything', () => {
    const { script, format } = loader()
    const withoutPrintf = `enable -n printf; PATH=/nonexistent\n${script}`
    const argv = ['-c', withoutPrintf, 'sh', format, 'sh', '-c', 'echo started']
    const result = spawnSync('bash', argv, { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('bwrap: the seccomp loader has no printf\n')
  })
})

describe('whether the kernel offers vsock', () => {
  it('reads the protocol list, and counts one it cannot read as offering it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-protocols-'))
    try {
      const list = join(dir, 'protocols')
      writeFileSync(list, 'protocol  size sockets\nAF_VSOCK  1224      0\nUNIX      1024     12\n')
      expect(vsockOffered(list)).toBe(true)
      writeFileSync(list, 'protocol  size sockets\nUNIX      1024     12\nNOT_AF_VSOCK 1 1\n')
      expect(vsockOffered(list)).toBe(false)
      expect(vsockOffered(join(dir, 'missing'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
